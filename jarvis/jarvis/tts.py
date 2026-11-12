"""Text to speech: ElevenLabs (if keyed) -> Kokoro on the Neural Engine (if chosen) -> F5 cloned voice (if chosen)
-> Kokoro -> piper
-> macOS `say` -> espeak-ng/espeak -> print.

`speak` never raises; it is called from notifier hooks and the voice loop.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import threading
import wave
from pathlib import Path

from .config import Config

log = logging.getLogger("jarvis.tts")

_lock = threading.Lock()  # one utterance at a time, whichever thread asks
_voices: dict[str, object] = {}  # piper voice cache, keyed by model path


def speak(cfg: Config, text: str) -> None:
    text = pronounce(cfg, (text or "").strip())
    if not text:
        return
    with _lock:
        if use_elevenlabs(cfg):
            try:
                if _play_mp3(elevenlabs_mp3(cfg, text)):
                    return
            except Exception as e:  # noqa: BLE001 - fall back to local voices
                log.warning("ElevenLabs failed: %s", e)
        if cfg.tts_engine == "ane" and ane_ready(cfg):
            try:
                if speak_ane(cfg, text):
                    return
            except Exception as e:  # noqa: BLE001 - fall back to ONNX Kokoro
                log.warning("Neural Engine voice failed: %s", e)
        if use_f5(cfg, text):
            try:
                if speak_f5(cfg, text):
                    return
            except Exception as e:  # noqa: BLE001 - fall back to Kokoro
                log.warning("F5 failed: %s", e)
        if cfg.tts_engine in ("auto", "kokoro", "f5", "ane") and kokoro_ready(cfg):
            try:
                audio, sr = synthesize_kokoro(cfg, text)
                if play_audio((audio * 32767).clip(-32768, 32767).astype("int16"), sr):
                    return
            except Exception as e:  # noqa: BLE001
                log.warning("Kokoro failed: %s", e)
        try:
            if cfg.piper_voice and _speak_piper(cfg.piper_voice, text):
                return
        except Exception as e:  # noqa: BLE001 - fall through to the next engine
            log.warning("piper failed: %s", e)
        try:
            if _speak_command(text):
                return
        except Exception as e:  # noqa: BLE001
            log.warning("system TTS failed: %s", e)
        print(f"Jarvis: {text}", flush=True)


# --- engine choice (shared by the desk speaker and the phone dashboard) ----------
def server_engine(cfg: Config) -> str | None:
    """Which engine the server will synthesize with, or None to let the phone speak itself."""
    if use_elevenlabs(cfg):
        return "elevenlabs"
    if cfg.tts_engine == "ane" and ane_ready(cfg):
        return "ane"
    if cfg.tts_engine == "f5" and f5_ready(cfg):
        return "f5"
    if cfg.tts_engine in ("auto", "kokoro", "f5", "ane") and kokoro_ready(cfg):
        return "kokoro"
    if cfg.tts_engine in ("auto", "piper") and cfg.piper_voice and _piper_voice(cfg.piper_voice) is not None:
        return "piper"
    return None


def voice_label(cfg: Config) -> str:
    if cfg.voice_name:
        return cfg.voice_name
    eng = server_engine(cfg)
    if eng == "ane":
        v = cfg.kokoro_voice.split("_", 1)[-1].capitalize()
        return f"{v} (Kokoro, Neural Engine)"
    if eng == "f5":
        return "Cloned voice (F5, local)"
    if eng == "kokoro":
        v = cfg.kokoro_voice.split("_", 1)[-1].capitalize()
        return f"{v} (Kokoro, local)"
    if eng == "elevenlabs":
        return "ElevenLabs"
    if eng == "piper":
        return "Piper (local)"
    return "Phone voice"


def pronounce(cfg: Config, text: str) -> str:
    """Apply tts_pronounce substitutions (longest first, whole words, case-insensitive)."""
    import re
    pairs = []
    for part in (cfg.tts_pronounce or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip():
                pairs.append((k.strip(), v.strip()))
    for k, v in sorted(pairs, key=lambda p: -len(p[0])):
        text = re.sub(rf"\b{re.escape(k)}\b", v, text, flags=re.I)
    return text


def synthesize(cfg: Config, text: str) -> tuple[bytes, str]:
    """Speech for the dashboard: (audio bytes, mime type). Raises if no server engine works."""
    text = pronounce(cfg, text)
    eng = server_engine(cfg)
    if eng == "elevenlabs":
        return elevenlabs_mp3(cfg, text), "audio/mpeg"
    if eng == "ane":
        try:
            return _wav_bytes(ane_synthesize(cfg, text), ANE_SAMPLE_RATE), "audio/wav"
        except Exception as e:  # noqa: BLE001 - fall back to ONNX Kokoro
            log.warning("Neural Engine voice failed: %s", e)
            eng = "kokoro" if kokoro_ready(cfg) else None
    if eng == "f5":
        if use_f5(cfg, text):
            try:
                return _wav_bytes(_to_int16(synthesize_f5(cfg, text)), F5_SAMPLE_RATE), "audio/wav"
            except Exception as e:  # noqa: BLE001 - fall back to Kokoro
                log.warning("F5 failed: %s", e)
        eng = "kokoro" if kokoro_ready(cfg) else None
    if eng == "kokoro":
        audio, sr = synthesize_kokoro(cfg, text)
        return _wav_bytes((audio * 32767).clip(-32768, 32767).astype("int16"), sr), "audio/wav"
    if eng == "piper":
        out = synthesize_piper(cfg.piper_voice, text)
        if out:
            return _wav_bytes(*out), "audio/wav"
    raise RuntimeError("no server voice available")


def _wav_bytes(audio, sr: int) -> bytes:
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(audio.astype("<i2").tobytes())
    return buf.getvalue()


# --- Kokoro (free, local, natural) -------------------------------------------------
KOKORO_FILES = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}
_kokoro = None
_kokoro_lock = threading.Lock()


def kokoro_dir(cfg: Config) -> Path:
    return Path(cfg.kokoro_dir).expanduser() if cfg.kokoro_dir else cfg.home / "kokoro"


def kokoro_ready(cfg: Config) -> bool:
    d = kokoro_dir(cfg)
    if not all((d / f).exists() for f in KOKORO_FILES):
        return False
    try:
        import kokoro_onnx  # noqa: F401
    except ImportError:
        return False
    return True


def _kokoro_model(cfg: Config):
    global _kokoro
    with _kokoro_lock:
        if _kokoro is None:
            from kokoro_onnx import Kokoro
            d = kokoro_dir(cfg)
            _kokoro = Kokoro(str(d / "kokoro-v1.0.onnx"), str(d / "voices-v1.0.bin"))
        return _kokoro


def synthesize_kokoro(cfg: Config, text: str):
    """Return (float32 numpy array in [-1, 1], sample_rate)."""
    k = _kokoro_model(cfg)
    return k.create(text[:3000], voice=cfg.kokoro_voice, speed=cfg.kokoro_speed, lang=cfg.kokoro_lang)


def download_kokoro(cfg: Config, progress=print) -> Path:
    import httpx
    d = kokoro_dir(cfg)
    d.mkdir(parents=True, exist_ok=True)
    for name, url in KOKORO_FILES.items():
        dest = d / name
        if dest.exists() and dest.stat().st_size > 1_000_000:
            progress(f"  ✓ {name} already present")
            continue
        tmp = dest.with_suffix(dest.suffix + ".part")
        progress(f"  ↓ {name}…")
        with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
        tmp.replace(dest)
    return d


# --- Kokoro on the Apple Neural Engine (Core ML via FluidAudio; a long-running Swift helper) --------
# ~/.local/share/jarvis/src/jarvis-tts: models load once (~30 s, at daemon start via ane_warm), then each request is
# one JSON line in, one JSON line out, with the wav written to a temp file. Measured on an M1: 1.6-2 s for 8.7 s of
# speech (ONNX Kokoro ~9 s), so sentence-by-sentence playback starts in well under a second.
ANE_SAMPLE_RATE = 24000
ANE_GAP_SECONDS = 0.08
ANE_START_TIMEOUT_S = 180  # first run downloads and compiles the models
ANE_REQUEST_TIMEOUT_S = 60
_ane: dict = {"proc": None, "key": None}
_ane_lock = threading.Lock()  # one request at a time over the helper's stdin/stdout


def _ane_bin(cfg: Config) -> Path:
    return Path(cfg.ane_tts_bin).expanduser()


def ane_ready(cfg: Config) -> bool:
    import sys
    return sys.platform == "darwin" and _ane_bin(cfg).is_file()


def _ane_readline(proc, timeout: float) -> dict:
    import json
    import select
    import time
    end = time.monotonic() + timeout
    while True:
        left = end - time.monotonic()
        if left <= 0:
            raise TimeoutError("Neural Engine voice didn't answer in time")
        r, _, _ = select.select([proc.stdout], [], [], left)
        if not r:
            continue
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(f"Neural Engine voice helper exited (code {proc.poll()})")
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)


def _ane_proc(cfg: Config):
    """The running helper for (binary, voice, version), started (and warmed) if needed. Caller holds _ane_lock."""
    key = (str(_ane_bin(cfg)), cfg.kokoro_voice, cfg.ane_version)
    p = _ane["proc"]
    if p is not None and p.poll() is None and _ane["key"] == key:
        return p
    if p is not None and p.poll() is None:
        p.terminate()
    p = subprocess.Popen([key[0], "--voice", cfg.kokoro_voice, "--version", cfg.ane_version],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        hello = _ane_readline(p, ANE_START_TIMEOUT_S)
    except Exception:
        p.kill()
        raise
    if not hello.get("ready"):
        p.kill()
        raise RuntimeError(f"Neural Engine voice failed to start: {hello.get('error')}")
    log.info("Neural Engine voice ready in %s ms (%s)", hello.get("load_ms"), cfg.kokoro_voice)
    _ane.update(proc=p, key=key)
    return p


def ane_warm(cfg: Config) -> None:
    """Start the helper in the background so the first reply isn't the slow one. Never raises."""
    if cfg.tts_engine != "ane" or not ane_ready(cfg):
        return
    try:
        with _ane_lock:
            _ane_proc(cfg)
    except Exception as e:  # noqa: BLE001
        log.warning("Neural Engine voice warm-up failed: %s", e)


