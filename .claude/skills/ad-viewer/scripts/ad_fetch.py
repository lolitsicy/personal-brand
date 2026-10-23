#!/usr/bin/env python3
"""Fetch a Facebook/Instagram ad or post, download its media, and lay it out for Claude to analyse.

Usage:
  ad_fetch.py fetch <url-or-ad-id> [--limit N] [--status ACTIVE|ALL] [--country NZ] [--no-transcript]
  ad_fetch.py from-json <raw.json> [--input-url URL] [--limit N]
  ad_fetch.py process <ad-dir>          # re-download missing media, rebuild frames and contact sheet
  ad_fetch.py list                      # one line per ad in the library

Accepts:
  https://www.facebook.com/ads/library/?id=123...            one ad
  123456789012345                                             one ad (Ad Library id)
  https://www.facebook.com/ads/library/?view_all_page_id=...  every ad a Page is running (top --limit)
  https://www.facebook.com/<page>   or   page:<name>         a brand's ads (resolved through the Ad Library)
  https://www.instagram.com/p/<code>/  or  /reel/<code>/      one Instagram post or reel
  https://www.instagram.com/<handle>/                          the handle's recent posts (organic, not ads)

Metadata comes from the ScrapeCreators API (set SCRAPECREATORS_API_KEY). Without a key, have Claude call the
ScrapeCreators connector (e.g. SCRAPECREATORS_GET_FACEBOOK_AD), save the response to a file and run from-json.
Media downloads and ffmpeg processing need direct internet access to the Meta CDNs (fbcdn.net, cdninstagram.com).
"""
import argparse
import datetime as dt
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("Install requests: pip install requests")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
LIBRARY = os.environ.get("AD_LIBRARY_DIR", os.path.join(REPO, "research", "competitor-ads", "library"))
API = os.environ.get("SCRAPECREATORS_BASE", "https://api.scrapecreators.com")

# ScrapeCreators REST paths. Field names below match the connector's output schema; the paths follow the
# public docs naming and can be overridden with SCRAPECREATORS_PATHS='{"fb_ad": "/v1/..."}' if they change.
PATHS = {
    "fb_ad": "/v1/facebook/adLibrary/ad",                       # ?id= | ?url=
    "fb_ad_transcript": "/v1/facebook/adLibrary/ad/transcript",  # ?id= | ?url=
    "fb_company_ads": "/v1/facebook/adLibrary/company/ads",      # ?pageId= | ?companyName=, &cursor=
    "fb_search_companies": "/v1/facebook/adLibrary/search/companies",  # ?query=
    "fb_profile": "/v1/facebook/profile",                       # ?url=
    "ig_post": "/v1/instagram/post",                            # ?url=
    "ig_transcript": "/v2/instagram/media/transcript",          # ?url=
    "ig_user_posts": "/v2/instagram/user/posts",                # ?handle=, &next_max_id=
}
PATHS.update(json.loads(os.environ.get("SCRAPECREATORS_PATHS", "{}")))

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
HOOK_TIMES = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0]   # dense sampling across the first 3 seconds
MAX_FRAMES = 16


# ---------- API ----------

def api_get(name, **params):
    key = os.environ.get("SCRAPECREATORS_API_KEY")
    if not key:
        sys.exit("SCRAPECREATORS_API_KEY is not set. Either set it, or fetch the JSON with the ScrapeCreators "
                 "connector and run: ad_fetch.py from-json <file>")
    params = {k: v for k, v in params.items() if v not in (None, "")}
    r = requests.get(API + PATHS[name], params=params, headers={"x-api-key": key}, timeout=90)
    if r.status_code == 404:
        sys.exit(f"{name}: 404 from {API + PATHS[name]}. The path may have changed; set SCRAPECREATORS_PATHS.")
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and "data" in data and "successful" in data:   # connector-style envelope
        data = data["data"]
    return data


# ---------- input parsing ----------

