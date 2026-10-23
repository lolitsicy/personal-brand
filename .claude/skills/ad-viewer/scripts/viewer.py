#!/usr/bin/env python3
"""Local ads viewer for the competitor-ad library (Python 3 stdlib only).

Usage:
  viewer.py build   [--library DIR] [--out FILE]   # writes DIR/index.html by default
  viewer.py summary [--library DIR]                # markdown table for Claude to read

Each ad lives in <library>/<id>/ with ad.json (see references/ad-schema.md),
media/, frames/, contact_sheet.jpg and optionally analysis.md / analysis.json.
The generated page is a single self-contained HTML file (inline CSS/JS, no CDN)
that references media by relative paths, so it opens straight from disk.
"""
import argparse
import datetime as _dt
import html
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

try:
    _REPO = Path(__file__).resolve().parents[4]
except IndexError:  # pragma: no cover
    _REPO = Path.cwd()
DEFAULT_LIBRARY = _REPO / "research" / "competitor-ads" / "library"
if not DEFAULT_LIBRARY.parent.exists():
    DEFAULT_LIBRARY = Path("/home/user/personal-brand/research/competitor-ads/library")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv"}


# --------------------------------------------------------------------------
# Safe markdown renderer
# --------------------------------------------------------------------------
_SAFE_URL = re.compile(r"^(https?:|mailto:|#|\.{0,2}/|[A-Za-z0-9_\-./]+$)", re.I)


def _inline(text):
    """Render inline markdown. Everything is HTML-escaped first."""
    out = []
    # split out code spans so their content is not further processed
    parts = re.split(r"(`+)(.+?)\1", text)
    # re.split with 2 groups yields: text, ticks, code, text, ticks, code, ...
    i = 0
    while i < len(parts):
        seg = parts[i]
        out.append(_inline_text(seg))
        if i + 2 < len(parts):
            out.append("<code>%s</code>" % html.escape(parts[i + 2].strip(), quote=True))
        i += 3
    return "".join(out)


def _inline_text(seg):
    links = []

    def link_sub(m):
        label, url = m.group(1), m.group(2).strip()
        if url.startswith("<") and url.endswith(">"):
            url = url[1:-1]
        url = url.split(" ", 1)[0]
        if not _SAFE_URL.match(url) or re.match(r"^\s*(javascript|data|vbscript):", url, re.I):
            links.append(html.escape(label))
        else:
            ext = url.lower().startswith(("http:", "https:"))
            attrs = ' target="_blank" rel="noopener noreferrer"' if ext else ""
            links.append('<a href="%s"%s>%s</a>' % (html.escape(url, quote=True), attrs,
                                                     _emph(html.escape(label, quote=True))))
        return "\x00%d\x00" % (len(links) - 1)

    seg = re.sub(r"\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+(?:\s+\"[^\"]*\")?)\)", link_sub, seg)
    seg = _emph(html.escape(seg, quote=True))
    # autolink bare URLs
    seg = re.sub(r"(?<![\"'=])\b(https?://[^\s<>\"']+[^\s<>\"'.,;:!?)\]])",
                 r'<a href="\1" target="_blank" rel="noopener noreferrer">\1</a>', seg)
    return re.sub(r"\x00(\d+)\x00", lambda m: links[int(m.group(1))], seg)


def _emph(s):
    s = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\*\w])\*(?=\S)(.+?)(?<=\S)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])", r"<em>\1</em>", s)
    s = re.sub(r"~~(?=\S)(.+?)(?<=\S)~~", r"<del>\1</del>", s)
    return s


_LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells = re.split(r"(?<!\\)\|", line)
    return [c.strip().replace("\\|", "|") for c in cells]


def render_markdown(md):
    lines = md.replace("\r\n", "\n").replace("\t", "    ").split("\n")
    out = []
    i = 0
    n = len(lines)

    def is_block_start(ln, nxt):
        s = ln.strip()
        return (not s or s.startswith(("#", "```", "~~~", ">")) or _LIST_RE.match(ln)
                or re.match(r"^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$", s)
                or ("|" in s and nxt is not None and _TABLE_SEP.match(nxt)))

    while i < n:
        line = lines[i]
        s = line.strip()
        nxt = lines[i + 1] if i + 1 < n else None
        if not s:
            i += 1
            continue
        # fenced code
        m = re.match(r"^(```|~~~)\s*([\w+-]*)", s)
        if m:
            fence = m.group(1)
            buf = []
            i += 1
            while i < n and not lines[i].strip().startswith(fence):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>%s</code></pre>" % html.escape("\n".join(buf)))
            continue
        # heading
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", s)
        if m:
            lvl = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (lvl, _inline(m.group(2)), lvl))
            i += 1
            continue
        # hr
        if re.match(r"^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$", s):
            out.append("<hr>")
            i += 1
            continue
        # table
        if "|" in s and nxt is not None and _TABLE_SEP.match(nxt):
            head = _split_row(line)
            aligns = []
            for c in _split_row(nxt):
                c = c.strip()
                aligns.append("center" if c.startswith(":") and c.endswith(":")
                              else "right" if c.endswith(":") else "")
            i += 2
            rows = []
            while i < n and lines[i].strip() and "|" in lines[i]:
                rows.append(_split_row(lines[i]))
                i += 1

            def cell(tag, txt, k):
                a = aligns[k] if k < len(aligns) and aligns[k] else ""
                st = ' style="text-align:%s"' % a if a else ""
                return "<%s%s>%s</%s>" % (tag, st, _inline(txt), tag)

            h = "".join(cell("th", c, k) for k, c in enumerate(head))
            body = "".join("<tr>%s</tr>" % "".join(cell("td", r[k] if k < len(r) else "", k)
                                                    for k in range(len(head))) for r in rows)
            out.append('<div class="tablewrap"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (h, body))
            continue
        # blockquote
        if s.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote>%s</blockquote>" % render_markdown("\n".join(buf)))
            continue
        # lists (nested by indentation)
        if _LIST_RE.match(line):
            stack = []  # (indent, tag)
            html_parts = []
            while i < n:
                ln = lines[i]
                lm = _LIST_RE.match(ln)
                if not lm:
                    if ln.strip() and ln.startswith("  ") and html_parts:
                        # continuation line of previous item
                        html_parts[-1] += " " + _inline(ln.strip())
                        i += 1
                        continue
                    break
                ind = len(lm.group(1))
                tag = "ol" if lm.group(2)[0].isdigit() else "ul"
                content = lm.group(3)
                task = re.match(r"^\[([ xX])\]\s+(.*)$", content)
                if task:
                    box = "&#9745; " if task.group(1).lower() == "x" else "&#9744; "
                    item = box + _inline(task.group(2))
                else:
                    item = _inline(content)
                while stack and ind < stack[-1][0]:
                    html_parts.append("</li></%s>" % stack.pop()[1])
                if stack and ind == stack[-1][0] and tag != stack[-1][1]:
                    html_parts.append("</li></%s>" % stack.pop()[1])
                if not stack or ind > stack[-1][0]:
                    stack.append((ind, tag))
                    html_parts.append("<%s><li>%s" % (tag, item))
                else:
                    html_parts.append("</li><li>%s" % item)
                i += 1
                # allow one blank line between items of the same list
                if i < n and not lines[i].strip() and i + 1 < n and _LIST_RE.match(lines[i + 1]):
                    i += 1
            while stack:
                html_parts.append("</li></%s>" % stack.pop()[1])
            out.append("".join(html_parts))
            continue
        # paragraph
        buf = [s]
        i += 1
        while i < n and not is_block_start(lines[i], lines[i + 1] if i + 1 < n else None):
            buf.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % "<br>".join(_inline(b) for b in buf))
    return "\n".join(out)


