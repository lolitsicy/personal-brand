"""What an unattended agent may do without asking you.

Every tool call gets one of:
  allow    - run it
  approve  - blocked until you approve this exact action (agent is told to ask you)
  deny     - never, even with approval

This is the second line of defence. The first is the OS sandbox (see worker.sandbox_settings),
which confines shell writes to the workspace and network to an allowlist. No command filter can
stop `python -c "import subprocess; subprocess.run(['git','push'])"`; the sandbox can.

Rules match the *command being run* (first word of each pipeline segment, after wrappers like
env/sudo/xargs/bash -c), not words that merely appear in arguments, so
`git commit -m "handle shutdown"` is fine and `git -C repo push` is caught.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ALLOW, APPROVE, DENY = "allow", "approve", "deny"


@dataclass
class Decision:
    verdict: str
    reason: str = ""
    key: str = ""  # identifier you approve, e.g. "Bash: git push origin main"
    via_approval: bool = False


HOME = Path(os.path.expanduser("~"))
SECRET_PATHS = [HOME / p for p in (
    ".ssh", ".aws", ".gnupg", ".config/gcloud", ".config/gh", ".kube", ".docker/config.json",
    ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".claude", ".config/anthropic",
)]
# Jarvis's own state: an agent that can write these can approve itself.
PROTECTED_NAMES = ("jarvis.db",)

ROOT_CMDS = {"sudo", "doas", "su", "pkexec", "runas"}
POWER_CMDS = {"shutdown", "reboot", "halt", "poweroff"}
REMOTE_CMDS = {"ssh", "scp", "sftp", "mosh"}
MAIL_CMDS = {"mail", "mailx", "sendmail", "mutt", "msmtp"}
SERVICE_CMDS = {"crontab", "systemctl", "launchctl", "service", "at", "batch"}
INFRA_READONLY = {
    "kubectl": {"get", "describe", "logs", "version", "explain", "api-resources", "top"},
    "terraform": {"plan", "validate", "fmt", "init", "show", "version", "output", "providers"},
    "pulumi": {"preview", "version", "whoami"},
    "helm": {"list", "status", "template", "lint", "version", "show"},
}
INFRA_ANY = {"flyctl", "fly", "vercel", "netlify", "heroku", "aws", "gcloud", "az", "doctl",
             "railway", "wrangler", "firebase"}
PUBLISH = {("npm", "publish"), ("pnpm", "publish"), ("yarn", "publish"), ("twine", "upload"),
           ("cargo", "publish"), ("gem", "push"), ("docker", "push"), ("podman", "push"),
           ("poetry", "publish"), ("uv", "publish"), ("hatch", "publish")}
WRAPPERS = {"env", "command", "builtin", "nohup", "time", "nice", "ionice", "timeout", "stdbuf",
            "exec", "caffeinate"}
SHELLS = {"sh", "bash", "zsh", "dash", "fish", "ksh"}
INTERPRETERS = SHELLS | {"python", "python3", "perl", "ruby", "node", "php"}
GIT_READONLY = {"log", "show", "ls-tree", "ls-files", "ls-remote", "status", "diff", "rev-parse",
                "cat-file", "describe", "blame", "shortlog", "show-ref", "for-each-ref", "grep",
                "rev-list", "reflog", "whatchanged", "version", "help"}
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

MCP_READ_VERB = re.compile(
    r"^(get|list|search|read|query|find|lookup|fetch|describe|show|preview|count|check|"
    r"validate|resolve|explore|download|view|inspect|summarize|status)([_\-A-Z]|$)")
MCP_WRITE_WORDS = {
    "create", "delete", "update", "send", "publish", "post", "save", "upload", "remove", "write",
    "set", "add", "edit", "trash", "archive", "share", "invite", "merge", "apply", "activate",
    "boost", "reply", "forward", "mark", "move", "copy", "rename", "deploy", "generate", "cancel",
    "submit", "pay", "charge", "refund", "transfer", "confirm", "unarchive", "untrash", "label",
    "unlabel", "respond", "execute", "invoke", "run", "import", "register", "connect", "migrate",
    "fill", "edit", "change", "replace", "approve", "start", "stop", "restore", "unpublish"}


def _mcp_is_read(action: str) -> bool:
    words = [w.lower() for w in re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", action)]
    return bool(words) and MCP_READ_VERB.match(action) is not None and \
        not any(w in MCP_WRITE_WORDS for w in words)


# --- helpers -----------------------------------------------------------------

def _norm(cmd: str) -> str:
    return " ".join(cmd.split())


def _resolve(path: str, cwd: Path) -> Path | None:
    """Resolve a path like a shell would. None if it depends on variables we can't see."""
    if not path or "$" in path or "`" in path:
        return None
    p = Path(os.path.expanduser(path))
    if not p.is_absolute():
        p = cwd / p
    try:
        return p.resolve()
    except OSError:
        return None


