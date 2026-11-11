"""Text to speech: piper (if configured) -> macOS `say` -> espeak-ng/espeak -> print.

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
        if cfg.tts_engine in ("auto", "kokoro") and kokoro_ready(cfg):
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
    if cfg.tts_engine in ("auto", "kokoro") and kokoro_ready(cfg):
        return "kokoro"
    if cfg.tts_engine in ("auto", "piper") and cfg.piper_voice and _piper_voice(cfg.piper_voice) is not None:
        return "piper"
    return None


def voice_label(cfg: Config) -> str:
    if cfg.voice_name:
        return cfg.voice_name
    eng = server_engine(cfg)
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