def classify(s):
    s = s.strip()
    if re.fullmatch(r"\d{8,20}", s):
        return "fb_ad", s
    if s.startswith("page:"):
        return "fb_page_name", s[5:].strip()
    u = urllib.parse.urlparse(s if "://" in s else "https://" + s)
    host, path = u.netloc.lower(), u.path.rstrip("/")
    q = urllib.parse.parse_qs(u.query)
    if "facebook.com" in host and "/ads/library" in path:
        if q.get("id"):
            return "fb_ad", q["id"][0]
        if q.get("view_all_page_id"):
            return "fb_page_id", q["view_all_page_id"][0]
        if q.get("q"):
            return "fb_page_name", q["q"][0]
    if "facebook.com" in host or "fb.com" in host:
        return "fb_page_url", s
    if "instagram.com" in host:
        m = re.match(r"^/(?:[^/]+/)?(p|reel|reels|tv)/([^/]+)", path)
        if m:
            return "ig_post", s
        handle = path.strip("/").split("/")[0]
        if handle:
            return "ig_handle", handle
    sys.exit(f"Don't know how to fetch: {s}")


# ---------- normalisation ----------

def _txt(v):
    if isinstance(v, dict):
        return v.get("text") or ""
    return v or ""


def _date(v):
    if v in (None, "", 0):
        return None
    if isinstance(v, (int, float)):
        return dt.datetime.fromtimestamp(v, dt.timezone.utc).date().isoformat()
    m = re.match(r"(\d{4}-\d{2}-\d{2})", str(v))
    return m.group(1) if m else str(v)


def _days(start, end, active):
    if not start:
        return None
    a = dt.date.fromisoformat(start)
    b = dt.date.today() if active or not end else dt.date.fromisoformat(end)
    return max((b - a).days, 0)


def norm_fb(ad, input_url=""):
    snap = ad.get("snapshot") or {}
    aid = str(ad.get("adArchiveID") or ad.get("ad_archive_id") or ad.get("adArchiveId") or "")
    active = ad.get("isActive", ad.get("is_active"))
    start = _date(ad.get("startDateString") or ad.get("startDate") or ad.get("start_date"))
    end = _date(ad.get("endDateString") or ad.get("endDate") or ad.get("end_date"))
    media, cards = [], []

    def add_img(img, role):
        url = img.get("original_image_url") or img.get("resized_image_url") or img.get("watermarked_resized_image_url")
        if url:
            media.append({"kind": "image", "role": role, "url": url})
            return len(media) - 1

    def add_vid(v, role):
        url = v.get("video_hd_url") or v.get("video_sd_url")
        if url:
            media.append({"kind": "video", "role": role, "url": url, "poster_url": v.get("video_preview_image_url")})
            return len(media) - 1

    for v in snap.get("videos") or []:
        add_vid(v, "main")
    for img in snap.get("images") or []:
        add_img(img, "main")
    for i, c in enumerate(snap.get("cards") or [], 1):
        idx = add_vid(c, f"card-{i}") if (c.get("video_hd_url") or c.get("video_sd_url")) else add_img(c, f"card-{i}")
        cards.append({"title": c.get("title"), "body": _txt(c.get("body")), "link_url": c.get("link_url"),
                      "link_description": c.get("link_description"), "cta_text": c.get("cta_text"), "media_index": idx})
    for v in snap.get("extra_videos") or []:
        add_vid(v, "extra")
    for img in snap.get("extra_images") or []:
        add_img(img, "extra")

    fmt = (snap.get("display_format") or "").upper()
    fmt = {"IMAGE": "image", "VIDEO": "video", "CAROUSEL": "carousel", "DCO": "dco", "DPA": "carousel", "MULTI_IMAGES": "carousel"}.get(
        fmt, "video" if any(m["kind"] == "video" for m in media) else ("carousel" if len(media) > 1 else ("image" if media else "unknown")))
    return {
        "id": f"fb-{aid}",
        "source": "facebook_ad_library",
        "input_url": input_url or ad.get("url") or f"https://www.facebook.com/ads/library/?id={aid}",
        "fetched_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "advertiser": {"name": snap.get("page_name") or ad.get("pageName") or ad.get("page_name"),
                       "page_id": str(snap.get("page_id") or ad.get("pageID") or ad.get("page_id") or ""),
                       "handle": snap.get("instagram_actor_name"), "profile_url": snap.get("page_profile_uri")},
        "status": {"active": active, "start_date": start, "end_date": end, "days_running": _days(start, end, active),
                   "platforms": ad.get("publisherPlatform") or ad.get("publisher_platform") or []},
        "copy": {"body": _txt(snap.get("body")), "headline": snap.get("title"), "link_description": snap.get("link_description"),
                 "caption": snap.get("caption"), "cta_text": snap.get("cta_text"), "cta_type": snap.get("cta_type"),
                 "link_url": snap.get("link_url")},
        "format": fmt, "media": media, "cards": cards, "transcript": None, "frames": [], "contact_sheet": None,
        "engagement": {"likes": None, "comments": None, "views": None, "plays": None},
        "spend": ad.get("spend"), "reach_estimate": ad.get("reachEstimate") or ad.get("reach_estimate"),
        "raw_file": "raw.json",
    }


