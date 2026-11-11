"""SQLite-backed goal queue. Safe for several processes (daemon, CLI, voice, bot)."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

QUEUED = "queued"
RUNNING = "running"
NEEDS_INPUT = "needs_input"
DONE = "done"
FAILED = "failed"
CANCELLED = "cancelled"
ACTIVE = (QUEUED, RUNNING, NEEDS_INPUT)

SCHEMA = """
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  done_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  workspace TEXT NOT NULL DEFAULT '',
  budget_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  session_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  pending_question TEXT,
  approvals TEXT NOT NULL DEFAULT '[]',
  pending_approvals TEXT NOT NULL DEFAULT '[]',
  created REAL NOT NULL,
  updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  ts REAL NOT NULL,
  text TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


@dataclass
class Goal:
    id: int
    title: str
    prompt: str
    done_criteria: str
    status: str
    workspace: str
    budget_usd: float
    spent_usd: float
    attempts: int
    max_attempts: int
    session_id: str | None
    summary: str
    pending_question: str | None
    approvals: list[str]
    pending_approvals: list[str]
    created: float
    updated: float

    @property
    def budget_left(self) -> float:
        return max(0.0, self.budget_usd - self.spent_usd)


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        try:
            yield conn
        finally:
            conn.close()

    @staticmethod
    def _goal(row: sqlite3.Row) -> Goal:
        d = dict(row)
        d["approvals"] = json.loads(d["approvals"])
        d["pending_approvals"] = json.loads(d["pending_approvals"])
        return Goal(**d)

    # --- goals -------------------------------------------------------------
    def add_goal(self, title: str, prompt: str, done_criteria: str, budget_usd: float,
                 max_attempts: int, workspace: str = "") -> Goal:
        now = time.time()
        with self._conn() as c:
            cur = c.execute(
                "INSERT INTO goals (title, prompt, done_criteria, budget_usd, max_attempts,"
                " workspace, created, updated) VALUES (?,?,?,?,?,?,?,?)",
                (title, prompt, done_criteria, budget_usd, max_attempts, workspace, now, now),
            )
            gid = cur.lastrowid
        self.log(gid, "created", f"{title} — done when: {done_criteria}")
        return self.get(gid)

    def get(self, goal_id: int) -> Goal | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM goals WHERE id=?", (goal_id,)).fetchone()
        return self._goal(row) if row else None

    def list(self, statuses: tuple[str, ...] | None = None, limit: int = 50) -> list[Goal]:
        q, args = "SELECT * FROM goals", []
        if statuses:
            q += f" WHERE status IN ({','.join('?' * len(statuses))})"
            args = list(statuses)
        q += " ORDER BY id DESC LIMIT ?"
        with self._conn() as c:
            return [self._goal(r) for r in c.execute(q, (*args, limit)).fetchall()]

    def update(self, goal_id: int, **fields) -> None:
        for k in ("approvals", "pending_approvals"):
            if k in fields:
                fields[k] = json.dumps(fields[k])
        fields["updated"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE goals SET {cols} WHERE id=?", (*fields.values(), goal_id))

    def add_spend(self, goal_id: int, usd: float) -> None:
        with self._conn() as c:
            c.execute("UPDATE goals SET spent_usd = spent_usd + ?, updated=? WHERE id=?",
                      (usd or 0.0, time.time(), goal_id))

    def claim_next(self) -> Goal | None:
        """Atomically move the oldest queued goal to running and return it."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute(
                "SELECT * FROM goals WHERE status=? ORDER BY id LIMIT 1", (QUEUED,)
            ).fetchone()
            if not row:
                c.execute("COMMIT")
                return None
            c.execute("UPDATE goals SET status=?, updated=? WHERE id=?",
                      (RUNNING, time.time(), row["id"]))
            c.execute("COMMIT")
        return self.get(row["id"])

    def recover_orphans(self) -> int:
        """Goals left 'running' by a crashed daemon go back to the queue."""
        with self._conn() as c:
            return c.execute("UPDATE goals SET status=? WHERE status=?", (QUEUED, RUNNING)).rowcount

    # --- human input -------------------------------------------------------
    def set_if_running(self, goal_id: int, **fields) -> bool:
        """Change a running goal; no-op (False) if it was cancelled meanwhile."""
        for k in ("approvals", "pending_approvals"):
            if k in fields:
                fields[k] = json.dumps(fields[k])
        fields["updated"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            n = c.execute(f"UPDATE goals SET {cols} WHERE id=? AND status=?",
                          (*fields.values(), goal_id, RUNNING)).rowcount
        return n == 1

    def cancel(self, goal_id: int) -> bool:
        with self._conn() as c:
            n = c.execute("UPDATE goals SET status=?, updated=? WHERE id=? AND status IN (?,?,?)",
                          (CANCELLED, time.time(), goal_id, *ACTIVE)).rowcount
        if n:
            self.log(goal_id, "cancelled", "cancelled by owner")
        return n == 1

    # --- human input -------------------------------------------------------
    def answer(self, goal_id: int, text: str, approve: bool = False) -> Goal:
        """Record your reply to a goal and put it back in the queue.

        approve=True grants every action the goal is currently blocked on (and only those).
        """
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT * FROM goals WHERE id=?", (goal_id,)).fetchone()
            if row is None:
                c.execute("ROLLBACK")
                raise KeyError(goal_id)
            g = self._goal(row)
            if approve and not g.pending_approvals:
                c.execute("ROLLBACK")
                raise ValueError(f"goal {goal_id} has no pending approval")
            fields: dict = {"pending_question": None, "pending_approvals": "[]", "updated": time.time()}
            if approve:
                fields["approvals"] = json.dumps([*g.approvals, *g.pending_approvals])
            if g.status in (NEEDS_INPUT, FAILED, DONE):
                fields["status"] = QUEUED
                if g.status != NEEDS_INPUT:  # reopening a finished goal grants fresh attempts
                    fields["attempts"] = 0
            cols = ", ".join(f"{k}=?" for k in fields)
            c.execute(f"UPDATE goals SET {cols} WHERE id=?", (*fields.values(), goal_id))
            c.execute("INSERT INTO inbox (goal_id, ts, text) VALUES (?,?,?)",
                      (goal_id, time.time(), text))
            c.execute("COMMIT")
        self.log(goal_id, "you", text + (f"  [approved: {'; '.join(g.pending_approvals)}]" if approve else ""))
        return self.get(goal_id)

    def post_inbox(self, goal_id: int, text: str) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO inbox (goal_id, ts, text) VALUES (?,?,?)",
                      (goal_id, time.time(), text))

    def peek_inbox(self, goal_id: int) -> list[tuple[int, str]]:
        with self._conn() as c:
            rows = c.execute("SELECT id, text FROM inbox WHERE goal_id=? AND consumed=0 ORDER BY id",
                             (goal_id,)).fetchall()
        return [(r["id"], r["text"]) for r in rows]

    def consume_inbox(self, ids: list[int]) -> None:
        if ids:
            with self._conn() as c:
                c.execute(f"UPDATE inbox SET consumed=1 WHERE id IN ({','.join('?' * len(ids))})", ids)

    def use_approval(self, goal_id: int, key: str) -> None:
        """Approvals are single-use: running the approved action spends it."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT approvals FROM goals WHERE id=?", (goal_id,)).fetchone()
            if row:
                a = json.loads(row["approvals"])
                if key in a:
                    a.remove(key)
                    c.execute("UPDATE goals SET approvals=? WHERE id=?", (json.dumps(a), goal_id))
            c.execute("COMMIT")
        self.log(goal_id, "approved_run", key)

    # --- events ------------------------------------------------------------
    def log(self, goal_id: int | None, kind: str, text: str) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO events (goal_id, ts, kind, text) VALUES (?,?,?,?)",
                      (goal_id, time.time(), kind, text[:20000]))

    def events(self, goal_id: int, limit: int = 200) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM events WHERE goal_id=? ORDER BY id DESC LIMIT ?",
                             (goal_id, limit)).fetchall()
        return [dict(r) for r in reversed(rows)]

    # --- small key/value state --------------------------------------------
    def kv_get(self, k: str, default: str | None = None) -> str | None:
        with self._conn() as c:
            row = c.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return row["v"] if row else default

    def kv_set(self, k: str, v: str) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                      (k, v))
