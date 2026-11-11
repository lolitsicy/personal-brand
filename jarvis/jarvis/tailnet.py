"""Tailscale: put the dashboard on your tailnet over HTTPS, reachable only by you.

`tailscale serve` terminates HTTPS with a real *.ts.net certificate and proxies to Jarvis on
127.0.0.1. For requests from a tailnet user it adds `Tailscale-User-Login`, which Jarvis checks
against an allowlist. Nothing is exposed to the internet (that would be `tailscale funnel`,
which Jarvis never uses).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass


class TailscaleError(RuntimeError):
    pass


@dataclass
class TailnetInfo:
    dns_name: str  # e.g. "homebox.tail1234.ts.net"
    owner_login: str  # login of the user who owns this machine
    online: bool

    @property
    def url(self) -> str:
        return f"https://{self.dns_name}"


def _run(args: list[str], timeout: float = 20) -> subprocess.CompletedProcess:
    exe = shutil.which("tailscale")
    if not exe:
        raise TailscaleError("tailscale CLI not found. Install it from https://tailscale.com/download "
                             "and run `tailscale up` once.")
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)


def parse_status(data: dict) -> TailnetInfo:
    if data.get("BackendState") not in (None, "Running"):
        raise TailscaleError(f"Tailscale is {data.get('BackendState')}. Run `tailscale up`.")
    me = data.get("Self") or {}
    dns = (me.get("DNSName") or "").rstrip(".")
    if not dns:
        raise TailscaleError("This machine has no tailnet DNS name. Enable MagicDNS in the "
                             "Tailscale admin console (DNS page).")
    users = data.get("User") or {}
    owner = users.get(str(me.get("UserID")), {}).get("LoginName", "")
    return TailnetInfo(dns, owner, bool(me.get("Online", True)))


def status() -> TailnetInfo:
    r = _run(["status", "--json"])
    if r.returncode != 0:
        raise TailscaleError(f"`tailscale status` failed: {r.stderr.strip() or r.stdout.strip()}")
    return parse_status(json.loads(r.stdout))


def serve(port: int) -> TailnetInfo:
    """Proxy https://<this machine>.ts.net -> http://127.0.0.1:<port>, in the background."""
    info = status()
    r = _run(["serve", "--bg", "--https=443", f"http://127.0.0.1:{port}"])
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip()
        hint = ""
        if "HTTPS" in msg or "cert" in msg.lower():
            hint = ("\nEnable HTTPS certificates for your tailnet in the admin console "
                    "(DNS page → HTTPS Certificates), then retry.")
        elif "access denied" in msg.lower() or "operator" in msg.lower():
            hint = "\nOn Linux run once: sudo tailscale set --operator=$USER"
        raise TailscaleError(f"`tailscale serve` failed: {msg}{hint}")
    return info


def unserve() -> None:
    _run(["serve", "--https=443", "off"])


def allowed_logins(cfg_value: str, info: TailnetInfo | None) -> set[str]:
    """Configured allowlist, else just the machine's owner."""
    users = {u.strip().lower() for u in cfg_value.split(",") if u.strip()}
    if not users and info and info.owner_login:
        users = {info.owner_login.lower()}
    return users
