"""Turns anything you say (voice, Telegram, CLI) into an action on the queue."""

from __future__ import annotations

import json
import logging
import re

from .config import Config
from .store import ACTIVE, NEEDS_INPUT, Store

log = logging.getLogger("jarvis.router")

ROUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string",
                   "enum": ["new_goal", "answer", "approve", "cancel", "status", "chat"]},
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
- status: they ask what's going on.
- chat: anything else; just reply.

Replies are spoken aloud: short, plain, no markdown, no lists.
"""


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


async def classify(cfg: Config, store: Store, text: str) -> dict:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

    prompt = f"## Queue\n{queue_snapshot(store)}\n\n## Owner said\n{text}"
    opts = ClaudeAgentOptions(
        model=cfg.router_model, effort=cfg.router_effort, system_prompt=ROUTER_SYSTEM,
        tools=[], max_turns=3, max_budget_usd=0.5,
        output_format={"type": "json_schema", "schema": ROUTE_SCHEMA},
        cwd=str(cfg.home),
    )
    out = None
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


def _fast_path(cfg: Config, store: Store, text: str) -> str | None:
    """Commands that shouldn't cost a model call."""
    t = text.lower().strip(" .!?")
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