def norm_ig(resp, input_url=""):
    m = (resp.get("data") or resp).get("xdt_shortcode_media") or resp.get("xdt_shortcode_media") or resp
    caption = ""
    edges = ((m.get("edge_media_to_caption") or {}).get("edges") or [])
    if edges:
        caption = edges[0].get("node", {}).get("text", "")
    media = []
    kids = ((m.get("edge_sidecar_to_children") or {}).get("edges") or [])
    if kids:
        for i, e in enumerate(kids, 1):
            n = e.get("node", {})
            media.append({"kind": "video" if n.get("is_video") else "image", "role": f"slide-{i}",
                          "url": n.get("video_url") if n.get("is_video") else n.get("display_url"), "poster_url": n.get("display_url")})
    else:
        media.append({"kind": "video" if m.get("is_video") else "image", "role": "main",
                      "url": m.get("video_url") if m.get("is_video") else m.get("display_url"), "poster_url": m.get("display_url")})
    owner = m.get("owner") or {}
    ts = m.get("taken_at_timestamp")
    start = _date(ts)
    return {
        "id": f"ig-{m.get('shortcode') or m.get('id')}",
        "source": "instagram_post",
        "input_url": input_url or f"https://www.instagram.com/p/{m.get('shortcode')}/",
        "fetched_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "advertiser": {"name": owner.get("full_name") or owner.get("username"), "page_id": owner.get("id"),
                       "handle": owner.get("username"), "profile_url": f"https://www.instagram.com/{owner.get('username')}/" if owner.get("username") else None},
        "status": {"active": None, "start_date": start, "end_date": None, "days_running": _days(start, None, True), "platforms": ["INSTAGRAM"]},
        "copy": {"body": caption, "headline": None, "link_description": None, "caption": None, "cta_text": None, "cta_type": None, "link_url": None},
        "format": "carousel" if len(media) > 1 else media[0]["kind"],
        "media": [x for x in media if x.get("url")], "cards": [], "transcript": None, "frames": [], "contact_sheet": None,
        "engagement": {"likes": (m.get("edge_media_preview_like") or {}).get("count"),
                       "comments": (m.get("edge_media_to_parent_comment") or {}).get("count"),
                       "views": m.get("video_view_count"), "plays": m.get("video_play_count")},
        "product_type": m.get("product_type"), "raw_file": "raw.json",
    }


# ---------- media ----------

def _ext(url, ctype):
    ext = mimetypes.guess_extension((ctype or "").split(";")[0].strip()) or os.path.splitext(urllib.parse.urlparse(url).path)[1]
    return {".jpe": ".jpg", ".jpeg": ".jpg", "": ".bin"}.get(ext, ext)


