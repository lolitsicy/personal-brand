import csv, sys

OUT_DIR = "/home/user/personal-brand/research/content-calendar"

CP = "Chrome Platter"
UG = "Under the Glass"
GB = "Gradient Backdrop"
PE = "Product & Essentials (vanity/chrome tray)"
IB = "Inside the bag"
CT = "capsules + tweezers"
CM = "capsules on mirror"
END = "Canva: end card"
TYPE = "Canva: type animation"
DESK = "Off-set: desk (phone)"
DRAWER = "Off-set: drawer (phone)"
FOUNDER = "Off-set: founder to camera"
CREATOR = "Off-set: creator self-shot"
LIFE = "Off-set: day-in-the-life (creator/founder)"
BTSPACK = "BTS: prop packing"
BTSSET = "BTS: on set"
DISPATCH = "Off-set: dispatch packing"
GIFT = "Off-set: gift wrap"
TEXTURE = "Pre-shoot: chrome texture (own props)"

FOOTER = "Always read the label and follow the directions for use. If symptoms persist, see your healthcare professional. Dietary supplements are not a replacement for a balanced diet."
CLAIM = "formulated to support metabolism, blood sugar balance and gut health."

# shot: (duration_s, framing, action, set, on-screen text, props)
R = []

def reel(**k):
    R.append(k)