# --------------------------------------------------------------------------
# Library loading
# --------------------------------------------------------------------------
def _url(rel):
    return urllib.parse.quote(rel.replace(os.sep, "/"), safe="/._-~")


def _read_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, None
    except Exception as e:  # noqa: BLE001
        return None, "%s: %s" % (p.name, e)


def _days_running(status):
    d = status.get("days_running")
    if isinstance(d, (int, float)):
        return int(d)
    try:
        start = _dt.date.fromisoformat(str(status.get("start_date"))[:10])
    except (TypeError, ValueError):
        return None
    end = status.get("end_date")
    try:
        end = _dt.date.fromisoformat(str(end)[:10]) if end else _dt.date.today()
    except ValueError:
        end = _dt.date.today()
    return max(0, (end - start).days)


def load_ad(folder, out_dir):
    """Return a normalised, viewer-ready record (or None if no ad.json)."""
    ad, err = _read_json(folder / "ad.json")
    if ad is None and err is None:
        return None
    warnings = []
    if err:
        warnings.append("ad.json could not be parsed (" + err + ")")
        ad = {}
    if not isinstance(ad, dict):
        warnings.append("ad.json is not an object")
        ad = {}
    base = os.path.relpath(folder, out_dir)

    def f(rel):
        """Resolve a folder-relative file → (page-relative url, exists)."""
        if not rel or not isinstance(rel, str):
            return None
        p = (folder / rel)
        ok = p.is_file()
        return {"src": _url(os.path.join(base, rel)), "ok": ok, "rel": rel}

    adv = ad.get("advertiser") or {}
    if isinstance(adv, str):
        adv = {"name": adv}
    status = ad.get("status") or {}
    copy = ad.get("copy") or {}
    fmt = (ad.get("format") or "unknown").lower()

    media = []
    for k, m in enumerate(ad.get("media") or []):
        if not isinstance(m, dict):
            continue
        file_ = f(m.get("file"))
        kind = (m.get("kind") or "").lower()
        if not kind and m.get("file"):
            ext = Path(m["file"]).suffix.lower()
            kind = "video" if ext in VIDEO_EXT else "image" if ext in IMAGE_EXT else "unknown"
        media.append({
            "i": k, "kind": kind or "unknown", "role": m.get("role"), "url": m.get("url"),
            "file": file_, "poster": f(m.get("poster")), "width": m.get("width"),
            "height": m.get("height"), "duration_s": m.get("duration_s"),
            "bytes": m.get("bytes"), "error": m.get("error"),
        })

    frames = []
    for fr in ad.get("frames") or []:
        if isinstance(fr, str):
            fr = {"file": fr}
        if not isinstance(fr, dict):
            continue
        ff = f(fr.get("file"))
        if ff:
            frames.append({"file": ff, "t": fr.get("t"), "media_index": fr.get("media_index", 0)})
    if not frames and (folder / "frames").is_dir():  # fall back to whatever is on disk
        for p in sorted((folder / "frames").glob("*.jpg")):
            m = re.search(r"(\d+(?:\.\d+)?)s", p.stem)
            frames.append({"file": f("frames/" + p.name), "t": float(m.group(1)) if m else None,
                           "media_index": 0})

    cs = ad.get("contact_sheet")
    contact = f(cs) if cs else (f("contact_sheet.jpg") if (folder / "contact_sheet.jpg").is_file() else None)

    transcript = ad.get("transcript")
    if isinstance(transcript, str):
        transcript = {"text": transcript, "source": None}
    if not isinstance(transcript, dict) or not (transcript.get("text") or "").strip():
        transcript = None

    analysis_json, aerr = _read_json(folder / "analysis.json")
    if aerr:
        warnings.append("analysis.json could not be parsed (" + aerr + ")")
    if analysis_json is not None and not isinstance(analysis_json, dict):
        analysis_json = None
    analysis_md = None
    amd = folder / "analysis.md"
    if amd.is_file():
        try:
            analysis_md = amd.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            warnings.append("analysis.md unreadable (%s)" % e)

    # thumbnail: poster > first image > first frame > contact sheet
    thumb = None
    for m in media:
        if m["kind"] == "video" and m["poster"] and m["poster"]["ok"]:
            thumb = m["poster"]["src"]
            break
        if m["kind"] == "image" and m["file"] and m["file"]["ok"]:
            thumb = m["file"]["src"]
            break
    if not thumb and frames and frames[0]["file"]["ok"]:
        thumb = frames[0]["file"]["src"]
    if not thumb and contact and contact["ok"]:
        thumb = contact["src"]

    has_video = any(m["kind"] == "video" for m in media)
    search = " ".join(str(x) for x in [
        ad.get("id"), adv.get("name"), adv.get("handle"), copy.get("body"), copy.get("headline"),
        copy.get("link_description"), copy.get("caption"), copy.get("cta_text"), copy.get("link_url"),
        " ".join("%s %s" % (c.get("title") or "", c.get("body") or "") for c in ad.get("cards") or []
                 if isinstance(c, dict)),
        (transcript or {}).get("text"), analysis_md,
        json.dumps(analysis_json, ensure_ascii=False) if analysis_json else "",
    ] if x).lower()

    return {
        "id": str(ad.get("id") or folder.name),
        "folder": folder.name,
        "base": _url(base),
        "source": ad.get("source"),
        "input_url": ad.get("input_url"),
        "fetched_at": ad.get("fetched_at"),
        "advertiser": adv,
        "status": {**status, "days_running": _days_running(status)},
        "copy": copy,
        "format": fmt,
        "has_video": has_video,
        "media": media,
        "cards": [c for c in (ad.get("cards") or []) if isinstance(c, dict)],
        "transcript": transcript,
        "frames": frames,
        "contact_sheet": contact,
        "engagement": ad.get("engagement") or {},
        "thumb": thumb,
        "analysis": analysis_json,
        "analysis_html": render_markdown(analysis_md) if analysis_md else None,
        "search": search,
        "warnings": warnings,
        "raw": ad,
    }


