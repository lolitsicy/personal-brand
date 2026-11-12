"""Turns anything you say (voice, Telegram, CLI) into an action on the queue."""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

import anyio

from .config import Config
from .store import ACTIVE, NEEDS_INPUT, Store

log = logging.getLogger("jarvis.router")

ROUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string",
                   "enum": ["new_goal", "answer", "approve", "cancel", "status", "briefing", "chat"]},
        "goal_id": {"type": "integer", "description": "Target goal for answer/approve/cancel/status; 0 if none."},
        "title": {"type": "string", "description": "new_goal: short title (≤8 words)."},
        "prompt": {"type": "string", "description": "new_goal: full brief for an autonomous agent, "
                                                    "including any context the owner gave."},
        "done_criteria": {"type": "string", "description": "new_goal: concrete, checkable conditions "
                                                           "(files exist, command output, tests pass). "
                                                           "Never vague."},
        "budget_usd": {"type": "number", "description": "new_goal: spend cap if the owner named one, else 0."},
        "answer_text": {"type": "string", "description": "answer: the owner's reply, cleaned up."},
        "reply": {"type": "string", "description": "What Jarvis says back. One or two short spoken sentences."},
    },
    "required": ["action", "goal_id", "title", "prompt", "done_criteria", "budget_usd",
                 "answer_text", "reply"],
    "additionalProperties": False,
}

ROUTER_SYSTEM = """\
You are the front desk of Jarvis, a home assistant that runs autonomous agents on goals.
You get one utterance from the owner (often speech-to-text, so expect transcription errors) plus
the current queue. Decide the single action:

- new_goal: the owner wants something done. Write a self-contained brief and concrete
  done-criteria an independent checker could verify in a workspace folder. If the request is
  too vague to define "done", still create the goal but make the first criterion
  "a written plan in PLAN.md the owner can approve" rather than inventing scope.
- answer: the owner is replying to a waiting question (match it to the right goal_id).
- approve: the owner approves a pending APPROVAL request.
- cancel: stop a goal.
- status: they ask what Jarvis itself is working on.
- briefing: they want a business update (sales, ads, inbox, calendar, "brief me", "how's the
  business"). Speech-to-text often garbles short commands ("breathe me", "brief meet") — if it
  plausibly means "brief me", choose briefing rather than asking.
- chat: anything else; just reply. For questions that need current information (weather,
  news, prices, opening hours, sports scores, facts you're unsure of), use web search first and
  answer from what you find. You do have web search; never say you lack permission for it.

Replies are spoken aloud: short, plain, no markdown, no lists.
"""


ROUTER_SEARCH_TOOLS = ["WebSearch", "mcp__keenable__search_web_pages",
                       "mcp__keenable__fetch_page_content"]


def queue_snapshot(store: Store) -> str:
    goals = store.list(ACTIVE, limit=20)
    if not goals:
        return "Queue is empty."
    lines = []
    for g in goals:
        line = f"#{g.id} [{g.status}] {g.title} (${g.spent_usd:.2f}/${g.budget_usd:.2f})"
        if g.status == NEEDS_INPUT and g.pending_question:
            line += f"\n   waiting on owner: {g.pending_question[:400]}"
        lines.append(line)
    return "\n".join(lines)


def _search_servers() -> dict:
    """The user's Keenable MCP server entry (from ~/.claude.json, read at run time; never copied anywhere)."""
    try:
        servers = json.loads((Path.home() / ".claude.json").read_text()).get("mcpServers") or {}
    except (OSError, ValueError):
        return {}
    k = servers.get("keenable")
    return {"keenable": k} if isinstance(k, dict) else {}


