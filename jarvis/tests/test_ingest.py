from __future__ import annotations

import sys
import types

import anyio
import pytest

from jarvis import ingest, voice
from jarvis.config import Config
from jarvis.store import Store


@pytest.fixture
def cfg(tmp_path):
    return Config(home=tmp_path, whisper_model="tiny.en", whisper_device="cpu",
                  default_budget_usd=2.5, max_attempts=4)


@pytest.fixture
def store(cfg):
    return Store(cfg.db_path)


@pytest.fixture
def rec(tmp_path):
    p = tmp_path / "Team Meeting.m4a"
    p.write_bytes(b"not really audio")
    return p


SEGS = [
    {"start": 0, "end": 1, "text": "Can you book the flights?", "speaker": "SPEAKER_00"},
    {"start": 1, "end": 2, "text": "And draft the budget.", "speaker": "SPEAKER_00"},
    {"start": 2, "end": 3, "text": "Sure.", "speaker": "SPEAKER_01"},
]


def test_format_transcript_merges_speakers():
    assert ingest.format_transcript(SEGS) == (
        "SPEAKER_00: Can you book the flights? And draft the budget.\nSPEAKER_01: Sure.")
    plain = [{"text": " one "}, {"text": "two", "speaker": None}, {"text": ""}]
    assert ingest.format_transcript(plain) == "one two"


def test_save_transcript(cfg, rec):
    p = ingest.save_transcript(cfg, rec, "hello")
    assert p.parent == cfg.home / "transcripts"
    assert p.name.endswith("Team_Meeting.txt") and p.read_text() == "hello\n"


# --- whisperx (fake module) --------------------------------------------------
def fake_whisperx(monkeypatch, pipeline_kw="token", top_level_pipeline=False):
    calls = {}
    wx = types.ModuleType("whisperx")
    diar = types.ModuleType("whisperx.diarize")

    class Model:
        def transcribe(self, audio, batch_size=None):
            calls["batch_size"] = batch_size
            return {"language": "en", "segments": [{"start": 0.0, "end": 1.0, "text": " hi there"},
                                                    {"start": 1.0, "end": 2.0, "text": " bye"}]}

    def load_model(name, device, compute_type=None, language=None):
        calls["load_model"] = (name, device, compute_type, language)
        return Model()

    wx.load_audio = lambda p: f"AUDIO({p})"
    wx.load_model = load_model
    wx.load_align_model = lambda language_code, device: ("ALIGN", {"lang": language_code})

    def align(segments, model, meta, audio, device, return_char_alignments=False):
        calls["align"] = True
        return {"segments": segments}

    wx.align = align

    def assign_word_speakers(diarize_df, result):
        for i, s in enumerate(result["segments"]):
            s["speaker"] = f"SPEAKER_0{i}"
        return result

    wx.assign_word_speakers = assign_word_speakers

    if pipeline_kw == "token":
        class Pipeline:
            def __init__(self, model_name=None, token=None, device="cpu"):
                calls["pipeline"] = ("token", token, device)

            def __call__(self, audio):
                return "DIARIZATION"
    else:
        class Pipeline:  # older whisperx
            def __init__(self, model_name=None, use_auth_token=None, device="cpu"):
                calls["pipeline"] = ("use_auth_token", use_auth_token, device)

            def __call__(self, audio):
                return "DIARIZATION"

    if top_level_pipeline:
        wx.DiarizationPipeline = Pipeline
        monkeypatch.setitem(sys.modules, "whisperx.diarize", None)  # import fails
    else:
        diar.DiarizationPipeline = Pipeline
        wx.diarize = diar
        monkeypatch.setitem(sys.modules, "whisperx.diarize", diar)
    monkeypatch.setitem(sys.modules, "whisperx", wx)
    return calls


def test_whisperx_without_diarization(cfg, rec, monkeypatch):
    calls = fake_whisperx(monkeypatch)
    segs = ingest.transcribe_with_whisperx(cfg, rec, diarize=False)
    assert [s["text"] for s in segs] == ["hi there", "bye"]
    assert all(s["speaker"] is None for s in segs)
    assert calls["load_model"] == ("tiny.en", "cpu", "int8", "en") and calls["align"]
    assert "pipeline" not in calls