def download(url, dest_noext):
    with requests.get(url, headers={"User-Agent": UA, "Referer": "https://www.facebook.com/"}, stream=True, timeout=120) as r:
        r.raise_for_status()
        path = dest_noext + _ext(url, r.headers.get("content-type"))
        with open(path, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    return path


def probe(path):
    if not shutil.which("ffprobe"):
        return {}
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                              "-of", "json", path], capture_output=True, text=True, timeout=60).stdout
        j = json.loads(out or "{}")
        s = (j.get("streams") or [{}])[0]
        d = j.get("format", {}).get("duration")
        return {"width": s.get("width"), "height": s.get("height"), "duration_s": round(float(d), 2) if d and d != "N/A" else None}
    except Exception:
        return {}


def frame_times(duration):
    if not duration:
        return [0.0]
    ts = [t for t in HOOK_TIMES if t < duration]
    rest = MAX_FRAMES - len(ts) - 1   # leave room for the end card
    if duration > 3 and rest > 0:
        step = (duration - 3) / (rest + 1)
        ts += [round(3 + step * (i + 1), 1) for i in range(rest)]
    ts.append(max(duration - 0.1, 0))   # end card
    return sorted(set(round(t, 1) for t in ts))


def extract_frames(ad, folder):
    if not shutil.which("ffmpeg"):
        return
    shutil.rmtree(os.path.join(folder, "frames"), ignore_errors=True)   # rebuild cleanly on re-runs
    os.makedirs(os.path.join(folder, "frames"), exist_ok=True)
    frames = []
    for i, m in enumerate(ad["media"]):
        if m.get("kind") != "video" or not m.get("file"):
            continue
        src = os.path.join(folder, m["file"])
        for t in frame_times(m.get("duration_s")):
            rel = f"frames/{i + 1:02d}_{t:05.1f}s.jpg"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", src, "-frames:v", "1", "-vf", "scale=540:-2",
                            os.path.join(folder, rel)], timeout=60)
            if os.path.exists(os.path.join(folder, rel)):
                frames.append({"file": rel, "t": t, "media_index": i})
        if not m.get("poster") and frames:
            m["poster"] = frames[0]["file"]
        audio = os.path.join(folder, "media", f"{i + 1:02d}_audio.m4a")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-vn", "-c:a", "aac", "-b:a", "96k", audio], timeout=120)
        if os.path.exists(audio) and os.path.getsize(audio) > 0:
            m["audio"] = os.path.relpath(audio, folder)
    ad["frames"] = frames


def contact_sheet(ad, folder):
    if not shutil.which("ffmpeg"):
        return
    tiles = [f["file"] for f in ad["frames"]] or [m["file"] for m in ad["media"] if m.get("kind") == "image" and m.get("file")]
    if not tiles:
        return
    tiles = tiles[:16]
    cols = min(4, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    inputs, filt = [], []
    for i, t in enumerate(tiles):
        inputs += ["-i", os.path.join(folder, t)]
        filt.append(f"[{i}:v]scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:color=white[v{i}]")
    layout = "|".join(f"{(i % cols) * 270}_{(i // cols) * 480}" for i in range(len(tiles)))
    if len(tiles) == 1:
        filt.append("[v0]null[out]")
    else:
        filt.append("".join(f"[v{i}]" for i in range(len(tiles))) + f"xstack=inputs={len(tiles)}:layout={layout}:fill=white[out]")
    out = os.path.join(folder, "contact_sheet.jpg")
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filt), "-map", "[out]", "-frames:v", "1", out], timeout=120)
    if os.path.exists(out):
        ad["contact_sheet"] = "contact_sheet.jpg"


def local_transcribe(ad, folder):
    """Optional: transcribe with a local Whisper CLI if one is installed and the API gave nothing."""
    exe = shutil.which("whisper")
    audio = next((m.get("audio") for m in ad["media"] if m.get("audio")), None)
    if not exe or not audio:
        return
    subprocess.run([exe, os.path.join(folder, audio), "--model", "base", "--output_format", "txt", "--output_dir", folder], capture_output=True, timeout=900)
    txt = os.path.join(folder, os.path.splitext(os.path.basename(audio))[0] + ".txt")
    if os.path.exists(txt):
        ad["transcript"] = {"text": open(txt).read().strip(), "source": "whisper-local"}


