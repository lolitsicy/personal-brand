---
name: ad-viewer
description: Pull a real Facebook or Instagram ad (or a brand's ads, or an Instagram post or reel), download the actual video or image, fetch the ad copy and transcript, sample frames, and give Claude everything it needs to tear the ad down properly. Builds a local viewer page of every ad pulled. Use when the user pastes a Meta Ad Library link, an ad id, a Facebook Page, an Instagram post/reel/profile link, or says "analyse this ad", "pull their ads", "what is this ad doing", "download this ad", or wants a swipe file with the real creative.
---

# Ad viewer

Input → fetch metadata → download media → frames, contact sheet, audio → Claude analyses → viewer page.

Everything lands in `research/competitor-ads/library/<id>/` (`fb-<ad archive id>` or `ig-<shortcode>`). The record format is in `references/ad-schema.md`; the teardown rubric is in `references/analysis-rubric.md`. For brand context and our competitor list, use the `competitor-ad-intel` skill's references.

## 1. Work out what was passed

| Input | What gets fetched |
|---|---|
| Ad Library link with `?id=` or a bare ad id | that ad |
| Ad Library link with `view_all_page_id=`, a Facebook Page link, or `page:<brand>` | the brand's ads, ranked by days running, top `--limit` (default 10) |
| `instagram.com/p/...` or `/reel/...` | that post or reel |
| `instagram.com/<handle>` | recent organic posts (not ads: for a brand's Instagram ads use `page:<brand>`) |

## 2. Fetch

**With an API key** (`SCRAPECREATORS_API_KEY` set, and the machine can reach the internet):
```bash
python3 .claude/skills/ad-viewer/scripts/ad_fetch.py fetch "<url or id>" [--limit 10] [--status ALL] [--country NZ]
```

**Without a key, through the ScrapeCreators connector** (Composio): call the matching tool, save its full JSON response to a file, and hand it to the script:
- one ad: `SCRAPECREATORS_GET_FACEBOOK_AD` (`url` or `ad_id`)
- a brand: `SCRAPECREATORS_LIST_FACEBOOK_COMPANY_ADS` (`page_id` or `company_name`, `status`, `country`)
- Instagram: `SCRAPECREATORS_GET_INSTAGRAM_POST` (`url`)
- transcripts: `SCRAPECREATORS_GET_FACEBOOK_AD_TRANSCRIPT` / `SCRAPECREATORS_GET_INSTAGRAM_MEDIA_TRANSCRIPT`. Paste the text into `ad.json` → `transcript: {"text": ..., "source": "scrapecreators"}`.
```bash
python3 .claude/skills/ad-viewer/scripts/ad_fetch.py from-json /path/to/response.json --input-url "<original url>"
```

The script downloads every image and video (cards and carousel slides included), probes size and duration, samples up to 16 frames (dense across 0 to 3 s for the hook, then even spacing, plus the end card), extracts the audio, builds `contact_sheet.jpg`, and transcribes locally with Whisper if it's installed and no transcript came back. Re-run media steps with `ad_fetch.py process <ad dir>`.

Meta CDN links expire within hours to days. If a download fails (`media[].error`), re-fetch the ad rather than reusing the old JSON.

## 3. Analyse

For each ad folder:
1. Read `ad.json` (copy, dates, platforms, cards, transcript).
2. Look at `contact_sheet.jpg` first, then the individual frames in `frames/` (always 0.0 to 3.0 s, then wherever the contact sheet shows a change), and every image in `media/`.
3. Write `analysis.md` following `references/analysis-rubric.md`, and `analysis.json` with the scores.

Don't analyse what wasn't fetched: a missing transcript or a failed video is stated, not guessed. When several ads from one brand are in, also write the cross-ad report the rubric describes.

## 4. View

```bash
python3 .claude/skills/ad-viewer/scripts/viewer.py build     # writes research/competitor-ads/library/index.html
python3 .claude/skills/ad-viewer/scripts/viewer.py summary   # markdown table for Claude
```
`index.html` opens from disk and plays the downloaded media. It shows the copy laid out like the ad, the frame strip, the contact sheet, the transcript and the analysis, with filters by brand, format and status.

## Requirements and limits

- Python 3 with `requests`; `ffmpeg`/`ffprobe` for frames, audio and the contact sheet; optional `whisper` CLI.
- Outbound access to `api.scrapecreators.com`, `*.fbcdn.net` and `*.cdninstagram.com`. A restricted cloud sandbox blocks these: run the script locally, or add those hosts to the environment's allowed domains.
- The Ad Library only exposes what Meta publishes: no spend or results for commercial ads outside the EU/UK, so days running and the number of variants are the performance proxies.
- Downloaded creative is for internal analysis. Don't republish competitors' assets.
