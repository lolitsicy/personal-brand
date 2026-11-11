# Jarvis

A home assistant that takes goals (typed, spoken, or sent from your phone), works on them with
autonomous Claude agents until they are **independently verified** done, and only interrupts you
when it actually needs a decision, an approval, or a new goal.

```
 you ──voice / Telegram / CLI──▶ router ──▶ goal queue (SQLite)
                                               │
                         daemon picks up goals ▼
                  ┌──────────── worker agent (Claude Agent SDK) ─────────────┐
                  │  works in its own folder · shell sandboxed · policy-gated │
                  └──────────────┬──────────────────────────────────────────┘
                     claims done │            blocked / needs a decision
                                 ▼                          │
                  verifier agent (fresh, read-only)         ▼
                   pass ─▶ ✅ notify + suggest next    ❓ ask you (push / Telegram / voice)
                   fail ─▶ feedback back to worker        your reply ─▶ resumes same session
```

## What it does and doesn't do

- **"Done" means verified.** Each goal has checkable done-criteria. When the worker says it's
  finished, a second agent with no edit tools checks every criterion against the real files.
  If anything fails, the worker gets the verifier's findings and tries again. After
  `max_attempts` failed rounds, the goal is marked failed.
- **Hard spend cap per goal** (`default_budget_usd`, $5 by default), enforced by the SDK.
- **It asks only when it has to.** Credentials, money, taste calls with no sensible default, and
  anything in the approval list below. Everything else it decides itself and notes in the summary.
- **It never runs constantly for nothing.** When idle, the daemon polls SQLite (free), not a
  model. When the queue empties it pings you once: *"What should I work on next?"* Finished
  goals come with suggested follow-up goals.
- **It is not a general life-automation magic box.** Goals with no checkable outcome
  ("grow my brand") get turned into "write a plan in PLAN.md for you to approve" rather than
  open-ended flailing.

## Safety model (read this before giving it real access)

Two layers, because neither is enough alone:

1. **OS sandbox** (Claude Code's bash sandbox: bubblewrap on Linux, Seatbelt on macOS). Shell
   commands can only write inside the goal's workspace (plus temp dirs). Outbound network is
   limited to `sandbox_allowed_domains` (package registries + GitHub by default). This is what
   stops `python -c "..."`-style workarounds that no command filter can catch. On Linux:
   `sudo apt install bubblewrap socat`. The default `sandbox = "on"` refuses to run agents
   without it. `"auto"` warns and falls back to the policy alone. Don't use that on a machine you
   care about.
2. **Action policy** (`jarvis/policy.py`). Every tool call is classified:
   - **deny**: `rm -rf /`, formatting disks, shutdown, and similar.
   - **needs your approval**: `git push`, publishing packages, `sudo`, ssh/scp, cloud CLIs,
     POST/PUT/DELETE with curl, `curl | sh`, email, crontab/systemctl, reading `~/.ssh` or `~/.aws`,
     deleting or writing outside the workspace, and **any MCP tool that isn't a read**
     (send email, create ad, update product...).
   - **allow**: everything else.

   Rules match the command actually being run, after unwrapping `env`, `sudo`, `xargs` and
   `bash -c`, and tracking `cd`, so `git -C repo push` is caught while
   `git commit -m "handle shutdown"` is not.

   Approvals are **exact, single-use, and tied to the folder**. Approving
   `git push origin main` once does not approve `git push --force origin main`, a second push,
   or the same push from another folder. Every blocked action in a run is asked in one message.
   Edit the rules in `policy.py` to taste.
3. **Jarvis's own state is off limits.** Workspaces live in `~/jarvis-workspaces/`, outside
   `~/.jarvis/`, and any attempt to write the queue DB, the config, or Jarvis's code is denied
   outright. Without this, an agent could approve its own actions.
4. **The verifier can't change anything.** It has no edit tools, and its shell is limited to
   read-only commands.

Agents use your Claude Code login and whatever MCP servers and settings your Claude Code has. If
you've connected Gmail, Shopify, or ad accounts to Claude Code, the agents can see those tools.
Writes to them go through approval, and reads don't.

## Install

**One command** (Linux or macOS). It sets up a venv, the sandbox tools, the config, the
Tailscale dashboard and an always-on service:

```bash
git clone <this repo> && cd <repo>/jarvis && ./deploy/install.sh   # add --no-voice to skip mic packages
```

Before you run it: install Claude Code, run `claude` once and sign in (that login is Jarvis's
only credential), and install Tailscale and run `tailscale up`.

Manual install:

```bash
# Python 3.10+ and Claude Code logged in (`claude` once, sign in). That login is all the auth needed.
pip install -e .              # core: queue, workers, CLI, Telegram, push
pip install -e '.[voice]'     # + microphone: faster-whisper, openwakeword, piper, sounddevice
pip install -e '.[ingest]'    # + WhisperX for recordings (pulls in PyTorch; big)
sudo apt install bubblewrap socat   # Linux: the shell sandbox (macOS has it built in)
jarvis init                   # writes ~/.jarvis/config.toml
```

## Use

```bash
jarvis say "make me a script that renames my photos by date taken, test it on a few samples"
jarvis up                     # daemon + dashboard (+ Telegram if configured). Add --voice for the mic.
jarvis list                   # what's queued / running / waiting on you
jarvis show 3                 # full log for goal 3: every tool call, block, verdict
jarvis answer 3 "use the EXIF date, fall back to file mtime"
jarvis approve 3              # allow the exact action goal 3 is blocked on
jarvis cancel 3

# Precise control, no model in the loop:
jarvis add "Weekly sales CSV" --done "report.csv exists with one row per day for the last 7 days" \
  --workspace ~/projects/shop-reports --budget 2
```

Goals get their own folder under `~/jarvis-workspaces/` unless you pass `--workspace`.

### HQ briefings (Maison Belasi)

At `hq_briefing_times` (08:30, 13:00 and 18:30 by default), or whenever you say *"brief me"*,
*"any updates?"* or *"how's the business doing?"*, a read-only agent checks your business and
reports back. The default checks are sales (Shopify), ads (Meta Ads), inbox (Gmail) and calendar.
You get a short spoken summary, a push notification (urgent if anything needs a look), and a
briefing card on the dashboard. Edit `hq_sources` in the config to change what it checks.

- **It only uses connectors you've given Claude Code.** Add them with `claude mcp add …` (user
  scope), or enable the claude.ai connectors in Claude Code. A source it can't reach shows
  as *Not connected*. It never estimates or invents figures. Verified: with no connectors, it
  reported all four sources unavailable. With a test Shopify connector, it reported the exact
  figures.