def process(ad, folder):
    os.makedirs(os.path.join(folder, "media"), exist_ok=True)
    for i, m in enumerate(ad["media"]):
        if m.get("file") and os.path.exists(os.path.join(folder, m["file"])):
            continue
        try:
            path = download(m["url"], os.path.join(folder, "media", f"{i + 1:02d}"))
            m["file"] = os.path.relpath(path, folder)
            m["bytes"] = os.path.getsize(path)
            m.update({k: v for k, v in probe(path).items() if v is not None})
            m["error"] = None
            if m.get("kind") == "video" and m.get("poster_url"):
                try:
                    m["poster"] = os.path.relpath(download(m["poster_url"], os.path.join(folder, "media", f"{i + 1:02d}_poster")), folder)
                except Exception:
                    pass
        except Exception as e:  # expired CDN links are common; keep going
            m["error"] = f"{type(e).__name__}: {e}"[:300]
    extract_frames(ad, folder)
    contact_sheet(ad, folder)
    if not ad.get("transcript"):
        local_transcribe(ad, folder)


def save(ad, raw, folder):
    os.makedirs(folder, exist_ok=True)
    json.dump(raw, open(os.path.join(folder, "raw.json"), "w"), indent=1)
    json.dump(ad, open(os.path.join(folder, "ad.json"), "w"), indent=1, ensure_ascii=False)


def ingest(ad, raw, transcript=True):
    folder = os.path.join(LIBRARY, ad["id"])
    save(ad, raw, folder)
    if transcript and any(m["kind"] == "video" for m in ad["media"]) and os.environ.get("SCRAPECREATORS_API_KEY"):
        try:
            if ad["source"] == "facebook_ad_library":
                t = api_get("fb_ad_transcript", id=ad["id"][3:])
            else:
                t = api_get("ig_transcript", url=ad["input_url"])
            text = t.get("transcript") if isinstance(t, dict) else None
            if isinstance(text, list):
                text = "\n".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in text)
            if not text and isinstance(t, dict) and isinstance(t.get("transcripts"), list):
                text = "\n".join(x.get("text", "") for x in t["transcripts"] if isinstance(x, dict))
            if text:
                ad["transcript"] = {"text": text, "source": "scrapecreators"}
        except SystemExit:
            raise
        except Exception as e:
            ad["transcript_error"] = str(e)[:300]
    process(ad, folder)
    save(ad, raw, folder)
    ok = sum(1 for m in ad["media"] if m.get("file"))
    print(f"{ad['id']}: {ad['advertiser']['name']} · {ad['format']} · {ok}/{len(ad['media'])} media · "
          f"{len(ad['frames'])} frames · transcript {'yes' if ad.get('transcript') else 'no'} → {os.path.relpath(folder, REPO)}")
    return folder


# ---------- commands ----------

def rank(items):
    def key(a):
        s = norm_fb(a)
        return s["status"]["days_running"] or 0
    return sorted(items, key=key, reverse=True)


def fetch_page_ads(page_id=None, name=None, limit=10, status="ACTIVE", country="ALL", transcript=True):
    items, cursor = [], None
    while len(items) < max(limit * 3, 30):
        r = api_get("fb_company_ads", pageId=page_id, companyName=None if page_id else name, status=status, country=country, cursor=cursor)
        items += r.get("results") or r.get("items") or r.get("ads") or []
        cursor = r.get("cursor") or r.get("next_cursor")
        if not cursor or not (r.get("has_more", True)):
            break
    print(f"{len(items)} ads found; keeping the {limit} longest-running")
    for a in rank(items)[:limit]:
        ingest(norm_fb(a), a, transcript)


