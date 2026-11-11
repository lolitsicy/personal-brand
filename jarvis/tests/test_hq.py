from __future__ import annotations

import datetime as dt
import time

import anyio
import pytest

from jarvis import hq, policy, router, tts
from jarvis.config import Config
from jarvis.store import Store

BRIEF = {"headline": "Sales up 22%.", "spoken": "Sales are up twenty two percent.",
         "sections": [{"key": "sales", "title": "Sales", "status": "ok", "value": "$1,840",
                       "delta": "+22%", "detail": "vs last Tue", "source": "shopify"}]}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_HOME", str(tmp_path / ".jarvis"))
    cfg = Config.load()
    cfg.hq_briefing_times = "08:30,13:00,18:30"
    store = Store(cfg.db_path)
    hq.init_db(store)
    return cfg, store


def at(h, m, day=12):
    return dt.datetime(2026, 11, day, h, m)


def test_schedule_due_and_marked(env):
    cfg, store = env
    assert not hq.due(cfg, store, at(7, 0))          # before the first slot
    assert hq.due(cfg, store, at(8, 31))             # first slot passed
    hq.mark_slot(cfg, store, at(8, 31))
    assert not hq.due(cfg, store, at(9, 0))          # already briefed for 08:30
    assert hq.due(cfg, store, at(13, 5))             # next slot
    hq.mark_slot(cfg, store, at(13, 5))
    assert not hq.due(cfg, store, at(13, 6))
    assert hq.due(cfg, store, at(8, 40, day=13))     # next day
    assert hq.next_slot(cfg, at(19, 0)) == at(8, 30, day=13)
    cfg.hq_briefing_times = ""
    assert not hq.due(cfg, store, at(12, 0)) and hq.next_slot(cfg, at(12, 0)) is None


def test_request_makes_it_due_and_run_clears_it(env):
    cfg, store = env
    cfg.hq_briefing_times = ""
    hq.request(store)
    assert hq.due(cfg, store)

    async def fake(cfg_, prompt, guard, ws):
        assert "Maison Belasi" in prompt and "Shopify" in prompt
        # the briefing guard never queues approvals: writes are simply denied
        assert guard("mcp__shopify__create_discount", {"code": "X"}).verdict == policy.DENY
        assert guard("mcp__shopify__get_orders", {}).verdict == policy.ALLOW
        assert guard("Bash", {"command": "rm -f x"}).verdict == policy.DENY
        return BRIEF, 0.12

    b = anyio.run(lambda: hq.run_briefing(cfg, store, runner=fake))
    assert b["headline"] == "Sales up 22%." and hq.latest(store)["id"] == b["id"]
    assert not hq.due(cfg, store) and not hq.is_running(store)


def test_failed_briefing_still_clears_running_flag(env):
    cfg, store = env

    async def boom(*a):
        raise RuntimeError("no network")

    with pytest.raises(RuntimeError):
        anyio.run(lambda: hq.run_briefing(cfg, store, runner=boom))
    assert not hq.is_running(store)


@pytest.mark.parametrize("said", ["Brief me", "hey jarvis, brief me", "give me an update", "any updates?",
                                  "how's the business doing", "what's happening at HQ", "How are sales"])
def test_brief_me_fast_path(env, said):
    cfg, store = env
    out = router._fast_path(cfg, store, said)
    assert out and "pulling a fresh hq update" in out.lower()
    assert store.kv_get("hq_requested") == "1"


def test_brief_me_answers_from_fresh_briefing(env):
    cfg, store = env
    hq.save(store, BRIEF)
    assert router._fast_path(cfg, store, "brief me") == BRIEF["spoken"]
    assert store.kv_get("hq_requested") in (None, "0")


def test_brief_me_with_stale_briefing_says_both(env, monkeypatch):
    cfg, store = env
    hq.save(store, BRIEF)
    real = time.time
    monkeypatch.setattr(router.time, "time", lambda: real() + 3600)
    out = router._fast_path(cfg, store, "brief me")
    assert "Sales up 22%." in out and "fresh" in out and store.kv_get("hq_requested") == "1"


def test_unrelated_text_is_not_a_briefing(env):
    cfg, store = env
    assert router._fast_path(cfg, store, "update the website copy for the hero section") is None


def test_agents_cannot_read_jarvis_config(env, tmp_path):
    cfg, _ = env
    protected = [cfg.db_path, cfg.home / "config.toml"]
    ws = tmp_path / "ws"
    ws.mkdir()
    conf = str(cfg.home / "config.toml")
    assert policy.check("Read", {"file_path": conf}, ws, [], protected).verdict == policy.APPROVE
    assert policy.check("Bash", {"command": f"cat {conf}"}, ws, [], protected).verdict == policy.APPROVE
    assert policy.check("Bash", {"command": f"base64 {conf}"}, ws, [], protected).verdict == policy.APPROVE
    assert policy.check("Read", {"file_path": str(ws / "config.toml")}, ws, [], protected).verdict == policy.ALLOW


def test_tts_engine_selection(env):
    cfg, _ = env
    assert not tts.use_elevenlabs(cfg)
    cfg.elevenlabs_api_key = "k"
    assert tts.use_elevenlabs(cfg)
    cfg.tts_engine = "browser"
    assert not tts.use_elevenlabs(cfg)


def test_elevenlabs_request_shape(env, monkeypatch):
    cfg, _ = env
    cfg.elevenlabs_api_key = "secret"
    seen = {}

    class R:
        status_code = 200
        content = b"ID3mp3"
        text = ""

    def fake_post(url, params=None, headers=None, json=None, timeout=None):
        seen.update(url=url, params=params, headers=headers, json=json)
        return R()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    assert tts.elevenlabs_mp3(cfg, "Hello there") == b"ID3mp3"
    assert seen["url"].endswith(f"/v1/text-to-speech/{cfg.elevenlabs_voice_id}")
    assert seen["headers"]["xi-api-key"] == "secret" and seen["json"]["text"] == "Hello there"
    assert seen["json"]["model_id"] == cfg.elevenlabs_model


def test_kokoro_engine_selection_and_wav(env, monkeypatch, tmp_path):
    import io
    import sys
    import types
    import wave

    import numpy as np
    cfg, _ = env
    assert tts.server_engine(cfg) is None and tts.voice_label(cfg) == "Phone voice"
    d = tmp_path / "kk"
    d.mkdir()
    for f in tts.KOKORO_FILES:
        (d / f).write_bytes(b"x")
    cfg.kokoro_dir = str(d)
    monkeypatch.setitem(sys.modules, "kokoro_onnx", types.ModuleType("kokoro_onnx"))
    monkeypatch.setattr(tts, "synthesize_kokoro", lambda c, t: (np.zeros(2400, dtype="float32"), 24000))
    assert tts.server_engine(cfg) == "kokoro" and tts.voice_label(cfg) == "George (Kokoro, local)"
    audio, mime = tts.synthesize(cfg, "hello")
    assert mime == "audio/wav"
    with wave.open(io.BytesIO(audio)) as w:
        assert w.getframerate() == 24000 and w.getnframes() == 2400
    cfg.elevenlabs_api_key = "k"  # a key, when set, takes precedence
    assert tts.server_engine(cfg) == "elevenlabs"
    cfg.tts_engine = "browser"
    assert tts.server_engine(cfg) is None


def test_pronunciation_map(env):
    cfg, _ = env
    assert tts.pronounce(cfg, "Maison Belasi sales. belasi!") == "May-zon Beh-lah-see sales. Beh-lah-see!"
    cfg.tts_pronounce = ""
    assert tts.pronounce(cfg, "Maison Belasi") == "Maison Belasi"
