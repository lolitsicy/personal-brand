"""Phone-friendly dashboard + JSON API, meant to sit behind `tailscale serve`.

Security model (all layers on by default):
  - Listens on 127.0.0.1 only. The only way in from another device is through tailscaled.
  - Every request must carry `Tailscale-User-Login` (set by `tailscale serve`) naming an allowed
    tailnet user. No header → 403. That includes browsers on this machine; use the CLI there.
  - State changes are POST-only with a non-form Content-Type (JSON or audio), and Origin must
    match. That blocks cross-site form posts and the agent's own WebFetch tool (GET-only).
  - Agents' shell commands can't reach localhost at all (the OS sandbox blocks it), and
    policy.py denies commands aimed at this port.
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import anyio

import time

from . import hq, router, tts
from .config import Config
from .store import ACTIVE, DONE, NEEDS_INPUT, Store

log = logging.getLogger("jarvis.web")

MAX_AUDIO = 15 * 1024 * 1024
MAX_JSON = 64 * 1024


def goal_json(g, events: list[dict] | None = None) -> dict:
    d = {
        "id": g.id, "title": g.title, "status": g.status, "summary": g.summary,
        "done_criteria": g.done_criteria, "prompt": g.prompt,
        "spent_usd": round(g.spent_usd, 2), "budget_usd": g.budget_usd,
        "attempts": g.attempts, "max_attempts": g.max_attempts,
        "question": g.pending_question if g.status == "needs_input" else None,
        "pending_approvals": g.pending_approvals, "workspace": g.workspace, "updated": g.updated,
    }
    if events is not None:
        d["events"] = [{"ts": e["ts"], "kind": e["kind"], "text": e["text"][:2000]} for e in events]
    return d


def overview(cfg: Config, store: Store, user: str) -> dict:
    goals = store.list(None, limit=300)
    now = time.time()
    day = 86400
    active = [g for g in goals if g.status in ACTIVE]
    needs = [g for g in active if g.status == NEEDS_INPUT]
    recent = [g for g in goals if g.status not in ACTIVE][:12]
    done_7d = [g for g in goals if g.status == DONE and now - g.updated < 7 * day]
    import datetime as _dt
    today = _dt.date.today()
    days = []
    for i in range(13, -1, -1):
        d = today - _dt.timedelta(days=i)
        lo = _dt.datetime.combine(d, _dt.time()).timestamp()
        hi = lo + day
        days.append({"date": d.isoformat(),
                     "done": sum(1 for g in goals if g.status == DONE and lo <= g.updated < hi),
                     "spend": round(sum(g.spent_usd for g in goals if lo <= g.updated < hi), 2)})
    b = hq.latest(store)
    nxt = hq.next_slot(cfg)
    return {
        "user": user, "updated_ts": now, "hq_name": cfg.hq_name,
        "summary": {"needs_you": len(needs), "in_motion": len(active) - len(needs),
                    "done_7d": len(done_7d), "spend_7d": round(sum(d["spend"] for d in days[-7:]), 2),
                    "spend_today": days[-1]["spend"], "budget_default": cfg.default_budget_usd},
        "needs_you": [goal_json(g) for g in needs],
        "active": [goal_json(g) for g in active if g.status != NEEDS_INPUT],
        "recent": [goal_json(g) for g in recent],
        "chart": {"days": days},
        "hq": {"briefing": b, "running": hq.is_running(store) or store.kv_get("hq_requested") == "1",
               "next_at": nxt.timestamp() if nxt else None, "name": cfg.hq_name},
        "voice": {"server_tts": tts.use_elevenlabs(cfg), "engine": "elevenlabs" if tts.use_elevenlabs(cfg)
                  else "browser", "voice_name": cfg.voice_name},
        "status": router.spoken_status(store),
    }


def make_handler(cfg: Config, store: Store, allowed: set[str], transcribe=None):
    """Build the request handler. `transcribe(path) -> text` is injectable for tests."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "Jarvis"
        sys_version = ""

        def log_message(self, fmt, *args):  # route to logging, not stderr
            log.info("%s %s", self.address_string(), fmt % args)

        # --- helpers -----------------------------------------------------------
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                             "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _user(self) -> str | None:
            login = (self.headers.get("Tailscale-User-Login") or "").strip().lower()
            if not login or login not in allowed:
                return None
            return login

        def _auth(self) -> str | None:
            user = self._user()
            if user is None:
                self._json(403, {"error": "Open this through your tailnet (tailscale serve) as an "
                                          "allowed user."})
            return user

        def _same_origin(self) -> bool:
            origin = self.headers.get("Origin")
            if not origin:
                return True  # non-browser client; header auth still applies
            return urlparse(origin).netloc.lower() == (self.headers.get("Host") or "").lower()

        def _body(self, limit: int) -> bytes | None:
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                self._json(413, {"error": "too large"})
                return None
            return self.rfile.read(n) if n else b""

        def _goal_id(self, path: str) -> int | None:
            m = re.fullmatch(r"/api/goals/(\d+)(?:/\w+)?", path)
            return int(m.group(1)) if m else None

        # --- GET -----------------------------------------------------------------
        def do_GET(self):
            user = self._auth()
            if user is None:
                return
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                return self._send(200, PAGE.replace("{{USER}}", _esc(user)).encode(),
                                  "text/html; charset=utf-8")
            if path == "/api/overview":
                return self._json(200, overview(cfg, store, user))
            if path == "/api/hq":
                return self._json(200, {"briefing": hq.latest(store), "running": hq.is_running(store)})
            if path == "/api/goals":
                active = store.list(ACTIVE, limit=50)
                recent = [g for g in store.list(None, limit=30) if g.status not in ACTIVE][:15]
                return self._json(200, {"active": [goal_json(g) for g in active],
                                        "recent": [goal_json(g) for g in recent],
                                        "status": router.spoken_status(store)})
            gid = self._goal_id(path)
            if gid is not None and path == f"/api/goals/{gid}":
                g = store.get(gid)
                if not g:
                    return self._json(404, {"error": "no such goal"})
                return self._json(200, goal_json(g, store.events(gid, 120)))
            return self._json(404, {"error": "not found"})

        # --- POST ----------------------------------------------------------------
        def do_POST(self):
            user = self._auth()
            if user is None:
                return
            if not self._same_origin():
                return self._json(403, {"error": "cross-origin request refused"})
            path = urlparse(self.path).path
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()

            if path == "/api/voice":
                if not ctype.startswith("audio/"):
                    return self._json(415, {"error": "send audio/*"})
                raw = self._body(MAX_AUDIO)
                if raw is None:
                    return
                if not raw:
                    return self._json(400, {"error": "empty audio"})
                suffix = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
                          "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav"}.get(ctype, ".bin")
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as f:
                    f.write(raw)
                    f.flush()
                    try:
                        fn = transcribe or (lambda p: __import__("jarvis.voice", fromlist=["x"])
                                            .transcribe_file(cfg, p))
                        heard = (fn(f.name) or "").strip()
                    except Exception as e:
                        log.exception("transcription failed")
                        return self._json(500, {"error": f"transcription failed: {e}"})
                if not heard:
                    return self._json(200, {"heard": "", "reply": "I didn't catch that."})
                reply = anyio.run(router.handle, cfg, store, heard)
                store.log(None, "web", f"{user} (voice): {heard}")
                return self._json(200, {"heard": heard, "reply": reply, "speak": reply})

            if ctype != "application/json":
                return self._json(415, {"error": "send application/json"})
            raw = self._body(MAX_JSON)
            if raw is None:
                return
            try:
                data = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "bad json"})

            if path == "/api/say":
                text = str(data.get("text", "")).strip()
                if not text:
                    return self._json(400, {"error": "say something"})
                reply = anyio.run(router.handle, cfg, store, text)
                store.log(None, "web", f"{user}: {text}")
                return self._json(200, {"reply": reply, "speak": reply})

            if path == "/api/hq/refresh":
                hq.request(store)
                return self._json(200, {"reply": "Pulling a fresh HQ update. It takes a minute or two."})

            if path == "/api/tts":
                if not tts.use_elevenlabs(cfg):
                    return self._json(404, {"error": "no server voice configured"})
                text = str(data.get("text", "")).strip()[:2500]
                if not text:
                    return self._json(400, {"error": "no text"})
                try:
                    audio = tts.elevenlabs_mp3(cfg, text)
                except Exception as e:
                    log.warning("tts failed: %s", e)
                    return self._json(502, {"error": "voice service failed"})
                return self._send(200, audio, "audio/mpeg")

            gid = self._goal_id(path)
            if gid is None or not store.get(gid):
                return self._json(404, {"error": "no such goal"})
            action = path.rsplit("/", 1)[-1]
            if action == "answer":
                text = str(data.get("text", "")).strip()
                if not text:
                    return self._json(400, {"error": "empty answer"})
                g = store.answer(gid, f"{text}  (via web, {user})")
                return self._json(200, {"reply": f"Sent. Goal {gid} is {g.status}."})
            if action == "approve":
                return self._json(200, {"reply": router.approve(store, gid)})
            if action == "cancel":
                ok = store.cancel(gid)
                return self._json(200, {"reply": f"Cancelled goal {gid}." if ok else f"Goal {gid} isn't active."})
            return self._json(404, {"error": "unknown action"})

    return Handler


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def make_server(cfg: Config, store: Store, allowed: set[str], port: int | None = None,
                transcribe=None) -> ThreadingHTTPServer:
    if not allowed:
        raise SystemExit("No tailnet users allowed. Set tailscale_allowed_users in config.toml, "
                         "or run with Tailscale up so the machine owner is detected.")
    srv = ThreadingHTTPServer(("127.0.0.1", port if port is not None else cfg.web_port),
                              make_handler(cfg, store, allowed, transcribe))
    srv.daemon_threads = True
    return srv


async def run_web(cfg: Config, store: Store, allowed: set[str]) -> None:
    srv = make_server(cfg, store, allowed)
    log.info("dashboard on http://127.0.0.1:%s for %s", srv.server_address[1], ", ".join(sorted(allowed)))
    t = threading.Thread(target=srv.serve_forever, name="jarvis-web", daemon=True)
    t.start()
    try:
        await anyio.sleep_forever()
    finally:
        srv.shutdown()


PAGE = Path(__file__).with_name("dashboard.html").read_text(encoding="utf-8")