def load_library(lib, out_dir):
    ads = []
    if not lib.is_dir():
        return ads
    for folder in sorted(p for p in lib.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))):
        rec = load_ad(folder, out_dir)
        if rec:
            ads.append(rec)
    ads.sort(key=lambda a: (-(a["status"].get("days_running") or -1), a["id"]))
    return ads


# --------------------------------------------------------------------------
# HTML page
# --------------------------------------------------------------------------
CSS = r"""
:root{--bg:#f6f6f4;--panel:#fff;--panel2:#f0f0ed;--fg:#1b1b1a;--muted:#6b6b66;--line:#e2e2dd;
--accent:#2f5bd3;--accent-fg:#fff;--good:#1f7a43;--good-bg:#e3f3e8;--warn:#9a5b00;--warn-bg:#fbefd9;
--bad:#b3261e;--bad-bg:#fbe3e1;--chip:#ececE8;--shadow:0 1px 2px rgba(0,0,0,.06),0 2px 8px rgba(0,0,0,.04);
--focus:#2f5bd3;--radius:8px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--panel:#1c1c1b;--panel2:#252523;--fg:#ebebe8;
--muted:#9c9c96;--line:#33332f;--accent:#7ea2ff;--accent-fg:#0d1530;--good:#7fd39d;--good-bg:#173323;
--warn:#f0bd6a;--warn-bg:#3a2c12;--bad:#ff8f86;--bad-bg:#3c1c19;--chip:#2c2c29;--shadow:none;--focus:#9db8ff;
color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
header.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px}
.toprow{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:650;letter-spacing:-.01em}
.count{color:var(--muted)}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center}
.controls input[type=search],.controls select{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;min-height:32px}
.controls input[type=search]{flex:1 1 220px;min-width:0}
.controls label.chk{display:inline-flex;gap:6px;align-items:center;color:var(--muted);white-space:nowrap}
main{padding:12px 16px 40px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;color:inherit;text-decoration:none;box-shadow:var(--shadow);min-width:0}
.card:hover{border-color:var(--muted)}
.thumb{position:relative;aspect-ratio:4/5;background:var(--panel2);overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .none{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:12px;text-align:center;padding:8px}
.thumb .fmt{position:absolute;top:6px;left:6px}
.thumb .play{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.6);color:#fff;border-radius:4px;padding:1px 6px;font-size:11px}
.cbody{padding:8px 10px 10px;display:flex;flex-direction:column;gap:5px;min-width:0}
.adv{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hl{color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
.badge{display:inline-block;font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:4px;background:var(--chip);color:var(--fg)}
.badge.f-video{background:#2b2b2b;color:#fff}.badge.f-carousel{background:#5b3fb5;color:#fff}.badge.f-image{background:#0f6f78;color:#fff}.badge.f-dco{background:#8a4b0f;color:#fff}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);margin-right:4px;vertical-align:middle}
.dot.on{background:var(--good)}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--chip);white-space:nowrap}
.chip b{font-weight:650}
.chip.low{background:var(--good-bg);color:var(--good)}.chip.medium{background:var(--warn-bg);color:var(--warn)}.chip.high{background:var(--bad-bg);color:var(--bad)}
.cta{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;white-space:nowrap}
.verdict{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.empty{color:var(--muted);padding:40px 0;text-align:center}
/* detail */
#detail{position:fixed;inset:0;z-index:20;display:none;background:rgba(0,0,0,.45)}
#detail.open{display:block}
.sheet{position:absolute;inset:16px;max-width:1200px;margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
.sheethead{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.sheethead .title{flex:1;min-width:0;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{font:inherit;color:var(--fg);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;min-height:32px}
.btn:hover{border-color:var(--muted)}
.sheetbody{overflow:auto;padding:14px;flex:1}
.cols{display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);gap:16px;align-items:start}
section.blk{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px;margin-bottom:12px;min-width:0}
section.blk>h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px;font-weight:650}
.note{color:var(--muted);font-style:italic;background:var(--panel2);border:1px dashed var(--line);border-radius:6px;padding:8px 10px;font-size:12px}
.warn{color:var(--warn);background:var(--warn-bg);border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:12px}
/* ad mock */
.admock{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.admock .ph{display:flex;gap:8px;align-items:center;padding:10px 12px}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--chip);display:grid;place-items:center;font-weight:700;flex:none}
.admock .ph .n{font-weight:650}.admock .ph .s{color:var(--muted);font-size:11.5px}
.admock .body{padding:0 12px 10px;white-space:pre-wrap;word-wrap:break-word}
.admock .media{background:#000}
.admock .media video,.admock .media>img{width:100%;max-height:70vh;display:block;object-fit:contain;background:#000}
.admock .foot{display:flex;gap:10px;align-items:center;padding:10px 12px;background:var(--panel2);border-top:1px solid var(--line)}
.admock .foot .t{flex:1;min-width:0}
.cap{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ahl{font-weight:650}
.ald{color:var(--muted);font-size:12px}
.ctabtn{flex:none;background:var(--chip);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-weight:650;white-space:nowrap}
.linkurl{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--muted);word-break:break-all;padding:8px 12px;border-top:1px solid var(--line)}
.carousel{display:flex;gap:8px;overflow-x:auto;padding:10px;scroll-snap-type:x mandatory;background:var(--panel2)}
.ccard{flex:0 0 72%;max-width:300px;scroll-snap-align:start;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
.ccard .cm{aspect-ratio:1/1;background:#000;display:grid;place-items:center}
.ccard .cm img,.ccard .cm video{width:100%;height:100%;object-fit:cover;display:block}
.ccard .ct{padding:8px;display:flex;gap:8px;align-items:center}
.ccard .ct>div{flex:1;min-width:0}
.mediaerr{padding:28px 12px;color:#ccc;text-align:center;font-size:12px;background:#222}
.mediaerr code{color:#eee;word-break:break-all}
.frames{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
.frames figure{margin:0;flex:0 0 auto;width:96px}
.frames img{width:96px;height:auto;display:block;border-radius:4px;border:1px solid var(--line);background:var(--panel2)}
.frames figcaption{font-size:11px;color:var(--muted);text-align:center;font-variant-numeric:tabular-nums}
.contact img{max-width:100%;height:auto;display:block;border-radius:4px}
.transcript{white-space:pre-wrap;max-height:320px;overflow:auto}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;word-break:break-word}
details summary{cursor:pointer;color:var(--muted);margin-top:8px}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:11.5px;line-height:1.4}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;background:var(--panel2);padding:0 3px;border-radius:3px}
pre code{background:none;padding:0}
.md h1,.md h2,.md h3,.md h4{margin:14px 0 6px;line-height:1.25}.md h1{font-size:18px}.md h2{font-size:15px}.md h3{font-size:13.5px}.md h4{font-size:13px}
.md>:first-child{margin-top:0}
.md p,.md ul,.md ol{margin:6px 0}.md ul,.md ol{padding-left:20px}
.md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--line);color:var(--muted)}
.md hr{border:0;border-top:1px solid var(--line)}
.tablewrap{overflow-x:auto}
.md table{border-collapse:collapse;margin:8px 0;font-size:12px}
.md th,.md td{border:1px solid var(--line);padding:4px 8px;vertical-align:top}
.md th{background:var(--panel2);text-align:left}
.scorerow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.scorerow .chip{font-size:12px;padding:3px 8px}
.ul2{margin:4px 0 8px;padding-left:18px}
.lbl{font-weight:650;margin-top:6px}
@media (max-width:860px){.cols{grid-template-columns:minmax(0,1fr)}.sheet{inset:0;border-radius:0;border:0}}
@media (max-width:480px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}header.top{position:static;padding:8px 16px}.controls{gap:6px}main{padding:10px 16px 32px}
.controls select{flex:1 1 40%}.cbody{padding:6px 8px 8px}.ccard{flex-basis:85%}.sheetbody{padding:10px}}
@media (prefers-reduced-motion:no-preference){.card{transition:border-color .12s}}
"""

