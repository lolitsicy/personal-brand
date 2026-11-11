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

    # HQ briefings: what Jarvis checks and reports on
    hq_name: str = "Maison Belasi"
    hq_sources: str = (
        "- Sales (Shopify): orders and revenue today so far vs the same time last week; best seller; "
        "any order problems (unfulfilled > 48h, refunds).\n"
        "- Ads (Meta Ads): spend today and over the last 7 days, ROAS/CPA vs the prior 7 days, any "
        "ad set that's spending without results.\n"
        "- Inbox (Gmail): unread emails from the last 24h that need a reply from the owner "
        "(customers, suppliers, press); ignore newsletters and notifications.\n"
        "- Calendar (Google Calendar): what's left today and the first thing tomorrow.")
    hq_briefing_times: str = "08:30,13:00,18:30"  # local time; "" = only on request
    hq_model: str = ""  # "" = worker_model
    hq_effort: str = "medium"
    hq_budget_usd: float = 0.75  # per briefing

    # Jarvis's voice. auto = ElevenLabs if a key is set, else the phone's own voice in the browser
    # and Piper/espeak/say on the desk speaker.
    tts_engine: str = "auto"  # auto | elevenlabs | browser
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "onwK4e9ZLuTAKqWW03F9"  # "Daniel": calm British male
    elevenlabs_model: str = "eleven_flash_v2_5"  # low latency
    voice_name: str = "Daniel"

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

# HQ briefings. Jarvis checks these through the MCP connectors you've added to Claude Code
# (`claude mcp add ...`). Anything it can't reach is reported as unavailable, never guessed.
hq_name = "Maison Belasi"
hq_briefing_times = "08:30,13:00,18:30"
# hq_sources = '''
# - Sales (Shopify): ...
# '''

# Jarvis's voice. Best: an ElevenLabs key (natural, ~$5/mo plan covers daily briefings).
# Without one, your phone's built-in voice is used in the dashboard.
tts_engine = "auto"
elevenlabs_api_key = ""
# elevenlabs_voice_id = "onwK4e9ZLuTAKqWW03F9"   # Daniel

speak_notifications = false
whisper_model = "small.en"
wake_word = "hey_jarvis"
piper_voice = ""
"""
