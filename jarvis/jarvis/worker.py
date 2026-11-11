"""Runs one goal: work -> self-report -> independent verification -> repeat or stop.

The agent never decides on its own that it's finished. A second, fresh agent checks the
done-criteria against the actual workspace. Only a pass from the verifier counts as done.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from . import policy
from .config import Config
from .notify import Notifier
from .store import DONE, FAILED, NEEDS_INPUT, QUEUED, Goal, Store

log = logging.getLogger("jarvis.worker")

WORK_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["done", "needs_input", "failed"],
                   "description": "done = you believe every done-criterion is met; needs_input = "
                                  "you are blocked on a decision, credential, approval or fact only "
                                  "the owner has; failed = impossible as specified"},
        "summary": {"type": "string", "description": "What you did and the current state, 1-5 sentences."},
        "question": {"type": "string", "description": "If needs_input: one specific question for the "
                                                      "owner, with your recommended answer. Else empty."},
        "evidence": {"type": "string", "description": "Commands run / files produced that prove the "
                                                      "done-criteria are met."},
        "next_steps": {"type": "string", "description": "If done: up to 3 worthwhile follow-up goals the "
                                                        "owner might want, one per line. Else empty."},
    },
    "required": ["status", "summary", "question", "evidence", "next_steps"],
    "additionalProperties": False,
}

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "passed": {"type": "boolean"},
        "reasoning": {"type": "string", "description": "What you checked and what you found. "
                                                       "If failed: exactly what is missing or wrong."},
    },
    "required": ["passed", "reasoning"],
    "additionalProperties": False,
}

WORKER_RULES = """\
You are an autonomous worker in Jarvis, a home agent system. Nobody is watching this session live.

- Work until the goal's done-criteria are actually met, then stop. Do not pad the work.
- Check your own result by running it (tests, scripts, opening the file) before claiming done.
  An independent verifier will re-check every criterion; false "done" claims waste an attempt.
- Stay inside your working directory unless the goal says otherwise.
- Run anything that publishes, deletes outside your folder, or contacts other systems
  (git push, package publish, deploys, sending messages) as its own Bash call, never chained
  with other steps, so a block doesn't stop the rest of your work. Finish everything else first.
- If a tool call is blocked with "needs owner approval", do not try to get around it with a
  different command. Finish what you can, then return status needs_input and ask for approval,
  explaining why the action is needed.
- Ask (needs_input) only for things you truly cannot decide or obtain yourself: credentials,
  money, taste calls with no sensible default, irreversible public actions. For everything else,
  pick the sensible default, note it in the summary, and keep going.