reel(id="S003", date="2026-10-25", title="biohacking dressed up film", length=12,
     hook='"biohacking," snaps on screen as a hard specular glint rakes across polished chrome.',
     shots=[
        (1.5, "ECU macro", "light sweeps across a chrome surface, glint flares", TEXTURE, "biohacking,", "chrome platter or tray, LED wand"),
        (2, "macro", "a single water droplet lands on frosted glass and spreads", TEXTURE, "biohacking,", "frosted glass sheet, pipette, water"),
        (2.5, "slow push-in", "chrome tweezers rotate on a pale ice blue to white gradient", TEXTURE, "dressed up.", "chrome tweezers, turntable, ice blue paper sweep"),
        (3, "overhead close", "hand in silver rings sets tweezers down on a chrome tray", TEXTURE, "dressed up.", "chrome tray, silver rings, tweezers"),
        (3, "full-frame graphic", "end card", END, "maison belasi. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="slow minimal electronic, glassy synth plucks, one soft hit on the cut to \"dressed up.\"",
     end='"maison belasi." / "join the waitlist."',
     tiktok="Cut shot 1 to 1s. Keep text in the centre band, clear of the bottom caption and right-side buttons. Native caption: \"the science of feeling good, with better taste.\"",
     props="chrome tray or platter, chrome tweezers, frosted glass sheet, pipette, silver rings, ice blue paper sweep, small turntable, LED wand",
     notes="Moved from Thu 22 Oct (date passed) to Sun 25 Oct, the next W1 day with no other Reel. Pre-shoot, so no product: own chrome props on a phone macro lens, or animate the type over a chrome texture in Canva. Never render or mock up a bottle.")

reel(id="S007", date="2026-10-24", title="POV 3pm crash", length=10,
     hook='Overhead POV: a hand sets down a third coffee cup beside two empties. Text: "POV: you eat well,"',
     shots=[
        (1.5, "overhead POV", "hand sets a third coffee cup beside two empty ones", DESK, "POV: you eat well,", "3 matching white or glass coffee cups, white desk"),
        (2, "close", "laptop corner clock reads 3:00 pm; gym bag strap in frame edge", DESK, "you train,", "laptop, gym bag"),
        (2.5, "side, hand only", "hand reaches for the cup, pauses, lifts it out of frame", DESK, "and it's still 3pm", "coffee cup"),
        (2, "overhead", "empty cup ring left on the desk", DESK, "on coffee number three.", "none"),
        (2, "full-frame graphic", "end card", END, "we designed for the rises and falls. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="dry, deadpan lo-fi beat; a tick-tock or clock-hit sound effect on the 3:00 pm frame",
     end='"we designed for the rises and falls." / "join the waitlist."',
     tiktok="Native POV format: shoot vertical on phone, no grade. Text in the centre band (TikTok's bottom caption area covers the desk edge). Optional creator voice: \"3pm. coffee number three. again.\"",
     props="3 matching coffee cups, laptop with visible clock, gym bag, clean white desk, cool window light (no warm golden tones)",
     notes="Do not show or imply the product fixes energy or the crash. End card frames design intent only (blood sugar rises and falls), never a fix. Calendar caption says \"formulated to support blood sugar balance\" and carries the footer.")

reel(id="S013", date="2026-10-27", title="three systems in 20 seconds", length=20,
     hook='Three words stack fast on an ice blue gradient: "metabolism. blood sugar. gut health." then "in 20 seconds."',
     shots=[
        (1.5, "full-frame type", "three words stack on beat", TYPE, "metabolism. blood sugar. gut health. / in 20 seconds.", "none"),
        (4.5, "macro", "slow ripple in a clear glass of water (B-roll under type)", TEXTURE, "metabolism. / how your body uses food for energy.", "clear glass, water"),
        (4.5, "macro", "water level in a glass gently rises and settles", TEXTURE, "blood sugar. / it rises and falls through the day.", "clear glass, jug"),
        (4.5, "macro", "droplets bead and run on frosted glass", TEXTURE, "gut health. / where food is broken down and absorbed.", "frosted glass, mister"),
        (2.5, "full-frame type", "three words lock together in one line", TYPE, "three systems. they work together.", "none"),
        (2.5, "full-frame graphic", "end card", END, "metabolic reset is formulated to support all three. / join the waitlist.", "none"),
     ],
     vo="optional VO (suggested): calm, close-mic, reads each card word for word. No extra lines.",
     audio="steady soft tick or metronome-like minimal beat, one change per system",
     end='"metabolic reset is formulated to support all three." / "join the waitlist."',
     tiktok="Keep the 20-second promise exact: TikTok users time it. Add an on-screen timer in the top-left (inside the safe zone). Text in centre band.",
     props="clear glasses, water jug, frosted glass sheet, plant mister",
     notes="Definitions are general physiology, but have them checked [CONFIRM] before posting. Caption footer already in calendar; keep it.")

reel(id="S016", date="2026-10-29", title="words we will never say", length=9,
     hook='"words we will never use:" on a chrome tray; chrome tweezers hover over a row of acrylic word tiles.',
     shots=[
        (1.5, "overhead", "tray of 4 clear acrylic word tiles, tweezers enter frame", TEXTURE, "words we will never use:", "chrome tray, 4 acrylic tiles, chrome tweezers"),
        (1.5, "overhead close", "tweezers lift the \"cure.\" tile out of frame", TEXTURE, "cure.  (struck through)", "tile: cure."),
        (1.5, "overhead close", "tweezers lift \"detox.\" out", TEXTURE, "detox.  (struck through)", "tile: detox."),
        (1.5, "overhead close", "tweezers lift \"miracle.\" out", TEXTURE, "miracle.  (struck through)", "tile: miracle."),
        (1.5, "overhead close", "tweezers lift \"melt.\" out; tray is empty", TEXTURE, "melt.  (struck through)", "tile: melt."),
        (1.5, "full-frame graphic", "end card", END, "we only say what we can stand behind. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="crisp, minimal beat with a small metallic \"tink\" as each tile lifts",
     end='"we only say what we can stand behind." / "join the waitlist."',
     tiktok="Hold each word 0.2s longer; TikTok viewers screenshot this format. Text centre-frame. Fallback if no tiles: pure Canva type animation with strike-throughs.",
     props="chrome tray, chrome tweezers, 4 clear acrylic tiles printed with the words (or Canva type animation)",
     notes="Every banned word must appear struck through and be removed. Never put these words in the caption, hashtags or alt text.")

reel(id="S019", date="2026-10-31", title="scariest thing in your drawer", length=10,
     hook='A dark drawer slides open, a phone torch beam hits a jumble of tubs. Text: "the scariest thing in your supplement drawer:"',
     shots=[
        (1.5, "front, low", "drawer slides open in the dark, torch beam on", DRAWER, "the scariest thing in your supplement drawer:", "drawer, phone torch, unbranded tubs"),
        (2, "close, handheld", "torch scans tubs; all labels turned away or blank", DRAWER, "the scariest thing in your supplement drawer:", "unbranded tubs"),
        (2.5, "ECU", "hand turns one tub: a plain mock label with no doses listed", DRAWER, "no doses on the label.", "generic mock label (made in-house, no real brand)"),
        (2, "front", "drawer slides shut, torch clicks off", DRAWER, "check your labels.", "none"),
        (2, "full-frame graphic", "end card, dark gradient", END, "happy halloween. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="tongue-in-cheek horror sting: low drone, creak on the drawer, one hit on \"no doses\"",
     end='"happy halloween." / "join the waitlist."',
     tiktok="Lean into the Halloween trend vibe; post 30 to 31 Oct. Text centre band. Optional native caption: \"go check yours. we'll wait.\"",
     props="drawer, 5 to 8 unbranded tubs (labels removed or turned), one generic mock label, phone torch",
     notes="No identifiable competitor products. No pill-spill. Only run if we will list every dose on our own label [CONFIRM].")

reel(id="S022", date="2026-11-02", title="why I started maison belasi", length=30,
     hook='Founder seated at a styled chrome tray, looks up into lens. Text: "why I started maison belasi."',
     shots=[
        (1.5, "MCU", "founder looks up to camera", FOUNDER, "why I started maison belasi.", "chrome tray, silver jewelry"),
        (8, "MCU", "founder speaks, line 1", FOUNDER, "doing everything right.", "none"),
        (3, "close insert", "cluttered supplement drawer (reuse S019 footage)", DRAWER, "the drawer.", "S019 footage"),
        (8, "MCU", "founder speaks, line 2", FOUNDER, "clinical, or overpromised.", "none"),
        (5.5, "MS", "founder speaks, line 3; touches the chrome tray", FOUNDER, CLAIM, "chrome tray"),
        (4, "full-frame graphic", "end card", END, "a note from our founder. / join the waitlist.", "none"),
     ],
     vo="founder to camera. Suggested wording only, founder to rewrite in her own words [founder script] [CONFIRM story facts]: (1) \"I did everything right. I ate well, I trained, and there was still a gap between the effort and how I felt.\" (2) \"supplements either looked clinical or promised too much. I wanted one I'd trust and actually leave out.\" (3) \"so we made metabolic reset. formulated to support metabolism, blood sugar balance and gut health.\"",
     audio="no music under speech, or a very low ambient pad; burned-in captions",
     end='"a note from our founder." / "join the waitlist."',
     tiktok="Open on the first spoken line, not a slow look-up. Talking-head is native here: one take, phone height, burned-in captions in centre band.",
     props="chrome tray, silver jewelry, ice blue or white backdrop, lav mic, S019 drawer footage",
     notes="Calendar asks 30 to 45s; capped at 30s per brief. No product on screen (pre-shoot). No personal health outcomes in the founder's story. Add the footer to the caption.")

reel(id="S025", date="2026-11-04", title="biohacking redesigned", length=10,
     hook='A chrome tweezer tip glints on ice blue seamless. Text: "biohacking, redesigned."',
     shots=[
        (1.5, "macro", "light rakes across chrome tweezers on ice blue seamless", TEXTURE, "biohacking, redesigned.", "chrome tweezers, ice blue seamless"),
        (2, "overhead", "generic unbranded lab-style objects (plain glass vial, measuring scoop) arranged in a neat grid", TEXTURE, "the look of the category,", "plain glass vial, scoop"),
        (0.5, "overhead", "hand swipes across lens (transition)", TEXTURE, "none", "none"),
        (3, "overhead", "chrome tray on ice blue seamless: silver rings, glass of water, clean empty space centre", PE, "reconsidered as an object.", "chrome tray, silver rings, glass"),
        (3, "full-frame graphic", "end card", END, "biohacking, redesigned. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="minimal, glassy beat; one crisp hit on the swipe to the chrome tray",
     end='"biohacking, redesigned." / "join the waitlist."',
     tiktok="Hand-swipe transition is TikTok-native; land it exactly on the beat. Text centre band.",
     props="chrome tweezers, plain glass vial, measuring scoop, chrome tray, silver rings, clear glass, ice blue seamless",
     notes="Objects only, no bodies. Not a then/now or before/after: both halves are styled, nothing is shown as worse. No competitor products, tubs or logos. Never say \"same science\" or imply equivalence to other products. Pre-shoot, so the tray stays product-free (empty space centre).")

reel(id="S028", date="2026-11-06", title="day in the life", length=15,
     hook='Phone alarm reads 6:00, a manicured hand swipes it off. Text: "a day in the life of a woman who does everything right."',
     shots=[
        (1.5, "CU", "6:00 alarm dismissed", LIFE, "a day in the life of a woman who does everything right.", "phone"),
        (2.5, "crop, feet and hands", "pilates reformer movement", LIFE, "6am pilates.", "reformer studio"),
        (2.5, "close", "green juice poured into a clear glass", LIFE, "green juice.", "green juice, clear glass"),
        (2.5, "overhead", "balanced lunch set down at a desk", LIFE, "a proper lunch.", "lunch bowl"),
        (3, "MS", "afternoon at the desk, hand sets down a glass of water by the laptop", LIFE, "blood sugar rises and falls through the day.", "laptop, glass of water"),
        (3, "full-frame graphic", "end card", END, "we designed for that. / join the waitlist.", "none"),
     ],
     vo="no VO (optional creator voiceover, suggested wording: \"6am pilates. green juice. a proper lunch.\")",
     audio="upbeat, polished \"day in the life\" vlog beat that eases on the afternoon shot",
     end='"we designed for that." / "join the waitlist."',
     tiktok="Faster cuts (about 1.5s each); \"day in the life\" is a native TikTok format. Text centre band.",
     props="phone, pilates studio access, green juice, clear glass, lunch bowl, laptop, glass of water",
     notes="No stock frustration acting, no stomach touching, no 3pm crash beat. Do not link the product to energy or a fix. Pre-reveal, so no product on screen. Calendar caption says \"formulated to support blood sugar balance\" and carries the footer. If a creator films it: disclose: #ad if paid, #gifted if gifted product.")

reel(id="S034", date="2026-11-10", title="packing the chrome", length=12,
     hook='Overhead: a chrome martini cup is laid into a foam-lined case. Text: "packing the chrome."',
     shots=[
        (1.5, "overhead", "chrome martini cup set into foam case", BTSPACK, "packing the chrome.", "chrome martini cup, foam case"),
        (2, "CU", "chrome tweezers wrapped in a cloth", BTSPACK, "tweezers.", "chrome tweezers, cloth"),
        (2, "overhead", "chrome platter slid into a sleeve", BTSPACK, "a chrome platter.", "chrome platter, sleeve"),
        (2, "CU", "glass sheets wrapped and stacked", BTSPACK, "a lot of glass.", "glass sheets, bubble wrap"),
        (2, "overhead", "case lid closes, latches click", BTSPACK, "none", "case"),
        (2.5, "full-frame graphic", "end card", END, "new york, 11 to 14 november. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="ASMR-forward: real clinks and latch clicks up front, light minimal beat underneath",
     end='"new york, 11 to 14 november." / "join the waitlist."',
     tiktok="Keep natural sound high; packing ASMR is a TikTok format. Text centre band.",
     props="chrome martini cup, chrome tweezers, chrome platter, glass sheets, foam-lined case, cloths",
     notes="Keep the product out of frame (reveal is 23 Nov).")

reel(id="S037", date="2026-11-11", title="under the glass BTS", length=15,
     hook='Looking up through a glass sheet, a crew hand sets an object on top. Text: "how we shot under the glass."',
     shots=[
        (1.5, "low angle, up through glass", "hand places a prop on the glass sheet", UG, "how we shot under the glass.", "glass sheet, prop"),
        (3, "wide BTS", "glass sheet on stands, camera on the floor pointing up", BTSSET, "a sheet of glass.", "stands, glass sheet"),
        (3, "CU", "camera on the floor, lens up", BTSSET, "a camera underneath.", "camera rig"),
        (3, "close", "crew mists water droplets on the glass", BTSSET, "and a lot of water.", "mister"),
        (2, "CU", "tethered monitor shows the final frame", BTSSET, "day 1.", "monitor"),
        (2.5, "full-frame graphic", "end card", END, "with studiovic. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="building, cinematic minimal electronic; snap cuts on the beat",
     end='"with studiovic." / "join the waitlist."',
     tiktok="Same-day post works better on TikTok; lead with the monitor frame if the hook underperforms. Text centre band.",
     props="glass sheet, C-stands, camera rig, mister, monitor, prop object (not the product)",
     notes="Product stays out of frame or fully obscured until the 23 Nov reveal. Confirm StudioVIC tag and handle [CONFIRM]. Needs same-day edit on set.")

reel(id="S040", date="2026-11-13", title="capsule from beneath", length=10,
     hook='From beneath the glass: tweezers lower a single capsule into frame. Text: "a capsule, from beneath the glass."',
     shots=[
        (1.5, "low angle, up through glass", "tweezers lower one capsule", UG, "a capsule, from beneath the glass.", "glass sheet, chrome tweezers, capsule"),
        (2, "low angle, up through glass", "capsule lands, droplets shiver", UG, "a capsule, from beneath the glass.", "capsule, water"),
        (2.5, "wide BTS", "camera rig under the glass", BTSSET, "the shot.", "camera rig"),
        (2, "CU", "monitor shows the hero frame", BTSSET, "none", "monitor"),
        (2, "full-frame graphic", "end card", END, "the shot we're most excited about. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="slow, airy ambient build with a soft drop when the capsule lands",
     end='"the shot we\'re most excited about." / "join the waitlist."',
     tiktok="Open on the landing (shot 2) for a faster hook; loop the clip so the end flows into the start. Text centre band.",
     props="glass sheet, chrome tweezers, capsule(s), mister, camera rig, monitor",
     notes="Confirm the capsules on set are real product, not stand-ins [CONFIRM]. Bottle stays out of frame until 23 Nov.")

reel(id="S042", date="2026-11-14", title="shoot wrap montage", length=15,
     hook='A chrome platter spins on a turntable, light flares off it. Text: "that\'s a wrap."',
     shots=[
        (1.5, "close", "chrome platter spins, flare", CP, "that's a wrap.", "chrome platter, turntable"),
        (2, "low angle", "under-the-glass rig", UG, "none", "glass rig"),
        (2, "wide", "gradient backdrop lit", GB, "none", "backdrop"),
        (2, "overhead", "styled vanity tray", PE, "none", "chrome tray, jewelry"),
        (2, "overhead", "open handbag set", IB, "none", "handbag"),
        (2, "close", "capsules on mirror set", CM, "none", "mirror, capsules"),
        (1.5, "wide", "lights switch off", BTSSET, "none", "none"),
        (2, "full-frame graphic", "end card", END, "four days. one bottle. a lot of chrome. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="energetic, fast-cut montage beat; one cut per beat",
     end='"four days. one bottle. a lot of chrome." / "join the waitlist."',
     tiktok="Even faster (about 1s per cut), crew faces allowed with consent. Text centre band.",
     props="pull from shoot B-roll of every set; turntable",
     notes="Bottle obscured in every frame until 23 Nov. \"one bottle\" assumes a real bottle was on set [CONFIRM].")

reel(id="S048", date="2026-11-17", title="creator 1 waitlist", length=20,
     hook='Creator to camera, raises her phone showing the waitlist page. Text: "I joined a waitlist for a supplement. let me explain."',
     shots=[
        (1.5, "MCU", "creator raises phone to lens", CREATOR, "I joined a waitlist for a supplement. let me explain.", "phone with waitlist page"),
        (5, "MCU", "creator speaks, line 1", CREATOR, "most live in a drawer.", "none"),
        (3, "B-roll", "brand chrome B-roll from shoot (no product)", CP, "formulated to support metabolism, blood sugar balance and gut health.", "shoot B-roll"),
        (5, "MCU", "creator speaks, line 2", CREATOR, "launching 3 december.", "none"),
        (3, "MCU", "creator speaks, line 3, small shrug", CREATOR, "I'm on the list.", "none"),
        (2.5, "full-frame graphic", "end card", END, "join the waitlist.", "none"),
     ],
     vo="creator to camera. Suggested wording only, creator to adapt: (1) \"I don't really do supplements. most of mine live in a drawer.\" (2) \"this one's formulated to support metabolism, blood sugar balance and gut health, and it actually looks good. it launches 3 december.\" (3) \"so yes, I'm on the list.\"",
     audio="creator's own voice; quiet lo-fi bed at most",
     end='"join the waitlist."',
     tiktok="Post natively from the creator's account (or Spark/collab). Keep the creator's own captions style; brand end card optional. Text centre band.",
     props="creator's phone showing waitlist page, shoot B-roll (no product)",
     notes="Creator may not claim results, energy or body changes. Paid partnership label; disclose: #ad if paid, #gifted if gifted product. Pre-reveal, so no product on screen. Footer in caption. Approve the script before filming.")

reel(id="S051", date="2026-11-19", title="gut health minus the hype", length=20,
     hook='"gut health," appears, then chrome tweezers pluck a glittery "hype" tile away, leaving "minus the hype."',
     shots=[
        (1.5, "overhead", "tweezers lift the \"hype\" tile out of frame", CT, "gut health, minus the hype.", "chrome tweezers, acrylic tile"),
        (4, "macro", "slow ripple in a glass of water", UG, "your gut breaks down food,", "glass, water"),
        (4, "macro", "droplets drawn across frosted glass", UG, "absorbs nutrients from it,", "frosted glass, mister"),
        (4, "macro", "soft light shifts across frosted glass", GB, "and is home to your gut microbiome.", "frosted glass"),
        (3.5, "full-frame type", "line settles on ice blue", TYPE, "metabolic reset is formulated to support gut health.", "none"),
        (3, "full-frame graphic", "end card", END, "no hype. / join the waitlist.", "none"),
     ],
     vo="optional VO (suggested): calm, close-mic, reads the cards only.",
     audio="clean, minimal, slightly playful pluck melody",
     end='"no hype." / "join the waitlist."',
     tiktok="Add \"in 20 seconds\" to the native caption to match S013. Text centre band.",
     props="chrome tweezers, glittery \"hype\" acrylic tile, glasses, frosted glass, mister",
     notes="Have the gut lines checked [CONFIRM]. No cartoon gut graphics. Footer in caption.")

reel(id="S054", date="2026-11-20", title="creator 2 waitlist spot", length=15,
     hook='At her vanity, the creator holds her phone up to the mirror showing the waitlist page. Text: "saving my spot on the waitlist."',
     shots=[
        (1.5, "mirror reflection MCU", "creator holds phone with the waitlist page up to the mirror", CREATOR, "\"saving my spot on the waitlist.\"", "creator's vanity, phone with waitlist page"),
        (4, "mirror reflection MCU", "creator speaks, line 1", CREATOR, "supplements never made the cut.", "mirror"),
        (4, "mirror reflection MCU", "creator speaks, line 2", CREATOR, "launching 3 december.", "none"),
        (3, "overhead", "creator places a small \"reserved\" card on an empty spot on her chrome tray", PE, "saving a spot.", "chrome tray, \"reserved\" card"),
        (2.5, "full-frame graphic", "end card", END, "join the waitlist.", "none"),
     ],
     vo="creator to camera. Suggested wording only: (1) \"my vanity is very curated. supplements never made the cut.\" (2) \"this one is formulated to support metabolism, blood sugar balance and gut health. it launches 3 december, so I'm saving my spot on the waitlist.\"",
     audio="soft, chic get-ready-with-me beat",
     end='"join the waitlist."',
     tiktok="GRWM framing is native: let her do one makeup step while talking. Text centre band.",
     props="creator's vanity, chrome tray, lipstick, jewelry, phone with waitlist page, \"reserved\" card",
     notes="Posts 20 Nov, before the 23 Nov reveal: no product, bottle or capsule on screen, and nothing implying she has used it. Do not swap in the bottle even if product reaches her early. Paid partnership label; disclose: #ad if paid, #gifted if gifted product. Footer in caption.")

reel(id="S057", date="2026-11-23", title="product reveal", length=15,
     hook='A hand sets the bottle down onto the chrome platter, a hard glint flares. Text: "meet"',
     shots=[
        (1.5, "CU", "bottle set onto platter, glint", CP, "meet", "bottle, chrome platter"),
        (3, "slow push-in", "bottle on platter, ice blue seamless", CP, "meet metabolic reset.", "bottle, platter"),
        (3, "low angle, up through glass", "bottle silhouette from beneath", UG, "a daily capsule.", "bottle, glass sheet"),
        (3, "macro", "tweezers lift a single capsule", CT, CLAIM, "capsule, chrome tweezers"),
        (2, "MS", "bottle turns slowly on gradient", GB, "launching 3 december.", "bottle, turntable"),
        (2.5, "full-frame graphic", "end card", END, "maison belasi. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="slow, anticipatory build with a clean drop on \"meet metabolic reset.\"",
     end='"maison belasi." / "join the waitlist."',
     tiktok="Put \"meet metabolic reset.\" on frame 1 (no build-up). Text centre band.",
     props="real bottle, capsules, chrome platter, glass sheet, chrome tweezers, turntable, ice blue seamless",
     notes="Needs real product footage from the shoot (packshots due ~22 Nov). Never composite a fake bottle.")

reel(id="S062", date="2026-11-25", title="in her bag", length=12,
     hook='Top-down into an open handbag, a lipstick drops in on the beat. Text: "packed with intention."',
     shots=[
        (1.5, "overhead", "lipstick drops into open bag", IB, "packed with intention. / lipstick.", "handbag, lipstick"),
        (2, "overhead", "headphones drop in", IB, "headphones.", "headphones"),
        (2, "overhead", "keys drop in", IB, "keys.", "keys"),
        (2.5, "overhead", "bottle placed in, beat lands", IB, "metabolic reset.", "bottle"),
        (1.5, "close", "clasp snaps shut", IB, "none", "handbag"),
        (2.5, "full-frame graphic", "end card", END, "packed with intention. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="rhythmic \"what's in my bag\" beat; one item per beat",
     end='"packed with intention." / "join the waitlist."',
     tiktok="\"what's in my bag\" format: add the item names in TikTok-native text style. Text centre band.",
     props="structured handbag, lipstick, headphones, keys, bottle",
     notes="Concept repeats in S095; see report.")

reel(id="S064", date="2026-11-26", title="creator 3 post", length=15,
     hook='Creator styles the bottle beside a chrome martini cup and raises her phone to shoot it. Text: "biohacking, but something I\'d actually post."',
     shots=[
        (1.5, "MS", "creator styles bottle next to martini cup, phone up", CREATOR, "\"biohacking, but something I'd actually post.\"", "bottle, chrome martini cup, phone"),
        (4, "MCU", "creator speaks, line 1", CREATOR, "chrome. glass. good light.", "none"),
        (3, "over the shoulder", "her phone screen shows the shot she is taking", CREATOR, "none", "phone"),
        (4, "MCU", "creator speaks, line 2", CREATOR, CLAIM, "none"),
        (2.5, "full-frame graphic", "end card", END, "join the waitlist.", "none"),
     ],
     vo="creator to camera. Suggested wording only: (1) \"my feed is chrome, glass and good light. my supplements never were.\" (2) \"this one's formulated to support metabolism, blood sugar balance and gut health. and yes, it's going on my grid.\"",
     audio="playful, stylish creator-vlog beat; shutter sound on the phone shot",
     end='"join the waitlist."',
     tiktok="Post from the creator's account; let her caption it in her own words. Text centre band.",
     props="bottle, chrome martini cup, creator's phone, styled table",
     notes="Creator needs product in hand before filming [CONFIRM]; no use or results claims. Paid partnership label; disclose: #ad if paid, #gifted if gifted product. Footer in caption.")

reel(id="S068", date="2026-11-28", title="mirror mirror", length=10,
     hook='Tweezers set one capsule onto a round mirror; it doubles in the reflection. Text: "mirror, mirror."',
     shots=[
        (1.5, "overhead", "tweezers place one capsule on mirror", CM, "mirror, mirror.", "round mirror, capsule, tweezers"),
        (2.5, "low angle across mirror", "bottle and its reflection", CM, "mirror, mirror.", "bottle, mirror"),
        (2.5, "rack focus", "focus pulls from reflection to bottle", CM, "the most considered thing on your vanity.", "bottle"),
        (1.5, "close", "hand lifts bottle out of frame", CM, "none", "bottle"),
        (2, "full-frame graphic", "end card", END, "launching 3 december. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="dreamy, slightly eerie fairy-tale chime vibe, slow",
     end='"launching 3 december." / "join the waitlist."',
     tiktok="Make it loop: end on the empty mirror so it flows back into shot 1. Text centre band.",
     props="round vanity mirror, capsule, chrome tweezers, bottle",
     notes="Show one capsule only, so the frame implies no dose. CTA \"join the waitlist.\" is in the calendar caption.")

reel(id="S072", date="2026-11-30", title="chrome spoon ingredients", length=12,
     hook='A chrome spoon slides into frame carrying a slice of ginger root. Text: "ginger."',
     shots=[
        (1.5, "macro", "spoon with ginger root slides in", GB, "ginger.", "chrome spoon, ginger root"),
        (2, "macro", "spoon with green tea leaves", GB, "green tea.", "chrome spoon, green tea leaves"),
        (2, "macro", "spoon with barberries", GB, "barberry.", "chrome spoon, barberries"),
        (2, "macro", "spoon under frosted glass (fourth ingredient, if public)", UG, "[ingredient 4]. [CONFIRM]", "chrome spoon, frosted glass"),
        (2, "overhead", "all spoons lined up on the chrome platter", CP, "chosen on purpose.", "chrome platter, spoons"),
        (2.5, "full-frame graphic", "end card", END, "full formula in our latest post. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="crisp, minimal, one clean hit per ingredient",
     end='"full formula in our latest post." / "join the waitlist."',
     tiktok="TikTok has no carousel: caption reads \"full formula in our latest post (TikTok: link in bio).\" and the TikTok end card reads \"full formula: link in bio.\" Text centre band.",
     props="4 chrome spoons, ginger root, green tea leaves, barberries, frosted glass, chrome platter, ice blue gradient",
     notes="Marked [HOLD] in the ad pack: post only after the S071 formula carousel is confirmed and live [CONFIRM full formula]. Never use or caption bismuth as chromium. No doses on screen unless confirmed ([dose]). No per-ingredient benefit claims. CTA \"join the waitlist.\" is in the calendar caption.")

reel(id="S076", date="2026-12-01", title="two days founder", length=25,
     hook='Founder lifts the bottle into frame. Text: "two days."',
     shots=[
        (1.5, "MCU", "founder raises bottle to lens", FOUNDER, "two days.", "bottle"),
        (4, "MCU", "founder speaks, intro line", FOUNDER, "here's what's in the bottle and why.", "bottle"),
        (4, "macro insert", "spoon of ginger root (S072 footage), founder VO", GB, "ginger root. [dose]", "S072 footage"),
        (4, "macro insert", "spoon of green tea leaves, founder VO", GB, "green tea. [dose]", "S072 footage"),
        (4, "macro insert", "spoon of barberries, founder VO", GB, "barberry. [dose]", "S072 footage"),
        (4, "macro insert", "fourth ingredient, founder VO", GB, "[ingredient 4]. [dose]", "S072 footage"),
        (3.5, "full-frame graphic", "end card", END, "launching 3 december. / join the waitlist.", "none"),
     ],
     vo="founder to camera then VO. Suggested wording only [founder script] [CONFIRM]: \"two days. here's what's in the bottle, and why.\" then one line per ingredient: \"[ingredient], at [dose]. we chose it because [CONFIRM permitted reason].\"",
     audio="no music under speech, or a very low ambient pad; burned-in captions",
     end='"launching 3 december." / "join the waitlist."',
     tiktok="Talking-head first, inserts second. Countdown framing is native; use TikTok's countdown sticker if available. Text centre band.",
     props="bottle, S072 spoon footage, lav mic, styled chrome tray backdrop",
     notes="Every ingredient line depends on [dose] and a confirmed, permitted reason [CONFIRM]. CTA \"join the waitlist.\" and footer are in the calendar caption.")

reel(id="S079", date="2026-12-02", title="first edition packed by hand", length=15,
     hook='Under a desk lamp, hands fold tissue over a bottle in a box. Text: "the night before."',
     shots=[
        (1.5, "CU", "tissue folded over bottle in box", DISPATCH, "the night before.", "box, tissue, bottle"),
        (3, "overhead", "stack of boxes on a table", DISPATCH, "the first edition,", "boxes"),
        (3, "CU", "a card tucked into a box", DISPATCH, "packed by hand.", "insert card"),
        (3, "CU", "box sealed with a sticker", DISPATCH, "none", "sticker"),
        (2, "wide", "room of boxes, lamp clicks off", DISPATCH, "none", "lamp"),
        (2.5, "full-frame graphic", "end card", END, "see you tomorrow. / join the waitlist.", "none"),
     ],
     vo="no VO",
     audio="quiet, intimate, late-night lo-fi; real paper and tape sounds",
     end='"see you tomorrow." / "join the waitlist."',
     tiktok="Keep natural sound up (packing ASMR). Native caption: \"tomorrow.\" Text centre band.",
     props="shipping boxes, tissue, bottles, insert cards, stickers, desk lamp",
     notes="Cover reads \"the first edition, packed by hand.\" There are no orders before launch: never say \"orders\" on screen or in caption. \"packed by hand\" must be true [CONFIRM]. CTA \"join the waitlist.\" is in the calendar caption.")

reel(id="S082", date="2026-12-03", title="launch film", length=20,
     hook='The bottle lands on the chrome platter, light flares. Text: "it\'s here."',
     shots=[
        (1.5, "CU", "bottle lands on platter, flare", CP, "it's here.", "bottle, chrome platter"),
        (2.5, "low angle, up through glass", "bottle from beneath", UG, "metabolic reset.", "bottle, glass sheet"),
        (3, "macro", "tweezers lift a capsule", CT, "a daily capsule,", "capsule, tweezers"),
        (3, "overhead", "bottle on vanity tray among jewelry", PE, CLAIM, "bottle, chrome tray, jewelry"),
        (3, "overhead", "bottle dropped into handbag", IB, "goes where you go.", "bottle, handbag"),
        (2.5, "close", "capsule on mirror, reflection", CM, "by maison belasi.", "capsule, mirror"),
        (4.5, "full-frame graphic", "end card on gradient", END, "now available. / shop now.", "none"),
     ],
     vo="no VO",
     audio="confident, polished launch-film beat, one set per bar, big clean drop on \"it's here.\"",
     end='"now available." / "shop now."',
     tiktok="Open with \"it's here.\" plus a 1s bottle close-up only, then faster cuts. Text centre band. Caption: \"shop now, link in bio.\"",
     props="bottle, capsules, chrome platter, glass sheet, chrome tweezers, chrome tray, jewelry, handbag, round mirror",
     notes="Cut from Shoot No. 1 footage. Footer in caption (already in calendar).")

reel(id="S086", date="2026-12-04", title="unboxing", length=20,
     hook='Overhead on ice blue: a hand pulls the tab on the box. Text: "unboxing metabolic reset."',
     shots=[
        (1.5, "overhead", "hand pulls box tab", PE, "unboxing metabolic reset.", "shipping box"),
        (3, "overhead", "lid lifts, tissue parts", PE, "the first edition,", "box, tissue"),
        (3, "close", "bottle lifted into the light", PE, "opened.", "bottle"),
        (3, "overhead", "insert card shown", PE, "[CONFIRM what's in the box]", "insert card"),
        (3, "overhead", "bottle set on chrome tray beside jewelry", PE, "none", "chrome tray, jewelry"),
        (3, "macro", "cap off, tweezers lift one capsule", CT, "none", "capsule, tweezers"),
        (3.5, "full-frame graphic", "end card", END, "shop now.", "none"),
     ],
     vo="no VO",
     audio="unboxing ASMR first (paper, tab, cap), soft beat underneath",
     end='"shop now."',
     tiktok="Unboxing is native: shoot handheld on phone for TikTok, keep it rawer than the IG cut. Text centre band.",
     props="final shipping box, tissue, insert card, bottle, chrome tray, jewelry, chrome tweezers",
     notes="Box contents and packaging must be final [CONFIRM]. No pill-spill.")

reel(id="S089", date="2026-12-06", title="how to take it", length=15,
     hook='A glass of water is set down beside the bottle on a chrome tray. Text: "how to take metabolic reset."',
     shots=[
        (1.5, "close", "glass set down beside bottle", PE, "how to take metabolic reset.", "clear glass, bottle, chrome tray"),
        (3, "macro", "tweezers place capsule(s) beside the glass", CT, "1. [dose].", "capsules, tweezers"),
        (3, "close", "water poured into glass", PE, "2. with water.", "jug, water"),
        (3, "close", "hand lifts glass", PE, "3. [CONFIRM when to take].", "glass"),
        (2, "ECU", "label on bottle", PE, "4. read the label.", "bottle"),
        (2.5, "full-frame graphic", "end card", END, "always read the label and follow the directions for use. / shop now.", "none"),
     ],
     vo="optional VO (suggested): reads the steps only.",
     audio="calm, clean, metronome-steady minimal beat",
     end='"always read the label and follow the directions for use." / "shop now."',
     tiktok="Number the steps large; how-to is a saveable TikTok format. Text centre band.",
     props="bottle, capsules, clear glass, jug, chrome tray, chrome tweezers",
     notes="Cannot be filmed until [dose] and timing are confirmed. Footage must show exactly the confirmed number of capsules.")

reel(id="S092", date="2026-12-08", title="creator it arrived", length=15,
     hook='Creator at her door holds the box up to the lens. Text: "it arrived."',
     shots=[
        (1.5, "MCU", "creator holds box up at the door", CREATOR, "\"it arrived.\"", "shipping box"),
        (3, "overhead", "creator opens box on table", CREATOR, "first look.", "box"),
        (3, "close", "creator turns the bottle in the light", CREATOR, "none", "bottle"),
        (4, "MCU", "creator speaks", CREATOR, CLAIM, "bottle"),
        (3.5, "full-frame graphic", "end card", END, "shop now.", "none"),
     ],
     vo="creator to camera. Suggested wording only: \"okay, the chrome. it's formulated to support metabolism, blood sugar balance and gut health, and it's going straight on my vanity.\"",
     audio="creator's natural sound plus a light, happy beat",
     end='"shop now."',
     tiktok="Post from the creator's account; raw handheld. Text centre band.",
     props="shipping box, bottle (creator's own space)",
     notes="First impressions only: no results, no \"after a week\", no body talk. Film only after the product arrives. Paid partnership label; disclose: #ad if paid, #gifted if gifted product. Footer in caption.")

reel(id="S095", date="2026-12-10", title="travel with metabolic reset", length=12,
     hook='Overhead into an open carry-on: a passport drops in on the beat. Text: "travel with metabolic reset."',
     shots=[
        (1.5, "overhead", "passport drops into an open carry-on", IB, "travel with metabolic reset.", "carry-on bag, passport"),
        (2.5, "overhead", "travel kit laid on chrome tray: passport, headphones, bottle", PE, "passport. headphones.", "passport, headphones, bottle, chrome tray"),
        (3, "side", "bottle placed in beside the headphones", IB, "metabolic reset.", "bottle, headphones"),
        (2.5, "MS", "bag zipped and wheeled out of frame", IB, "goes where you go.", "carry-on bag"),
        (2.5, "full-frame graphic", "end card", END, "shop now.", "none"),
     ],
     vo="no VO",
     audio="travel-ready, upbeat walking-tempo beat",
     end='"shop now."',
     tiktok="Lean into the December travel and holiday angle. Text centre band.",
     props="carry-on bag, passport, headphones, bottle, chrome tray",
     notes="Travel angle (passport, headphones) so it does not repeat S062 (\"in her bag\": lipstick, headphones, keys). Check Shoot No. 1 footage covers a travel bag, else reshoot off-set with the real bottle.")

reel(id="S097", date="2026-12-14", title="wrapped in chrome", length=15,
     hook='Hands fold mirror-silver paper over a box. Text: "gift it in chrome."',
     shots=[
        (1.5, "CU", "hands fold mirror-silver paper over a box", GIFT, "gift it in chrome.", "box, mirror-silver paper"),
        (3, "close", "ice blue ribbon tied", GIFT, "gift it in chrome.", "ice blue ribbon"),
        (3, "close", "tag written: \"for you.\"", GIFT, "none", "gift tag, pen"),
        (3, "overhead", "gift placed on chrome platter beside silver jewelry", CP, "the most considered gift under the tree.", "chrome platter, jewelry"),
        (2, "overhead", "box opens to show the bottle", CP, "metabolic reset.", "bottle"),
        (2.5, "full-frame graphic", "end card", END, "shop now.", "none"),
     ],
     vo="no VO",
     audio="festive but restrained: sleigh-bell-free, soft chimes over a minimal beat",
     end='"shop now."',
     tiktok="Gift-wrap ASMR works natively; slightly faster. Text centre band. Add Christmas shipping cut-off in the caption once confirmed.",
     props="gift box, mirror-silver wrapping paper, ice blue ribbon, gift tag, chrome platter, silver jewelry, bottle",
     notes="New footage (not from Shoot No. 1). Christmas shipping cut-offs for NZ and AU [CONFIRM]. If we sell a gift box or offer gift wrap, show only what exists [CONFIRM].")

reel(id="S100", date="2026-12-19", title="thank you first edition", length=20,
     hook='Founder holds a handwritten card to the lens. Text: "thank you for the first edition."',
     shots=[
        (1.5, "MCU", "founder holds card to lens", FOUNDER, "thank you for the first edition.", "handwritten card"),
        (6, "MCU", "founder speaks, line 1", FOUNDER, "thank you.", "none"),
        (3, "B-roll", "packing footage (reuse S079)", DISPATCH, "none", "S079 footage"),
        (6, "MCU", "founder speaks, line 2", FOUNDER, "see you in 2027.", "none"),
        (3.5, "full-frame graphic", "end card", END, "see you in 2027. / shop now.", "none"),
     ],
     vo="founder to camera. Suggested wording only [founder script]: (1) \"thank you to everyone who joined the waitlist and chose the first edition.\" (2) \"we're reading every message. there's more to come in 2027.\" [CONFIRM]",
     audio="no music under speech, or a very low warm-but-cool ambient pad",
     end='"see you in 2027." / "shop now."',
     tiktok="Talking-head native; open on \"thank you\", not the card. Text centre band.",
     props="handwritten card, styled chrome tray backdrop, lav mic, S079 footage",
     notes="No order numbers, \"sold out\" or customer quotes unless real [CONFIRM]. Do not read out customer messages that describe results.")

# ---------- validate ----------
errs = []
for r in R:
    tot = round(sum(s[0] for s in r["shots"]), 2)
    if tot != r["length"]:
        errs.append(f"{r['id']} shots sum {tot} != {r['length']}")
    if not (7 <= r["length"] <= 30):
        errs.append(f"{r['id']} length {r['length']}")
    pre = r["date"] < "2026-12-03"
    endtxt = r["end"].lower()
    if pre and "join the waitlist" not in endtxt:
        errs.append(f"{r['id']} pre-launch CTA missing")
    if not pre and "shop now" not in endtxt:
        errs.append(f"{r['id']} launch CTA missing")
# ---------- sync with posts.csv ----------
with open(f"{OUT_DIR}/posts.csv") as f:
    cal = {row["id"]: row for row in csv.DictReader(f) if row["format"] == "REEL"}
ids = {r["id"] for r in R}
for cid in sorted(set(cal) - ids):
    errs.append(f"{cid} is a REEL in posts.csv but has no script")
for r in R:
    c = cal.get(r["id"])
    if not c:
        errs.append(f"{r['id']} has a script but is not a REEL in posts.csv")
    elif (c["date"], c["title"]) != (r["date"], r["title"]):
        errs.append(f"{r['id']} out of sync with posts.csv: {c['date']} {c['title']!r} vs {r['date']} {r['title']!r}")
R.sort(key=lambda r: (r["date"], r["id"]))
if errs:
    print("\n".join(errs)); sys.exit(1)

def fmt(x):
    return ("%g" % x)

# ---------- markdown ----------
L = []
L.append("# Reel filming scripts: Metabolic Reset organic calendar")
L.append("")
L.append(f"Built 23 Oct 2026 from `posts.csv` (every row where format = REEL; {len(R)} Reels). Each Reel is cross-posted to TikTok. Covers already exist in Canva; these scripts are what gets filmed. The batch-by-set shot list is `reel-shotlist.csv`.")
L.append("")
L.append("## How to use")
L.append("")
L.append("- **On-screen text** is exact wording, lowercase, burned in. Max about 6 words per card where possible. `/` = next card or line.")
L.append("- **Sets** use the Shoot No. 1 names: Chrome Platter, Under the Glass, Gradient Backdrop, Product & Essentials (vanity/chrome tray), Inside the bag, capsules + tweezers, capsules on mirror. Anything else is labelled Off-set, BTS, Pre-shoot or Canva.")
L.append("- **Before 23 Nov** (product reveal) no bottle appears on screen. Never mock up or render a bottle. Real packshots arrive ~22 Nov.")
L.append("- **Creator and founder lines are suggested wording only.** They rewrite in their own words, then the script is approved before filming.")
L.append("- **Audio:** the brand account must use licensed audio (Meta Sound Collection / TikTok Commercial Music Library). Audio notes describe a vibe, not a track.")
L.append("- **Safe zone (both platforms):** keep text in the centre band, roughly 15% clear at the top, 25% at the bottom (caption, handle) and 15% on the right (buttons). TikTok notes below cover what else changes.")
L.append("- Shoot 9:16, 1080x1920, 4K if possible. Grade: white, ice blue, chrome. No warm neutrals, no neon.")
L.append("")
L.append("## Compliance reminder (NZ/AU)")
L.append("")
L.append(f"- Structure/function only: \"{CLAIM}\" Never cure, treat, prevent, detox, burn fat, weight loss, or any outcome or timeframe.")
L.append("- No before/after bodies, measuring tapes, scales, stomach pinching, pill-spill, or identifiable competitor products.")
L.append("- No invented testimonials, stats, doses, prices or ingredients. Placeholders stay until confirmed: [dose], [price], [ingredient 4], [CONFIRM]. A Reel with a placeholder on screen does not post until it is filled.")
L.append("- CTA: before 3 Dec \"join the waitlist\"; from 3 Dec \"shop now\".")
L.append("- Creators: no results, energy or body claims, and nothing implying use before they received the product. Paid partnership label; disclose: #ad if paid, #gifted if gifted product.")
L.append(f"- Any Reel that names the product's function carries the footer in its caption: *{FOOTER}*")
L.append("")
L.append("---")
for r in R:
    L.append("")
    L.append(f"## {r['id']} · {r['date']} · {r['title']}")
    L.append("")
    L.append(f"**Length:** {r['length']}s  ")
    L.append(f"**Hook (0 to 1.5s):** {r['hook']}")
    L.append("")
    L.append("| # | dur | framing | action | set | on-screen text |")
    L.append("|---|---|---|---|---|---|")
    for i, s in enumerate(r["shots"], 1):
        L.append(f"| {i} | {fmt(s[0])}s | {s[1]} | {s[2]} | {s[3]} | {s[4]} |")
    L.append("")
    L.append(f"**VO:** {r['vo']}  ")
    L.append(f"**Audio:** {r['audio']}  ")
    L.append(f"**End card + CTA:** {r['end']}  ")
    L.append(f"**TikTok:** {r['tiktok']}  ")
    L.append(f"**Props:** {r['props']}")
    if r.get("notes"):
        L.append("")
        L.append(f"> Note: {r['notes']}")
L.append("")
md = "\n".join(L)
open(f"{OUT_DIR}/reel-scripts.md", "w").write(md)

with open(f"{OUT_DIR}/reel-shotlist.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "date", "set", "shot_no", "duration_s", "framing", "action", "props"])
    for r in R:
        for i, s in enumerate(r["shots"], 1):
            w.writerow([r["id"], r["date"], s[3], i, fmt(s[0]), s[1], s[2], s[5]])
print("ok", len(R))