def _inside(path: Path | None, root: Path) -> bool:
    if path is None:
        return False
    try:
        path.relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _is_secret(p: Path | None, raw: str = "") -> bool:
    if p is not None:
        for s in SECRET_PATHS:
            try:
                p.relative_to(s)
                return True
            except ValueError:
                pass
    raw = raw.replace("\\", "/")
    for s in SECRET_PATHS:
        rel = str(s.relative_to(HOME))
        if f"/{rel}" in raw or raw.startswith(f"~/{rel}") or raw.startswith(f"$HOME/{rel}"):
            return True
    return False


def _is_protected(text: str, protected: list[Path], cwd: Path | None = None) -> bool:
    if any(n in text for n in PROTECTED_NAMES) or any(str(p) in text for p in protected):
        return True
    if cwd is not None:
        p = _resolve(text, cwd)
        if p is not None:
            for q in protected:
                try:
                    p.relative_to(q.resolve())
                    return True
                except (ValueError, OSError):
                    pass
    return False


def split_segments(cmd: str) -> list[str]:
    """Split a shell line on && || ; | & and newlines, respecting quotes."""
    segs, cur, q, i = [], [], None, 0
    while i < len(cmd):
        ch = cmd[i]
        if q:
            cur.append(ch)
            if ch == "\\" and q == '"' and i + 1 < len(cmd):
                cur.append(cmd[i + 1])
                i += 1
            elif ch == q:
                q = None
        elif ch in "'\"":
            q = ch
            cur.append(ch)
        elif cmd.startswith(("&&", "||"), i):
            segs.append("".join(cur))
            cur = []
            i += 1
        elif ch == "&" and (cmd[i - 1:i] in (">", "<") or cmd[i + 1:i + 2] == ">"):
            cur.append(ch)  # redirection like 2>&1 or &>file
        elif ch in ";|\n&":
            segs.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    segs.append("".join(cur))
    return [_norm(x) for x in segs if x.strip()]


def _tokens(seg: str) -> list[str]:
    try:
        return shlex.split(seg)
    except ValueError:
        return seg.split()


_REDIR = re.compile(r"^(\d?>>?|&>>?|>\|)(.*)$")


def _strip_redirs(tokens: list[str]) -> tuple[list[str], list[str]]:
    """Return (tokens without redirections, output redirection targets)."""
    out, targets, i = [], [], 0
    while i < len(tokens):
        t = tokens[i]
        m = _REDIR.match(t)
        if m:
            tgt = m.group(2)
            if tgt.startswith("&"):  # 2>&1
                i += 1
                continue
            if not tgt and i + 1 < len(tokens):
                tgt = tokens[i + 1]
                i += 1
            if tgt:
                targets.append(tgt)
            i += 1
            continue
        if t.startswith("<"):
            i += 2 if t == "<" else 1
            continue
        out.append(t)
        i += 1
    return out, targets


def _unwrap(tokens: list[str]) -> tuple[list[str], list[str]]:
    """Peel env assignments and wrappers. Returns (real command tokens, wrappers seen)."""
    seen = []
    while tokens:
        t = tokens[0]
        name = os.path.basename(t)
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
            tokens = tokens[1:]
        elif name in WRAPPERS or name in ROOT_CMDS:
            seen.append(name)
            tokens = tokens[1:]
            while tokens and tokens[0].startswith("-"):
                tokens = tokens[1:]
            if name == "timeout" and tokens and re.match(r"^\d", tokens[0]):
                tokens = tokens[1:]
        elif name == "xargs":
            seen.append(name)
            tokens = [x for x in tokens[1:] if not x.startswith("-")]
        else:
            break
    return tokens, seen


def _approval_key(seg: str, cwd: Path, workspace: Path) -> str:
    toks, _ = _strip_redirs(_tokens(seg))
    k = "Bash: " + _norm(" ".join(shlex.quote(t) for t in toks))
    if cwd != workspace.resolve():
        k += f"  (in {cwd})"
    return k


@dataclass
class _Ctx:
    workspace: Path
    approvals: list[str]
    protected: list[Path]
    read_only: bool