def _ane_chunk(cfg: Config, text: str):
    """One request -> int16 numpy array at ANE_SAMPLE_RATE."""
    import json
    import numpy as np
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out = f.name
    try:
        with _ane_lock:
            p = _ane_proc(cfg)
            p.stdin.write(json.dumps({"text": text, "out": out, "voice": cfg.kokoro_voice,
                                      "speed": float(cfg.kokoro_speed)}) + "\n")
            p.stdin.flush()
            res = _ane_readline(p, ANE_REQUEST_TIMEOUT_S)
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "synthesis failed")
        with wave.open(out) as w:
            return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").copy()
    finally:
        Path(out).unlink(missing_ok=True)


def ane_chunks(text: str) -> list[str]:
    """The first sentence alone (so speech starts at once), then sentence chunks of a natural length."""
    import re
    parts = [x.strip() for x in re.split(r"(?<=[.!?])\s+", text.strip()) if x.strip()]
    if not parts:
        return []
    return [parts[0]] + (split_sentences(" ".join(parts[1:]), min_chars=40) if len(parts) > 1 else [])


def iter_ane(cfg: Config, text: str):
    for chunk in ane_chunks(text):
        yield _ane_chunk(cfg, chunk)


def ane_synthesize(cfg: Config, text: str):
    """Whole reply in one request (the dashboard plays one file)."""
    return _ane_chunk(cfg, text)


