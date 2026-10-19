"""100-post organic calendar for Metabolic Reset, pre-launch to launch (launch day Thu 3 Dec 2026).

Run: python3 posts.py  -> writes posts.csv and posts.md next to this file.
Fields: date, format, pillar, title, on_image, caption, needs
Formats: FEED (3:4 1080x1440), CAROUSEL-n (3:4, n slides), REEL (9:16 cover; also posted to TikTok), STORY (9:16 frame)
"""
import csv
import datetime as dt
import os

FOOTER = "Always read the label and follow the directions for use. If symptoms persist, see your healthcare professional. Dietary supplements are not a replacement for a balanced diet."

WEEKS = [
    ("W1", "2026-10-19", "Tease: the world of maison belasi"),
    ("W2", "2026-10-26", "The gap: doing everything right"),
    ("W3", "2026-11-02", "What we stand for"),
    ("W4", "2026-11-09", "Shoot week, New York"),
    ("W5", "2026-11-16", "Education and first creators"),
    ("W6", "2026-11-23", "Product reveal"),
    ("W7", "2026-11-30", "Formula reveal and countdown"),
    ("LAUNCH", "2026-12-03", "Launch day"),
    ("W8", "2026-12-04", "Launch week"),
    ("W9", "2026-12-11", "First edition and gifting"),
]