- **Briefings are strictly read-only.** Any tool that would change something (send, create,
  update…) is denied outright, not queued for approval. In testing it was told to create a
  discount code; the call was blocked, and it told you it hadn't been done.
- Each briefing is capped at `hq_budget_usd` ($0.75). A run with no connectors cost $0.17 on
  Sonnet.
- "Brief me" within 20 minutes of the last briefing answers instantly from that briefing.

### Jarvis's voice

| Where | Default | Best |
|---|---|---|
| Phone dashboard | your phone's built-in voice, auto-picking the most natural English one (choose it in ⚙︎) | **ElevenLabs**: set `elevenlabs_api_key`. The default voice is "Daniel" (calm British male); change it with `elevenlabs_voice_id` |
| Desk speaker (`jarvis up --voice`) | Piper (local, free) → espeak / `say` | ElevenLabs, same key |

ElevenLabs is the recommendation if you'll listen every day. Phone voices range from good
(iPhone "Premium" voices, once downloaded in Settings → Accessibility → Spoken Content) to
robotic. The key lives only in `~/.jarvis/config.toml`, which agents aren't allowed to read
without your approval.

### Phone, via Tailscale (recommended)

`jarvis tailscale on` (the installer runs it) publishes the dashboard at
`https://<this-machine>.<your-tailnet>.ts.net` using `tailscale serve`. Open it on your phone
with the Tailscale app connected and add it to your home screen. From there you can see what's
running, read each goal's log, answer questions, **approve blocked actions** (it shows exactly
what you're approving), cancel goals, type new goals, or **hold the mic button and talk**. Audio
is transcribed on your machine.

How it's locked down:
- It's **tailnet-only**. `tailscale serve` never exposes anything to the internet (that would be
  `funnel`, which Jarvis never uses). The dashboard itself listens only on `127.0.0.1`.
- **Identity comes from Tailscale.** Each request must carry the tailnet login that
  `tailscale serve` attaches, and it must be on `tailscale_allowed_users`. If that's empty, only
  the machine's owner in Tailscale is allowed. Everyone else, including a browser on the same
  machine, gets 403.
- **Agents can't reach it.** Their shell sandbox blocks localhost. The policy denies commands
  aimed at the dashboard port or carrying the identity header, and denies WebFetch to localhost
  or `*.ts.net`. Changes are POST-only with a JSON or audio body plus an Origin check, so
  another website can't submit forms to it.
- Tap a phone notification (ntfy or Telegram) and it opens the dashboard.

One-time Tailscale settings: enable **MagicDNS** and **HTTPS Certificates** in the admin console
(DNS page). On Linux, `sudo tailscale set --operator=$USER` lets Jarvis configure serve without
root; the installer does this for you. `jarvis tailscale status` shows the URL and who is
allowed, and `jarvis tailscale off` unpublishes it.

### Phone, other channels

