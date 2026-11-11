"""Configuration: defaults, overridable by ~/.jarvis/config.toml and env vars."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path


def _home() -> Path:
    return Path(os.environ.get("JARVIS_HOME", Path.home() / ".jarvis")).expanduser()


@dataclass
class Config:
    home: Path = field(default_factory=_home)

    # Models. Worker does the real work; router just classifies what you said.
    worker_model: str = "claude-opus-5-5"
    worker_effort: str = "high"
    verifier_model: str = "claude-opus-5-5"
    router_model: str = "claude-opus-5-5"
    router_effort: str = "low"

    # Guard rails
    default_budget_usd: float = 5.0  # total spend cap per goal, across all attempts
    max_attempts: int = 3  # work -> verify cycles before giving up
    max_turns_per_attempt: int = 150
    concurrency: int = 2  # goals running at once
    poll_seconds: float = 3.0
    # OS sandbox for the agent's shell commands (Claude Code's sandbox: bubblewrap on Linux,
    # Seatbelt on macOS). Blocks writes outside the workspace and network outside the allowlist,
    # which a command-pattern policy alone can't (e.g. `python -c` doing the same thing).
    sandbox: str = "on"  # on (refuse to run without it) | auto (warn and continue) | off
    sandbox_allowed_domains: str = ("pypi.org,files.pythonhosted.org,registry.npmjs.org,"
                                    "registry.yarnpkg.com,github.com,codeload.github.com,"
                                    "objects.githubusercontent.com,raw.githubusercontent.com,"
                                    "crates.io,static.crates.io,index.crates.io,proxy.golang.org")

    # Notifications
    ntfy_topic: str = ""  # e.g. "jarvis-<random>" -> install ntfy app, subscribe
    ntfy_server: str = "https://ntfy.sh"
    telegram_token: str = ""
    telegram_chat_id: str = ""  # only this chat may control Jarvis
    speak_notifications: bool = False  # say notifications out loud via TTS

    # Tailscale dashboard
    web_port: int = 8765  # dashboard listens on 127.0.0.1 only; tailscale serve fronts it
    tailscale_allowed_users: str = ""  # comma-separated tailnet logins; "" = this machine's owner
    public_url: str = ""  # set by `jarvis tailscale on`; used as the tap-through link in notifications

    # Voice
    whisper_model: str = "small.en"  # faster-whisper model for live speech
    whisper_device: str = "auto"  # auto | cpu | cuda
    wake_word: str = "hey_jarvis"  # openwakeword model name; "" = push-to-talk
    piper_voice: str = ""  # path to a piper .onnx voice; "" = espeak/say fallback

    @property
    def db_path(self) -> Path:
        return self.home / "jarvis.db"

    # Where goal folders go. Deliberately outside `home`, so `../..` from a workspace can't
    # reach the queue DB or config.
    workspaces_dir: str = ""

    # Recordings (jarvis ingest)
    whisperx_model: str = ""  # "" = same as whisper_model; large-v3 is best for recordings
    hf_token: str = ""  # HuggingFace token for speaker diarization

    @property
    def workspaces(self) -> Path:
        if self.workspaces_dir:
            return Path(self.workspaces_dir).expanduser()
        return self.home.parent / f"{self.home.name.lstrip('.')}-workspaces"

    @classmethod
    def load(cls) -> "Config":
        cfg = cls()
        path = cfg.home / "config.toml"
        data: dict = {}
        if path.exists():
            data = tomllib.loads(path.read_text())
        for f in fields(cls):
            if f.name == "home":
                continue
            env = os.environ.get(f"JARVIS_{f.name.upper()}")
            val = env if env is not None else data.get(f.name)
            if val is None:
                continue
            cur = getattr(cfg, f.name)
            if isinstance(cur, bool):
                val = val if isinstance(val, bool) else str(val).lower() in ("1", "true", "yes")
            elif isinstance(cur, int):
                val = int(val)
            elif isinstance(cur, float):
                val = float(val)
            setattr(cfg, f.name, val)
        cfg.home.mkdir(parents=True, exist_ok=True)
        cfg.workspaces.mkdir(parents=True, exist_ok=True)
        return cfg


SAMPLE_CONFIG = """\
# Jarvis config. Every key is optional; env vars JARVIS_<KEY> override.
worker_model = "claude-opus-5-5"
worker_effort = "high"
default_budget_usd = 5.0
max_attempts = 3
concurrency = 2

# Phone push: install the ntfy app and subscribe to this topic. Pick something unguessable.
ntfy_topic = ""

# Two-way phone control: create a bot with @BotFather, then run `jarvis telegram` and
# send it /start; it prints your chat id. Put both here.
telegram_token = ""
telegram_chat_id = ""

# Shell sandbox. "on" refuses to run agents without it (Linux: apt install bubblewrap socat;
# macOS: built in). "auto" warns and falls back to the command policy alone. Keep "on".
sandbox = "on"
# sandbox_allowed_domains = "pypi.org,files.pythonhosted.org,registry.npmjs.org,github.com"

# Tailscale dashboard (`jarvis tailscale on`). Only these tailnet logins may open it;
# empty = whoever owns this machine in Tailscale.
web_port = 8765
tailscale_allowed_users = ""

speak_notifications = false
whisper_model = "small.en"
wake_word = "hey_jarvis"
piper_voice = ""
"""
