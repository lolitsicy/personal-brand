"""Get Jarvis's attention to you: terminal, phone push (ntfy), Telegram, voice."""

from __future__ import annotations

import logging

import httpx

from .config import Config

log = logging.getLogger("jarvis.notify")


class Notifier:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.extra = []  # callables(title, body) added at runtime, e.g. TTS in voice mode

    def send(self, title: str, body: str, priority: str = "default") -> None:
        print(f"\n🔔 {title}\n{body}\n", flush=True)
        if self.cfg.ntfy_topic:
            try:
                httpx.post(
                    f"{self.cfg.ntfy_server.rstrip('/')}/{self.cfg.ntfy_topic}",
                    content=body.encode(),
                    headers={"Title": title.encode("utf-8").decode("latin-1", "ignore"),
                             "Priority": priority, "Tags": "robot",
                             **({"Click": self.cfg.public_url} if self.cfg.public_url else {})},
                    timeout=10,
                )
            except httpx.HTTPError as e:
                log.warning("ntfy failed: %s", e)
        if self.cfg.telegram_token and self.cfg.telegram_chat_id:
            try:
                httpx.post(
                    f"https://api.telegram.org/bot{self.cfg.telegram_token}/sendMessage",
                    json={"chat_id": self.cfg.telegram_chat_id,
                          "text": (f"{title}\n\n{body}" + (f"\n\n{self.cfg.public_url}"
                                                            if self.cfg.public_url else ""))[:4000]},
                    timeout=10,
                )
            except httpx.HTTPError as e:
                log.warning("telegram failed: %s", e)
        if self.cfg.speak_notifications:
            from .tts import speak
            speak(self.cfg, title)
        for fn in self.extra:
            try:
                fn(title, body)
            except Exception as e:  # never let a notifier kill the daemon
                log.warning("notifier hook failed: %s", e)