- **Push (one-way):** install the [ntfy](https://ntfy.sh) app, subscribe to a hard-to-guess
  topic, and set `ntfy_topic` to it. ntfy.sh topics are public to anyone who knows the name, so
  don't put anything sensitive in goal titles if you use the public server. You can self-host
  ntfy and set `ntfy_server`.
- **Two-way (recommended):** create a bot with @BotFather, set `telegram_token`, and run
  `jarvis telegram`. Send it `/start` and it replies with your chat id. Put that in
  `telegram_chat_id`. From then on only that chat can control it. Text it goals and answers, or
  send **voice notes**, which are transcribed locally. `/status` and `/goals` work too.

### Voice ("Hey Jarvis")

`jarvis up --voice` (or `jarvis voice`) listens for the wake word with openWakeWord,
records until you stop talking, transcribes locally with **faster-whisper**, routes what you
said, and replies with Piper TTS (or espeak / macOS `say`). Goal notifications are spoken too.

- No GPU: `whisper_model = "small.en"` (default) is fine on a modern CPU. Use `base.en` on a Pi.
- NVIDIA GPU: `whisper_model = "large-v3"` or `distil-large-v3`, `whisper_device = "cuda"`.
- `wake_word = ""` switches to push-to-talk (press Enter).
- Test without a mic: `jarvis voice --file request.wav`.

### WhisperX: recordings into goals

WhisperX is the wrong tool for live conversation (it's built for batch accuracy, word timestamps,
and speaker labels), so live voice uses faster-whisper. WhisperX does what it's good at here:

```bash
jarvis ingest voice-memo.m4a                # transcribe, extract action items, queue them as goals
HF_TOKEN=... jarvis ingest meeting.wav --diarize   # label speakers (needs a HuggingFace token
                                                   # with the pyannote model terms accepted)
```

Transcripts are saved in `~/.jarvis/transcripts/`.

## Run it 24/7

- Linux: `deploy/jarvis.service` (systemd user unit; instructions inside).
- macOS: `deploy/com.jarvis.agent.plist` (launchd; instructions inside).

Hardware: anything that runs Claude Code. The agents run in the cloud, and your box only runs
the shell commands and (for voice) Whisper. A Mac mini or any recent mini PC is plenty, and a
Raspberry Pi 5 works with `base.en`.

## Config (`~/.jarvis/config.toml`, or env `JARVIS_<KEY>`)

| key | default | |
|---|---|---|
| `worker_model` / `verifier_model` | `claude-opus-5-5` | `claude-sonnet-5-5` is roughly half the cost and fine for routine goals |
| `worker_effort` | `high` | `medium` is cheaper and faster |
| `router_model` / `router_effort` | `claude-opus-5-5` / `low` | classifies what you said |
| `default_budget_usd` | `5.0` | per goal, all attempts combined |
| `max_attempts` | `3` | work→verify rounds |
| `concurrency` | `2` | goals in parallel |
| `sandbox` | `auto` | `on` / `off` |
| `sandbox_allowed_domains` | registries + GitHub | comma-separated |
| `ntfy_topic`, `telegram_token`, `telegram_chat_id` | | phone |
| `web_port` | `8765` | dashboard (loopback only) |
| `hq_name`, `hq_sources`, `hq_briefing_times` | Maison Belasi; sales/ads/inbox/calendar; 08:30,13:00,18:30 | briefings |
| `hq_model`, `hq_effort`, `hq_budget_usd` | worker model, `medium`, `0.75` | |
| `tts_engine`, `elevenlabs_api_key`, `elevenlabs_voice_id` | `auto`, —, Daniel | voice |
| `tailscale_allowed_users` | machine owner | comma-separated tailnet logins |
| `speak_notifications` | `false` | |
| `whisper_model`, `whisper_device`, `wake_word`, `piper_voice` | | voice |

## Known limitations

- **Spend from a run that crashes or that you cancel isn't counted** toward the goal's
  budget, because the SDK only reports cost when a run ends normally. Each run is still capped by
  the SDK at the budget that remained when it started, so the worst case is about one extra
  run's worth.
- **The policy is a filter, not a proof.** It is tuned for an over-eager agent, not a
  determined attacker. The sandbox is the hard boundary, so keep it on. Network tools that don't
  go through the shell (WebFetch, MCP servers) aren't covered by the sandbox's domain allowlist.
  MCP writes still need approval.
- **The Tailscale path was tested with a stand-in `tailscale` binary**, not a real tailnet.
  The dashboard, identity checks and installer were run for real. If `tailscale serve` changes
  its flags, `jarvis tailscale on` prints Tailscale's error.
- **The router takes a few seconds** (one model call) for anything beyond the built-in fast
  commands (`status`, `approve N`, `cancel N`). That's fine for conversation, but you'll notice
  it.
- **Live microphone mode wasn't tested on real hardware during development.** It was tested
  with recorded audio through the same code path. If the wake word misfires, try
  `wake_word = ""` (push-to-talk) first.
- **openWakeWord ≥0.6 needs `tflite-runtime`, which has no wheels for Python 3.12+ on Linux**, so
  pip may install 0.4. Both are supported. faster-whisper 1.2 with PyAV 19 can't open files
  directly, so Jarvis decodes audio itself with ffmpeg or a built-in WAV reader.

## Tests

```bash
pip install -e '.[dev]' && python -m pytest -q
```

The 150 unit tests use a scripted fake agent and fake audio/Telegram backends, so they need no
network, mic or credentials. The full loop was also run for real against live agents: build,
independent verification (retry-on-rejection is unit-tested only), an approval round-trip with `git push`, a question answered in
plain English, a mid-run cancel, a sandbox escape attempt, and voice-file → goal.
