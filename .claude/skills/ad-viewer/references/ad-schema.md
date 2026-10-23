# ad.json (normalised ad record)

One folder per ad: `research/competitor-ads/library/<id>/`. Paths inside are relative to that folder.

```json
{
  "id": "fb-1185617869915074",            // fb-<adArchiveID> | ig-<shortcode>
  "source": "facebook_ad_library",         // facebook_ad_library | instagram_post
  "input_url": "https://www.facebook.com/ads/library?id=1185617869915074",
  "fetched_at": "2026-10-23T10:00:00Z",
  "advertiser": {"name": "rhode", "page_id": "109162541773169", "handle": "rhode", "profile_url": "https://..."},
  "status": {"active": true, "start_date": "2026-09-01", "end_date": null, "days_running": 52, "platforms": ["FACEBOOK", "INSTAGRAM"]},
  "copy": {"body": "...", "headline": "...", "link_description": "...", "caption": "...", "cta_text": "Shop now", "cta_type": "SHOP_NOW", "link_url": "https://..."},
  "format": "video",                       // image | video | carousel | dco | unknown
  "media": [
    {"kind": "video", "role": "main", "url": "https://...", "file": "media/01.mp4", "poster": "media/01_poster.jpg",
     "width": 1080, "height": 1920, "duration_s": 14.2, "bytes": 2345678, "error": null}
  ],
  "cards": [{"title": "...", "body": "...", "link_url": "...", "cta_text": "...", "media_index": 1}],
  "transcript": {"text": "...", "source": "scrapecreators" },   // or null
  "frames": [{"file": "frames/01_000.0s.jpg", "t": 0.0, "media_index": 0}],
  "contact_sheet": "contact_sheet.jpg",    // grid of frames (videos) or images, for one-look review
  "engagement": {"likes": null, "comments": null, "views": null, "plays": null},
  "raw_file": "raw.json"
}
```

Claude writes the analysis next to it:
- `analysis.md`: the full teardown (rubric in `analysis-rubric.md`).
- `analysis.json`: `{"verdict": "...", "scores": {"hook": 0-5, "clarity": 0-5, "proof": 0-5, "brand_fit": 0-5, "compliance_risk": "low|medium|high"}, "angle": "...", "steal": ["..."], "avoid": ["..."]}`
