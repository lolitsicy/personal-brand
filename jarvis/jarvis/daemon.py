"""The always-on loop. Cheap when idle: it polls SQLite, not a model."""

from __future__ import annotations

import logging
import time

import anyio

from .config import Config
from .notify import Notifier
from .store import ACTIVE, QUEUED, Store
from .worker import AgentRunner, Worker

log = logging.getLogger("jarvis.daemon")

IDLE_NUDGE_AFTER = 60.0  # seconds of empty queue before asking for new work


def _single_instance(cfg: Config):
    """Two daemons would each 'recover' the other's running goals and run them twice."""
    import fcntl
    f = open(cfg.home / "daemon.lock", "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another Jarvis daemon is already running (lock: "
                         f"{cfg.home / 'daemon.lock'}).")
    return f


async def run(cfg: Config, store: Store, notifier: Notifier, runner: AgentRunner | None = None,
              stop_when_idle: bool = False) -> None:
    lock = _single_instance(cfg)  # noqa: F841  (held for the life of the daemon)
    if cfg.tts_engine == "ane":  # load the Neural Engine voice now, not on the first reply
        import threading

        from . import tts
        threading.Thread(target=tts.ane_warm, args=(cfg,), daemon=True, name="ane-warm").start()
    worker = Worker(cfg, store, notifier, runner)
    n = store.recover_orphans()
    if n:
        log.info("re-queued %d goals left running by a previous crash", n)
    sem = anyio.Semaphore(cfg.concurrency)
    running: set[int] = set()
    idle_since: float | None = None

    async def one(goal):
        try:
            await worker.run_goal(goal)
        except Exception as e:
            log.exception("goal %s crashed", goal.id)
            if store.set_if_running(goal.id, status="failed", summary=f"crashed: {e!r}"):
                notifier.send(f"❌ #{goal.id} crashed", repr(e), "high")
        finally:
            running.discard(goal.id)
            sem.release()

    from . import hq
    hq.init_db(store)
    store.kv_set("hq_running", "0")

    async def brief():
        try:
            b = await hq.run_briefing(cfg, store)
            body = b.get("spoken") or b.get("headline", "")
            attention = [s["title"] for s in b.get("sections", []) if s.get("status") == "attention"]
            notifier.send(f"HQ update{' — needs a look: ' + ', '.join(attention) if attention else ''}",
                          body, "high" if attention else "default")
        except Exception as e:
            log.exception("HQ briefing failed")
            notifier.send("HQ update failed", repr(e), "default")

    async with anyio.create_task_group() as tg:
        while True:
            if not stop_when_idle and not hq.is_running(store) and hq.due(cfg, store):
                store.kv_set("hq_running", "1")
                tg.start_soon(brief)
            # Fill free slots
            while sem.value > 0:
                await sem.acquire()
                g = store.claim_next()
                if g is None:
                    sem.release()
                    break
                running.add(g.id)
                log.info("starting goal #%s %s", g.id, g.title)
                tg.start_soon(one, g)

            if stop_when_idle and not running and not store.list((QUEUED,), limit=1):
                return
            active = store.list(ACTIVE, limit=1)
            if not active and not running:
                idle_since = idle_since or time.time()
                if (time.time() - idle_since > IDLE_NUDGE_AFTER
                        and store.kv_get("idle_nudged") != "1"):
                    notifier.send("Jarvis is idle",
                                  "Everything in the queue is finished. What should I work on next?")
                    store.kv_set("idle_nudged", "1")
            else:
                idle_since = None
                store.kv_set("idle_nudged", "0")
            await anyio.sleep(cfg.poll_seconds)