def _git_sub(args: list[str]) -> str:
    i = 0
    while i < len(args):
        a = args[i]
        if a in GIT_OPTS_WITH_VALUE:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        return a
    return ""


def _method(args: list[str]) -> str | None:
    for i, a in enumerate(args):
        if a in ("-X", "--request") and i + 1 < len(args):
            return args[i + 1].upper()
        m = re.match(r"^(?:-X|--request=)(\w+)$", a)
        if m:
            return m.group(1).upper()
    return None


def _all_local(args: list[str]) -> bool:
    urls = [a for a in args if not a.startswith("-") and ("://" in a or "localhost" in a
                                                          or re.match(r"^[\w.\-]+(:\d+)?/", a))]
    return bool(urls) and all(re.search(r"(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)", u) for u in urls)


# --- the bash checker ----------------------------------------------------------

def _check_tokens(toks: list[str], seg: str, cwd: Path, ctx: _Ctx, depth: int) -> Decision:
    key = _approval_key(seg, cwd, ctx.workspace)
    toks, redirs = _strip_redirs(toks)
    toks, wrappers = _unwrap(toks)

    def approve(why: str) -> Decision:
        return Decision(APPROVE, why, key)

    def deny(why: str) -> Decision:
        return Decision(DENY, why, key)

    for r in redirs:
        if r in ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"):
            continue
        if _is_protected(r, ctx.protected, cwd):
            return deny("modifies Jarvis's own state")
        if ctx.read_only:
            return deny("the verifier must not modify files")
        if not _inside(_resolve(r, cwd), ctx.workspace):
            return approve("writes outside the workspace")
    if not toks:
        return Decision(ALLOW)

    cmd = os.path.basename(toks[0])
    args = toks[1:]
    plain = [a for a in args if not a.startswith("-")]
    sub = plain[0] if plain else ""

    # nested shells
    if cmd in SHELLS and "-c" in args and depth < 3:
        i = args.index("-c")
        if i + 1 < len(args):
            return _check_line(args[i + 1], cwd, ctx, depth + 1)
    if cmd == "eval" and depth < 3:
        return _check_line(" ".join(args), cwd, ctx, depth + 1)

    # never, even with approval
    if cmd in POWER_CMDS:
        return deny("powers off the machine")
    if cmd.startswith("mkfs") or (cmd == "dd" and any(a.startswith("of=/dev/") for a in args)):
        return deny("writes to a raw disk")
    if cmd == "chmod" and "-R" in args and "/" in plain:
        return deny("changes permissions on /")

    if cmd in ("rm", "rmdir", "shred", "unlink") or (
            cmd == "find" and ("-delete" in args or "rm" in args)):
        targets = plain if cmd != "find" else (plain[:1] or ["."])
        for t in targets:
            p = _resolve(t, cwd)
            if (p is not None and p in (Path("/"), HOME.resolve())) or \
               re.fullmatch(r'(/\*|~/?\*?|"?\$\{?HOME\}?"?/?\*?)', t):
                return deny("deletes / or your home folder")
        for t in targets:
            if _is_protected(t, ctx.protected, cwd):
                return deny("modifies Jarvis's own state")
        if ctx.read_only:
            return deny("the verifier must not modify files")
        for t in targets:
            if not _inside(_resolve(t, cwd), ctx.workspace):
                return approve("deletes files outside the workspace")
        return Decision(ALLOW)

    if wrappers and any(w in ROOT_CMDS for w in wrappers):
        return approve("runs as root")

    if any(_is_protected(a, ctx.protected, cwd) for a in args):
        if ctx.read_only or cmd not in ("cat", "ls", "head", "tail", "wc", "file", "stat", "grep",
                                        "less", "more", "strings", "base64", "xxd", "od"):
            return deny("modifies Jarvis's own state")
        return approve("reads Jarvis's config or queue (holds your API keys)")

    for a in args:
        val = a.split("=", 1)[1] if a.startswith("-") and "=" in a else a
        if a.startswith("-") and "=" not in a:
            continue
        if _is_secret(_resolve(val, cwd), val):
            return approve("reads credentials")

    if ctx.read_only:
        mutating = {"mv", "cp", "tee", "truncate", "touch", "mkdir", "ln", "chmod", "chown",
                    "patch", "install"}
        git_mut = {"commit", "checkout", "reset", "stash", "clean", "add", "rm", "mv", "merge",
                   "rebase", "switch", "restore", "push", "tag", "branch", "am", "apply", "cherry-pick"}
        if cmd in mutating or (cmd == "sed" and any(a.startswith("-i") for a in args)) or \
           (cmd == "git" and _git_sub(args) in git_mut):
            return deny("the verifier must not modify files")

    if cmd == "git":
        gsub = _git_sub(args)
        if gsub == "push":
            return approve("publishes code to a remote")
        if gsub == "reset" and "--hard" in args:
            return approve("discards uncommitted work")
        if gsub == "clean" and any(re.match(r"^-[a-zA-Z]*f", a) for a in args):
            return approve("deletes untracked files")
        if gsub in GIT_READONLY:
            return Decision(ALLOW)
        if "-C" in args:
            i = args.index("-C")
            if i + 1 < len(args) and not _inside(_resolve(args[i + 1], cwd), ctx.workspace):
                return approve("runs git in another folder")
        return Decision(ALLOW)

    if cmd == "gh":
        verbs = {"create", "merge", "close", "delete", "edit", "upload", "comment", "review",
                 "reopen", "set", "fork", "rename", "archive", "transfer", "lock", "ready"}
        if len(plain) > 1 and plain[1] in verbs:
            return approve("acts on GitHub")
        if sub == "workflow" and len(plain) > 1 and plain[1] in ("run", "enable", "disable"):
            return approve("acts on GitHub")
        if sub == "api" and (any(a in ("-f", "-F", "--field", "--raw-field", "--input") or
                                 re.match(r"^-[fF].", a) for a in args) or
                             _method(args) not in (None, "GET")):
            return approve("acts on GitHub")
        return Decision(ALLOW)

    if (cmd, sub) in PUBLISH:
        return approve("publishes a package or image")
    if cmd in REMOTE_CMDS:
        return approve("touches another machine")
    if cmd == "rsync" and any(re.match(r"^[^/]*:", a) for a in plain):
        return approve("touches another machine")
    if cmd in MAIL_CMDS:
        return approve("sends email")
    if cmd in SERVICE_CMDS:
        if cmd == "systemctl" and sub in ("status", "list-units", "list-timers", "is-active", "cat"):
            return Decision(ALLOW)
        if cmd == "crontab" and args == ["-l"]:
            return Decision(ALLOW)
        return approve("changes system services or schedules")
    if cmd in INFRA_READONLY:
        return Decision(ALLOW) if sub in INFRA_READONLY[cmd] else approve("changes infrastructure")
    if cmd in INFRA_ANY:
        return approve("changes cloud infrastructure")

    if cmd == "curl":
        sends = any(a in ("-d", "-F", "-T", "--data", "--data-raw", "--data-binary",
                          "--data-urlencode", "--json", "--form", "--upload-file") or
                    re.match(r"^(-[dFT].|--(data|json|form|upload-file)=)", a) for a in args)
        if (sends or _method(args) not in (None, "GET", "HEAD")) and not _all_local(args):
            return approve("sends data to a web service")
        return Decision(ALLOW)
    if cmd == "wget" and any(a.startswith(("--post-data", "--post-file", "--method", "--body-"))
                             for a in args) and not _all_local(args):
        return approve("sends data to a web service")

    if cmd in ("cp", "mv", "install", "ln", "rsync") and len(plain) >= 2:
        if not _inside(_resolve(plain[-1], cwd), ctx.workspace):
            return approve("writes outside the workspace")
    if cmd in ("sed", "perl") and any(a.startswith("-i") or a == "-pi" for a in args) or \
       cmd in ("truncate", "touch", "chmod", "chown", "mkdir", "patch"):
        for t in plain[1:] if cmd in ("sed", "perl", "chmod", "chown") else plain:
            if "/" in t or t.startswith(("~", "..")):
                if not _inside(_resolve(t, cwd), ctx.workspace):
                    return approve("modifies files outside the workspace")
    if cmd == "tee":
        for t in plain:
            if not _inside(_resolve(t, cwd), ctx.workspace):
                return approve("writes outside the workspace")

    return Decision(ALLOW)


