from __future__ import annotations

import json

import anyio
import httpx
import pytest

from jarvis import router, telegram_bot as tg, voice
from jarvis.config import Config
from jarvis.store import Store

OWNER = "4242"


def msg(update_id, chat_id=OWNER, text=None, voice_id=None):
    m = {"message_id": update_id, "chat": {"id": int(chat_id), "type": "private"},
         "from": {"id": int(chat_id), "username": "owner"}}
    if text is not None:
        m["text"] = text
    if voice_id:
        m["voice"] = {"file_id": voice_id, "duration": 2, "mime_type": "audio/ogg"}
    return {"update_id": update_id, "message": m}


class FakeAPI:
    token = "SECRET"

    def __init__(self, batches=()):
        self.batches, self.sent, self.offsets, self.closed = list(batches), [], [], False

    async def get_updates(self, offset, timeout=50):
        self.offsets.append(offset)
        return self.batches.pop(0) if self.batches else []

    async def send_message(self, chat_id, text):
        self.sent.append((chat_id, text))

    async def typing(self, chat_id):
        pass

    async def download(self, file_id, dst):
        dst.write_bytes(b"OggS fake")
        return dst

    async def aclose(self):
        self.closed = True


@pytest.fixture
def cfg(tmp_path):
    return Config(home=tmp_path, telegram_token="SECRET", telegram_chat_id=OWNER)


@pytest.fixture
def store(cfg):
    return Store(cfg.db_path)


@pytest.fixture
def routed(monkeypatch):
    heard = []

    async def fake_handle(c, s, text):
        heard.append(text)
        return f"ok: {text}"

    monkeypatch.setattr(router, "handle", fake_handle)
    return heard


# --- pure helpers ------------------------------------------------------------
def test_parse_update_text_and_voice():
    m = tg.parse_update(msg(7, text=" hello "))
    assert (m.update_id, m.chat_id, m.text, m.voice_file_id, m.sender) == (7, OWNER, "hello", "", "owner")
    v = tg.parse_update(msg(8, voice_id="F1"))
    assert v.voice_file_id == "F1" and v.text == ""
    assert tg.parse_update({"update_id": 9, "callback_query": {}}) is None
    assert tg.parse_update({"update_id": 9, "message": {"text": "no chat"}}) is None


def test_is_authorized(cfg):
    assert tg.is_authorized(cfg, OWNER)
    assert tg.is_authorized(cfg, int(OWNER))
    assert not tg.is_authorized(cfg, "999")
    cfg.telegram_chat_id = ""
    assert not tg.is_authorized(cfg, OWNER)


def test_parse_command():
    assert tg.parse_command("/status") == ("status", "")
    assert tg.parse_command("/Goals@JarvisBot now please") == ("goals", "now please")
    assert tg.parse_command("status") is None


def test_next_offset():
    assert tg.next_offset([], 5) == 5
    assert tg.next_offset([{"update_id": 10}, {"update_id": 12}], 5) == 13


def test_chunks_and_redact():
    assert tg.chunks("x" * 9000, 4000) == ["x" * 4000, "x" * 4000, "x" * 1000]
    assert tg.redact("https://api.telegram.org/botSECRET/getUpdates", "SECRET") == \
        "https://api.telegram.org/bot<token>/getUpdates"


# --- authorization -----------------------------------------------------------
def test_no_chat_id_start_reveals_id_only(cfg, store, routed, capsys):
    cfg.telegram_chat_id = ""
    api = FakeAPI()
    r = anyio.run(tg.reply_for, cfg, store, api, tg.parse_update(msg(1, "777", "/start")))
    assert "777" in r and "telegram_chat_id" in r
    assert "777" in capsys.readouterr().out
    assert anyio.run(tg.reply_for, cfg, store, api, tg.parse_update(msg(2, "777", "do stuff"))) is None
    assert routed == []


def test_stranger_is_ignored(cfg, store, routed):
    api = FakeAPI()
    for text in ("/start", "/status", "delete everything"):
        assert anyio.run(tg.reply_for, cfg, store, api, tg.parse_update(msg(1, "999", text))) is None
    assert routed == []


# --- owner messages ----------------------------------------------------------
def test_text_goes_to_router(cfg, store, routed):
    r = anyio.run(tg.reply_for, cfg, store, FakeAPI(), tg.parse_update(msg(1, text="build me a site")))
    assert r == "ok: build me a site" and routed == ["build me a site"]


