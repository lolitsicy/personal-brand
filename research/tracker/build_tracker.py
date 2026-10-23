"""Builds the creative tracker's seed data (one JSON file per db document) from the plans and the Canva inventory.

Run: python3 build_tracker.py   -> writes seed/items/<id>.json, seed/facts/<key>.json and seed/batches.json
Then load the seed into the tracker artifact's db (collections "items" and "facts").
"""
import csv
import json
import os
import re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "seed")

FACTS = [
    # key, label, question
    ("price", "Price", "Retail price per bottle (NZD and AUD)."),
    ("dose", "Dose and when to take it", "How many capsules a day, and when (e.g. with breakfast)."),
    ("ingredient4", "Ingredient 4", "The fourth ingredient's name (formula reveal 30 Nov)."),
    ("label_disclosure", "Every dose on the label", "Confirm the label lists every ingredient and dose, with no proprietary blend."),
    ("run_size", "First edition run size", "How many units in the first edition, and is it genuinely limited?"),
    ("shipping_offer", "Shipping offer", "Free shipping threshold or flat rate, NZ and AU."),
    ("policies", "Shipping, returns, subscriptions", "Shipping times, returns policy and how subscriptions work."),
    ("subscription", "Subscription discount", "Subscribe-and-save percentage, and can people pause anytime?"),
    ("founding_price", "Founding price", "Is there a founding price for waitlist members? Amount and end date."),
    ("early_access_date", "Waitlist early access", "When early access opens and how far ahead of launch (planned 2 Dec)."),
    ("waitlist_close_date", "Waitlist close date", "The date the waitlist closes, if it does."),
    ("shipping_cutoffs", "Christmas shipping cut-offs", "Last order dates for Christmas delivery in NZ and AU."),
    ("third_perk", "Third waitlist perk", "The third perk waitlist members get (ad C5-48)."),
    ("founder_note", "Founder note", "40 to 60 words from the founder (ad C4-39)."),
    ("founder_story", "Founder story", "The founder's real story and wording for the founder Reels (S022, S100)."),
    ("name_story", "Name story", "What 'maison' and 'belasi' mean to you, and the brand promise (S004)."),
    ("founder_qa", "Founder Q&A answers", "The real questions from 1 Nov and the founder's answers (S023)."),
    ("creators", "Creator names", "Creator handles and whether each is paid or gifted (#ad or #gifted)."),
    ("creator_product_date", "Creators have product", "Confirm creators have product in hand before they film (by 26 Nov)."),
    ("gift_items", "Gift guide items", "The accessory and ritual set in the gift guide (S096)."),
    ("box_contents", "What's in the box", "What the first-edition box actually contains (unboxing, S086)."),
    ("packed_by_hand", "Packed by hand", "Is the first edition genuinely packed by hand?"),
    ("real_product_on_set", "Real product on set", "Were the capsules and bottle on set real product, not stand-ins?"),
    ("studiovic_handle", "StudioVIC handle", "StudioVIC's Instagram and TikTok handle for credits (S037)."),
    ("review", "First real review", "A verified customer review, with their permission to use it. Never write one."),
]
FACT_KEYS = {k for k, _, _ in FACTS}

# Text patterns that mean a creative depends on a fact.
RULES = [
    (r"\[price\]|price \[confirm|confirm[^\]]*price", "price"),
    (r"\[dose|confirm dose|dose confirm|\[dose\]|two capsules|when to take", "dose"),
    (r"\[ingredient 4\]|full formula\]|confirm full formula", "ingredient4"),
    (r"proprietary blend|every dose on the label|every ingredient (and dose )?listed|doses you can see", "label_disclosure"),
    (r"\[run size\]|limited run|first edition is limited|first run is small|first edition only|when it's gone|limited\b", "run_size"),
    (r"\[shipping offer\]", "shipping_offer"),
    (r"\[details\]|confirm all", "policies"),
    (r"\[save x%\]|subscribe and", "subscription"),
    (r"founding pric|founding offer", "founding_price"),
    (r"early access", "early_access_date"),
    (r"waitlist closes", "waitlist_close_date"),
    (r"cut-off", "shipping_cutoffs"),
    (r"\[third perk\]", "third_perk"),
    (r"\[founder note", "founder_note"),
    (r"\[founder script\]|founder story", "founder_story"),
    (r"what maison means|what belasi means|\[the promise\]|confirm name story", "name_story"),
    (r"\[question \d\]|\[founder answer\]|founder answers", "founder_qa"),
    (r"\[creator\]|@creator", "creators"),
    (r"product in hand before filming", "creator_product_date"),
    (r"\[accessory\]|\[ritual set\]", "gift_items"),
    (r"\[review\]|\[first name\]", "review"),
    (r"packed by hand", "packed_by_hand"),
]
# Facts the Reel scripts depend on that the calendar text doesn't spell out.
EXTRA = {
    "S022": ["founder_story"], "S100": ["founder_story"], "S037": ["studiovic_handle"],
    "S040": ["real_product_on_set"], "S042": ["real_product_on_set"], "S086": ["box_contents"],
    "S089": ["dose"], "S076": ["dose", "ingredient4"], "S072": ["ingredient4"], "S097": ["shipping_cutoffs"],
    "S064": ["creator_product_date"], "S092": ["creator_product_date", "creators"], "S048": ["creators"],
    "S052": ["creators"], "S054": ["creators"], "S019": ["label_disclosure"],
    "C5-50": ["waitlist_close_date"], "L3-01": ["early_access_date"], "L3-02": ["early_access_date"],
    "L3-05": ["founding_price"], "L1-08": ["price", "shipping_offer"], "L4-03": ["dose", "policies"],
    "S065": ["price", "policies"], "S085": ["dose", "price", "policies"], "S098": ["shipping_cutoffs"], "S099": ["shipping_cutoffs"],
    "S018": ["run_size"], "S077": ["early_access_date"], "S075": ["early_access_date"],
}

