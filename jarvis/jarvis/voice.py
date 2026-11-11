"""Voice front end: mic -> wake word -> energy VAD -> faster-whisper -> router -> TTS.

Heavy dependencies (numpy, sounddevice, openwakeword, faster-whisper) are imported lazily so the
rest of Jarvis works without them. Install with `pip install 'jarvis-home[voice]'`.
"""

from __future__ import annotations

import logging
import os
import queue
import shutil
import subprocess
import threading
from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path

from . import router, tts
from .config import Config
from .store import Store

log = logging.getLogger("jarvis.voice")

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms at 16 kHz: the chunk size openwakeword expects
INSTALL_HINT = "pip install 'jarvis-home[voice]'"


class VoiceDepsMissing(RuntimeError):
    pass


def _require(module: str):
    import importlib

    try:
        return importlib.import_module(module)
    except ImportError as e:
        raise VoiceDepsMissing(f"Voice mode needs '{module}' ({e}). Install it with: {INSTALL_HINT}") from e
    except OSError as e:  # sounddevice raises this when the PortAudio C library is missing
        raise VoiceDepsMissing(
            f"'{module}' could not load a system library ({e}). Install PortAudio "
            "(macOS: brew install portaudio; Debian/Ubuntu: sudo apt install libportaudio2)."
        ) from e


# --- energy VAD (pure numpy, unit-tested) ------------------------------------
WAITING, SPEECH, DONE, TIMEOUT = "waiting", "speech", "done", "timeout"


@dataclass(frozen=True)
class VadConfig:
    sample_rate: int = SAMPLE_RATE
    frame_samples: int = FRAME
    threshold: float = 0.015  # RMS on the float [-1, 1] scale counted as speech
    silence_s: float = 1.2  # this much quiet after speech ends the utterance
    max_s: float = 20.0  # hard cap on utterance length
    wait_s: float = 8.0  # give up if nobody starts talking within this long
    min_speech_s: float = 0.24  # loud run needed to count as speech (ignores clicks)
    preroll_s: float = 0.32  # audio kept from just before speech started

    @property
    def frame_s(self) -> float:
        return self.frame_samples / self.sample_rate

    def frames(self, seconds: float) -> int:
        return max(1, round(seconds / self.frame_s))


def to_float32(x):
    """int16 or float audio -> float32 in [-1, 1]."""
    import numpy as np

    x = np.asarray(x)
    if x.dtype == np.int16:
        return x.astype(np.float32) / 32768.0
    return x.astype(np.float32, copy=False)


def rms(frame) -> float:
    import numpy as np

    f = to_float32(frame)
    if f.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(f, dtype=np.float64))))


def noise_threshold(levels, floor: float = 0.015, factor: float = 3.0, ceiling: float = 0.2) -> float:
    """Speech threshold from a stretch of background audio's per-frame RMS levels."""
    import numpy as np

    if len(levels) == 0:
        return floor
    return float(min(ceiling, max(floor, factor * float(np.median(levels)))))


class Endpointer:
    """Feed fixed-size frames; tells you when an utterance has started and ended.

    States: waiting -> speech -> done, or waiting -> timeout if no speech within wait_s.
    """

    def __init__(self, vad: VadConfig | None = None):
        self.vad = vad or VadConfig()
        v = self.vad
        self.state = WAITING
        self._pre: deque = deque(maxlen=v.frames(v.preroll_s) + v.frames(v.min_speech_s))
        self._frames: list = []
        self._loud_run = 0
        self._quiet_run = 0
        self._seen = 0

    def push(self, frame) -> str:
        if self.state in (DONE, TIMEOUT):
            return self.state
        v = self.vad
        self._seen += 1
        loud = rms(frame) >= v.threshold
        if self.state == WAITING:
            self._pre.append(frame)
            self._loud_run = self._loud_run + 1 if loud else 0
            if self._loud_run >= v.frames(v.min_speech_s):
                self.state = SPEECH
                self._frames = list(self._pre)
                self._pre.clear()
            elif self._seen >= v.frames(v.wait_s):
                self.state = TIMEOUT
            return self.state
        self._frames.append(frame)
        self._quiet_run = 0 if loud else self._quiet_run + 1
        if self._quiet_run >= v.frames(v.silence_s) or len(self._frames) >= v.frames(v.max_s):
            self.state = DONE
        return self.state

    def finish(self) -> str:
        """Input ended (e.g. end of a file): close an in-progress utterance."""
        if self.state == SPEECH:
            self.state = DONE
        elif self.state == WAITING:
            self.state = TIMEOUT
        return self.state

    @property
    def audio(self):
        """Captured utterance as float32, trailing silence trimmed to ~0.25 s."""
        import numpy as np

        if not self._frames:
            return np.zeros(0, dtype=np.float32)
        keep = len(self._frames) - max(0, self._quiet_run - self.vad.frames(0.25))
        return to_float32(np.concatenate(self._frames[:keep]))