JS = r"""
(function(){
'use strict';
var ADS = JSON.parse(document.getElementById('ad-data').textContent);
var $ = function(s,r){return (r||document).querySelector(s);};
function el(tag, attrs){
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs){
    var v = attrs[k]; if (v === null || v === undefined || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;   /* only used for server-rendered safe markdown */
    else if (k === 'cls') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (var i = 2; i < arguments.length; i++){
    var c = arguments[i]; if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) c.forEach(function(x){ if (x) n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    else n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}
function note(t){ return el('div',{cls:'note'},t); }
function fmtNum(n){ return (n === null || n === undefined) ? '' : Number(n).toLocaleString(); }
function fmtBytes(b){ if (!b) return ''; var u=['B','KB','MB','GB'],i=0; while(b>=1024&&i<3){b/=1024;i++;} return b.toFixed(i?1:0)+' '+u[i]; }
function fmtT(t){ if (t === null || t === undefined || t === '') return ''; t = Number(t); var m = Math.floor(t/60), s = (t - m*60); return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
function advName(a){ return (a.advertiser && (a.advertiser.name || a.advertiser.handle)) || 'Unknown advertiser'; }
function days(a){ var d = a.status && a.status.days_running; return (d === null || d === undefined) ? null : d; }
function scoreChips(a, big){
  var s = a.analysis && a.analysis.scores; if (!s) return null;
  var wrap = el('div',{cls: big ? 'scorerow' : 'chips'});
  [['hook','Hook'],['clarity','Clarity'],['proof','Proof'],['brand_fit','Fit']].forEach(function(p){
    if (s[p[0]] !== undefined && s[p[0]] !== null) wrap.appendChild(el('span',{cls:'chip', title:p[1]+' score'}, p[1]+' ', el('b',null,String(s[p[0]])), '/5'));
  });
  if (s.compliance_risk){ var r = String(s.compliance_risk).toLowerCase(); wrap.appendChild(el('span',{cls:'chip '+r, title:'Compliance risk'}, 'Risk ', el('b',null,r))); }
  return wrap.childNodes.length ? wrap : null;
}
function mediaEl(m, opts){
  opts = opts || {};
  if (!m) return el('div',{cls:'mediaerr'},'Media not fetched');
  if (m.file && m.file.ok){
    if (m.kind === 'video'){
      var v = el('video',{src:m.file.src, controls:true, preload:'metadata', playsinline:true, poster:(m.poster && m.poster.ok) ? m.poster.src : null});
      v.addEventListener('error', function(){
        if (v.nextSibling && v.nextSibling.className === 'mediaerr') return;
        v.parentNode && v.parentNode.insertBefore(el('div',{cls:'mediaerr'}, 'This browser cannot play the video. ', el('a',{href:m.file.src, style:'color:#fff'}, 'Open ' + m.file.rel)), v.nextSibling);
      });
      return v;
    }
    return el('img',{src:m.file.src, alt:opts.alt || 'Ad '+m.kind, loading:'lazy'});
  }
  var why = m.error ? ('Not fetched: ' + m.error) : (m.file ? 'Not fetched (missing file ' + m.file.rel + ')' : 'Not fetched (no local file)');
  var box = el('div',{cls:'mediaerr'}, el('div',null, (m.kind||'media') + ' - ' + why));
  if (m.poster && m.poster.ok) return el('div',null, el('img',{src:m.poster.src, alt:'Poster', loading:'lazy', style:'width:100%;display:block'}), box);
  if (m.url) box.appendChild(el('div',{style:'margin-top:6px'}, 'Source: ', el('code',null,m.url)));
  return box;
}

/* ---------------- grid ---------------- */
var state = { q:'', adv:'', fmt:'', active:false, sort:'days' };
var visible = [];
function fillSelect(sel, values){ values.forEach(function(v){ sel.appendChild(el('option',{value:v[0]}, v[1])); }); }
var advCounts = {}; ADS.forEach(function(a){ var n = advName(a); advCounts[n] = (advCounts[n]||0)+1; });
fillSelect($('#f-adv'), Object.keys(advCounts).sort(function(a,b){return a.localeCompare(b);}).map(function(n){ return [n, n+' ('+advCounts[n]+')']; }));
var fmts = {}; ADS.forEach(function(a){ fmts[a.format] = (fmts[a.format]||0)+1; });
fillSelect($('#f-fmt'), Object.keys(fmts).sort().map(function(f){ return [f, f+' ('+fmts[f]+')']; }));

function scoreSum(a){ var s = a.analysis && a.analysis.scores; if (!s) return -1; return ['hook','clarity','proof','brand_fit'].reduce(function(t,k){ return t + (Number(s[k])||0); },0); }
function applyFilters(){
  var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  visible = ADS.filter(function(a){
    if (state.adv && advName(a) !== state.adv) return false;
    if (state.fmt && a.format !== state.fmt) return false;
    if (state.active && !(a.status && a.status.active)) return false;
    for (var i=0;i<terms.length;i++) if (a.search.indexOf(terms[i]) < 0) return false;
    return true;
  });
  var cmp = {
    days: function(a,b){ return (days(b)===null?-1:days(b)) - (days(a)===null?-1:days(a)); },
    newest: function(a,b){ return String((b.status||{}).start_date||'').localeCompare(String((a.status||{}).start_date||'')); },
    score: function(a,b){ return scoreSum(b) - scoreSum(a); },
    adv: function(a,b){ return advName(a).localeCompare(advName(b)) || ((days(b)||0)-(days(a)||0)); }
  }[state.sort];
  visible.sort(function(a,b){ return cmp(a,b) || a.id.localeCompare(b.id); });
  renderGrid();
}
function card(a){
  var st = a.status || {}, d = days(a), c = a.copy || {};
  var thumb = el('div',{cls:'thumb'},
    a.thumb ? el('img',{src:a.thumb, alt:'', loading:'lazy'}) : el('div',{cls:'none'},'No media fetched'),
    el('span',{cls:'badge fmt f-'+a.format}, a.format),
    a.has_video ? el('span',{cls:'play', 'aria-hidden':'true'}, '\u25B6 video') : (a.media.length > 1 ? el('span',{cls:'play','aria-hidden':'true'}, a.media.length + ' items') : null));
  var verdict = a.analysis && a.analysis.verdict;
  return el('a',{cls:'card', href:'#'+encodeURIComponent(a.id), 'data-id':a.id, 'aria-label': advName(a) + ', ' + a.format + (d!==null ? ', ' + d + ' days running' : '')},
    thumb,
    el('div',{cls:'cbody'},
      el('div',{cls:'adv', title:advName(a)}, advName(a)),
      el('div',{cls:'meta'},
        el('span',null, el('span',{cls:'dot'+(st.active?' on':'')}), st.active ? 'Active' : (st.active === false ? 'Inactive' : 'Status ?')),
        d !== null ? el('span',null, d + 'd') : null,
        (st.platforms && st.platforms.length) ? el('span',{title:st.platforms.join(', ')}, st.platforms.map(function(p){return String(p).slice(0,2).toUpperCase();}).join(' ')) : null,
        c.cta_text ? el('span',{cls:'cta'}, c.cta_text) : null),
      (c.headline || c.body) ? el('div',{cls:'hl'}, c.headline || c.body) : null,
      scoreChips(a),
      verdict ? el('div',{cls:'verdict'}, verdict) : null));
}
function renderGrid(){
  var g = $('#grid'); g.textContent = '';
  if (!ADS.length){ g.appendChild(el('div',{cls:'empty'},'No ads in the library yet. Fetch some, then rebuild.')); }
  else if (!visible.length){ g.appendChild(el('div',{cls:'empty'},'No ads match these filters.')); }
  visible.forEach(function(a){ g.appendChild(card(a)); });
  $('#count').textContent = visible.length + ' of ' + ADS.length + ' ads';
}
$('#q').addEventListener('input', function(e){ state.q = e.target.value; applyFilters(); });
$('#f-adv').addEventListener('change', function(e){ state.adv = e.target.value; applyFilters(); });
$('#f-fmt').addEventListener('change', function(e){ state.fmt = e.target.value; applyFilters(); });
$('#f-active').addEventListener('change', function(e){ state.active = e.target.checked; applyFilters(); });
$('#f-sort').addEventListener('change', function(e){ state.sort = e.target.value; applyFilters(); });

/* ---------------- detail ---------------- */
var detail = $('#detail'), lastFocus = null, current = null;
function blk(title, content, id){ return el('section',{cls:'blk', id:id||null}, el('h2',null,title), content); }
function adMock(a){
  var c = a.copy || {}, adv = advName(a), st = a.status || {};
  var linkHost = ''; try { if (c.link_url) linkHost = new URL(c.link_url).hostname.replace(/^www\./,''); } catch(e) {}
  var head = el('div',{cls:'ph'}, el('div',{cls:'avatar','aria-hidden':'true'}, adv.charAt(0).toUpperCase()),
    el('div',null, el('div',{cls:'n'}, adv), el('div',{cls:'s'}, 'Sponsored' + (st.start_date ? ' \u00B7 since ' + st.start_date : ''))));
  var body = c.body ? el('div',{cls:'body'}, c.body) : el('div',{cls:'body'}, note('No body copy fetched'));
  var media;
  var useCards = a.cards && a.cards.length;
  if (useCards || a.format === 'carousel' || a.format === 'dco' || a.media.length > 1){
    var row = el('div',{cls:'carousel', role:'list', 'aria-label':'Carousel cards'});
    var items = useCards ? a.cards : a.media.map(function(m,i){ return {media_index:i}; });
    items.forEach(function(cd, k){
      var mi = (cd.media_index === undefined || cd.media_index === null) ? k : cd.media_index;
      var m = a.media[mi];
      row.appendChild(el('div',{cls:'ccard', role:'listitem'},
        el('div',{cls:'cm'}, mediaEl(m, {alt:'Card '+(k+1)})),
        (cd.title || cd.body || cd.cta_text) ? el('div',{cls:'ct'},
          el('div',null, cd.title ? el('div',{cls:'ahl'}, cd.title) : null, cd.body ? el('div',{cls:'ald'}, cd.body) : null,
            cd.link_url ? el('div',{cls:'cap', title:cd.link_url}, cd.link_url) : null),
          cd.cta_text ? el('span',{cls:'ctabtn'}, cd.cta_text) : null) : el('div',{cls:'ct ald'}, 'Card ' + (k+1))));
    });
    if (!items.length) row.appendChild(note('No media fetched'));
    media = row;
  } else {
    media = el('div',{cls:'media'}, a.media.length ? mediaEl(a.media[0], {alt:'Ad creative'}) : el('div',{cls:'mediaerr'},'Media not fetched'));
  }
  var foot = (c.headline || c.link_description || c.cta_text || c.caption || linkHost) ? el('div',{cls:'foot'},
    el('div',{cls:'t'}, (c.caption || linkHost) ? el('div',{cls:'cap'}, c.caption || linkHost) : null,
      c.headline ? el('div',{cls:'ahl'}, c.headline) : null,
      c.link_description ? el('div',{cls:'ald'}, c.link_description) : null),
    c.cta_text ? el('span',{cls:'ctabtn'}, c.cta_text) : null) : null;
  var url = el('div',{cls:'linkurl'}, c.link_url ? 'Link: ' + c.link_url : 'Link URL: not fetched');
  return el('div',{cls:'admock'}, head, body, media, foot, url);
}
function framesBlock(a){
  if (!a.frames.length) return note(a.has_video ? 'Frames not extracted' : 'No frames (not a video)');
  var groups = {};
  a.frames.forEach(function(f){ (groups[f.media_index||0] = groups[f.media_index||0] || []).push(f); });
  var wrap = el('div');
  Object.keys(groups).forEach(function(k){
    if (Object.keys(groups).length > 1) wrap.appendChild(el('div',{cls:'lbl'}, 'Media ' + (Number(k)+1)));
    wrap.appendChild(el('div',{cls:'frames'}, groups[k].map(function(f){
      return el('figure',null, f.file.ok ? el('a',{href:f.file.src, target:'_blank'}, el('img',{src:f.file.src, alt:'Frame at '+fmtT(f.t), loading:'lazy'})) : el('div',{cls:'note'},'missing'),
        el('figcaption',null, f.t !== null && f.t !== undefined ? fmtT(f.t) : ''));
    })));
  });
  return wrap;
}
function kv(pairs){
  var dl = el('dl',{cls:'kv'});
  pairs.forEach(function(p){ if (p[1] === null || p[1] === undefined || p[1] === '') return; dl.appendChild(el('dt',null,p[0])); dl.appendChild(el('dd',null,p[1])); });
  return dl;
}
function linkOrText(u){ return u ? el('a',{href:u, target:'_blank', rel:'noopener noreferrer'}, u) : null; }
function metaBlock(a){
  var st = a.status || {}, adv = a.advertiser || {}, e = a.engagement || {};
  var mediaRows = a.media.map(function(m,i){
    return el('li',null, '#' + (i+1) + ' ' + m.kind + (m.role ? ' (' + m.role + ')' : '') +
      (m.width && m.height ? ' \u00B7 ' + m.width + '\u00D7' + m.height : '') +
      (m.duration_s ? ' \u00B7 ' + Number(m.duration_s).toFixed(1) + 's' : '') +
      (m.bytes ? ' \u00B7 ' + fmtBytes(m.bytes) : '') +
      (m.file ? ' \u00B7 ' + m.file.rel + (m.file.ok ? '' : ' (missing)') : ' \u00B7 not fetched') +
      (m.error ? ' \u00B7 error: ' + m.error : ''));
  });
  var raw = el('details',null, el('summary',null,'Raw ad.json'), el('pre',null, JSON.stringify(a.raw, null, 2)));
  return el('div',null, kv([
    ['ID', a.id], ['Folder', a.folder], ['Source', a.source], ['Input URL', linkOrText(a.input_url)], ['Fetched', a.fetched_at],
    ['Advertiser', adv.name], ['Handle', adv.handle], ['Page ID', adv.page_id], ['Profile', linkOrText(adv.profile_url)],
    ['Active', st.active === true ? 'yes' : st.active === false ? 'no' : 'unknown'],
    ['Start', st.start_date], ['End', st.end_date || (st.active ? 'running' : null)], ['Days running', days(a) !== null ? String(days(a)) : null],
    ['Platforms', (st.platforms||[]).join(', ')], ['Format', a.format],
    ['CTA type', (a.copy||{}).cta_type],
    ['Likes', fmtNum(e.likes)], ['Comments', fmtNum(e.comments)], ['Views', fmtNum(e.views)], ['Plays', fmtNum(e.plays)]
  ]), mediaRows.length ? el('div',null, el('div',{cls:'lbl'},'Media'), el('ul',{cls:'ul2'}, mediaRows)) : null, raw);
}
function analysisBlock(a){
  var j = a.analysis, parts = [];
  if (j){
    var sc = scoreChips(a, true); if (sc) parts.push(sc);
    if (j.verdict) parts.push(el('p',null, el('b',null,'Verdict: '), j.verdict));
    if (j.angle) parts.push(el('p',null, el('b',null,'Angle: '), j.angle));
    ['steal','avoid'].forEach(function(k){
      if (Array.isArray(j[k]) && j[k].length) parts.push(el('div',null, el('div',{cls:'lbl'}, k === 'steal' ? 'Steal' : 'Avoid'), el('ul',{cls:'ul2'}, j[k].map(function(x){ return el('li',null,String(x)); }))));
    });
  }
  if (a.analysis_html) parts.push(el('div',{cls:'md', html:a.analysis_html}));
  else parts.push(note(j ? 'analysis.md not written yet' : 'Not analysed yet (no analysis.md / analysis.json)'));
  return el('div',null, parts);
}
function openDetail(id){
  var a = ADS.find(function(x){ return x.id === id; });
  if (!a){ closeDetail(true); return; }
  if (!detail.classList.contains('open')) lastFocus = document.activeElement;
  current = a;
  var c = a.copy || {};
  var body = $('#detail-body'); body.textContent = '';
  if (a.warnings.length) body.appendChild(el('div',{cls:'warn'}, a.warnings.join(' \u00B7 ')));
  var left = el('div',null, adMock(a));
  var right = el('div',null,
    blk('Analysis', analysisBlock(a)),
    blk('Transcript', a.transcript ? el('div',null, el('div',{cls:'transcript'}, a.transcript.text), a.transcript.source ? el('div',{cls:'ald', style:'margin-top:6px'}, 'Source: ' + a.transcript.source) : null)
                                   : note(a.has_video ? 'Transcript not fetched' : 'No transcript (no video)')));
  body.appendChild(el('div',{cls:'cols'}, left, right));
  body.appendChild(blk('Frames', framesBlock(a)));
  body.appendChild(blk('Contact sheet', (a.contact_sheet && a.contact_sheet.ok) ? el('div',{cls:'contact'}, el('a',{href:a.contact_sheet.src, target:'_blank'}, el('img',{src:a.contact_sheet.src, alt:'Contact sheet', loading:'lazy'}))) : note('Contact sheet not generated')));
  body.appendChild(blk('Metadata', metaBlock(a)));
  $('#detail-title').textContent = advName(a) + ' \u00B7 ' + a.format + (days(a) !== null ? ' \u00B7 ' + days(a) + 'd' : '') + (c.headline ? ' \u00B7 ' + c.headline : '');
  var idx = visible.indexOf(a);
  $('#prev').disabled = idx <= 0; $('#next').disabled = idx < 0 || idx >= visible.length - 1;
  detail.classList.add('open'); document.body.style.overflow = 'hidden';
  $('#detail-body').scrollTop = 0;
  $('#close').focus();
  document.title = advName(a) + ' - Ad viewer';
}
function closeDetail(fromHash){
  if (!detail.classList.contains('open')) return;
  detail.querySelectorAll('video').forEach(function(v){ try{ v.pause(); }catch(e){} });
  detail.classList.remove('open'); document.body.style.overflow = '';
  document.title = 'Ad viewer';
  if (!fromHash) history.pushState(null, '', location.pathname + location.search);
  var target = current && document.querySelector('.card[data-id="' + CSS.escape(current.id) + '"]');
  (target || lastFocus || document.body).focus && (target || lastFocus).focus();
  current = null;
}
function step(dir){
  if (!current) return; var i = visible.indexOf(current) + dir;
  if (i >= 0 && i < visible.length) location.hash = encodeURIComponent(visible[i].id);
}
function route(){
  var h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h) openDetail(h); else closeDetail(true);
}
$('#close').addEventListener('click', function(){ closeDetail(false); });
$('#prev').addEventListener('click', function(){ step(-1); });
$('#next').addEventListener('click', function(){ step(1); });
detail.addEventListener('click', function(e){ if (e.target === detail) closeDetail(false); });
document.addEventListener('keydown', function(e){
  if (!detail.classList.contains('open')){
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT'){ e.preventDefault(); $('#q').focus(); }
    return;
  }
  if (e.key === 'Escape'){ e.preventDefault(); closeDetail(false); }
  else if ((e.key === 'ArrowRight' || e.key === 'j') && !/INPUT|VIDEO/.test(document.activeElement.tagName)) step(1);
  else if ((e.key === 'ArrowLeft' || e.key === 'k') && !/INPUT|VIDEO/.test(document.activeElement.tagName)) step(-1);
  else if (e.key === 'Tab'){ /* keep focus inside the dialog */
    var f = detail.querySelectorAll('button:not([disabled]),a[href],video,[tabindex]:not([tabindex="-1"]),summary');
    if (!f.length) return; var first = f[0], last = f[f.length-1];
    if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }
});
window.addEventListener('hashchange', route);
applyFilters();
route();
})();
"""