def test_whisperx_diarize_needs_token(cfg, rec, monkeypatch):
    for k in ("HF_TOKEN", "HUGGINGFACE_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    calls = fake_whisperx(monkeypatch)
    segs = ingest.transcribe_with_whisperx(cfg, rec, diarize=True, hf_token=None)
    assert "pipeline" not in calls and segs[0]["speaker"] is None


@pytest.mark.parametrize("kw,top", [("token", False), ("use_auth_token", True)])
def test_whisperx_diarization(cfg, rec, monkeypatch, kw, top):
    calls = fake_whisperx(monkeypatch, pipeline_kw=kw, top_level_pipeline=top)
    segs = ingest.transcribe_with_whisperx(cfg, rec, diarize=True, hf_token="hf_x")
    assert calls["pipeline"] == (kw, "hf_x", "cpu")
    assert [s["speaker"] for s in segs] == ["SPEAKER_00", "SPEAKER_01"]


def test_falls_back_to_faster_whisper(cfg, rec, monkeypatch):
    monkeypatch.setitem(sys.modules, "whisperx", None)  # "not installed"

    class Seg:
        def __init__(self, t):
            self.text, self.start, self.end = t, 0.0, 1.0

    class FW:
        def transcribe(self, audio, **kw):
            return iter([Seg(" book flights "), Seg("  ")]), None

    monkeypatch.setattr(voice, "get_whisper", lambda c: FW())
    monkeypatch.setattr(voice, "load_audio", lambda p: None)
    segs = ingest.transcribe_recording(cfg, rec, diarize=True)
    assert segs == [{"start": 0.0, "end": 1.0, "text": "book flights", "speaker": None}]


def test_missing_whisperx_hint(cfg, rec, monkeypatch):
    monkeypatch.setitem(sys.modules, "whisperx", None)
    with pytest.raises(RuntimeError, match=r"jarvis-home\[ingest\]"):
        ingest.transcribe_with_whisperx(cfg, rec)


# --- extraction via the SDK (faked) ------------------------------------------
def fake_sdk(monkeypatch, structured=None, result=None):
    import claude_agent_sdk as sdk

    seen = {}

    class FakeResult:
        def __init__(self):
            self.structured_output, self.result = structured, result

    async def fake_query(prompt, options):
        seen["prompt"], seen["options"] = prompt, options
        yield object()  # some non-result message
        yield FakeResult()

    monkeypatch.setattr(sdk, "query", fake_query)
    monkeypatch.setattr(sdk, "ResultMessage", FakeResult)
    return seen


def test_extract_goals_uses_structured_output(cfg, store, monkeypatch):
    out = {"goals": [{"title": "t", "prompt": "p", "done_criteria": "d"}], "summary": "s"}
    seen = fake_sdk(monkeypatch, structured=out)
    assert anyio.run(ingest.extract_goals, cfg, store, "SPEAKER_00: book flights") == out
    opts = seen["options"]
    assert opts.tools == [] and opts.output_format["schema"] is ingest.EXTRACT_SCHEMA
    assert "book flights" in seen["prompt"] and "Queue" in seen["prompt"]


def test_extract_goals_parses_text_fallback(cfg, store, monkeypatch):
    fake_sdk(monkeypatch, result='Here: {"goals": [], "summary": "nothing"}')
    assert anyio.run(ingest.extract_goals, cfg, store, "x") == {"goals": [], "summary": "nothing"}


def test_extract_goals_empty_raises(cfg, store, monkeypatch):
    fake_sdk(monkeypatch)
    with pytest.raises(RuntimeError):
        anyio.run(ingest.extract_goals, cfg, store, "x")


# --- ingest end to end -------------------------------------------------------
def test_ingest_creates_multiple_goals(cfg, store, rec, monkeypatch):
    monkeypatch.setattr(ingest, "transcribe_recording", lambda c, p, diarize, hf_token: SEGS)
    got = {}

    async def fake_extract(c, s, transcript):
        got["transcript"] = transcript
        return {"summary": "Trip planning.", "goals": [
            {"title": "Book flights", "prompt": "Find flights", "done_criteria": "flights.md lists 3 options"},
            {"title": "Draft budget", "prompt": "Write a budget", "done_criteria": "budget.csv exists"},
            {"title": "", "prompt": "", "done_criteria": ""},  # junk is skipped
        ]}

    monkeypatch.setattr(ingest, "extract_goals", fake_extract)
    out = anyio.run(lambda: ingest.ingest(cfg, store, rec, diarize=True))
    goals = sorted(store.list(), key=lambda g: g.id)
    assert [g.title for g in goals] == ["Book flights", "Draft budget"]
    assert all(g.budget_usd == 2.5 and g.max_attempts == 4 for g in goals)
    assert "Team Meeting.m4a" in goals[0].prompt
    assert got["transcript"].startswith("SPEAKER_00: Can you book")
    assert "Trip planning." in out and "Created 2 goals" in out and "#1 Book flights" in out
    files = list((cfg.home / "transcripts").iterdir())
    assert len(files) == 1 and "SPEAKER_01: Sure." in files[0].read_text()


def test_ingest_no_speech(cfg, store, rec, monkeypatch):
    monkeypatch.setattr(ingest, "transcribe_recording", lambda c, p, diarize, hf_token: [])
    assert "couldn't hear" in anyio.run(lambda: ingest.ingest(cfg, store, rec))
    assert store.list() == []


def test_ingest_extraction_failure_keeps_transcript(cfg, store, rec, monkeypatch):
    monkeypatch.setattr(ingest, "transcribe_recording", lambda c, p, diarize, hf_token: SEGS)

    async def boom(*a):
        raise RuntimeError("api down")

    monkeypatch.setattr(ingest, "extract_goals", boom)
    out = anyio.run(lambda: ingest.ingest(cfg, store, rec))
    assert "api down" in out and "Transcript saved" in out
    assert list((cfg.home / "transcripts").iterdir())


def test_ingest_missing_file(cfg, store):
    with pytest.raises(FileNotFoundError):
        anyio.run(lambda: ingest.ingest(cfg, store, "/nope/x.wav"))
