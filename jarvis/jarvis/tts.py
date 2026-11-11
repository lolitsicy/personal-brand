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
    text = (text or "").strip()
    if not text:
        return
    with _lock:
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