def speak_ane(cfg: Config, text: str) -> bool:
    """Play each sentence as soon as it's ready while the next one is made."""
    import queue
    import numpy as np
    q: queue.Queue = queue.Queue(maxsize=3)
    done = object()

    def produce():
        try:
            for c in iter_ane(cfg, text):
                q.put(c)
        except Exception as e:  # noqa: BLE001
            q.put(e)
        q.put(done)

    threading.Thread(target=produce, daemon=True, name="ane-tts").start()
    played = False
    gap = np.zeros(int(ANE_SAMPLE_RATE * ANE_GAP_SECONDS), dtype=np.int16)
    while (item := q.get()) is not done:
        if isinstance(item, Exception):
            if not played:
                raise item  # nothing said yet: the caller falls back to ONNX Kokoro
            log.warning("Neural Engine voice failed mid-reply: %s", item)
            return True
        played = play_audio(np.concatenate([item, gap]), ANE_SAMPLE_RATE) or played
    return played


# --- F5-TTS (voice cloning; Apple Silicon via MLX) -----------------------------------
F5_SAMPLE_RATE = 24000
F5_GAP_SECONDS = 0.12  # pause between sentences
_f5 = None  # (model, reference audio as mx.array)
_f5_lock = threading.Lock()  # MLX generation is not thread-safe; one sentence at a time


