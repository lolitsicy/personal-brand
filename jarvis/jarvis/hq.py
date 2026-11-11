"""HQ briefings: a read-only agent checks your business sources and reports back.

Runs on a schedule (hq_briefing_times) and on request ("Jarvis, brief me"). It uses whatever MCP
connectors your Claude Code has (Shopify, Meta Ads, Gmail, Calendar...), read-only: any tool that
would change something is denied, not queued for approval. A source it can't reach is reported
as unavailable, never guessed.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
from pathlib import Path

from . import policy
from .config import Config
from .store import Store

log = logging.getLogger("jarvis.hq")

BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One sentence: the single most important thing right now."},
        "spoken": {"type": "string", "description": "The briefing as Jarvis would say it aloud: 3-6 short "
                                                    "sentences, plain words, numbers rounded, no lists or markdown."},
        "sections": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "short id, e.g. sales, ads, inbox, calendar"},
                "title": {"type": "string"},
                "status": {"type": "string", "enum": ["ok", "attention", "unavailable"]},
                "value": {"type": "string", "description": "the headline figure, e.g. '$1,240' or '3 to reply'. "
                                                           "Empty if unavailable."},
                "delta": {"type": "string", "description": "change vs the comparison period, e.g. '+12% vs last "
                                                           "Tue', or empty"},
                "detail": {"type": "string", "description": "1-2 sentences of context, or why unavailable"},
                "source": {"type": "string", "description": "which tool/connector the figure came from"},
            },
            "required": ["key", "title", "status", "value", "delta", "detail", "source"],
            "additionalProperties": False,
        }},
    },
    "required": ["headline", "spoken", "sections"],
    "additionalProperties": False,
}

BRIEF_RULES = """\
You are Jarvis's HQ analyst, preparing a briefing for the owner. You are strictly read-only.

- Use only the connected tools (MCP servers) to get real figures. Never estimate, invent, or
  carry over numbers you didn't fetch in this session. If a source's tools aren't available or
  fail, mark that section "unavailable" and say why in one line.
- Mark "attention" for anything the owner should act on today (a drop in sales or ROAS,
  overspend, an urgent email, a clash in the calendar).
- Compare like with like (today so far vs the same time last week where possible) and say what
  you compared.
- Be brief. The owner hears the spoken version on their phone.
"""


def init_db(store: Store) -> None:
    with store._conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS briefings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, data TEXT NOT NULL,
            cost_usd REAL NOT NULL DEFAULT 0)""")