def test_status_and_goals_commands(cfg, store, routed):
    store.add_goal("Buy milk", "buy milk", "receipt.txt exists", 5.0, 3)
    api = FakeAPI()
    status = anyio.run(tg.reply_for, cfg, store, api, tg.parse_update(msg(1, text="/status")))
    assert status == router.spoken_status(store)
    goals = anyio.run(tg.reply_for, cfg, store, api, tg.parse_update(msg(2, text="/goals")))
    assert "#1 [queued] Buy milk" in goals
    assert routed == []


def test_unknown_command_is_passed_as_text(cfg, store, routed):
    anyio.run(tg.reply_for, cfg, store, FakeAPI(), tg.parse_update(msg(1, text="/approve 3")))
    assert routed == ["approve 3"]


def test_voice_note_is_transcribed_and_echoed(cfg, store, routed, monkeypatch):
    seen = {}

    def fake_transcribe(c, path):
        seen["bytes"] = path.read_bytes()
        return "remind me to call mom"

    monkeypatch.setattr(voice, "transcribe_file", fake_transcribe)
    r = anyio.run(tg.reply_for, cfg, store, FakeAPI(), tg.parse_update(msg(1, voice_id="F1")))
    assert seen["bytes"] == b"OggS fake"
    assert "Heard: “remind me to call mom”" in r and "ok: remind me to call mom" in r
    assert routed == ["remind me to call mom"]


def test_voice_failure_is_reported(cfg, store, routed, monkeypatch):
    def broken(c, p):
        raise voice.VoiceDepsMissing("Voice mode needs 'faster_whisper'")

    monkeypatch.setattr(voice, "transcribe_file", broken)
    r = anyio.run(tg.reply_for, cfg, store, FakeAPI(), tg.parse_update(msg(1, voice_id="F1")))
    assert "couldn't transcribe" in r and routed == []


# --- polling loop ------------------------------------------------------------
def test_run_telegram_persists_offset_and_replies(cfg, store, routed):
    store.kv_set("tg_offset", "100")
    api = FakeAPI([[msg(100, text="hi"), msg(101, "999", "intruder"), msg(102, text="/goals")], []])
    anyio.run(lambda: tg.run_telegram(cfg, store, api=api, max_polls=2))
    assert api.offsets == [100, 103]
    assert store.kv_get("tg_offset") == "103"
    assert [c for c, _ in api.sent] == [OWNER, OWNER]
    assert api.sent[0][1] == "ok: hi"
    assert api.closed


def test_run_telegram_survives_handler_crash(cfg, store, monkeypatch):
    async def boom(*a):
        raise ValueError("kaboom")

    monkeypatch.setattr(router, "handle", boom)
    api = FakeAPI([[msg(1, text="hi")]])
    anyio.run(lambda: tg.run_telegram(cfg, store, api=api, max_polls=1))
    assert api.sent and "kaboom" in api.sent[0][1]
    assert store.kv_get("tg_offset") == "2"


def test_run_telegram_requires_token(cfg, store):
    cfg.telegram_token = ""
    with pytest.raises(RuntimeError, match="telegram_token"):
        anyio.run(tg.run_telegram, cfg, store)


# --- real client against a mock transport -----------------------------------
def test_telegram_api_http_calls(tmp_path):
    calls = []

    def handler(req: httpx.Request):
        calls.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
        if req.url.path.endswith("/getUpdates"):
            return httpx.Response(200, json={"ok": True, "result": [msg(5, text="yo")]})
        if req.url.path.endswith("/getFile"):
            return httpx.Response(200, json={"ok": True, "result": {"file_path": "voice/file_1.oga"}})
        if req.url.path.startswith("/file/"):
            return httpx.Response(200, content=b"AUDIO")
        if req.url.path.endswith("/sendMessage"):
            return httpx.Response(200, json={"ok": True, "result": {}})
        return httpx.Response(200, json={"ok": False, "description": "nope"})

    async def main():
        api = tg.TelegramAPI("T0K", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        ups = await api.get_updates(3, timeout=1)
        await api.send_message("1", "x" * 4500)
        dst = await api.download("FID", tmp_path / "v.oga")
        with pytest.raises(RuntimeError, match="nope"):
            await api.call("bogus")
        await api.aclose()
        return ups, dst

    ups, dst = anyio.run(main)
    assert ups[0]["update_id"] == 5
    assert calls[0][1] == "/botT0K/getUpdates" and calls[0][2]["offset"] == 3
    assert [c[2]["text"] for c in calls if c[1].endswith("sendMessage")] == ["x" * 4000, "x" * 500]
    assert ("GET", "/file/botT0K/voice/file_1.oga", None) in calls
    assert dst.read_bytes() == b"AUDIO"
