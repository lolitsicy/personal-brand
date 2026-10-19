#!/usr/bin/env python3
"""Rank Meta Ad Library results by longevity and variant count.

Usage:
    python3 rank_ads.py raw1.json [raw2.json ...] [--top 15] [--json] [--exclude-page "Name" ...]

Accepts the saved output of mcp__Meta_Ads__ads_library_search in either shape:
  {"results": "<json string>", ...}   (the raw tool result)
  {"estimated_total_count": N, "ads": [...]}

Score = days_live * (1 + ln(variants)), where variants is the number of ads the
same page started within +/- VARIANT_WINDOW_DAYS. Long-running ads and ads that
an advertiser keeps iterating on are a rough signal of spend. It is a proxy,
not performance data.
"""
import argparse
import json
import math
import sys
import time
from collections import defaultdict

VARIANT_WINDOW_DAYS = 3
DAY = 86400


def load_ads(path):
    with open(path) as f:
        data = json.load(f)
    if isinstance(data.get("results"), str):
        data = json.loads(data["results"])
    return data.get("ads", [])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("files", nargs="+")
    p.add_argument("--top", type=int, default=15)
    p.add_argument("--json", action="store_true", help="emit JSON instead of a markdown table")
    p.add_argument("--exclude-page", action="append", default=[], help="page name to drop (repeatable)")
    args = p.parse_args()

    ads = {}
    for path in args.files:
        for ad in load_ads(path):
            ads[ad["id"]] = ad  # de-dupe across queries
    excluded = {n.strip().lower() for n in args.exclude_page}
    ads = [a for a in ads.values() if a.get("page_name", "").strip().lower() not in excluded]

    now = time.time()
    by_page = defaultdict(list)
    for ad in ads:
        start = ad.get("ad_delivery_start_time") or ad.get("ad_creation_time")
        if start is None:
            continue
        stop = ad.get("ad_delivery_stop_time") or now
        ad["_start"] = int(start)
        ad["_days_live"] = max(0.0, (int(stop) - int(start)) / DAY)
        by_page[ad.get("page_id")].append(ad)

    ranked = []
    for page_ads in by_page.values():
        for ad in page_ads:
            variants = sum(
                1 for other in page_ads
                if abs(other["_start"] - ad["_start"]) <= VARIANT_WINDOW_DAYS * DAY
            )
            ad["_variants"] = variants
            ad["_score"] = round(ad["_days_live"] * (1 + math.log(variants)), 1)
            ranked.append(ad)
    ranked.sort(key=lambda a: a["_score"], reverse=True)
    ranked = ranked[: args.top]

    if args.json:
        out = [{
            "id": a["id"],
            "page_name": a.get("page_name", "").strip(),
            "page_id": a.get("page_id"),
            "days_live": round(a["_days_live"], 1),
            "variants": a["_variants"],
            "score": a["_score"],
            "link_title": a.get("ad_creative_link_title", ""),
            "ad_snapshot_url": a.get("ad_snapshot_url"),
        } for a in ranked]
        json.dump(out, sys.stdout, indent=2)
        print()
        return

    print("| # | Advertiser | Days live | Variants | Score | Link title | Snapshot |")
    print("|---|---|---|---|---|---|---|")
    for i, a in enumerate(ranked, 1):
        title = (a.get("ad_creative_link_title") or "").replace("|", "/")
        print(f"| {i} | {a.get('page_name', '').strip()} | {a['_days_live']:.0f} | {a['_variants']} "
              f"| {a['_score']} | {title} | {a.get('ad_snapshot_url')} |")
    print(f"\n{len(by_page)} advertisers, {sum(len(v) for v in by_page.values())} ads. "
          "Score is a longevity/iteration proxy, not performance data.")


if __name__ == "__main__":
    main()