def latest(store: Store) -> dict | None:
    init_db(store)
    with store._conn() as c:
        row = c.execute("SELECT * FROM briefings ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return None
    return {"id": row["id"], "ts": row["ts"], **json.loads(row["data"])}


def save(store: Store, data: dict, cost: float = 0.0) -> dict:
    init_db(store)
    with store._conn() as c:
        cur = c.execute("INSERT INTO briefings (ts, data, cost_usd) VALUES (?,?,?)",
                        (time.time(), json.dumps(data), cost))
    return {"id": cur.lastrowid, "ts": time.time(), **data}


def request(store: Store) -> None:
    store.kv_set("hq_requested", "1")


def is_running(store: Store) -> bool:
    return store.kv_get("hq_running") == "1"


def slots(cfg: Config) -> list[dt.time]:
    out = []
    for s in cfg.hq_briefing_times.split(","):
        s = s.strip()
        if s:
            h, m = s.split(":")
            out.append(dt.time(int(h), int(m)))
    return sorted(out)


def next_slot(cfg: Config, now: dt.datetime | None = None) -> dt.datetime | None:
    now = now or dt.datetime.now()
    for day in (0, 1):
        for t in slots(cfg):
            cand = dt.datetime.combine(now.date() + dt.timedelta(days=day), t)
            if cand > now:
                return cand
    return None


def due(cfg: Config, store: Store, now: dt.datetime | None = None) -> bool:
    """True if a scheduled slot has passed today that hasn't been briefed yet, or one was requested."""
    if store.kv_get("hq_requested") == "1":
        return True
    now = now or dt.datetime.now()
    passed = [t for t in slots(cfg) if dt.datetime.combine(now.date(), t) <= now]
    if not passed:
        return False
    key = f"{now.date()}T{passed[-1].strftime('%H:%M')}"
    return store.kv_get("hq_last_slot") != key


def mark_slot(cfg: Config, store: Store, now: dt.datetime | None = None) -> None:
    now = now or dt.datetime.now()
    passed = [t for t in slots(cfg) if dt.datetime.combine(now.date(), t) <= now]
    if passed:
        store.kv_set("hq_last_slot", f"{now.date()}T{passed[-1].strftime('%H:%M')}")
    store.kv_set("hq_requested", "0")


async def run_briefing(cfg: Config, store: Store, runner=None, mcp_servers: dict | None = None) -> dict:
    """Run one briefing and store it. `runner(prompt, guard) -> (structured, cost)` is injectable."""
    store.kv_set("hq_running", "1")
    try:
        prompt = (f"# Briefing for {cfg.hq_name}\nLocal time: {dt.datetime.now():%A %d %B %Y, %H:%M}\n\n"
                  f"## What to check\n{cfg.hq_sources}")
        ws = cfg.home / "hq"
        ws.mkdir(parents=True, exist_ok=True)
        protected = [cfg.db_path, cfg.home / "config.toml", Path(__file__).resolve().parent]

        def guard(tool: str, args: dict) -> policy.Decision:
            d = policy.check(tool, args, ws, [], protected, read_only=True)
            if d.verdict == policy.APPROVE:  # briefings never wait for approval: just don't do it
                return policy.Decision(policy.DENY, d.reason + " (briefings are read-only)", d.key)
            return d

        if runner is None:
            structured, cost = await _sdk_brief(cfg, prompt, guard, ws, mcp_servers)
        else:
            structured, cost = await runner(cfg, prompt, guard, ws)
        if not structured:
            raise RuntimeError("the briefing agent returned nothing")
        b = save(store, structured, cost)
        store.log(None, "hq", b.get("headline", ""))
        return b
    finally:
        store.kv_set("hq_running", "0")
        mark_slot(cfg, store)


async def _sdk_brief(cfg: Config, prompt: str, guard, ws: Path, mcp_servers: dict | None = None):
    from claude_agent_sdk import (ClaudeAgentOptions, HookMatcher, PermissionResultAllow,
                                  PermissionResultDeny, ResultMessage, query)

    from .worker import _json_from

    async def pre_tool(inp, _id, _ctx):
        d = guard(inp["tool_name"], inp.get("tool_input") or {})
        if d.verdict == policy.ALLOW:
            return {}
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": f"Blocked: {d.reason}"}}

    async def can_use(tool, args, _ctx):  # tools not pre-allowed (e.g. MCP) are decided by policy
        d = guard(tool, args or {})
        return PermissionResultAllow() if d.verdict == policy.ALLOW else PermissionResultDeny(message=d.reason)

    opts = ClaudeAgentOptions(
        can_use_tool=can_use,
        cwd=str(ws), model=cfg.hq_model or cfg.worker_model, effort=cfg.hq_effort,
        system_prompt={"type": "preset", "preset": "claude_code", "append": BRIEF_RULES},
        permission_mode="default",
        disallowed_tools=["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
        setting_sources=["user", "project"],  # load the MCP servers you've added to Claude Code
        hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool])]},
        output_format={"type": "json_schema", "schema": BRIEF_SCHEMA},
        max_budget_usd=cfg.hq_budget_usd, max_turns=40,
        **({"mcp_servers": mcp_servers} if mcp_servers else {}),
    )
    out, cost = None, 0.0
    async for msg in query(prompt=prompt, options=opts):
        if isinstance(msg, ResultMessage):
            cost = msg.total_cost_usd or 0.0
            out = msg.structured_output or _json_from(msg.result)
    return out, cost