def split_frames(audio, frame_samples: int = FRAME):
    """Chop a 1-D array into full frames (the ragged tail is dropped)."""
    n = len(audio) // frame_samples
    return [audio[i * frame_samples:(i + 1) * frame_samples] for i in range(n)]


def find_utterance(audio, vad: VadConfig | None = None):
    """Run the endpointer over a whole array. Returns the first utterance (float32) or None."""
    ep = Endpointer(vad)
    for f in split_frames(audio, ep.vad.frame_samples):
        if ep.push(f) in (DONE, TIMEOUT):
            break
    else:
        ep.finish()
    return ep.audio if ep.state == DONE else None


# --- speech to text ----------------------------------------------------------
_models: dict[tuple, object] = {}
_model_lock = threading.Lock()


def resolve_device(cfg: Config) -> tuple[str, str]:
    """(device, compute_type) for faster-whisper."""
    device = (cfg.whisper_device or "auto").lower()
    if device == "auto":
        device = "cpu"
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
        except Exception:  # noqa: BLE001
            pass
    return device, ("float16" if device == "cuda" else "int8")


def get_whisper(cfg: Config):
    """Load the faster-whisper model once per (model, device)."""
    fw = _require("faster_whisper")
    device, compute = resolve_device(cfg)
    key = (cfg.whisper_model, device, compute)
    with _model_lock:
        m = _models.get(key)
        if m is None:
            log.info("loading whisper %s on %s (%s)", cfg.whisper_model, device, compute)
            m = fw.WhisperModel(cfg.whisper_model, device=device, compute_type=compute)
            _models[key] = m
    return m


def vocabulary(cfg: Config) -> str:
    """Words Jarvis hears often; biases Whisper toward them (short commands mishear easily)."""
    return (f"Jarvis, brief me. Any updates? Approve goal 3. Cancel goal 2. Status. "
            f"{cfg.hq_name}, Shopify, Meta Ads, Gmail, ROAS, orders, inbox, calendar.")


def _transcribe(cfg: Config, audio_or_path) -> str:
    model = get_whisper(cfg)
    segments, _info = model.transcribe(
        audio_or_path, beam_size=5, vad_filter=True, condition_on_previous_text=False,
        initial_prompt=vocabulary(cfg),
    )
    return " ".join(s.text.strip() for s in segments if s.text.strip()).strip()


def transcribe_array(cfg: Config, audio) -> str:
    """16 kHz mono audio (int16 or float32) -> text."""
    return _transcribe(cfg, to_float32(audio))


def resample(audio, src_rate: int, dst_rate: int = SAMPLE_RATE):
    """Linear-interpolation resample of float mono audio (good enough for speech recognition)."""
    import numpy as np

    if src_rate == dst_rate or audio.size == 0:
        return audio
    n = int(round(audio.size * dst_rate / src_rate))
    return np.interp(np.linspace(0, audio.size - 1, n), np.arange(audio.size), audio).astype(np.float32)


def read_wav(path: str | Path):
    """PCM wav -> 16 kHz mono float32 with only the stdlib + numpy."""
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as w:
        sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported wav sample width {width}")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return resample(a, sr)