class _Session:
    """One long-lived Claude Code process for the router, on its own event-loop thread (each web request runs
    in its own anyio.run, so the client can't live in any one of them). Serialised by a lock; reconnects when
    the options change, after cfg.router_session_turns replies, or after an error."""

    def __init__(self):
        import threading
        self.lock = threading.Lock()
        self.portal = None
        self._portal_cm = None
        self.client = None
        self.key = None
        self.turns = 0

    def _ensure_portal(self):
        if self.portal is None:
            import atexit

            from anyio.from_thread import start_blocking_portal
            self._portal_cm = start_blocking_portal()
            self.portal = self._portal_cm.__enter__()
            atexit.register(self.close)

    async def _drop(self):
        c, self.client, self.key, self.turns = self.client, None, None, 0
        if c is not None:
            try:
                await c.disconnect()
            except Exception:  # noqa: BLE001
                pass

    async def _ask(self, opts, key, prompt: str, max_turns: int):
        from claude_agent_sdk import ClaudeSDKClient, ResultMessage
        if self.client is None or self.key != key or self.turns >= max_turns:
            await self._drop()
            c = ClaudeSDKClient(opts)
            await c.connect()
            self.client, self.key = c, key
        try:
            await self.client.query(prompt)
            out = None
            async for msg in self.client.receive_response():
                if isinstance(msg, ResultMessage):
                    out = msg.structured_output
                    if out is None and msg.result:
                        m = re.search(r"\{.*\}", msg.result, re.S)
                        out = json.loads(m.group(0)) if m else None
            self.turns += 1
            return out
        except BaseException:
            await self._drop()
            raise

    def ask(self, opts, key, prompt: str, max_turns: int):
        with self.lock:
            self._ensure_portal()
            return self.portal.call(self._ask, opts, key, prompt, max_turns)

    def close(self):
        try:
            if self.portal is not None:
                self.portal.call(self._drop)
                self._portal_cm.__exit__(None, None, None)
        except Exception:  # noqa: BLE001
            pass
        self.portal = self._portal_cm = None


_session = _Session()


async def classify(cfg: Config, store: Store, text: str) -> dict:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

    where = f"\n\n## Owner's location\n{cfg.home_city} (use it for weather and local questions)" if cfg.home_city else ""
    prompt = f"## Queue\n{queue_snapshot(store)}{where}\n\n## Owner said\n{text}"
    opts = ClaudeAgentOptions(
        model=cfg.router_model, effort=cfg.router_effort, system_prompt=ROUTER_SYSTEM,
        # Read-only web search so chat can answer live questions (weather, news, facts).
        # Built-in WebSearch isn't available on every account; Keenable MCP covers that case.
        tools=["WebSearch"], allowed_tools=ROUTER_SEARCH_TOOLS, max_turns=6, max_budget_usd=0.5,
        output_format={"type": "json_schema", "schema": ROUTE_SCHEMA},
        cwd=str(cfg.home),
        # Speed: every reply starts a fresh Claude Code process. Skip the user's settings (plugins, hooks,
        # CLAUDE.md) and every MCP server except the web search one: ~2 s less per reply.
        setting_sources=[], mcp_servers=_search_servers(), extra_args={"strict-mcp-config": None},
    )
    out = None
    if cfg.router_persistent:
        key = (cfg.router_model, cfg.router_effort)
        try:
            out = await anyio.to_thread.run_sync(_session.ask, opts, key, prompt, max(1, cfg.router_session_turns))
            if out:
                return out
        except Exception as e:  # noqa: BLE001 - fall back to a one-off process
            log.warning("router session failed, using a one-off call: %s", e)
    async for msg in query(prompt=prompt, options=opts):
        if isinstance(msg, ResultMessage):
            out = msg.structured_output
            if out is None and msg.result:
                m = re.search(r"\{.*\}", msg.result, re.S)
                out = json.loads(m.group(0)) if m else None
    if not out:
        raise RuntimeError("router returned no decision")
    return out