def build_html(ads, lib, generated):
    data = json.dumps(ads, ensure_ascii=False, separators=(",", ":"))
    # make the blob safe inside <script>: no "</", "<!--" or U+2028/9 surprises
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026") \
               .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    n_an = sum(1 for a in ads if a["analysis"] or a["analysis_html"])
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; media-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>Ad viewer</title>
<style>%(css)s</style>
</head>
<body>
<header class="top">
  <div class="toprow"><h1>Competitor ad swipe file</h1><span class="count" id="count"></span>
  <span class="count">&middot; %(n_an)d analysed &middot; built %(gen)s</span></div>
  <div class="controls" role="search">
    <input type="search" id="q" placeholder="Search copy, transcript, analysis  ( / )" aria-label="Search ads">
    <select id="f-adv" aria-label="Advertiser"><option value="">All advertisers</option></select>
    <select id="f-fmt" aria-label="Format"><option value="">All formats</option></select>
    <select id="f-sort" aria-label="Sort">
      <option value="days">Longest running</option><option value="newest">Newest start</option>
      <option value="score">Highest score</option><option value="adv">Advertiser A-Z</option>
    </select>
    <label class="chk"><input type="checkbox" id="f-active"> Active only</label>
  </div>
</header>
<main><div class="grid" id="grid" aria-live="polite"></div></main>
<div id="detail" role="dialog" aria-modal="true" aria-labelledby="detail-title">
  <div class="sheet">
    <div class="sheethead">
      <button class="btn" id="prev" type="button" aria-label="Previous ad">&larr;</button>
      <button class="btn" id="next" type="button" aria-label="Next ad">&rarr;</button>
      <div class="title" id="detail-title"></div>
      <button class="btn" id="close" type="button" aria-label="Close detail">Close &times;</button>
    </div>
    <div class="sheetbody" id="detail-body"></div>
  </div>
