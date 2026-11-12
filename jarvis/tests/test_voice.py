from __future__ import annotations

import threading

import anyio
import numpy as np
import pytest

from jarvis import router, tts, voice
from jarvis.config import Config
from jarvis.store import Store

SR = voice.SAMPLE_RATE


def tone(seconds: float, amp: float = 0.3, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def silence(seconds: float, noise: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(0)
    return (rng.normal(0, noise, int(SR * seconds)) if noise else np.zeros(int(SR * seconds))).astype(np.float32)


@pytest.fixture
def cfg(tmp_path):
    return Config(home=tmp_path, whisper_model="tiny.en", whisper_device="cpu")


@pytest.fixture
def store(cfg):
    return Store(cfg.db_path)


# --- VAD ---------------------------------------------------------------------
def test_rms_handles_int16_and_float():
    assert voice.rms(np.zeros(100, np.int16)) == 0.0
    assert voice.rms(np.full(100, 16384, np.int16)) == pytest.approx(0.5)
    assert voice.rms(np.full(100, 0.25, np.float32)) == pytest.approx(0.25)
    assert voice.rms(np.zeros(0)) == 0.0


def test_find_utterance_trims_to_speech():
    audio = np.concatenate([silence(1.0, 0.002), tone(2.0), silence(3.0, 0.002)])
    utt = voice.find_utterance(audio)
    assert utt is not None and utt.dtype == np.float32
    secs = len(utt) / SR
    # 2 s of speech + up to ~0.5 s preroll + ~0.25 s kept tail
    assert 2.0 <= secs <= 2.9, secs


def test_find_utterance_int16_input():
    audio = (np.concatenate([silence(0.5), tone(1.0), silence(2.0)]) * 32767).astype(np.int16)
    utt = voice.find_utterance(audio)
    assert utt is not None and 1.0 <= len(utt) / SR <= 1.9


def test_short_click_is_not_speech():
    click = tone(0.08, amp=0.9)  # one frame
    audio = np.concatenate([silence(1.0), click, silence(9.0)])
    assert voice.find_utterance(audio) is None


def test_no_speech_times_out():
    ep = voice.Endpointer(voice.VadConfig(wait_s=1.0))
    states = [ep.push(f) for f in voice.split_frames(silence(2.0))]
    assert states[-1] == voice.TIMEOUT
    assert voice.WAITING in states and voice.SPEECH not in states


def test_max_length_cap():
    vad = voice.VadConfig(max_s=3.0)
    utt = voice.find_utterance(tone(10.0), vad)
    assert utt is not None and len(utt) / SR <= 3.0 + 0.5


def test_speech_until_end_of_input_is_closed():
    utt = voice.find_utterance(np.concatenate([silence(0.3), tone(1.0)]))
    assert utt is not None and len(utt) / SR >= 1.0


def test_pause_shorter_than_silence_window_keeps_one_utterance():
    audio = np.concatenate([tone(1.0), silence(0.6), tone(1.0), silence(2.0)])
    utt = voice.find_utterance(audio)
    assert utt is not None and len(utt) / SR >= 2.6


def test_endpointer_state_sequence():
    ep = voice.Endpointer()
    frames = voice.split_frames(np.concatenate([silence(0.4), tone(1.0), silence(1.5)]))
    states = [ep.push(f) for f in frames]
    assert states[0] == voice.WAITING
    assert voice.SPEECH in states
    assert states[-1] == voice.DONE
    assert ep.push(frames[0]) == voice.DONE  # sticky


def test_noise_threshold():
    assert voice.noise_threshold([]) == 0.015
    assert voice.noise_threshold([0.001] * 10) == 0.015  # floor
    assert voice.noise_threshold([0.02] * 10) == pytest.approx(0.06)
    assert voice.noise_threshold([0.5] * 10) == 0.2  # ceiling


def test_split_frames_drops_tail():
    frames = voice.split_frames(np.arange(1280 * 3 + 5))
    assert len(frames) == 3 and all(len(f) == 1280 for f in frames)


# --- audio loading -----------------------------------------------------------
def test_read_wav_resamples_to_16k(tmp_path):
    p = tmp_path / "a.wav"
    tts.write_wav(p, (tone(1.0) * 32767).astype(np.int16).repeat(1), SR)
    a = voice.read_wav(p)
    assert len(a) == SR and a.dtype == np.float32
    a22 = voice.resample(tone(1.0), SR, 22050)
    tts.write_wav(p, (a22 * 32767).astype(np.int16), 22050)
    assert abs(len(voice.read_wav(p)) - SR) <= 1


# --- transcription with a fake model -----------------------------------------
class FakeSeg:
    def __init__(self, text, start=0.0, end=1.0):
        self.text, self.start, self.end = text, start, end


class FakeWhisper:
    def __init__(self, texts):
        self.texts, self.calls = texts, []

    def transcribe(self, audio, **kw):
        self.calls.append((audio, kw))
        return iter(FakeSeg(t) for t in self.texts), None


def test_transcribe_file_decodes_and_joins(tmp_path, cfg, monkeypatch):
    fake = FakeWhisper([" Hey Jarvis,", " buy milk. ", "  "])
    monkeypatch.setattr(voice, "get_whisper", lambda c: fake)
    p = tmp_path / "x.wav"
    tts.write_wav(p, (tone(0.5) * 32767).astype(np.int16), 22050)
    assert voice.transcribe_file(cfg, p) == "Hey Jarvis, buy milk."
    audio, kw = fake.calls[0]
    assert isinstance(audio, np.ndarray) and audio.dtype == np.float32  # we decode, not PyAV
    assert kw["vad_filter"] is True


def test_transcribe_file_missing(cfg):
    with pytest.raises(FileNotFoundError):
        voice.transcribe_file(cfg, "/nope/missing.wav")


def test_get_whisper_loads_once(cfg, monkeypatch):
    import types

    made = []

    class WM:
        def __init__(self, name, device, compute_type):
            made.append((name, device, compute_type))

    monkeypatch.setattr(voice, "_require", lambda m: types.SimpleNamespace(WhisperModel=WM))
    monkeypatch.setattr(voice, "_models", {})
    a, b = voice.get_whisper(cfg), voice.get_whisper(cfg)
    assert a is b and made == [("tiny.en", "cpu", "int8")]


def test_resolve_device(cfg, monkeypatch):
    import sys
    import types

    assert voice.resolve_device(cfg) == ("cpu", "int8")
    cfg.whisper_device = "cuda"
    assert voice.resolve_device(cfg) == ("cuda", "float16")
    cfg.whisper_device = "auto"
    monkeypatch.setitem(sys.modules, "ctranslate2", types.SimpleNamespace(get_cuda_device_count=lambda: 1))
    assert voice.resolve_device(cfg) == ("cuda", "float16")
    monkeypatch.setitem(sys.modules, "ctranslate2", types.SimpleNamespace(get_cuda_device_count=lambda: 0))
    assert voice.resolve_device(cfg) == ("cpu", "int8")


def test_missing_dependency_message():
    with pytest.raises(voice.VoiceDepsMissing, match=r"jarvis-home\[voice\]"):
        voice._require("definitely_not_installed_xyz")


# --- handle_file / notifier --------------------------------------------------
def test_handle_file_routes_text(cfg, store, monkeypatch):
    seen = {}

    async def fake_handle(c, s, text):
        seen["text"] = text
        return "On it."

    monkeypatch.setattr(voice, "transcribe_file", lambda c, p: "remind me to buy milk")
    monkeypatch.setattr(router, "handle", fake_handle)
    out = anyio.run(voice.handle_file, cfg, store, "x.wav")
    assert out == "On it." and seen["text"] == "remind me to buy milk"


def test_handle_file_empty_transcript(cfg, store, monkeypatch):
    async def boom(*a):
        raise AssertionError("router should not be called")

    monkeypatch.setattr(voice, "transcribe_file", lambda c, p: "")
    monkeypatch.setattr(router, "handle", boom)
    assert "didn't catch" in anyio.run(voice.handle_file, cfg, store, "x.wav")


def test_speaking_notifier_speaks_title_in_background(cfg, monkeypatch):
    said, done = [], threading.Event()

    def fake_speak(c, text):
        said.append(text)
        done.set()

    monkeypatch.setattr(tts, "speak", fake_speak)
    voice.speaking_notifier(cfg)("✅ #3 Buy milk done", "long body")
    assert done.wait(2)
    assert said == ["#3 Buy milk done"]


# --- tts fallbacks -----------------------------------------------------------
def test_speak_falls_back_to_print(cfg, monkeypatch, capsys):
    monkeypatch.setattr(tts.shutil, "which", lambda x: None)
    tts.speak(cfg, "hello there")
    assert "Jarvis: hello there" in capsys.readouterr().out


def test_speak_never_raises(cfg, monkeypatch, capsys):
    cfg.piper_voice = "/missing/voice.onnx"
    monkeypatch.setattr(tts.shutil, "which", lambda x: "/usr/bin/" + x)

    def explode(*a, **k):
        raise OSError("boom")

    monkeypatch.setattr(tts.subprocess, "run", explode)
    tts.speak(cfg, "still fine")
    assert "still fine" in capsys.readouterr().out


def test_speak_uses_system_command(cfg, monkeypatch):
    calls = []
    monkeypatch.setattr(tts.shutil, "which", lambda x: "/usr/bin/espeak-ng" if x == "espeak-ng" else None)

    class R:
        returncode, stderr = 0, b""

    monkeypatch.setattr(tts.subprocess, "run", lambda args, **k: calls.append(args) or R())
    tts.speak(cfg, "hi")
    assert calls == [["/usr/bin/espeak-ng", "hi"]]


# --- F5 cloned voice ---------------------------------------------------------
@pytest.fixture
def f5cfg(cfg, tmp_path, monkeypatch):
    ref = tmp_path / "ref.wav"
    tts.write_wav(ref, np.zeros(tts.F5_SAMPLE_RATE, dtype=np.int16), tts.F5_SAMPLE_RATE)
    cfg.tts_engine, cfg.f5_ref_audio, cfg.f5_ref_text = "f5", str(ref), "Reference words."
    monkeypatch.setattr(tts, "f5_ready", lambda c: True)
    return cfg


def test_split_sentences_joins_short_ones():
    assert tts.split_sentences("Done. The report is ready in your workspace. Anything else?") == \
        ["Done. The report is ready in your workspace.", "Anything else?"]
    assert tts.split_sentences("  ") == []


def test_f5_frames_scales_with_text_length():
    assert tts.f5_frames(100, "abcd", "abcdabcd") == 300
    assert tts.f5_frames(100, "abcd", "abcdabcd", speed=2.0) == 200


def test_f5_ready_needs_reference(cfg, tmp_path):
    cfg.tts_engine = "f5"
    assert not tts.f5_ready(cfg)
    cfg.f5_ref_audio, cfg.f5_ref_text = str(tmp_path / "missing.wav"), "hi"
    assert not tts.f5_ready(cfg)


def test_engine_choice_f5_and_fallback(f5cfg, monkeypatch):
    monkeypatch.setattr(tts, "kokoro_ready", lambda c: True)
    assert tts.server_engine(f5cfg) == "f5"
    assert tts.voice_label(f5cfg).startswith("Cloned voice")
    monkeypatch.setattr(tts, "f5_ready", lambda c: False)
    assert tts.server_engine(f5cfg) == "kokoro"
    f5cfg.tts_engine = "auto"
    monkeypatch.setattr(tts, "f5_ready", lambda c: True)
    assert tts.server_engine(f5cfg) == "kokoro"  # F5 is opt-in only


def test_synthesize_f5_joins_sentences(f5cfg, monkeypatch):
    monkeypatch.setattr(tts, "iter_f5", lambda c, t: iter([np.full(10, 0.5, np.float32)] * 2))
    data, mime = tts.synthesize(f5cfg, "One sentence here, long enough. And another one.")
    assert mime == "audio/wav"
    gap = int(tts.F5_SAMPLE_RATE * tts.F5_GAP_SECONDS)
    assert len(data) == 44 + 2 * (20 + gap)


def test_synthesize_f5_falls_back_to_kokoro(f5cfg, monkeypatch):
    def boom(c, t):
        raise RuntimeError("mlx exploded")
        yield
    monkeypatch.setattr(tts, "iter_f5", boom)
    monkeypatch.setattr(tts, "kokoro_ready", lambda c: True)
    monkeypatch.setattr(tts, "synthesize_kokoro", lambda c, t: (np.zeros(5, np.float32), 24000))
    data, mime = tts.synthesize(f5cfg, "hello")
    assert mime == "audio/wav" and len(data) == 44 + 10


def test_long_reply_skips_f5(f5cfg, monkeypatch):
    f5cfg.f5_max_chars = 10
    assert not tts.use_f5(f5cfg, "x" * 11)
    assert tts.use_f5(f5cfg, "x" * 10)


def test_speak_f5_streams_each_sentence(f5cfg, monkeypatch):
    played = []
    monkeypatch.setattr(tts, "iter_f5", lambda c, t: iter([np.ones(3, np.float32), np.ones(4, np.float32)]))
    monkeypatch.setattr(tts, "play_audio", lambda a, sr: played.append((len(a), sr)) or True)
    tts.speak(f5cfg, "First sentence that is long enough. Second.")
    gap = int(tts.F5_SAMPLE_RATE * tts.F5_GAP_SECONDS)
    assert played == [(3 + gap, 24000), (4 + gap, 24000)]


def test_speak_f5_failure_before_audio_uses_kokoro(f5cfg, monkeypatch):
    def boom(c, t):
        raise RuntimeError("no gpu")
        yield
    played = []
    monkeypatch.setattr(tts, "iter_f5", boom)
    monkeypatch.setattr(tts, "kokoro_ready", lambda c: True)
    monkeypatch.setattr(tts, "synthesize_kokoro", lambda c, t: (np.zeros(7, np.float32), 24000))
    monkeypatch.setattr(tts, "play_audio", lambda a, sr: played.append(len(a)) or True)
    tts.speak(f5cfg, "hello")
    assert played == [7]


def test_read_ref_wav_rejects_wrong_format(tmp_path):
    p = tmp_path / "bad.wav"
    tts.write_wav(p, np.zeros(100, np.int16), 16000)
    with pytest.raises(ValueError, match="24000"):
        tts._read_ref_wav(p)
    p2 = tmp_path / "ok.wav"
    tts.write_wav(p2, np.full(100, 16384, np.int16), 24000)
    assert abs(tts._read_ref_wav(p2)[0] - 0.5) < 1e-6


def test_ane_engine_streams_sentences_through_the_helper(tmp_path, monkeypatch):
    """tts_engine = "ane": a long-running helper (faked here) answers one JSON line per sentence."""
    import sys
    import numpy as np
    from jarvis import tts
    fake = tmp_path / "jarvis-tts"
    fake.write_text(f"""#!{sys.executable}
import json, sys, wave
print(json.dumps({{"ready": True, "load_ms": 1}}), flush=True)
for line in sys.stdin:
    r = json.loads(line)
    with wave.open(r["out"], "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
        w.writeframes(b"\\x01\\x00" * (100 * len(r["text"])))
    print(json.dumps({{"ok": True, "out": r["out"], "ms": 1, "seconds": 0.1}}), flush=True)
""")
    fake.chmod(0o755)
    cfg = Config(home=tmp_path)
    cfg.tts_engine, cfg.ane_tts_bin = "ane", str(fake)
    monkeypatch.setattr(sys, "platform", "darwin")
    played = []
    monkeypatch.setattr(tts, "play_audio", lambda a, sr: played.append((len(a), sr)) or True)
    try:
        assert tts.server_engine(cfg) == "ane" and "Neural Engine" in tts.voice_label(cfg)
        tts.speak(cfg, "This is the first sentence of the reply. And this is the second one, a bit longer.")
        assert len(played) == 2 and all(sr == 24000 for _, sr in played)
        data, mime = tts.synthesize(cfg, "Hello there.")
        assert mime == "audio/wav" and data[:4] == b"RIFF"
    finally:
        p = tts._ane["proc"]
        if p is not None:
            p.kill()
        tts._ane.update(proc=None, key=None)


def test_ane_missing_helper_falls_back(tmp_path):
    from jarvis import tts
    cfg = Config(home=tmp_path)
    cfg.tts_engine, cfg.ane_tts_bin = "ane", str(tmp_path / "nope")
    assert not tts.ane_ready(cfg) and tts.server_engine(cfg) != "ane"
