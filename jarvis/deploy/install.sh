#!/usr/bin/env bash
# Jarvis installer: venv, sandbox deps, config, Tailscale dashboard, always-on service.
#
#   ./deploy/install.sh              # everything, including voice
#   ./deploy/install.sh --no-voice   # skip microphone/speech packages
#   ./deploy/install.sh --no-service # don't install the background service
#
# Safe to re-run. Asks for sudo only for system packages and Tailscale operator rights.
set -euo pipefail

VOICE=1 SERVICE=1
for arg in "$@"; do
  case "$arg" in
    --no-voice) VOICE=0 ;;
    --no-service) SERVICE=0 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${JARVIS_PREFIX:-$HOME/.local/share/jarvis}"
BIN="$HOME/.local/bin"
OS="$(uname -s)"
say()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

say "Checking prerequisites"
PY=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    PY="$c"; break
  fi
done
[ -n "$PY" ] || die "Python 3.11+ is required (macOS: brew install python; Ubuntu: apt install python3)."
ok "Python: $($PY --version)"
if command -v claude >/dev/null; then
  ok "Claude Code: $(claude --version 2>/dev/null | head -1)"
else
  warn "Claude Code CLI not found. Jarvis uses its login. Install it (https://claude.ai/code),"
  warn "run \`claude\` once and sign in, then re-run this script."
fi

say "System packages (sandbox + audio)"
if [ "$OS" = "Linux" ]; then
  pkgs="bubblewrap socat ffmpeg"
  [ "$VOICE" = 1 ] && pkgs="$pkgs libportaudio2"
  if command -v apt-get >/dev/null; then
    $SUDO apt-get install -y -q $pkgs >/dev/null || { $SUDO apt-get update -q >/dev/null && $SUDO apt-get install -y -q $pkgs >/dev/null; }
  elif command -v dnf >/dev/null; then
    $SUDO dnf install -y -q bubblewrap socat ffmpeg portaudio >/dev/null || warn "dnf install failed; install bubblewrap, socat, ffmpeg yourself"
  elif command -v pacman >/dev/null; then
    $SUDO pacman -S --needed --noconfirm bubblewrap socat ffmpeg portaudio >/dev/null
  else
    warn "Unknown package manager: install bubblewrap, socat, ffmpeg (and portaudio for voice) yourself."
  fi
  command -v bwrap >/dev/null && command -v socat >/dev/null && ok "sandbox tools present" \
    || warn "bubblewrap/socat missing: Jarvis will refuse to run agents (sandbox = \"on\")."
elif [ "$OS" = "Darwin" ]; then
  ok "macOS sandbox is built in"
  if ! command -v ffmpeg >/dev/null; then
    if command -v brew >/dev/null; then brew install ffmpeg >/dev/null && ok "ffmpeg installed"
    else warn "Install ffmpeg (brew install ffmpeg) for voice notes and phone-mic audio."; fi
  fi
else
  die "Unsupported OS: $OS (Linux and macOS only)."
fi

say "Installing Jarvis into $PREFIX"
"$PY" -m venv "$PREFIX/venv"
"$PREFIX/venv/bin/pip" install -q --upgrade pip
extras=""; [ "$VOICE" = 1 ] && extras="[voice]"
"$PREFIX/venv/bin/pip" install -q "$SRC$extras"
mkdir -p "$BIN"
ln -sf "$PREFIX/venv/bin/jarvis" "$BIN/jarvis"
JARVIS="$BIN/jarvis"
ok "jarvis → $JARVIS"
case ":$PATH:" in *":$BIN:"*) ;; *) warn "Add $BIN to your PATH (e.g. in ~/.zshrc or ~/.bashrc)." ;; esac
"$JARVIS" init | sed 's/^/  /'

say "Tailscale dashboard"
TS_URL=""
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  if [ "$OS" = "Linux" ] && ! tailscale serve status >/dev/null 2>&1; then
    warn "Granting $USER permission to configure tailscale serve (sudo tailscale set --operator)"
    $SUDO tailscale set --operator="$USER" || true
  fi
  if out="$("$JARVIS" tailscale on 2>&1)"; then
    echo "$out" | sed 's/^/  /'
    TS_URL="$(echo "$out" | grep -o 'https://[^ ]*' | head -1)"
  else
    echo "$out" | sed 's/^/  /'
    warn "Dashboard not on the tailnet yet; fix the above and run: jarvis tailscale on"
  fi
else
  warn "Tailscale not installed or not logged in. Install from https://tailscale.com/download,"
  warn "run \`tailscale up\`, then: jarvis tailscale on"
fi

if [ "$SERVICE" = 1 ]; then
  say "Background service"
  if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/jarvis.service" <<EOF
[Unit]
Description=Jarvis autonomous goal runner
After=network-online.target

[Service]
ExecStart=$JARVIS up
Restart=on-failure
RestartSec=10
Environment=PYTHONUNBUFFERED=1
Environment=PATH=$BIN:$PREFIX/venv/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now jarvis.service
    loginctl enable-linger "$USER" 2>/dev/null || $SUDO loginctl enable-linger "$USER" 2>/dev/null || true
    ok "running: systemctl --user status jarvis   ·   logs: journalctl --user -u jarvis -f"
  elif [ "$OS" = "Darwin" ]; then
    plist="$HOME/Library/LaunchAgents/com.jarvis.agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jarvis.agent</string>
  <key>ProgramArguments</key><array><string>$JARVIS</string><string>up</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$BIN:$PREFIX/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/jarvis.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/jarvis.log</string>
</dict></plist>
EOF
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    ok "running (launchd)   ·   logs: tail -f ~/Library/Logs/jarvis.log"
  else
    warn "No systemd user session here. Start it yourself: $JARVIS up"
  fi
fi

say "Done"
[ -n "$TS_URL" ] && echo "  Phone: open $TS_URL with Tailscale on (add it to your home screen)."
echo "  Talk to it:  jarvis say \"...\"     See goals:  jarvis list"
echo "  Settings:    ~/.jarvis/config.toml (Telegram, ntfy, models, budget)"
[ "$VOICE" = 1 ] && echo "  Voice at the desk: add --voice to ExecStart/ProgramArguments, or run: jarvis up --voice"