</div>
<script type="application/json" id="ad-data">%(data)s</script>
<script>%(js)s</script>
</body>
</html>
""" % {"css": CSS, "js": JS, "data": data, "n_an": n_an, "gen": html.escape(generated)}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def cmd_build(args):
    lib = Path(args.library).expanduser().resolve()
    if not lib.is_dir():
        print("library not found: %s" % lib, file=sys.stderr)
        return 1
    out = Path(args.out).expanduser().resolve() if args.out else lib / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    ads = load_library(lib, out.parent)
    generated = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    out.write_text(build_html(ads, lib, generated), encoding="utf-8")
    missing = sum(1 for a in ads for m in a["media"] if not (m["file"] and m["file"]["ok"]))
    print("wrote %s  (%d ads, %d with analysis, %d media not fetched)" % (
        out, len(ads), sum(1 for a in ads if a["analysis"] or a["analysis_html"]), missing))
    for a in ads:
        for w in a["warnings"]:
            print("  warning %s: %s" % (a["id"], w), file=sys.stderr)
    return 0


def _cell(v):
    s = "" if v is None else str(v)
    return re.sub(r"\s+", " ", s).replace("|", "\\|").strip()


def cmd_summary(args):
    lib = Path(args.library).expanduser().resolve()
    if not lib.is_dir():
        print("library not found: %s" % lib, file=sys.stderr)
        return 1
    ads = load_library(lib, lib)
    print("# Ad library: %d ads (%s)\n" % (len(ads), lib))
    if not ads:
        print("_No ads yet._")
        return 0
    print("| id | advertiser | format | days | active | analysis | verdict |")
    print("|---|---|---|---:|---|---|---|")
    for a in ads:
        st = a["status"]
        has = "md+json" if a["analysis"] and a["analysis_html"] else "json" if a["analysis"] else \
              "md" if a["analysis_html"] else "-"
        verdict = (a["analysis"] or {}).get("verdict") or ""
        if len(verdict) > 90:
            verdict = verdict[:87] + "..."
        active = "yes" if st.get("active") is True else "no" if st.get("active") is False else "?"
        d = st.get("days_running")
        print("| %s |" % " | ".join(_cell(x) for x in [
            a["id"], (a["advertiser"] or {}).get("name") or (a["advertiser"] or {}).get("handle"),
            a["format"], "" if d is None else d, active, has, verdict]))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write a self-contained index.html")
    b.add_argument("--library", default=str(DEFAULT_LIBRARY))
    b.add_argument("--out", help="output file (default: <library>/index.html)")
    s = sub.add_parser("summary", help="print a markdown table of all ads")
    s.add_argument("--library", default=str(DEFAULT_LIBRARY))
    args = ap.parse_args(argv)
    return cmd_build(args) if args.cmd == "build" else cmd_summary(args)


if __name__ == "__main__":
    sys.exit(main())