def apply(cfg: Config, store: Store, d: dict) -> str:
    """Execute a routed decision. Returns what Jarvis should say."""
    action, gid = d.get("action"), int(d.get("goal_id") or 0)
    reply = d.get("reply") or "Okay."
    if action == "new_goal":
        budget = float(d.get("budget_usd") or 0) or cfg.default_budget_usd
        g = store.add_goal(d["title"] or d["prompt"][:60], d["prompt"], d["done_criteria"],
                           budget, cfg.max_attempts)
        return f"{reply} It's goal {g.id}."
    if action in ("answer", "approve", "cancel", "status") and gid and not store.get(gid):
        return f"I don't have a goal {gid}."
    if action == "answer" and gid:
        store.answer(gid, d.get("answer_text") or "", approve=False)
        return reply
    if action == "approve":
        if not gid:  # approve the only pending approval if unambiguous
            waiting = [g for g in store.list((NEEDS_INPUT,)) if g.pending_approvals]
            if len(waiting) != 1:
                return "Which goal should I approve? Say approve and the goal number."
            gid = waiting[0].id
        return approve(store, gid)
    if action == "cancel" and gid:
        return f"Cancelled goal {gid}." if store.cancel(gid) else f"Goal {gid} isn't active."
    if action == "status":
        return reply
    if action == "briefing":
        return _fast_path(cfg, store, "brief me") or reply
    return reply


async def handle(cfg: Config, store: Store, text: str) -> str:
    """One utterance in, one spoken reply out."""
    text = text.strip()
    if not text:
        return ""
    fast = _fast_path(cfg, store, text)
    if fast is not None:
        return fast
    try:
        d = await classify(cfg, store, text)
    except Exception as e:
        log.exception("router failed")
        return f"Sorry, I couldn't process that: {e}"
    store.log(None, "router", json.dumps({"heard": text, **d})[:4000])
    return apply(cfg, store, d)


BRIEF_RE = re.compile(
    r"^(?:hey jarvis[, ]*)?(?:brief me|briefing|give me (?:an |the |my )?(?:update|briefing|rundown)|"
    r"(?:any |an )?updates?|what'?s (?:happening|new|going on) (?:at|with|in) (?:hq|the business|the store|"
    r"maison belasi|mb)|how(?:'s| is| are) (?:hq|the business|the store|sales|maison belasi)(?: doing| going)?|"
    r"hq (?:update|status|briefing))(?: please)?$")
FRESH_SECONDS = 20 * 60


def _fast_path(cfg: Config, store: Store, text: str) -> str | None:
    """Commands that shouldn't cost a model call."""
    t = text.lower().strip(" .!?")
    if BRIEF_RE.match(t):
        from . import hq
        b = hq.latest(store)
        if b and time.time() - b["ts"] < FRESH_SECONDS:
            return b.get("spoken") or b.get("headline") or "Nothing new at HQ."
        hq.request(store)
        lead = (f"Last update {int((time.time() - b['ts']) // 60)} minutes ago: {b.get('headline', '')} "
                if b else "")
        return lead + "I'm pulling a fresh HQ update now. I'll tell you when it's ready."
    m = re.fullmatch(r"(?:approve|approved)(?: goal)? #?(\d+)", t)
    if m:
        gid = int(m.group(1))
        if not store.get(gid):
            return f"I don't have a goal {gid}."
        return approve(store, gid)
    m = re.fullmatch(r"cancel(?: goal)? #?(\d+)", t)
    if m:
        gid = int(m.group(1))
        if not store.get(gid):
            return f"I don't have a goal {gid}."
        return f"Cancelled goal {gid}." if store.cancel(gid) else f"Goal {gid} isn't active."
    if t in ("status", "what's going on", "whats going on", "what are you working on"):
        return spoken_status(store)
    return None


def approve(store: Store, gid: int) -> str:
    """Grant exactly what goal `gid` is blocked on, and say what that was."""
    g = store.get(gid)
    if not g or not g.pending_approvals:
        return f"Goal {gid} isn't waiting for an approval."
    keys = g.pending_approvals
    store.answer(gid, "Approved. Go ahead with exactly the approved actions.", approve=True)
    what = "; ".join(k.removeprefix("Bash: ") for k in keys)
    return f"Approved for goal {gid}, once: {what}"


def spoken_status(store: Store) -> str:
    goals = store.list(ACTIVE, limit=10)
    if not goals:
        return "Nothing in the queue. What should I work on?"
    parts = []
    for g in goals:
        s = {"queued": "is queued", "running": "is running", "needs_input": "needs your input"}[g.status]
        parts.append(f"Goal {g.id}, {g.title}, {s}")
    return ". ".join(parts) + "."