def f5_ready(cfg: Config) -> bool:
    if not (cfg.f5_ref_audio and cfg.f5_ref_text.strip()):
        return False
    if not Path(cfg.f5_ref_audio).expanduser().exists():
        return False
    try:
        import f5_tts_mlx  # noqa: F401
    except ImportError:
        return False
    return True


def use_f5(cfg: Config, text: str) -> bool:
    return cfg.tts_engine == "f5" and len(text) <= cfg.f5_max_chars and f5_ready(cfg)


def split_sentences(text: str, min_chars: int = 40) -> list[str]:
    """Sentence chunks for F5. Very short sentences are joined to the next so each chunk sounds natural."""
    import re
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p.strip()]
    out: list[str] = []
    for p in parts:
        if out and len(out[-1]) < min_chars:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out


def _read_ref_wav(path: Path):
    import numpy as np
    with wave.open(str(path)) as w:
        if w.getframerate() != F5_SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path} must be mono 16-bit {F5_SAMPLE_RATE} Hz wav; convert with: "
                             f"ffmpeg -i in -ac 1 -ar {F5_SAMPLE_RATE} -sample_fmt s16 out.wav")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


def _f5_model(cfg: Config):
    global _f5
    if _f5 is None:
        import mlx.core as mx
        from f5_tts_mlx.cfm import F5TTS
        from f5_tts_mlx.generate import TARGET_RMS
        model = F5TTS.from_pretrained(cfg.f5_model)
        # float32 matters: float64 (soundfile's default) pushes MLX off the fast path.
        ref = mx.array(_read_ref_wav(Path(cfg.f5_ref_audio).expanduser()))
        rms = mx.sqrt(mx.mean(mx.square(ref)))
        if rms < TARGET_RMS:
            ref = ref * TARGET_RMS / rms
        _f5 = (model, ref)
    return _f5