- Your final answer must be the structured result.
"""

VERIFIER_RULES = """\
You are the verifier in Jarvis. A worker agent claims a goal is done. Your job is to check each
done-criterion yourself against the real files and by running commands. Do not trust the worker's
summary. Do not modify anything. Pass only if every criterion is met; partial is a fail.
"""


@dataclass
class RunResult:
    structured: dict | None
    cost_usd: float
    session_id: str | None
    subtype: str  # "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution"
    text: str = ""
    transcript: list[str] = field(default_factory=list)


class AgentRunner(Protocol):
    async def run(self, *, prompt: str, cwd: Path, model: str, effort: str, system_append: str,
                  schema: dict, budget_usd: float, max_turns: int, resume: str | None,
                  read_only: bool, guard, should_stop=None) -> RunResult: ...


def sandbox_settings(cfg: Config) -> dict | None:
    import platform
    import shutil
    mode = (cfg.sandbox or "auto").lower()
    if mode == "off":
        return None
    supported = platform.system() == "Darwin" or (
        platform.system() == "Linux" and shutil.which("bwrap") and shutil.which("socat"))
    if not supported:
        if mode == "on":
            raise RuntimeError("sandbox = 'on' but it isn't supported here. On Linux install "
                               "bubblewrap and socat (apt install bubblewrap socat).")
        log.warning("shell sandbox unavailable (Linux needs bubblewrap + socat); relying on policy only")
        return None
    domains = [d.strip() for d in cfg.sandbox_allowed_domains.split(",") if d.strip()]
    return {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False,
            "network": {"allowedDomains": domains}}


class SDKRunner:
    """Real runner on the Claude Agent SDK (Claude Code as a library)."""

    def __init__(self, sandbox: dict | None = None):
        self.sandbox = sandbox

    async def run(self, *, prompt, cwd, model, effort, system_append, schema, budget_usd,
                  max_turns, resume, read_only, guard, should_stop=lambda: False) -> RunResult:
        from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, HookMatcher,
                                      ResultMessage, TextBlock, ToolUseBlock, query)

        async def pre_tool(inp: dict, _tool_use_id, _ctx) -> dict:
            d = guard(inp["tool_name"], inp.get("tool_input") or {})
            if d.verdict == policy.ALLOW:
                return {}
            reason = (f"Blocked: {d.reason}. This needs owner approval."
                      if d.verdict == policy.APPROVE else f"Blocked permanently: {d.reason}.")
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                           "permissionDecision": "deny",
                                           "permissionDecisionReason": reason}}

        disallowed = ["Write", "Edit", "MultiEdit", "NotebookEdit"] if read_only else []
        opts = ClaudeAgentOptions(
            cwd=str(cwd),
            model=model,
            effort=effort,
            system_prompt={"type": "preset", "preset": "claude_code", "append": system_append},
            permission_mode="acceptEdits",
            allowed_tools=["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep",
                           "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookEdit"],
            disallowed_tools=disallowed,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool])]},
            output_format={"type": "json_schema", "schema": schema},
            max_budget_usd=max(budget_usd, 0.01),
            max_turns=max_turns,
            resume=resume,
            sandbox=self.sandbox,
        )
        res = RunResult(None, 0.0, resume, "error_during_execution")
        async for msg in query(prompt=prompt, options=opts):
            if should_stop():  # owner cancelled: abandoning the stream stops the CLI
                res.subtype = "cancelled"
                break
            if isinstance(msg, AssistantMessage):
                for b in msg.content:
                    if isinstance(b, TextBlock) and b.text.strip():
                        res.transcript.append(b.text.strip())
                    elif isinstance(b, ToolUseBlock):
                        res.transcript.append(f"→ {b.name} {_brief(b.input)}")
            elif isinstance(msg, ResultMessage):
                res.cost_usd = msg.total_cost_usd or 0.0
                res.session_id = msg.session_id or res.session_id
                res.subtype = msg.subtype
                res.text = msg.result or ""
                res.structured = msg.structured_output or _json_from(msg.result)
        return res


def _brief(d: Any, n: int = 200) -> str:
    s = json.dumps(d, ensure_ascii=False) if not isinstance(d, str) else d
    return s if len(s) <= n else s[: n - 1] + "…"


def _json_from(text: str | None) -> dict | None:
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "goal"


class Worker:
    def __init__(self, cfg: Config, store: Store, notifier: Notifier, runner: AgentRunner | None = None):
        self.cfg, self.store, self.notifier = cfg, store, notifier
        self.runner = runner or SDKRunner(sandbox_settings(cfg))

    def workspace_for(self, g: Goal) -> Path:
        if g.workspace:
            p = Path(g.workspace).expanduser()
        else:
            p = self.cfg.workspaces / f"{g.id:04d}-{_slug(g.title)}"
            self.store.update(g.id, workspace=str(p))
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _first_prompt(self, g: Goal, inbox: list[str]) -> str:
        parts = [f"# Goal #{g.id}: {g.title}\n\n{g.prompt}\n\n## Done when\n{g.done_criteria}"]
        if inbox:
            parts.append("## Notes from the owner\n" + "\n".join(f"- {m}" for m in inbox))
        return "\n\n".join(parts)

    async def run_goal(self, g: Goal) -> Goal:
        ws = self.workspace_for(g)
        store, gid = self.store, g.id

        while True:
            g = store.get(gid)
            if g.status != "running":  # cancelled underneath us
                return g
            if g.attempts >= g.max_attempts:
                return self._finish(g, FAILED, f"Gave up after {g.attempts} attempts. Last state: {g.summary}")
            if g.budget_left <= 0.01:
                return self._finish(g, FAILED, f"Budget of ${g.budget_usd:.2f} used up. Last state: {g.summary}")

            inbox_rows = store.peek_inbox(gid)
            inbox = [t for _, t in inbox_rows]
            if g.session_id:
                prompt = "Continue the goal.\n\n" + "\n".join(f"- {m}" for m in inbox) if inbox \
                    else "Continue the goal from where you stopped."
                if g.approvals:
                    prompt += ("\n\nThe owner approved these actions. Each may be run once, exactly "
                               "as written:\n" + "\n".join(f"- {a}" for a in g.approvals))
            else:
                prompt = self._first_prompt(g, inbox)

            pending: list[policy.Decision] = []
            protected = self.protected_paths()

            def guard(tool: str, args: dict) -> policy.Decision:
                d = policy.check(tool, args, ws, store.get(gid).approvals, protected)
                if d.via_approval:
                    store.use_approval(gid, d.key)
                elif d.verdict != policy.ALLOW:
                    pending.append(d)
                    store.log(gid, "blocked", f"{d.verdict}: {d.key} ({d.reason})")
                return d

            store.update(gid, attempts=g.attempts + 1)
            store.log(gid, "attempt", f"attempt {g.attempts + 1}/{g.max_attempts}, ${g.budget_left:.2f} left")
            try:
                r = await self.runner.run(
                    prompt=prompt, cwd=ws, model=self.cfg.worker_model, effort=self.cfg.worker_effort,
                    system_append=WORKER_RULES, schema=WORK_SCHEMA, budget_usd=g.budget_left,
                    max_turns=self.cfg.max_turns_per_attempt, resume=g.session_id, read_only=False,
                    guard=guard, should_stop=lambda: self._stopped(gid))
            except Exception as e:  # SDK/CLI crash: count the attempt, try again
                log.exception("worker crashed on goal %s", gid)
                store.log(gid, "error", f"worker crashed: {e!r}")
                continue

            store.add_spend(gid, r.cost_usd)
            store.consume_inbox([i for i, _ in inbox_rows])  # only now: a crash keeps your reply
            if r.subtype == "cancelled" or self._stopped(gid):
                return store.get(gid)
            for line in r.transcript[-40:]:
                store.log(gid, "agent", line)
            store.update(gid, session_id=r.session_id)
            out = r.structured or {}
            summary = out.get("summary") or r.text[-1500:] or f"(run ended: {r.subtype})"
            store.update(gid, summary=summary)

            if r.subtype == "error_max_budget_usd":
                g = store.get(gid)
                return self._finish(g, FAILED, f"Hit the ${g.budget_usd:.2f} budget. {summary}")
            if r.subtype == "error_max_turns" or not out:
                store.log(gid, "note", f"run ended without a result ({r.subtype}); continuing")
                continue

            status = out.get("status")
            approval_needed: dict[str, policy.Decision] = {}
            for d in pending:
                if d.verdict == policy.APPROVE:
                    approval_needed.setdefault(d.key, d)

            if status == "needs_input" or approval_needed:
                if approval_needed:
                    lines = "\n".join(f"  • {k}  — {d.reason}" for k, d in approval_needed.items())
                    q = (f"APPROVAL needed for:\n{lines}\n{out.get('question') or summary}\n"
                         f"Reply 'approve {gid}' to allow exactly these (once each), "
                         f"or answer with another instruction.")
                else:
                    q = out.get("question") or summary
                if not store.set_if_running(gid, status=NEEDS_INPUT, pending_question=q,
                                            pending_approvals=list(approval_needed),
                                            attempts=max(0, store.get(gid).attempts - 1)):
                    return store.get(gid)  # cancelled meanwhile
                store.log(gid, "question", q)
                self.notifier.send(f"Jarvis needs you — #{gid} {g.title}", f"{summary}\n\n❓ {q}", "high")
                return store.get(gid)

            if status == "failed":
                return self._finish(store.get(gid), FAILED, summary)

            # status == done -> independent check
            verdict = await self._verify(store.get(gid), ws, out)
            if verdict is None:
                continue
            if verdict.get("passed"):
                extra = f"\nVerified: {verdict.get('reasoning', '')}"
                if (out.get("next_steps") or "").strip():
                    extra += f"\n\nPossible next goals:\n{out['next_steps'].strip()}\n(Say one and I'll queue it.)"
                return self._finish(store.get(gid), DONE, summary, extra=extra)
            feedback = verdict.get("reasoning", "verifier rejected the result")
            store.log(gid, "verify_fail", feedback)
            store.post_inbox(gid, f"Verifier rejected 'done': {feedback}. Fix this.")

    def _stopped(self, gid: int) -> bool:
        g = self.store.get(gid)
        return g is None or g.status != "running"

    def protected_paths(self) -> list[Path]:
        pkg = Path(__file__).resolve().parent
        return [self.cfg.db_path, self.cfg.home / "config.toml", pkg]

    async def _verify(self, g: Goal, ws: Path, out: dict) -> dict | None:
        prompt = (f"# Goal #{g.id}: {g.title}\n\n{g.prompt}\n\n## Done-criteria to check\n{g.done_criteria}\n\n"
                  f"## Worker's claim\n{out.get('summary', '')}\n\nEvidence offered: {out.get('evidence', '')}")
        owner = [e["text"] for e in self.store.events(g.id, 500) if e["kind"] == "you"]
        if owner:
            prompt += "\n\n## What the owner told the worker (authoritative)\n" + \
                      "\n".join(f"- {m}" for m in owner)

        protected = self.protected_paths()

        def guard(tool, args):
            d = policy.check(tool, args, ws, [], protected, read_only=True)
            if d.verdict != policy.ALLOW:
                self.store.log(g.id, "verifier_blocked", f"{d.verdict}: {d.key} ({d.reason})")
            return d

        try:
            r = await self.runner.run(
                prompt=prompt, cwd=ws, model=self.cfg.verifier_model, effort="medium",
                system_append=VERIFIER_RULES, schema=VERIFY_SCHEMA,
                budget_usd=min(g.budget_left, max(0.5, g.budget_usd * 0.2)), max_turns=40,
                resume=None, read_only=True, guard=guard, should_stop=lambda: self._stopped(g.id))
        except Exception as e:
            self.store.log(g.id, "error", f"verifier crashed: {e!r}")
            return None
        self.store.add_spend(g.id, r.cost_usd)
        v = r.structured
        if not v or "passed" not in v:
            self.store.log(g.id, "error", f"verifier gave no verdict ({r.subtype})")
            return None
        self.store.log(g.id, "verify", f"{'PASS' if v['passed'] else 'FAIL'}: {v.get('reasoning', '')}")
        return v

    def _finish(self, g: Goal, status: str, summary: str, extra: str = "") -> Goal:
        if not self.store.set_if_running(g.id, status=status, summary=summary):
            return self.store.get(g.id)  # cancelled meanwhile: don't resurrect it
        self.store.log(g.id, status, summary + extra)
        g = self.store.get(g.id)
        icon = "✅" if status == DONE else "❌"
        self.notifier.send(
            f"{icon} #{g.id} {g.title} — {status}",
            f"{summary}{extra}\n\nSpent ${g.spent_usd:.2f} of ${g.budget_usd:.2f}. Files: {g.workspace}",
            "default" if status == DONE else "high")
        return g


__all__ = ["Worker", "SDKRunner", "RunResult", "AgentRunner", "QUEUED"]
