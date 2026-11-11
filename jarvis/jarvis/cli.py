"""jarvis <command> — run `jarvis -h` for the list."""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys

import anyio

from .config import SAMPLE_CONFIG, Config
from .notify import Notifier
from .store import ACTIVE, Store


def _ctx():
    cfg = Config.load()
    return cfg, Store(cfg.db_path), Notifier(cfg)


def cmd_init(a):
    cfg = Config.load()
    p = cfg.home / "config.toml"
    if p.exists():
        print(f"{p} already exists")
    else:
        p.write_text(SAMPLE_CONFIG)
        print(f"Wrote {p}. Edit it to add ntfy/Telegram, then run `jarvis up`.")


def cmd_add(a):
    cfg, store, _ = _ctx()
    g = store.add_goal(a.title, a.prompt or a.title, a.done, a.budget or cfg.default_budget_usd,
                       a.attempts or cfg.max_attempts, a.workspace or "")
    print(f"Queued goal #{g.id}: {g.title}")


def cmd_list(a):
    _, store, _ = _ctx()
    goals = store.list(None if a.all else ACTIVE + ("done", "failed"), limit=a.n)
    if not goals:
        print("No goals.")
    for g in goals:
        when = dt.datetime.fromtimestamp(g.updated).strftime("%m-%d %H:%M")
        print(f"#{g.id:<4} {g.status:<12} ${g.spent_usd:>5.2f}/{g.budget_usd:<5.2f} {when}  {g.title}")
        if g.pending_question and g.status == "needs_input":
            print("       ❓ " + g.pending_question.replace("\n", "\n          "))


def cmd_show(a):
    _, store, _ = _ctx()
    g = store.get(a.id)
    if not g:
        sys.exit(f"No goal #{a.id}")
    print(f"#{g.id} {g.title} [{g.status}]  attempts {g.attempts}/{g.max_attempts}  "
          f"${g.spent_usd:.2f}/${g.budget_usd:.2f}\nworkspace: {g.workspace}\n\n{g.prompt}\n\n"
          f"Done when: {g.done_criteria}\n\nSummary: {g.summary}\n")
    if g.pending_question:
        print(f"❓ {g.pending_question}\n")
    for e in store.events(g.id, a.n):
        t = dt.datetime.fromtimestamp(e["ts"]).strftime("%H:%M:%S")
        print(f"{t} {e['kind']:<11} {e['text'][:500]}")


def cmd_answer(a):
    _, store, _ = _ctx()
    g = store.answer(a.id, " ".join(a.text))
    print(f"#{g.id} is {g.status}")


def cmd_approve(a):
    from .router import approve
    _, store, _ = _ctx()
    print(approve(store, a.id))


def cmd_cancel(a):
    _, store, _ = _ctx()
    print(f"Cancelled #{a.id}" if store.cancel(a.id) else f"#{a.id} isn't active")


def cmd_say(a):
    from .router import handle
    cfg, store, _ = _ctx()
    print(anyio.run(handle, cfg, store, " ".join(a.text)))


def cmd_daemon(a):
    from .daemon import run
    cfg, store, notifier = _ctx()
    print(f"Jarvis daemon running. DB: {cfg.db_path}. Ctrl-C to stop.")
    anyio.run(lambda: run(cfg, store, notifier, stop_when_idle=a.once))


def cmd_voice(a):
    from .voice import handle_file, run_voice
    cfg, store, notifier = _ctx()
    if a.file:
        print(anyio.run(handle_file, cfg, store, a.file))
    else:
        anyio.run(run_voice, cfg, store, notifier)


def cmd_ingest(a):
    from .ingest import ingest
    cfg, store, _ = _ctx()
    print(anyio.run(lambda: ingest(cfg, store, a.path, diarize=a.diarize)))


def cmd_telegram(a):
    from .telegram_bot import run_telegram
    cfg, store, _ = _ctx()
    anyio.run(run_telegram, cfg, store)


def cmd_up(a):
    """Daemon + Telegram (+ voice) in one process."""
    from .daemon import run
    cfg, store, notifier = _ctx()

    async def main():
        async with anyio.create_task_group() as tg:
            tg.start_soon(run, cfg, store, notifier)
            if cfg.telegram_token:
                from .telegram_bot import run_telegram
                tg.start_soon(run_telegram, cfg, store)
            if a.voice:
                from .voice import run_voice, speaking_notifier
                notifier.extra.append(speaking_notifier(cfg))
                tg.start_soon(run_voice, cfg, store, notifier)
    print(f"Jarvis is up. DB: {cfg.db_path}")
    anyio.run(main)


def main(argv=None):
    p = argparse.ArgumentParser(prog="jarvis", description="Autonomous goal runner")
    p.add_argument("-v", "--verbose", action="store_true")
    sp = p.add_subparsers(dest="cmd", required=True)

    sp.add_parser("init", help="write a sample ~/.jarvis/config.toml").set_defaults(f=cmd_init)

    s = sp.add_parser("add", help="queue a goal")
    s.add_argument("title")
    s.add_argument("--done", required=True, help="checkable done-criteria")
    s.add_argument("--prompt", help="full brief (defaults to the title)")
    s.add_argument("--budget", type=float, help="USD cap for this goal")
    s.add_argument("--attempts", type=int)
    s.add_argument("--workspace", help="existing folder to work in (default: new folder)")
    s.set_defaults(f=cmd_add)

    s = sp.add_parser("list", help="show goals")
    s.add_argument("--all", action="store_true")
    s.add_argument("-n", type=int, default=30)
    s.set_defaults(f=cmd_list)

    s = sp.add_parser("show", help="goal detail and log")
    s.add_argument("id", type=int)
    s.add_argument("-n", type=int, default=60)
    s.set_defaults(f=cmd_show)

    s = sp.add_parser("answer", help="reply to a goal's question")
    s.add_argument("id", type=int)
    s.add_argument("text", nargs="+")
    s.set_defaults(f=cmd_answer)

    s = sp.add_parser("approve", help="approve a blocked action")
    s.add_argument("id", type=int)
    s.set_defaults(f=cmd_approve)

    s = sp.add_parser("cancel")
    s.add_argument("id", type=int)
    s.set_defaults(f=cmd_cancel)

    s = sp.add_parser("say", help="talk to Jarvis in plain English (same path as voice)")
    s.add_argument("text", nargs="+")
    s.set_defaults(f=cmd_say)

    s = sp.add_parser("daemon", help="run the worker loop")
    s.add_argument("--once", action="store_true", help="exit when the queue is empty")
    s.set_defaults(f=cmd_daemon)

    s = sp.add_parser("voice", help="microphone loop (or --file to test with a wav)")
    s.add_argument("--file")
    s.set_defaults(f=cmd_voice)

    s = sp.add_parser("ingest", help="turn a recording into goals (WhisperX)")
    s.add_argument("path")
    s.add_argument("--diarize", action="store_true", help="label speakers (needs HF_TOKEN)")
    s.set_defaults(f=cmd_ingest)

    sp.add_parser("telegram", help="run the Telegram bot only").set_defaults(f=cmd_telegram)

    s = sp.add_parser("up", help="daemon + Telegram (+ --voice) together")
    s.add_argument("--voice", action="store_true")
    s.set_defaults(f=cmd_up)

    a = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    a.f(a)


if __name__ == "__main__":
    main()