def iter_f5(cfg: Config, text: str):
    """Yield one float32 numpy chunk (24 kHz) per sentence, so playback can start early."""
    import mlx.core as mx
    import numpy as np
    from f5_tts_mlx.generate import HOP_LENGTH
    from f5_tts_mlx.utils import convert_char_to_pinyin
    ref_text = cfg.f5_ref_text.strip()
    for sentence in split_sentences(text):
        with _f5_lock:
            model, ref = _f5_model(cfg)
            # Pass an explicit length: without it the output can come back nearly empty.
            frames = f5_frames(ref.shape[0] // HOP_LENGTH, ref_text, sentence, cfg.f5_speed)
            out, _ = model.sample(
                mx.expand_dims(ref, axis=0), text=convert_char_to_pinyin([f"{ref_text} {sentence}"]),
                duration=frames, steps=cfg.f5_steps, method="euler", speed=cfg.f5_speed,
                cfg_strength=2.0, sway_sampling_coef=-1.0, seed=cfg.f5_seed)
            out = out[ref.shape[0]:]
            mx.eval(out)
            chunk = np.array(out, dtype=np.float32)
        yield chunk


def f5_frames(ref_frames: int, ref_text: str, text: str, speed: float = 1.0) -> int:
    """Total mel frames (reference + new speech), scaled from the reference's speaking rate.
    Same formula as f5_tts_mlx's estimated_duration, minus its print()."""
    ref_len = max(1, len(ref_text.encode()))
    return ref_frames + int(ref_frames / ref_len * len(text.encode()) / speed)


def synthesize_f5(cfg: Config, text: str):
    """Whole reply as one float32 array at F5_SAMPLE_RATE."""
    import numpy as np
    gap = np.zeros(int(F5_SAMPLE_RATE * F5_GAP_SECONDS), dtype=np.float32)
    chunks = []
    for c in iter_f5(cfg, text):
        chunks += [c, gap]
    if not chunks:
        raise RuntimeError("F5 produced no audio")
    return np.concatenate(chunks[:-1])


def speak_f5(cfg: Config, text: str) -> bool:
    """Play each sentence as soon as it's ready while the next one generates."""
    import queue
    import numpy as np
    q: queue.Queue = queue.Queue()
    done = object()

    def produce():
        try:
            for c in iter_f5(cfg, text):
                q.put(c)
        except Exception as e:  # noqa: BLE001
            q.put(e)
        q.put(done)

    threading.Thread(target=produce, daemon=True, name="f5-tts").start()
    played = False
    gap = np.zeros(int(F5_SAMPLE_RATE * F5_GAP_SECONDS), dtype=np.float32)
    while (item := q.get()) is not done:
        if isinstance(item, Exception):
            if not played:
                raise item  # nothing said yet: let the caller fall back to Kokoro
            log.warning("F5 failed mid-reply: %s", item)
            return True
        played = play_audio(_to_int16(np.concatenate([item, gap])), F5_SAMPLE_RATE) or played
    return played


def download_f5(cfg: Config) -> None:
    from huggingface_hub import snapshot_download
    snapshot_download(cfg.f5_model)


def _to_int16(audio):
    import numpy as np
    return (np.clip(audio, -1, 1) * 32767).astype(np.int16)


# --- ElevenLabs -----------------------------------------------------------------
def use_elevenlabs(cfg: Config) -> bool:
    return bool(cfg.elevenlabs_api_key) and cfg.tts_engine in ("auto", "elevenlabs")


def elevenlabs_mp3(cfg: Config, text: str) -> bytes:
    """Synthesize speech with ElevenLabs. Returns MP3 bytes; raises on failure."""
    import httpx
    r = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{cfg.elevenlabs_voice_id}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": cfg.elevenlabs_api_key, "Accept": "audio/mpeg"},
        json={"text": text[:2500], "model_id": cfg.elevenlabs_model,
              "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs HTTP {r.status_code}: {r.text[:200]}")
    return r.content


def _play_mp3(data: bytes) -> bool:
    import shutil
    import subprocess
    import tempfile
    for cmd in (["afplay"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"], ["mpg123", "-q"]):
        if shutil.which(cmd[0]):
            with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
                f.write(data)
                f.flush()
                return subprocess.run([*cmd, f.name], timeout=120).returncode == 0
    return False


# --- piper -------------------------------------------------------------------
def _piper_voice(model_path: str):
    try:
        from piper import PiperVoice
    except ImportError:
        log.info("piper_voice is set but piper-tts is not installed (pip install piper-tts)")
        return None
    v = _voices.get(model_path)
    if v is None:
        path = Path(model_path).expanduser()
        if not path.exists():
            log.warning("piper voice not found: %s", path)
            return None
        v = PiperVoice.load(str(path))
        _voices[model_path] = v
    return v


def synthesize_piper(model_path: str, text: str):
    """Return (int16 numpy array, sample_rate) or None if piper isn't usable."""
    voice = _piper_voice(model_path)
    if voice is None:
        return None
    import numpy as np

    chunks = list(voice.synthesize(text))  # one AudioChunk per sentence (piper-tts >= 1.3)
    if not chunks:
        return None
    audio = np.concatenate([c.audio_int16_array for c in chunks])
    return audio, chunks[0].sample_rate


def write_wav(path: str | Path, audio, sample_rate: int) -> None:
    """Write mono int16 audio to a wav file."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(audio.astype("<i2").tobytes())


def _speak_piper(model_path: str, text: str) -> bool:
    out = synthesize_piper(model_path, text)
    if out is None:
        return False
    audio, sr = out
    return play_audio(audio, sr)


def play_audio(audio, sample_rate: int) -> bool:
    """Play int16/float mono audio. sounddevice first, then a wav through aplay/afplay/paplay."""
    try:
        import sounddevice as sd  # raises OSError when PortAudio is missing

        sd.play(audio, sample_rate)
        sd.wait()
        return True
    except Exception as e:  # noqa: BLE001
        log.debug("sounddevice playback unavailable: %s", e)
    player = next((p for p in ("afplay", "aplay", "paplay") if shutil.which(p)), None)
    if not player:
        log.warning("no audio player found (install sounddevice+portaudio, or aplay)")
        return False
    import numpy as np

    if audio.dtype != np.int16:
        audio = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name
    try:
        write_wav(tmp, audio, sample_rate)
        args = [player, "-q", tmp] if player == "aplay" else [player, tmp]
        return subprocess.run(args, capture_output=True, timeout=120).returncode == 0
    finally:
        Path(tmp).unlink(missing_ok=True)


# --- system engines ----------------------------------------------------------
def _speak_command(text: str) -> bool:
    for cmd in ("say", "espeak-ng", "espeak"):
        exe = shutil.which(cmd)
        if not exe:
            continue
        r = subprocess.run([exe, text], capture_output=True, timeout=120)
        if r.returncode == 0:
            return True
        log.warning("%s exited %s: %s", cmd, r.returncode, r.stderr[-300:])
    return False