FONT_FIX = {
    "S053": "Headline serif changes from slide to slide: set one font.",
    "S060": "Headline serif changes from slide to slide: set one font. [dose CONFIRM] is split over two text boxes.",
    "S071": "Headline serif changes from slide to slide: set one font.",
    "S085": "Headline serif changes on all 6 pages: set one font.",
    "S091": "Headline face differs on every page; wordmark position varies.",
    "S096": "Headline face differs across pages: set one font.",
    "S004": "Pages 2 to 4 use Canva's default sans: Copy style from page 1's headline.",
    "S023": "Pages 2 to 4 use the default sans, and the wordmark is centred while page 1's is left-aligned.",
    "S033": "Pages 2 to 4 use the default sans, and the wordmark is centred while page 1's is left-aligned.",
    "S059": "Pages 2 to 3 use Canva's default sans: Copy style from page 1's headline.",
    "S065": "Pages 2 to 4 use the default sans, and the wordmark is centred while page 1's is left-aligned.",
    "S083": "Pages 2 to 3 use Canva's default sans: Copy style from page 1's headline.",
    "S044": "Page 5 wordmark is in a different font from the other pages.",
}
ISSUES = {
    "S074": ["Tight letter spacing: the full stop nearly touches the '2'. Nudge by hand."],
    "S098": ["Tight letter spacing in 'by [date]'. Nudge by hand."],
    "S099": ["Tight letter spacing in 'order for'. Nudge by hand."],
    "S042": ["The display font draws the straight apostrophe curly. The stored text is correct."],
    "S043": ["The display font draws the straight apostrophe curly. The stored text is correct."],
    "S003": ["Moved from 22 Oct (missed) to 25 Oct."],
    "S095": ["Needs travel footage. Check Shoot No. 1 covers it, else reshoot."],
    "L4-06": ["Template only. Don't run until a real, verified review exists and the customer agrees."],
}


def facts_for(pid, text):
    t = text.lower()
    found = [key for pat, key in RULES if re.search(pat, t)]
    found += EXTRA.get(pid, [])
    return sorted(set(k for k in found if k in FACT_KEYS), key=[k for k, _, _ in FACTS].index)


def canva_url(did):
    return f"https://www.canva.com/design/{did}/edit"