def cmd_fetch(args):
    kind, val = classify(args.target)
    if kind == "fb_ad":
        raw = api_get("fb_ad", id=val)
        ingest(norm_fb(raw, args.target if "://" in args.target else ""), raw, not args.no_transcript)
    elif kind == "fb_page_id":
        fetch_page_ads(page_id=val, limit=args.limit, status=args.status, country=args.country, transcript=not args.no_transcript)
    elif kind == "fb_page_name":
        fetch_page_ads(name=val, limit=args.limit, status=args.status, country=args.country, transcript=not args.no_transcript)
    elif kind == "fb_page_url":
        prof = api_get("fb_profile", url=val)
        pid = prof.get("pageId") or prof.get("adLibrary", {}).get("pageId") or prof.get("id")
        if not pid:
            sys.exit("Couldn't resolve that Page to an Ad Library page id. Try page:<brand name> or the Ad Library URL.")
        fetch_page_ads(page_id=str(pid), limit=args.limit, status=args.status, country=args.country, transcript=not args.no_transcript)
    elif kind == "ig_post":
        raw = api_get("ig_post", url=val)
        ingest(norm_ig(raw, val), raw, not args.no_transcript)
    elif kind == "ig_handle":
        r = api_get("ig_user_posts", handle=val)
        posts = r.get("items") or r.get("posts") or []
        print(f"{len(posts)} posts on @{val} (organic posts, not ads; for ads use page:<brand>)")
        for p in posts[: args.limit]:
            code = p.get("code") or p.get("shortcode")
            if code:
                url = f"https://www.instagram.com/p/{code}/"
                raw = api_get("ig_post", url=url)
                ingest(norm_ig(raw, url), raw, not args.no_transcript)


def cmd_from_json(args):
    raw = json.load(open(args.file))
    if isinstance(raw, dict) and "data" in raw and "successful" in raw:
        raw = raw["data"]
    if isinstance(raw, dict) and ("items" in raw or "results" in raw):
        items = raw.get("items") or raw.get("results")
        for a in rank(items)[: args.limit]:
            ingest(norm_fb(a), a, False)
    elif isinstance(raw, dict) and ("snapshot" in raw or "adArchiveID" in raw):
        ingest(norm_fb(raw, args.input_url or ""), raw, False)
    elif isinstance(raw, dict) and ("xdt_shortcode_media" in raw or "xdt_shortcode_media" in (raw.get("data") or {})):
        ingest(norm_ig(raw, args.input_url or ""), raw, False)
    else:
        sys.exit("Unrecognised JSON: expected a ScrapeCreators ad, company-ads page, or Instagram post response.")


def cmd_process(args):
    folder = os.path.abspath(args.dir)
    ad = json.load(open(os.path.join(folder, "ad.json")))
    raw = json.load(open(os.path.join(folder, "raw.json"))) if os.path.exists(os.path.join(folder, "raw.json")) else {}
    process(ad, folder)
    save(ad, raw, folder)
    print(f"{ad['id']}: {len(ad['frames'])} frames, contact sheet {'yes' if ad.get('contact_sheet') else 'no'}")


def cmd_list(_):
    if not os.path.isdir(LIBRARY):
        return
    for d in sorted(os.listdir(LIBRARY)):
        p = os.path.join(LIBRARY, d, "ad.json")
        if os.path.exists(p):
            a = json.load(open(p))
            done = "analysed" if os.path.exists(os.path.join(LIBRARY, d, "analysis.md")) else "to analyse"
            print(f"{a['id']}\t{a['advertiser']['name']}\t{a['format']}\t{a['status'].get('days_running')}d\t{done}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("target")
    f.add_argument("--limit", type=int, default=10)
    f.add_argument("--status", default="ACTIVE", choices=["ACTIVE", "ALL", "INACTIVE"])
    f.add_argument("--country", default="ALL")
    f.add_argument("--no-transcript", action="store_true")
    j = sub.add_parser("from-json")
    j.add_argument("file")
    j.add_argument("--input-url")
    j.add_argument("--limit", type=int, default=10)
    p = sub.add_parser("process")
    p.add_argument("dir")
    sub.add_parser("list")
    args = ap.parse_args()
    {"fetch": cmd_fetch, "from-json": cmd_from_json, "process": cmd_process, "list": cmd_list}[args.cmd](args)


if __name__ == "__main__":
    main()
