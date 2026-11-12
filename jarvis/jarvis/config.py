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

    # Jarvis's voice, for both the phone dashboard and the desk speaker.
    # auto = ElevenLabs if you set a key, else Kokoro (free, local, natural) if installed,
    # else Piper if piper_voice is set, else the phone's own voice / espeak / say.
    tts_engine: str = "auto"  # auto | ane | kokoro | f5 | piper | elevenlabs | browser
    kokoro_voice: str = "bm_george"  # British male; also bm_daniel, bm_lewis, bm_fable, af_heart...
    kokoro_speed: float = 1.0
    kokoro_lang: str = "en-gb"
    # How to say words the voice gets wrong: "Word=phonetic; Other=…". Adjust by ear.
    tts_pronounce: str = "Maison Belasi=May-zon Beh-lah-see; Belasi=Beh-lah-see"
    kokoro_dir: str = ""  # "" = ~/.jarvis/kokoro (model files from `jarvis voices download`)
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "onwK4e9ZLuTAKqWW03F9"  # "Daniel": calm British male
    elevenlabs_model: str = "eleven_flash_v2_5"  # low latency
    voice_name: str = ""  # display name; "" = derived from the engine
    # F5-TTS voice cloning (Apple Silicon, via MLX). Set tts_engine = "f5" to use it; Kokoro is
    # the fallback if F5 fails or a reply is longer than f5_max_chars.
    f5_ref_audio: str = ""  # 5-10 s mono 24 kHz wav of the voice to copy (with the speaker's consent)
    f5_ref_text: str = ""  # exactly what is said in f5_ref_audio
    f5_model: str = "lucasnewman/f5-tts-mlx"
    f5_steps: int = 16  # 8 is about twice as fast, slightly rougher
    f5_speed: float = 1.0
    f5_seed: int = 7  # fixed so the voice sounds the same every time
    f5_max_chars: int = 400  # longer replies use Kokoro so you aren't kept waiting
    # Kokoro on the Apple Neural Engine (Core ML via FluidAudio, a long-running Swift helper). tts_engine = "ane":
    # ~5x faster than the ONNX Kokoro on an M1, same voices (kokoro_voice). Falls back to ONNX Kokoro on failure.
    ane_tts_bin: str = "~/.local/share/jarvis/src/jarvis-tts/.build/release/jarvis-tts"
    ane_version: str = "v3"  # v3 (newer hybrid pipeline) | legacy

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

# Jarvis's voice. Default: Kokoro, free and local (`jarvis voices download` once, ~350 MB).
# British male voices: bm_george, bm_daniel, bm_lewis, bm_fable.
tts_engine = "auto"
kokoro_voice = "bm_george"
# Fix how names are said (adjust by ear): "Word=phonetic; Other=..."
tts_pronounce = "Maison Belasi=May-zon Beh-lah-see; Belasi=Beh-lah-see"
# Optional paid upgrade: an ElevenLabs key takes over when set.
elevenlabs_api_key = ""
# elevenlabs_voice_id = "onwK4e9ZLuTAKqWW03F9"   # Daniel

speak_notifications = false
whisper_model = "small.en"
wake_word = "hey_jarvis"
piper_voice = ""
"""