# (date, format, pillar, title, on_image, caption, needs)
P = [
    # W1 tease
    ("2026-10-21", "FEED", "Brand", "something considered", "something considered is coming.", "biohacking, made fashionable. the waitlist is open. link in bio.", ""),
    ("2026-10-21", "STORY", "Waitlist", "waitlist open", "the waitlist is open.", "link sticker: join the waitlist", ""),
    ("2026-10-22", "REEL", "Brand", "biohacking dressed up film", "biohacking, dressed up.", "the science of feeling good, with better taste. join the waitlist.", "abstract chrome/glass footage or type animation"),
    ("2026-10-22", "STORY", "Brand", "behind the name", "maison belasi. / why the name?", "3 frames: what maison means to us, what belasi means, the promise", "founder to confirm name story"),
    ("2026-10-23", "CAROUSEL-4", "Brand", "what is maison belasi", "what is maison belasi?", "clinical by design. fashionable by nature. our first product is metabolic reset. join the waitlist.", ""),
    ("2026-10-23", "STORY", "Community", "3pm poll", "your 3pm is: / coffee / snack / push through", "poll sticker", ""),
    ("2026-10-24", "REEL", "Problem", "POV 3pm crash", "POV: you eat well, you train, and it's still 3pm on coffee number three.", "if this is you, we made something for you. join the waitlist.", "phone footage of desk/coffee"),
    ("2026-10-24", "STORY", "Community", "supplement drawer question", "what's in your supplement drawer?", "question sticker", ""),
    ("2026-10-25", "FEED", "Brand", "precision not promises", "precision, not promises.", "we'd rather show you than tell you. join the waitlist.", ""),
    ("2026-10-25", "STORY", "Waitlist", "repost precision", "precision, not promises. / join the waitlist", "reshare feed post + link sticker", ""),
    # W2 the gap
    ("2026-10-26", "CAROUSEL-5", "Problem", "the gap", "doing everything right. still not feeling right.", "the gap between effort and how you feel is real. we built metabolic reset for it. join the waitlist.", ""),
    ("2026-10-26", "STORY", "Education", "metabolism quiz", "true or false: metabolism is only about calories.", "quiz sticker, answer: false. it also involves blood sugar balance and gut health.", ""),
    ("2026-10-27", "REEL", "Education", "three systems in 20 seconds", "metabolism. blood sugar. gut health. in 20 seconds.", "three systems that work together. metabolic reset is formulated to support all three. join the waitlist.\n\n" + FOOTER, "type animation"),
    ("2026-10-28", "FEED", "Education", "slump has a mechanism", "your afternoon slump has a mechanism.", "blood sugar rises and falls through the day. more on this soon. join the waitlist.", ""),
    ("2026-10-28", "STORY", "Community", "3pm slider", "how heavy is your 3pm?", "emoji slider sticker", ""),
    ("2026-10-29", "REEL", "Brand", "words we will never say", "words we will never use: cure. detox. miracle. melt.", "we only say what we can stand behind. join the waitlist.", "type animation"),
    ("2026-10-30", "CAROUSEL-6", "Education", "how to read a supplement label", "how to read a supplement label.", "doses listed? proprietary blends? claims that sound too good? save this for your next shop. join the waitlist.", ""),
    ("2026-10-30", "STORY", "Waitlist", "first edition limited", "the first edition is limited. [CONFIRM]", "link sticker: join the waitlist", "CONFIRM limited run"),
    ("2026-10-31", "REEL", "Education", "scariest thing in your drawer", "the scariest thing in your supplement drawer: no doses on the label.", "happy halloween. check your labels. join the waitlist.", "phone footage of supplement drawer"),
    ("2026-11-01", "FEED", "Education", "three systems card", "metabolism. blood sugar. gut health.", "one daily capsule, formulated to support all three. join the waitlist.\n\n" + FOOTER, ""),
    ("2026-11-01", "STORY", "Community", "ask us anything", "ask us anything about metabolic health.", "question sticker. answer with general education only, never personal advice.", ""),
    # W3 what we stand for
    ("2026-11-02", "REEL", "Founder", "why I started maison belasi", "why I started maison belasi.", "a note from our founder. join the waitlist.", "founder to camera, 30 to 45s [founder script]"),
    ("2026-11-02", "STORY", "Founder", "founder Q&A", "you asked. our founder answers.", "3 frames answering questions from 1 Nov", "founder answers"),
    ("2026-11-03", "CAROUSEL-5", "Brand", "chrome not clutter", "chrome, not clutter.", "our design philosophy, in five slides. join the waitlist.", ""),
    ("2026-11-04", "REEL", "Brand", "biohacking then and now", "biohacking used to look like this. / now it looks like this.", "same science. better taste. join the waitlist.", "footage: cluttered tubs vs chrome tray"),
    ("2026-11-04", "STORY", "Community", "this or that", "this or that: / powder or capsule / gym bag or handbag", "poll stickers", ""),
    ("2026-11-05", "FEED", "Brand", "not a miracle", "not a fat burner. not a detox. not a miracle.", "just a daily capsule formulated to support metabolism, blood sugar balance and gut health. join the waitlist.\n\n" + FOOTER, ""),
    ("2026-11-06", "REEL", "Problem", "day in the life", "a day in the life of a woman who does everything right.", "6am pilates. green juice. 3pm crash. sound familiar? join the waitlist.", "creator or founder footage"),
    ("2026-11-06", "STORY", "Waitlist", "waitlist reminder", "on the list yet?", "link sticker: join the waitlist", ""),
    ("2026-11-07", "CAROUSEL-5", "Brand", "what we left out", "what we left out of metabolic reset.", "no proprietary blends. no fillers we don't need. no promises we can't keep. [CONFIRM] join the waitlist.", "CONFIRM no proprietary blends"),
    ("2026-11-08", "STORY", "Community", "jewelry poll", "would you take a supplement that looks this good?", "poll sticker", ""),
    ("2026-11-08", "FEED", "Brand", "our world mood board", "our world: chrome, glass, ice blue.", "the mood board for shoot no. 1. new york, next week. join the waitlist.", "mood board images from shoot deck"),
    # W4 shoot week
    ("2026-11-09", "STORY", "BTS", "off to new york", "this week: new york. shoot no. 1.", "3 frames: props, mood, see you on set", ""),
    ("2026-11-10", "REEL", "BTS", "packing the chrome", "packing the chrome.", "tweezers, a martini cup and a lot of glass. join the waitlist.", "footage: prop packing"),
    ("2026-11-10", "FEED", "Brand", "handle with tweezers", "handle with tweezers.", "precise by design. join the waitlist.", ""),
    ("2026-11-11", "STORY", "BTS", "shoot day 1", "shoot day 1.", "BTS frames from set", "BTS from JCHQ/StudioVIC"),
    ("2026-11-11", "REEL", "BTS", "under the glass BTS", "how we shot under the glass.", "day 1 on set with studiovic. join the waitlist.", "BTS footage"),
    ("2026-11-12", "STORY", "BTS", "shot A or B", "which shot? A or B", "poll sticker with two BTS stills", "BTS stills"),
    ("2026-11-12", "FEED", "BTS", "on set", "on set.", "shoot no. 1, new york. first look goes to the waitlist.", "phone BTS still"),
    ("2026-11-13", "REEL", "BTS", "capsule from beneath", "a capsule, from beneath the glass.", "the shot we're most excited about. join the waitlist.", "BTS footage"),
    ("2026-11-13", "STORY", "BTS", "shoot day 3", "shoot day 3.", "BTS frames", "BTS"),
    ("2026-11-14", "REEL", "BTS", "shoot wrap montage", "that's a wrap.", "four days, one bottle, a lot of chrome. join the waitlist.", "BTS montage"),
    ("2026-11-14", "STORY", "BTS", "wrap", "that's a wrap. first look: 23 nov.", "countdown sticker to 23 Nov", ""),
    ("2026-11-15", "CAROUSEL-6", "BTS", "behind shoot no 1", "behind the scenes: shoot no. 1.", "six frames from new york. the final images land soon. join the waitlist.", "BTS stills"),
    ("2026-11-15", "STORY", "Waitlist", "first look to waitlist", "the first look goes to the waitlist.", "link sticker", ""),
    # W5 education + creators
    ("2026-11-16", "CAROUSEL-5", "Education", "blood sugar 101", "blood sugar 101.", "what it is, why it rises and falls, and why balance matters to how you feel. save this. join the waitlist.\n\n" + FOOTER, ""),
    ("2026-11-16", "STORY", "Education", "blood sugar quiz", "quick quiz: what can affect blood sugar balance?", "quiz sticker: meals, sleep, stress, all of the above (answer: all)", ""),
    ("2026-11-17", "REEL", "Creator", "creator 1 waitlist", "\"I joined a waitlist for a supplement. let me explain.\"", "[creator] is on the list. are you? join the waitlist. #ad if paid", "creator 1 video"),
    ("2026-11-18", "FEED", "Product", "morning ritual teaser", "a morning ritual, refined.", "coming soon to your morning. join the waitlist.", ""),
    ("2026-11-18", "STORY", "Community", "morning or night", "morning routine or night routine?", "poll sticker", ""),
    ("2026-11-19", "REEL", "Education", "gut health minus the hype", "gut health, minus the hype.", "what your gut actually does, in 20 seconds. join the waitlist.", "type animation"),
    ("2026-11-19", "STORY", "Creator", "creator takeover", "takeover: [creator]", "creator story frames", "creator content"),
    ("2026-11-20", "CAROUSEL-5", "Education", "metabolism myths", "metabolism myths, retired.", "five things you've probably heard about metabolism, and what's actually true. join the waitlist.", "fact-check each slide"),
    ("2026-11-20", "REEL", "Creator", "creator 2 vanity", "\"the first supplement that looks like it belongs on my vanity.\"", "[creator] is on the list. join the waitlist. #ad if paid", "creator 2 video"),
    ("2026-11-21", "STORY", "Waitlist", "first look countdown", "first look: sunday.", "countdown sticker to 23 Nov", ""),
    ("2026-11-22", "FEED", "Product", "first look sunday", "first look, tomorrow.", "the waitlist sees it first. link in bio.", ""),
    # W6 product reveal
    ("2026-11-23", "REEL", "Product", "product reveal", "meet metabolic reset.", "a daily capsule formulated to support metabolism, blood sugar balance and gut health. launching 3 december. join the waitlist.\n\n" + FOOTER, "shoot film"),
    ("2026-11-23", "FEED", "Product", "meet metabolic reset", "meet metabolic reset.", "chrome on the outside. considered on the inside. launching 3 december.\n\n" + FOOTER, "hero shot: chrome platter"),
    ("2026-11-23", "STORY", "Product", "reveal frames", "meet metabolic reset. / 3 december", "3 frames + link sticker", "shoot stills"),
    ("2026-11-24", "CAROUSEL-6", "Product", "in detail", "metabolic reset, in detail.", "the bottle, the capsule, the ritual and what it's designed to support. formula reveal on 30 november.\n\n" + FOOTER, "shoot stills"),
    ("2026-11-24", "STORY", "Community", "first impressions", "first impressions?", "emoji slider", ""),
    ("2026-11-25", "REEL", "Product", "in her bag", "packed with intention.", "lipstick. headphones. keys. metabolic reset. join the waitlist.", "shoot film: bag"),
    ("2026-11-25", "FEED", "Product", "chrome outside", "chrome on the outside. considered on the inside.", "launching 3 december. join the waitlist.", "shoot still"),
    ("2026-11-26", "REEL", "Creator", "creator 3 post", "\"biohacking, but something I'd actually post.\"", "[creator] is on the list. join the waitlist. #ad if paid", "creator 3 video"),
    ("2026-11-26", "STORY", "Product", "FAQ when how much", "when? how much? / your questions, answered.", "3 frames: launch date, price [CONFIRM], where we ship", "CONFIRM price, shipping"),
    ("2026-11-27", "FEED", "Launch", "not doing black friday", "we're not doing black friday.", "we're doing a first edition instead. waitlist members get founding pricing on 2 december. [CONFIRM] join the waitlist.", "CONFIRM founding pricing"),
    ("2026-11-27", "STORY", "Launch", "not doing black friday story", "no black friday. just first in line.", "link sticker", "CONFIRM founding pricing"),
    ("2026-11-28", "REEL", "Product", "mirror mirror", "mirror, mirror.", "the most considered thing on your vanity. launching 3 december.", "shoot film: mirror"),
    ("2026-11-29", "FEED", "Product", "goes with everything", "goes with everything.", "silver, chrome and a daily capsule. launching 3 december.", "shoot still: tray + jewelry"),
    ("2026-11-29", "STORY", "Launch", "4 days", "4 days.", "countdown sticker to 3 Dec", ""),
    # W7 formula + countdown
    ("2026-11-30", "CAROUSEL-6", "Product", "formula revealed", "the formula, revealed.", "every ingredient, every dose, and why it's there. [CONFIRM full formula]\n\n" + FOOTER, "CONFIRM formula is public"),
    ("2026-11-30", "REEL", "Product", "chrome spoon ingredients", "ginger. green tea. barberry.", "chosen on purpose. full formula in our latest post.\n\n" + FOOTER, "shoot film: ingredients"),
    ("2026-11-30", "STORY", "Launch", "3 days", "3 days.", "countdown sticker", ""),
    ("2026-12-01", "FEED", "Launch", "countdown 2", "2.", "two days. waitlist, check your inbox tomorrow.", ""),
    ("2026-12-01", "STORY", "Launch", "early access tomorrow", "waitlist: early access opens tomorrow. [CONFIRM]", "link sticker", "CONFIRM early access"),
    ("2026-12-01", "REEL", "Founder", "two days founder", "two days. here's what's in the bottle and why.", "our founder on the formula.\n\n" + FOOTER, "founder video"),
    ("2026-12-02", "FEED", "Launch", "waitlist first", "waitlist, you're in first.", "early access is open for waitlist members. everyone else: tomorrow. [CONFIRM]", "CONFIRM early access"),
    ("2026-12-02", "STORY", "Launch", "early access link", "early access is open.", "link sticker to waitlist access page", "CONFIRM"),
    ("2026-12-02", "REEL", "BTS", "the night before", "the night before.", "first orders, packed by hand. see you tomorrow.", "BTS: packing"),
    ("2026-12-02", "STORY", "Launch", "tomorrow", "tomorrow.", "countdown sticker", ""),
    # LAUNCH day
    ("2026-12-03", "FEED", "Launch", "now available", "metabolic reset. now available.", "a daily capsule formulated to support metabolism, blood sugar balance and gut health. shop via link in bio.\n\n" + FOOTER, "hero shot"),
    ("2026-12-03", "REEL", "Launch", "launch film", "it's here.", "metabolic reset by maison belasi. shop via link in bio.\n\n" + FOOTER, "launch film from shoot"),
    ("2026-12-03", "STORY", "Launch", "launch frames", "it's here. / shop now", "3 frames + shop link sticker", ""),
    ("2026-12-03", "STORY", "Community", "thank you waitlist", "thank you, waitlist.", "1 frame", ""),
    ("2026-12-03", "CAROUSEL-6", "Launch", "everything you need to know", "everything you need to know.", "what it is, how to take it, price, shipping across NZ and AU. [CONFIRM dose, price, shipping]\n\n" + FOOTER, "CONFIRM details"),
    # W8 launch week
    ("2026-12-04", "REEL", "Product", "unboxing", "unboxing metabolic reset.", "the first edition, opened. shop via link in bio.", "unboxing footage"),
    ("2026-12-04", "STORY", "Community", "your first orders", "your first orders.", "reshare customer posts. no results claims in reposts.", "real customer content only"),
    ("2026-12-05", "FEED", "Product", "morning ritual", "a morning ritual, refined.", "water. capsules. thirty seconds. [CONFIRM dose]\n\n" + FOOTER, "shoot still: glass + spoon"),
    ("2026-12-06", "REEL", "Product", "how to take it", "how to take metabolic reset.", "the 15-second guide. [CONFIRM dose]\n\n" + FOOTER, "footage: glass + capsule"),
    ("2026-12-06", "STORY", "Community", "launch Q&A", "you asked: launch week edition.", "answer top questions", ""),
    ("2026-12-07", "CAROUSEL-5", "Launch", "launch FAQ", "launch FAQ.", "shipping, subscriptions, dose and returns. [CONFIRM all]", "CONFIRM policies"),
    ("2026-12-08", "REEL", "Creator", "creator it arrived", "\"it arrived.\"", "[creator] unboxes the first edition. #ad if paid", "creator video, no results claims"),
    ("2026-12-09", "FEED", "Launch", "first edition limited", "first edition, limited run.", "when it's gone, it's gone. [CONFIRM real]", "CONFIRM limited run"),
    ("2026-12-10", "STORY", "Community", "how do you take yours", "how do you take yours?", "poll: morning / with breakfast / on the go", ""),
    ("2026-12-10", "REEL", "Product", "packed with intention product", "the new bag essential.", "packed with intention. shop via link in bio.", "shoot film: bag"),
    # W9 gifting
    ("2026-12-12", "CAROUSEL-5", "Launch", "considered gift guide", "the considered gift guide.", "for the woman who does everything right. shop via link in bio.", "styled stills"),
    ("2026-12-14", "REEL", "Launch", "wrapped in chrome", "gift it in chrome.", "the most considered gift under the tree. shop via link in bio.", "gift wrap footage"),
    ("2026-12-16", "STORY", "Launch", "shipping cut-off", "order by [date] for christmas.", "link sticker", "CONFIRM shipping cut-off"),
    ("2026-12-17", "FEED", "Launch", "last order date", "last order for christmas: [date].", "NZ and AU shipping cut-offs in our stories. [CONFIRM]", "CONFIRM dates"),
    ("2026-12-19", "REEL", "Founder", "thank you first edition", "thank you for the first edition.", "a note from our founder. see you in 2027.", "founder video"),
]