CONTROL_PORTS: set[int] = {8765}  # Jarvis dashboard; worker adds the configured port


def _check_line(line: str, cwd: Path, ctx: _Ctx, depth: int = 0) -> Decision:
    line = _norm(line)
    whole = f"Bash: {line}"
    if re.search(r":\(\)\s*\{\s*:\|:&\s*\};:", line):
        return Decision(DENY, "fork bomb", whole)
    if "tailscale-user-login" in line.lower() or any(
            re.search(rf"(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)\D{{0,3}}:{p}\b", line)
            for p in CONTROL_PORTS):
        return Decision(DENY, "talks to Jarvis's own control API", whole)

    results: list[Decision] = []
    if re.search(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(" + "|".join(INTERPRETERS) + r")\b", line) or \
       re.search(r"<\(\s*(curl|wget)\b", line):
        results.append(Decision(ALLOW, "approved by owner", whole, True) if whole in ctx.approvals
                       else Decision(APPROVE, "runs code downloaded from the internet", whole))

    for seg in split_segments(line):
        toks = _tokens(seg)
        bare, _ = _unwrap(_strip_redirs(toks)[0])
        if bare and bare[0] in ("cd", "pushd"):
            new = _resolve(bare[1] if len(bare) > 1 else "~", cwd)
            cwd = new if new is not None else Path("/unknown-dir")
            continue
        d = _check_tokens(toks, seg, cwd, ctx, depth)
        if d.verdict == APPROVE and d.key in ctx.approvals:
            d = Decision(ALLOW, "approved by owner", d.key, True)
        results.append(d)

    for verdict in (DENY, APPROVE):
        hit = [r for r in results if r.verdict == verdict]
        if hit:
            return hit[0]
    used = [r for r in results if r.via_approval]
    return used[0] if used else Decision(ALLOW)


# --- entry point -----------------------------------------------------------------

def mcp_key(tool: str, args: dict) -> str:
    """Exact-args key. The hash covers every argument; the preview is for humans."""
    blob = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    h = hashlib.sha256(blob.encode()).hexdigest()[:12]
    preview = blob if len(blob) <= 300 else blob[:299] + "…"
    return f"{tool} [{h}] {preview}"


def check(tool: str, args: dict, workspace: Path, approvals: list[str],
          protected: list[Path] | None = None, read_only: bool = False) -> Decision:
    workspace = Path(workspace).resolve()
    ctx = _Ctx(workspace, approvals, list(protected or []), read_only)

    if tool == "Bash":
        return _check_line(str(args.get("command", "")), workspace, ctx)

    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        raw = str(args.get("file_path") or args.get("notebook_path") or "")
        key = f"{tool}: {raw}"
        if read_only:
            return Decision(DENY, "the verifier must not modify files", key)
        if _is_protected(raw, ctx.protected, workspace):
            return Decision(DENY, "modifies Jarvis's own state", key)
        if _inside(_resolve(raw, workspace), workspace):
            return Decision(ALLOW, key=key)
        if key in approvals:
            return Decision(ALLOW, "approved by owner", key, True)
        return Decision(APPROVE, "writes outside the workspace", key)

    if tool == "WebFetch":
        url = str(args.get("url", "")).lower()
        host = urlparse(url).hostname or ""
        if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or host.endswith(".ts.net") \
                or host.startswith("127."):
            return Decision(DENY, "talks to Jarvis's own control API or your tailnet", f"WebFetch: {url}")
        return Decision(ALLOW)

    if tool in ("Read", "Glob", "Grep"):
        raw = str(args.get("file_path") or args.get("path") or "")
        rp = _resolve(raw, workspace) if raw else None
        if rp is not None and rp.name in ("config.toml", "jarvis.db") and \
                any(_inside(rp, q.parent if q.suffix else q) for q in ctx.protected):
            key = f"{tool}: {raw}"
            if key in approvals:
                return Decision(ALLOW, "approved by owner", key, True)
            return Decision(APPROVE, "reads Jarvis's config or queue (holds your API keys)", key)
        pattern = str(args.get("pattern") or "") if tool == "Glob" else ""
        p = _resolve(raw, workspace) if raw else workspace
        key = f"{tool}: {raw} {pattern}".strip()
        risky = _is_secret(p, raw) or any(f"{s.name}" in pattern for s in SECRET_PATHS)
        if tool in ("Glob", "Grep") and p in (Path("/"), HOME.resolve()):
            risky = True  # searching your whole home folder sweeps up credentials
        if risky:
            if key in approvals:
                return Decision(ALLOW, "approved by owner", key, True)
            return Decision(APPROVE, "reads credentials or searches your whole home folder", key)
        return Decision(ALLOW)

    if tool.startswith("mcp__"):
        if tool.startswith("mcp__jarvis__"):
            return Decision(ALLOW)
        action = tool.rsplit("__", 1)[-1]
        key = mcp_key(tool, args)
        if _mcp_is_read(action):
            return Decision(ALLOW, key=key)
        if key in approvals:
            return Decision(ALLOW, "approved by owner", key, True)
        return Decision(APPROVE, f"external side effect via {tool}", key)

    return Decision(ALLOW)
