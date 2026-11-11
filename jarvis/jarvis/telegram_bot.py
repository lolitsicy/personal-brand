"""Telegram front end: long-polls the Bot API with httpx; text and voice notes go to the router.

Only `telegram_chat_id` may talk to Jarvis. With no chat id configured the bot answers /start with
the sender's chat id (so you can configure it) and ignores everything else.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from . import router
from .config import Config
from .store import ACTIVE, Store

log = logging.getLogger("jarvis.telegram")

API = "https://api.telegram.org"
OFFSET_KEY = "tg_offset"
POLL_TIMEOUT = 50  # seconds Telegram holds a getUpdates request open
MAX_MESSAGE = 4000  # Telegram's hard limit is 4096
HELP = ("Talk to me in plain English, or send a voice note.\n"
        "/status - what's running\n/goals - active goals\n"
        "Replies like 'approve 3' or 'cancel 3' work too.")


# --- pure helpers ------------------------------------------------------------
@dataclass
class Incoming:
    update_id: int
    chat_id: str
    text: str = ""
    voice_file_id: str = ""  # voice note or audio file to transcribe
    sender: str = ""


def parse_update(update: dict) -> Incoming | None:
    """Pull out what we care about from a getUpdates entry. None for non-message updates."""
    msg = update.get("message") or update.get("edited_message")
    if not isinstance(msg, dict) or "chat" not in msg:
        return None
    media = msg.get("voice") or msg.get("audio") or {}
    sender = msg.get("from") or {}
    return Incoming(
        update_id=int(update.get("update_id", 0)),
        chat_id=str(msg["chat"].get("id", "")),
        text=(msg.get("text") or msg.get("caption") or "").strip(),
        voice_file_id=media.get("file_id", "") if isinstance(media, dict) else "",
        sender=sender.get("username") or sender.get("first_name") or "",
    )


def is_authorized(cfg: Config, chat_id: str | int) -> bool:
    allowed = str(cfg.telegram_chat_id or "").strip()
    return bool(allowed) and str(chat_id).strip() == allowed


def parse_command(text: str) -> tuple[str, str] | None:
    """'/status@JarvisBot now' -> ('status', 'now'). None if not a command."""
    if not text.startswith("/"):
        return None
    head, _, rest = text.partition(" ")
    return head[1:].split("@", 1)[0].lower(), rest.strip()


def next_offset(updates: list[dict], current: int) -> int:
    ids = [int(u.get("update_id", 0)) for u in updates]
    return max([current, *(i + 1 for i in ids)])


def format_goals(goals) -> str:
    if not goals:
        return "No active goals."
    lines = []
    for g in goals:
        line = f"#{g.id} [{g.status}] {g.title} (${g.spent_usd:.2f}/${g.budget_usd:.2f})"
        if g.pending_question:
            line += f"\n   ❓ {g.pending_question[:300]}"
        lines.append(line)
    return "\n".join(lines)


def chunks(text: str, size: int = MAX_MESSAGE) -> list[str]:
    text = text or "…"
    return [text[i:i + size] for i in range(0, len(text), size)]


def redact(s: str, token: str) -> str:
    return s.replace(token, "<token>") if token else s


# --- Bot API client ----------------------------------------------------------
class TelegramAPI:
    def __init__(self, token: str, client: httpx.AsyncClient | None = None):
        self.token = token
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(POLL_TIMEOUT + 20))

    async def call(self, method: str, **params) -> object:
        r = await self.client.post(f"{API}/bot{self.token}/{method}", json=params)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"telegram {method} failed: {data.get('description', r.status_code)}")
        return data.get("result")

    async def get_updates(self, offset: int, timeout: int = POLL_TIMEOUT) -> list[dict]:
        return await self.call("getUpdates", offset=offset, timeout=timeout,
                               allowed_updates=["message", "edited_message"]) or []

    async def send_message(self, chat_id: str, text: str) -> None:
        for part in chunks(text):
            await self.call("sendMessage", chat_id=chat_id, text=part)

    async def typing(self, chat_id: str) -> None:
        try:
            await self.call("sendChatAction", chat_id=chat_id, action="typing")
        except Exception:  # noqa: BLE001 - cosmetic
            pass

    async def download(self, file_id: str, dst: Path) -> Path:
        info = await self.call("getFile", file_id=file_id)
        r = await self.client.get(f"{API}/file/bot{self.token}/{info['file_path']}")
        r.raise_for_status()
        dst.write_bytes(r.content)
        return dst

    async def aclose(self) -> None:
        await self.client.aclose()


# --- message handling --------------------------------------------------------
async def transcribe_voice(cfg: Config, api: TelegramAPI, file_id: str) -> str:
    import anyio

    from .voice import transcribe_file

    with tempfile.TemporaryDirectory() as td:
        path = await api.download(file_id, Path(td) / "voice.oga")
        return await anyio.to_thread.run_sync(transcribe_file, cfg, path)


async def reply_for(cfg: Config, store: Store, api: TelegramAPI, m: Incoming) -> str | None:
    """Decide the reply to one message. None means stay silent."""
    if not is_authorized(cfg, m.chat_id):
        if not str(cfg.telegram_chat_id or "").strip() and (parse_command(m.text) or ("",))[0] == "start":
            print(f"Telegram chat id for {m.sender or 'sender'}: {m.chat_id}", flush=True)
            return (f"Your chat id is {m.chat_id} — put it in {cfg.home / 'config.toml'} as "
                    f'telegram_chat_id = "{m.chat_id}" and restart Jarvis.')
        log.warning("ignoring message from unauthorized chat %s (%s)", m.chat_id, m.sender)
        return None

    if m.voice_file_id:
        await api.typing(m.chat_id)
        try:
            heard = await transcribe_voice(cfg, api, m.voice_file_id)
        except Exception as e:  # noqa: BLE001 - e.g. voice extras not installed
            log.exception("voice note failed")
            return f"I couldn't transcribe that voice note: {redact(str(e), api.token)}"
        if not heard:
            return "I couldn't hear anything in that voice note."
        await api.typing(m.chat_id)
        return f"🎙 Heard: “{heard}”\n\n{await router.handle(cfg, store, heard)}"

    cmd = parse_command(m.text)
    if cmd:
        name, args = cmd
        if name in ("start", "help"):
            return HELP
        if name == "status":
            return router.spoken_status(store)
        if name == "goals":
            return format_goals(store.list(ACTIVE, limit=30))
        text = f"{name} {args}".strip()  # e.g. /approve 3 -> "approve 3"
    else:
        text = m.text
    if not text:
        return None
    await api.typing(m.chat_id)
    return await router.handle(cfg, store, text)


async def process_update(cfg: Config, store: Store, api: TelegramAPI, update: dict) -> None:
    m = parse_update(update)
    if m is None:
        return
    try:
        reply = await reply_for(cfg, store, api, m)
    except Exception as e:  # noqa: BLE001 - one bad message must not kill the bot
        log.exception("telegram message failed")
        reply = f"Something went wrong: {redact(str(e), api.token)}" if is_authorized(cfg, m.chat_id) else None
    if reply:
        try:
            await api.send_message(m.chat_id, reply)
        except Exception as e:  # noqa: BLE001
            log.warning("sendMessage failed: %s", redact(str(e), api.token))


async def run_telegram(cfg: Config, store: Store, api: TelegramAPI | None = None,
                       max_polls: int | None = None) -> None:
    """Long-poll forever (or `max_polls` times, for tests)."""
    import anyio

    if not cfg.telegram_token:
        raise RuntimeError(f"telegram_token is not set in {cfg.home / 'config.toml'}")
    # httpx logs every request URL at INFO, and the URL contains the bot token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    api = api or TelegramAPI(cfg.telegram_token)
    if not cfg.telegram_chat_id:
        print("Telegram: no telegram_chat_id configured. Send /start to your bot to get it.", flush=True)
    offset = int(store.kv_get(OFFSET_KEY, "0") or 0)
    backoff = 1.0
    polls = 0
    try:
        while max_polls is None or polls < max_polls:
            polls += 1
            try:
                updates = await api.get_updates(offset)
                backoff = 1.0
            except (httpx.HTTPError, RuntimeError, ValueError) as e:
                log.warning("getUpdates failed: %s", redact(str(e), cfg.telegram_token))
                await anyio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue
            for u in updates:
                # Advance first so a message that crashes us is not replayed forever.
                offset = next_offset([u], offset)
                store.kv_set(OFFSET_KEY, str(offset))
                await process_update(cfg, store, api, u)
    finally:
        await api.aclose()