def main():
    inv = [d for d in json.load(open(os.path.join(HERE, "canva-inventory.json"))) if not d["is_archive"]]
    by_plan = defaultdict(list)
    for d in inv:
        if d.get("plan_id"):
            by_plan[d["plan_id"]].append(d)

    items = []
    order = 0

    # Organic posts.
    with open(os.path.join(ROOT, "content-calendar", "posts.csv")) as f:
        posts = list(csv.DictReader(f))
    for p in posts:
        order += 1
        pid, fmt = p["id"], p["format"]
        designs = by_plan.get(pid, [])
        text = " ".join([p["on_image"], p["caption"].split("Always read the label")[0], p["needs"]] + [d.get("text") or "" for d in designs])
        needs = p["needs"].lower()
        is_reel = fmt == "REEL"
        photo = fmt in ("FEED",) or fmt.startswith("CAROUSEL") or (fmt == "STORY" and re.search(r"still|photo|bts|footage|shot|reshare|creator", needs + " " + p["caption"].lower()) is not None)
        issues = list(ISSUES.get(pid, []))
        if pid in FONT_FIX:
            issues.insert(0, FONT_FIX[pid])
        items.append(dict(
            id=pid, order=order, area="Organic social", group=f"{p['week']} · {p['theme']}",
            title=p["title"], date=f"{p['day']} {p['date'][8:10]} {['Oct','Nov','Dec'][int(p['date'][5:7]) - 10]}",
            kind={"REEL": "Reel + TikTok", "STORY": "Story", "FEED": "Feed post"}.get(fmt, "Carousel"),
            formats=fmt + (" · script in reel-scripts.md" if is_reel else ""),
            links=[{"label": "Canva" + (f" ({len(designs)})" if len(designs) > 1 else ""), "url": canva_url(d["design_id"])} for d in designs[:1]],
            built=bool(designs), facts=facts_for(pid, text),
            film_needed=is_reel, film_done=False, photo_needed=bool(photo) and not is_reel, photo_done=False,
            font_fix=pid in FONT_FIX, font_done=False, approved=False, issues=issues, notes="",
        ))

    # Ads: pre-launch deck, legacy, launch pack.
    def ad_rows(path):
        rows = {}
        for line in open(path):
            m = re.match(r"\|\s*((?:L\d-\d\d)|\d\d)(?: \(was \d+\))?\s*\|(.*)", line)
            if m and "canva" not in line:
                rows.setdefault(m.group(1), line)
        return rows

    pre = ad_rows(os.path.join(ROOT, "competitor-ads", "packs", "2026-10-19-50-ads.md"))
    launch = ad_rows(os.path.join(ROOT, "competitor-ads", "packs", "2026-10-20-launch-ads.md"))
    camp_of = lambda n: f"C{(int(n) - 1) // 10 + 1}"
    camp_names = {"C1": "C1 Hook Test", "C2": "C2 The Object", "C3": "C3 Problem to Fix", "C4": "C4 Ritual and Creators", "C5": "C5 First Edition",
                  "L1": "L1 Announcement", "L2": "L2 Formula reveal", "L3": "L3 Waitlist to buyer", "L4": "L4 Visitors and cart"}

    def add_ad(pid, group, area, line, title_hint):
        nonlocal order
        order += 1
        designs = sorted(by_plan.get(pid, []), key=lambda d: d.get("format_variant") or "")
        cells = [c.strip() for c in line.split("|")[1:-1]] if line else []
        title = title_hint
        if cells:
            onimg = next((c for c in cells if "**" in c), "")
            title = re.sub(r"\*\*|\[[^\]]*\]", "", onimg).split(" / ")[0].strip() or title_hint
        text = (line or "") + " " + " ".join(d.get("text") or "" for d in designs) + " " + " ".join(d.get("title") or "" for d in designs)
        variants = sorted({d.get("format_variant") for d in designs if d.get("format_variant")})
        need = {"9x16"} if pid in ("C4-36", "C4-37", "C4-38") else {"4x5", "9x16"}
        issues = list(ISSUES.get(pid, []))
        missing = need - set(variants)
        if designs and missing:
            issues.append("Missing variant: " + ", ".join(sorted(missing)))
        if "CONFIRM claim" in text:
            issues.append("Prints an unconfirmed claim. Confirm it or change the line before this runs.")
        items.append(dict(
            id=pid, order=order, area=area, group=group, title=title, date="", kind="Meta ad",
            formats=" + ".join(variants), links=[{"label": v or "open", "url": canva_url(d["design_id"])} for d, v in ((d, d.get("format_variant")) for d in designs)],
            built=bool(designs) and not missing, facts=facts_for(pid, text),
            film_needed=pid in ("C4-36", "C4-37", "C4-38"), film_done=False,
            photo_needed=pid not in ("C4-36", "C4-37", "C4-38"), photo_done=False,
            font_fix=area == "Launch ads", font_done=False, approved=False, issues=issues, notes="",
        ))

    for n in [f"{i:02d}" for i in range(1, 51)]:
        if n in ("33", "34"):
            continue
        pid = f"{camp_of(n)}-{n}"
        add_ad(pid, camp_names[camp_of(n)], "Pre-launch ads", pre.get(n), f"ad {n}")
    for pid in sorted(k for k in by_plan if k.startswith("LEGACY")):
        t = by_plan[pid][0]["title"].split("|")[0].replace("MR ", "").strip()
        add_ad(pid, "Legacy pre-launch ads", "Pre-launch ads", None, t)
    for c in ("L1", "L2", "L3", "L4"):
        for k in sorted(x for x in launch if x.startswith(c)):
            add_ad(k, camp_names[c], "Launch ads", launch[k], k)

    for pid in ("C4-36", "C4-37", "C4-38"):
        for it in items:
            if it["id"] == pid:
                it["issues"].append("Partnership ad: needs the creator's Reel, filmed after they have product.")

    os.makedirs(os.path.join(OUT, "items"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "facts"), exist_ok=True)
    writes = []
    for it in items:
        doc = {k: v for k, v in it.items() if k != "id"}
        fp = os.path.join(OUT, "items", it["id"] + ".json")
        json.dump(doc, open(fp, "w"), indent=1)
        writes.append({"op": "set", "collection": "items", "doc_id": it["id"], "file_path": fp})
    for i, (k, label, q) in enumerate(FACTS):
        fp = os.path.join(OUT, "facts", k + ".json")
        json.dump({"label": label, "question": q, "value": "", "order": i}, open(fp, "w"), indent=1)
        writes.append({"op": "set", "collection": "facts", "doc_id": k, "file_path": fp})
    batches = [writes[i:i + 50] for i in range(0, len(writes), 50)]
    json.dump(batches, open(os.path.join(OUT, "batches.json"), "w"), indent=1)
    used = defaultdict(int)
    for it in items:
        for k in it["facts"]:
            used[k] += 1
    print(f"items {len(items)} (built {sum(i['built'] for i in items)}), facts {len(FACTS)}, batches {len(batches)}")
    print("fact use:", dict(used))
    print("unused facts:", [k for k, _, _ in FACTS if not used[k]])


if __name__ == "__main__":
    main()