def load_audio(path: str | Path):
    """Any audio file -> 16 kHz mono float32. ffmpeg if present, else stdlib wav reader.
    Returns None if neither can read it (caller then lets faster-whisper/PyAV try)."""
    import numpy as np

    if shutil.which("ffmpeg"):
        r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path),
                            "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
                           capture_output=True, timeout=1800)
        if r.returncode == 0:
            return np.frombuffer(r.stdout, dtype="<f4").copy()
        log.warning("ffmpeg could not decode %s: %s", path, r.stderr[-300:])
    try:
        return read_wav(path)
    except Exception:  # noqa: BLE001 - not a PCM wav
        return None


def transcribe_file(cfg: Config, path: str | Path) -> str:
    """Transcribe an audio file (wav, or e.g. Telegram ogg/opus via ffmpeg).

    We decode ourselves rather than handing the path to faster-whisper: its PyAV decoder breaks
    with av>=19 (`open() got an unexpected keyword argument 'metadata_errors'`)."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    audio = load_audio(path)
    if audio is None:
        hint = "" if shutil.which("ffmpeg") else " Install ffmpeg (brew/apt install ffmpeg)."
        raise ValueError(f"couldn't decode that audio ({path.suffix or 'unknown format'}).{hint}")
    if audio.size < SAMPLE_RATE // 4:  # under 0.25 s
        return ""
    return _transcribe(cfg, audio)


async def handle_file(cfg: Config, store: Store, path: str | Path) -> str:
    """Transcribe a recording and treat it as one utterance (testing without a mic)."""
    import anyio

    text = await anyio.to_thread.run_sync(transcribe_file, cfg, path)
    print(f"Heard: {text!r}", flush=True)
    if not text:
        return "I didn't catch anything in that recording."
    return await router.handle(cfg, store, text)


# --- notifications -----------------------------------------------------------
def speaking_notifier(cfg: Config):
    """Notifier hook (title, body) that says the title out loud without blocking the caller."""

    def _notify(title: str, body: str) -> None:
        threading.Thread(target=tts.speak, args=(cfg, _plain(title)), daemon=True).start()

    return _notify


def _plain(s: str) -> str:
    """Drop emoji/symbols TTS engines read out awkwardly ("cross mark ...")."""
    return "".join(ch for ch in s if ch.isalnum() or ch.isspace() or ch in ".,:;!?'-#$%&()").strip()


# --- live microphone loop ----------------------------------------------------
class Mic:
    """16 kHz mono int16 input stream delivering FRAME-sized chunks through a bounded queue."""

    def __init__(self, maxframes: int = 400):
        self._q: queue.Queue = queue.Queue(maxsize=maxframes)
        self._stream = None

    def __enter__(self):
        sd = _require("sounddevice")

        def cb(indata, frames, time_info, status):  # runs on PortAudio's thread
            if status:
                log.debug("mic status: %s", status)
            chunk = indata[:, 0].copy()
            try:
                self._q.put_nowait(chunk)
            except queue.Full:  # nobody is reading (e.g. waiting for Enter): drop oldest
                try:
                    self._q.get_nowait()
                except queue.Empty:
                    pass
                self._q.put_nowait(chunk)

        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                                      blocksize=FRAME, callback=cb)
        self._stream.start()
        return self

    def __exit__(self, *exc):
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()

    def read(self, timeout: float = 1.0):
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self) -> None:
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                return


class WakeWord:
    """openwakeword wrapper that works with both the 0.4 API (wakeword_model_paths, models shipped
    in the wheel) and 0.5+/0.6 (wakeword_models, models fetched by utils.download_models,
    tflite by default -> we force onnx since tflite-runtime has no wheels for new Pythons)."""

    def __init__(self, name: str, threshold: float = 0.5):
        oww = _require("openwakeword")
        from openwakeword.model import Model

        self.threshold = threshold
        if os.path.exists(name):  # a custom model file
            try:
                self.model = Model(wakeword_models=[name], inference_framework="onnx")
            except TypeError:
                self.model = Model(wakeword_model_paths=[name])
            return
        if hasattr(oww, "FEATURE_MODELS"):  # >= 0.5: model files are downloaded on demand
            try:
                from openwakeword.utils import download_models

                download_models([name])
            except Exception as e:  # noqa: BLE001 - maybe offline but already cached
                log.warning("openwakeword download_models failed: %s", e)
            self.model = Model(wakeword_models=[name], inference_framework="onnx")
        else:  # 0.4: pretrained onnx models ship inside the package
            paths = [p for p in oww.get_pretrained_model_paths() if Path(p).name.startswith(name)]
            if not paths:
                avail = ", ".join(sorted(getattr(oww, "models", {}))) or "?"
                raise VoiceDepsMissing(f"Unknown wake word model '{name}'. Available: {avail}")
            self.model = Model(wakeword_model_paths=paths[:1])

    def detect(self, frame) -> bool:
        scores = self.model.predict(frame)
        return bool(scores) and max(scores.values()) >= self.threshold

    def reset(self) -> None:
        self.model.reset()


def beep(freq: float = 880.0, seconds: float = 0.12) -> None:
    try:
        import numpy as np

        t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
        tone = (0.2 * np.sin(2 * np.pi * freq * t) * np.hanning(t.size)).astype(np.float32)
        if tts.play_audio(tone, SAMPLE_RATE):
            return
    except Exception:  # noqa: BLE001
        pass
    print("\a", end="", flush=True)


def calibrate(mic: Mic, vad: VadConfig, seconds: float = 1.0) -> VadConfig:
    """Measure background noise for a moment and raise the speech threshold above it."""
    levels = []
    for _ in range(vad.frames(seconds)):
        f = mic.read(timeout=2.0)
        if f is None:
            break
        levels.append(rms(f))
    return replace(vad, threshold=noise_threshold(levels, floor=vad.threshold))


def listen_once(mic: Mic, vad: VadConfig, wake: WakeWord | None, stop: threading.Event):
    """Block until wake word (or Enter), then record one utterance. Returns float32 audio or None."""
    if wake is not None:
        while not stop.is_set():
            f = mic.read(timeout=0.5)
            if f is not None and wake.detect(f):
                wake.reset()
                break
        else:
            return None
    else:
        try:
            input("Press Enter, then speak... ")
        except EOFError:
            stop.set()
            return None
    beep()
    mic.drain()  # don't record the beep or anything said before it
    print("listening...", flush=True)
    ep = Endpointer(vad)
    while not stop.is_set():
        f = mic.read(timeout=1.0)
        if f is None:
            continue
        if ep.push(f) in (DONE, TIMEOUT):
            break
    return ep.audio if ep.state == DONE else None


async def run_voice(cfg: Config, store: Store, notifier=None) -> None:
    """Live loop. Pass the process's Notifier to also have goal notifications spoken."""
    import anyio

    _require("numpy")
    print(f"Loading speech model '{cfg.whisper_model}'...", flush=True)
    await anyio.to_thread.run_sync(get_whisper, cfg)
    wake = WakeWord(cfg.wake_word) if cfg.wake_word else None
    if notifier is not None:
        notifier.extra.append(speaking_notifier(cfg))
    stop = threading.Event()
    try:
        with Mic() as mic:
            vad = await anyio.to_thread.run_sync(calibrate, mic, VadConfig())
            log.info("speech threshold %.4f", vad.threshold)
            print(f"Say '{cfg.wake_word.replace('_', ' ')}' to talk." if wake else
                  "Push-to-talk mode (wake_word is empty).", flush=True)
            while True:
                audio = await _thread(listen_once, mic, vad, wake, stop)
                if stop.is_set():
                    return
                if audio is None or audio.size == 0:
                    continue
                text = await anyio.to_thread.run_sync(transcribe_array, cfg, audio)
                print(f"You: {text}", flush=True)
                if not text:
                    continue
                reply = await router.handle(cfg, store, text)
                print(f"Jarvis: {reply}", flush=True)
                await anyio.to_thread.run_sync(tts.speak, cfg, reply)
                mic.drain()  # don't hear ourselves
                if wake is not None:
                    wake.reset()
    finally:
        stop.set()


async def _thread(fn, *args):
    import inspect

    import anyio

    kw = ("abandon_on_cancel" if "abandon_on_cancel" in inspect.signature(anyio.to_thread.run_sync).parameters
          else "cancellable")  # anyio < 4.1
    return await anyio.to_thread.run_sync(fn, *args, **{kw: True})
