"""Builds calendar.html (the launch schedule page) from posts.csv plus the ad flighting below.

Run: python3 build_calendar.py
"""
import csv
import datetime as dt
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
START = dt.date(2026, 10, 19)
END = dt.date(2026, 12, 20)

ADS = [
    # (phase, campaign, ad sets, start, end, note)
    ("PRE", "C1 Hook Test", "Effort gap · Science · Identity", "2026-10-21", "2026-11-22", "Type-led statics. Find the winning hook before photos land."),
    ("PRE", "C5 First Edition: nudge + first access", "Gentle nudge · First access", "2026-11-16", "2026-12-02", "Retarget site visitors 30d + engagers 60d, excl. waitlist."),
    ("PRE", "C4 Creators", "Creators", "2026-11-17", "2026-12-02", "Partnership ads on the creator Reels posted 17, 20, 26 Nov."),
    ("PRE", "C2 The Object", "Product hero · In her life · Precision", "2026-11-23", "2026-12-02", "Real shoot photos. Use C1's winning angle first."),
    ("PRE", "C3 Problem to Fix", "3pm gap · Tried everything · Read the label", "2026-11-23", "2026-12-02", "Same budget pool as C2 via CBO."),
    ("PRE", "C4 Ritual + Founder/FAQ", "Ritual · Founder and FAQ", "2026-11-23", "2026-12-02", "Warm: engagers + video viewers."),
    ("PRE", "C5 Founding offer [CONFIRM]", "Founding offer", "2026-11-27", "2026-12-02", "Counter-programme Black Friday. Only if founding pricing is real."),
    ("LAUNCH", "L3 Waitlist to buyer", "Waitlist custom audience", "2026-12-02", "2026-12-13", "Early access day, then launch. Highest priority budget."),
    ("LAUNCH", "L1 Launch announcement", "Broad cold", "2026-12-03", "2026-12-20", "Sales objective. Winners from C2/C3 with CTA 'shop now'."),
    ("LAUNCH", "L2 Formula reveal", "Cold + warm", "2026-12-03", "2026-12-20", "Ingredient ads 33/34 with new CTA."),
    ("LAUNCH", "L4 Site visitors and cart", "Visitors + ATC, excl. purchasers", "2026-12-04", "2026-12-20", "Retargeting. Proof, FAQ, first edition."),
]

MILESTONES = [
    ("2026-10-21", "Waitlist opens, first post"),
    ("2026-11-11", "Shoot starts, New York (11–14 Nov)"),
    ("2026-11-22", "Final shoot photos due"),
    ("2026-11-23", "Product reveal"),
    ("2026-11-27", "Black Friday: costs spike, don't scale"),
    ("2026-11-30", "Formula reveal · test pixel Purchase event"),
    ("2026-12-02", "Waitlist early access [CONFIRM] · PRE campaigns off at 23:59"),
    ("2026-12-03", "LAUNCH · LAUNCH campaigns on"),
    ("2026-12-16", "Christmas shipping cut-off [CONFIRM]"),
]


def main():
    with open(os.path.join(HERE, "posts.csv")) as f:
        posts = list(csv.DictReader(f))
    for p in posts:
        p["caption"] = p["caption"].split("\n\nAlways read the label")[0] + (" + footer" if "Always read the label" in p["caption"] else "")
    total_days = (END - START).days + 1
    ads_json = [dict(phase=a[0], name=a[1], sets=a[2], start=a[3], end=a[4], note=a[5],
                     left=round(((dt.date.fromisoformat(a[3]) - START).days) / total_days * 100, 2),
                     width=round(((dt.date.fromisoformat(a[4]) - dt.date.fromisoformat(a[3])).days + 1) / total_days * 100, 2))
                for a in ADS]
    ms_json = [dict(date=d, label=l, left=round((dt.date.fromisoformat(d) - START).days / total_days * 100, 2)) for d, l in MILESTONES]
    weeks = []
    d = START
    while d <= END:
        weeks.append(dict(label=d.strftime("%-d %b"), left=round((d - START).days / total_days * 100, 2)))
        d += dt.timedelta(days=7)
    tpl = open(os.path.join(HERE, "calendar.template.html")).read()
    out = (tpl.replace("__POSTS__", json.dumps(posts))
              .replace("__ADS__", json.dumps(ads_json))
              .replace("__MILESTONES__", json.dumps(ms_json))
              .replace("__WEEKS__", json.dumps(weeks)))
    open(os.path.join(HERE, "calendar.html"), "w").write(out)
    print("posts", len(posts), "ads", len(ads_json))


if __name__ == "__main__":
    main()