assert len(P) == 100, len(P)


def week_of(d):
    cur = None
    for code, start, theme in WEEKS:
        if d >= start:
            cur = (code, theme)
    return cur


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    rows = []
    for i, (d, fmt, pillar, title, on_img, cap, needs) in enumerate(P, 1):
        wk, theme = week_of(d)
        phase = "PRE-LAUNCH" if d < "2026-12-03" else ("LAUNCH DAY" if d == "2026-12-03" else "LAUNCH")
        day = dt.date.fromisoformat(d).strftime("%a")
        platforms = "Instagram Reels + TikTok" if fmt == "REEL" else ("Instagram Stories" if fmt == "STORY" else "Instagram feed")
        rows.append(dict(id=f"S{i:03d}", date=d, day=day, week=wk, theme=theme, phase=phase, format=fmt,
                         platforms=platforms, pillar=pillar, title=title, on_image=on_img, caption=cap, needs=needs))
    with open(os.path.join(here, "posts.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with open(os.path.join(here, "posts.md"), "w") as f:
        f.write("# Metabolic Reset: 100-post organic calendar\n\nLaunch day: Thursday 3 December 2026. Generated from posts.py.\n\n")
        cur = None
        for r in rows:
            if r["week"] != cur:
                cur = r["week"]
                f.write(f"\n## {cur}: {r['theme']}\n\n| ID | Date | Format | Pillar | On-image | Caption | Needs |\n|---|---|---|---|---|---|---|\n")
            cap = r["caption"].replace("\n\n" + FOOTER, " + footer").replace("|", "/")
            f.write(f"| {r['id']} | {r['day']} {r['date'][5:]} | {r['format']} | {r['pillar']} | {r['on_image']} | {cap} | {r['needs']} |\n")
        f.write(f"\n\nFooter (\"+ footer\"): {FOOTER}\n")
    from collections import Counter
    print(Counter(r["format"].split("-")[0] for r in rows), Counter(r["week"] for r in rows))


if __name__ == "__main__":
    main()
