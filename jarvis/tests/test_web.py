from __future__ import annotations

import json
import os
import stat
import threading
from pathlib import Path

import httpx
import pytest

from jarvis import policy, router, tailnet
from jarvis.config import Config
from jarvis.store import NEEDS_INPUT, QUEUED, Store
from jarvis.web import make_server

ME = "owner@example.com"


@pytest.fixture
def srv(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_HOME", str(tmp_path / ".jarvis"))
    cfg = Config.load()
    store = Store(cfg.db_path)
    heard = []

    async def fake_handle(c, s, text):
        heard.append(text)
        return f"ok: {text}"

    monkeypatch.setattr(router, "handle", fake_handle)
    server = make_server(cfg, store, {ME}, port=0, transcribe=lambda p: "build me a website")
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    client = httpx.Client(base_url=base, headers={"Tailscale-User-Login": ME}, timeout=5)
    yield cfg, store, client, base, heard
    server.shutdown()


def test_binds_loopback_only(srv):
    _, _, client, base, _ = srv
    assert base.startswith("http://127.0.0.1:")


def test_requires_allowed_tailnet_user(srv):
    _, _, _, base, _ = srv
    assert httpx.get(base + "/api/goals").status_code == 403
    assert httpx.get(base + "/", headers={"Tailscale-User-Login": "stranger@x.com"}).status_code == 403
    assert httpx.get(base + "/", headers={"Tailscale-User-Login": "OWNER@example.com"}).status_code == 200


def test_page_and_goals(srv):
    _, store, client, _, _ = srv
    store.add_goal("Write poem", "p", "poem.txt exists", 5, 3)
    page = client.get("/")
    assert page.status_code == 200 and "Jarvis" in page.text and ME in page.text
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    d = client.get("/api/goals").json()
    assert d["active"][0]["title"] == "Write poem" and "Goal 1" in d["status"]
    g = client.get("/api/goals/1").json()
    assert g["events"][0]["kind"] == "created"


def test_say_goes_through_router(srv):
    _, store, client, _, heard = srv
    r = client.post("/api/say", json={"text": "make a website"})
    assert r.json()["reply"] == "ok: make a website" and heard == ["make a website"]


def test_mutations_refuse_form_posts_and_cross_origin(srv):
    _, store, client, _, heard = srv
    # a cross-site HTML form can only send these content types
    r = client.post("/api/say", content="text=hi", headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415
    r = client.post("/api/say", content="hi", headers={"Content-Type": "text/plain"})
    assert r.status_code == 415
    r = client.post("/api/say", json={"text": "hi"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert heard == []
    # GET can't change anything (the agent's WebFetch tool is GET-only)
    store.add_goal("t", "p", "d", 5, 3)
    assert client.get("/api/goals/1/cancel").status_code == 404
    assert store.get(1).status == QUEUED


def test_answer_approve_cancel(srv):
    _, store, client, _, _ = srv
    g = store.add_goal("Publish", "p", "d", 5, 3)
    store.update(g.id, status=NEEDS_INPUT, pending_question="Push?",
                 pending_approvals=["Bash: git push origin main"])
    d = client.get("/api/goals").json()["active"][0]
    assert d["question"] == "Push?" and d["pending_approvals"] == ["Bash: git push origin main"]

    r = client.post(f"/api/goals/{g.id}/approve", json={})
    assert "git push origin main" in r.json()["reply"]
    assert store.get(g.id).approvals == ["Bash: git push origin main"]
    # approving again grants nothing more
    assert "isn't waiting" in client.post(f"/api/goals/{g.id}/approve", json={}).json()["reply"]

    store.update(g.id, status=NEEDS_INPUT, pending_question="Colour?")
    r = client.post(f"/api/goals/{g.id}/answer", json={"text": "blue"})
    assert store.get(g.id).status == QUEUED and "blue" in store.peek_inbox(g.id)[-1][1]

    assert "Cancelled" in client.post(f"/api/goals/{g.id}/cancel", json={}).json()["reply"]
    assert store.get(g.id).status == "cancelled"
    assert client.post("/api/goals/99/cancel", json={}).status_code == 404


def test_voice_upload(srv):
    _, _, client, _, heard = srv
    r = client.post("/api/voice", content=b"\x1aE\xdf\xa3" + b"0" * 5000, headers={"Content-Type": "audio/webm"})
    assert r.json() == {"heard": "build me a website", "reply": "ok: build me a website",
                        "speak": "ok: build me a website"}
    assert client.post("/api/voice", content=b"x", headers={"Content-Type": "text/plain"}).status_code == 415


def test_refuses_to_start_with_nobody_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_HOME", str(tmp_path / ".jarvis"))
    cfg = Config.load()
    with pytest.raises(SystemExit):
        make_server(cfg, Store(cfg.db_path), set(), port=0)


# --- tailscale -------------------------------------------------------------

STATUS = {
    "BackendState": "Running",
    "Self": {"DNSName": "homebox.tail1234.ts.net.", "UserID": 42, "Online": True},
    "User": {"42": {"LoginName": "Owner@example.com"}},
}


def test_parse_status_and_allowlist():
    info = tailnet.parse_status(STATUS)
    assert info.url == "https://homebox.tail1234.ts.net" and info.owner_login == "Owner@example.com"
    assert tailnet.allowed_logins("", info) == {"owner@example.com"}
    assert tailnet.allowed_logins("a@x.com, B@y.com", info) == {"a@x.com", "b@y.com"}
    with pytest.raises(tailnet.TailscaleError):
        tailnet.parse_status({"BackendState": "NeedsLogin"})


def _fake_tailscale(tmp_path: Path, serve_rc: int = 0, serve_err: str = "") -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "ts.log"
    exe = bindir / "tailscale"
    exe.write_text(f"""#!/bin/sh
echo "$@" >> {log}
if [ "$1" = status ]; then cat <<'J'
{json.dumps(STATUS)}
J
exit 0; fi
if [ "$1" = serve ]; then echo "{serve_err}" >&2; exit {serve_rc}; fi
""")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return log


def test_cli_tailscale_on_sets_public_url(tmp_path, monkeypatch, capsys):
    from jarvis.cli import main
    log = _fake_tailscale(tmp_path)
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}:{os.environ['PATH']}")
    monkeypatch.setenv("JARVIS_HOME", str(tmp_path / ".jarvis"))
    main(["init"])
    main(["tailscale", "on"])
    out = capsys.readouterr().out
    assert "https://homebox.tail1234.ts.net" in out and "owner@example.com" in out
    assert "serve --bg --https=443 http://127.0.0.1:8765" in log.read_text()
    assert Config.load().public_url == "https://homebox.tail1234.ts.net"
    cfg_text = (tmp_path / ".jarvis" / "config.toml").read_text()
    assert cfg_text.count("public_url") == 1 and "telegram_token" in cfg_text  # rest preserved
    main(["tailscale", "on"])  # idempotent
    assert (tmp_path / ".jarvis" / "config.toml").read_text().count("public_url") == 1


def test_cli_tailscale_https_hint(tmp_path, monkeypatch):
    from jarvis.cli import main
    _fake_tailscale(tmp_path, serve_rc=1, serve_err="HTTPS is not enabled for this tailnet")
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}:{os.environ['PATH']}")
    monkeypatch.setenv("JARVIS_HOME", str(tmp_path / ".jarvis"))
    with pytest.raises(SystemExit) as e:
        main(["tailscale", "on"])
    assert "HTTPS Certificates" in str(e.value)


# --- agents can't reach the control API --------------------------------------

@pytest.mark.parametrize("cmd", [
    "curl -s http://127.0.0.1:8765/api/goals",
    "curl -X POST localhost:8765/api/goals/1/approve -H 'Content-Type: application/json' -d {}",
    "python3 -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/')\"",
    "curl -H 'Tailscale-User-Login: me@x.com' http://10.0.0.5:9999/",
])
def test_policy_blocks_control_api(tmp_path, cmd):
    assert policy.check("Bash", {"command": cmd}, tmp_path, []).verdict == policy.DENY


def test_policy_blocks_webfetch_to_local_and_tailnet(tmp_path):
    for url in ("http://127.0.0.1:8765/api/goals", "http://localhost:8765/", "https://homebox.tail1234.ts.net/"):
        assert policy.check("WebFetch", {"url": url}, tmp_path, []).verdict == policy.DENY
    assert policy.check("WebFetch", {"url": "https://docs.python.org/3/"}, tmp_path, []).verdict == policy.ALLOW
    assert policy.check("Bash", {"command": "curl -s http://localhost:3000/health"}, tmp_path, []).verdict \
        == policy.ALLOW


# --- overview / HQ / voice endpoints ------------------------------------------

def test_overview_shape(srv):
    from jarvis import hq
    _, store, client, _, _ = srv
    a = store.add_goal("Ask me", "p", "d", 5, 3)
    store.update(a.id, status=NEEDS_INPUT, pending_question="Blue?", spent_usd=0.4)
    b = store.add_goal("Running", "p", "d", 5, 3)
    store.update(b.id, status="running")
    c = store.add_goal("Done", "p", "d", 5, 3)
    store.update(c.id, status="done", spent_usd=0.3)
    hq.save(store, {"headline": "Sales up.", "spoken": "Sales are up.", "sections": []})
    d = client.get("/api/overview").json()
    assert d["summary"]["needs_you"] == 1 and d["summary"]["in_motion"] == 1 and d["summary"]["done_7d"] == 1
    assert [g["title"] for g in d["needs_you"]] == ["Ask me"] and [g["title"] for g in d["active"]] == ["Running"]
    assert len(d["chart"]["days"]) == 14 and d["chart"]["days"][-1]["done"] == 1
    assert d["hq"]["briefing"]["headline"] == "Sales up." and d["hq"]["name"] == "Maison Belasi"
    assert d["voice"] == {"server_tts": False, "engine": "browser", "voice_name": "Phone voice"}
    assert d["summary"]["spend_today"] == pytest.approx(0.7)


def test_hq_refresh_and_tts_without_key(srv):
    _, store, client, _, _ = srv
    assert "Pulling" in client.post("/api/hq/refresh", json={}).json()["reply"]
    assert store.kv_get("hq_requested") == "1"
    assert client.post("/api/tts", json={"text": "hi"}).status_code == 404


def test_tts_with_key(srv, monkeypatch):
    from jarvis import tts
    cfg, _, client, _, _ = srv
    cfg.elevenlabs_api_key = "k"
    monkeypatch.setattr(tts, "elevenlabs_mp3", lambda c, t: b"ID3" + t.encode())
    r = client.post("/api/tts", json={"text": "hello"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3hello"
