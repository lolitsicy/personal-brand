# Canva audit: gaps and issues (Metabolic Reset)

Audited 23 Oct 2026, read-only. Machine-readable inventory: `canva-inventory.json` (294 designs).

| Area | Live | Archive | Total |
|---|---|---|---|
| Ads, 1 PRE-LAUNCH (C1–C5) | 105 | 40 | 145 |
| Ads, 2 LAUNCH (L1–L4) | 46 | 0 | 46 |
| Organic (W1–W9 + LAUNCH) | 100 | 3 | 103 |
| **Total** | **251** | **43** | **294** |

Every live design was read with `read-design`. The 43 archive designs were listed but not read, so they have no size or text in the inventory. Live variants: 74 at 4x5, 144 at 9x16 and 33 at 3x4.

## 1. Planned items with no live design, or missing a variant
None.
- Pre-launch ads 01–50: all present in both 4x5 and 9x16, except 36/37/38, which are 9x16 only as planned. 33 and 34 are absent from pre-launch because they became L2-01 and L2-02.
- Launch ads L1-01..L1-08, L2-01..L2-04, L3-01..L3-05 and L4-01..L4-06: all present in both 4x5 and 9x16.
- Organic S001–S100: all 100 present.

## 2. Duplicates (same plan_id + variant, live)
None.

## 3. Wrong size or wrong page count
None.
- All 4x5 designs are 1080x1350, and all 9x16 designs are 1080x1920.
- Organic FEED and CAROUSEL posts are 1080x1440. REEL and STORY posts are 1080x1920.
- Carousel page counts match CAROUSEL-n. S004, S023, S033 and S065 have 4 pages, and S059 and S083 have 3, as planned. Every ad has 1 page.
- The size notes in the 19 Oct pack ("came out 9:16", "check size") are out of date. Every live ad is now the correct size.

## 4. Text that differs from the plan's on-image text
Most designs match the plan word for word. Canva's text export drops line breaks, which produces run-together words like "notfeeling". These are not real differences. The real differences are:
- **C4-40 FAQ (4x5 + 9x16):** the plan's subline "3 questions, answered" is missing. In its place the design shows the full Q&A: "What is it? A daily capsule. What's it for? Formulated to support… When? First edition. Waitlist first."
- **C1-10 (4x5 + 9x16)** adds "the first edition is limited." That line is not in the plan's on-image text. The same claim is marked [CONFIRM] on C5-43 and S018, but nothing flags it here.
- **C5-41** adds "the first edition is limited." This is the same unflagged claim as C1-10.
- **C5-46** adds "first edition only."
- **Other C5 sublines and C4-35:** each adds a short subline taken from its primary text:
  - C5-42: "waitlist members get first access."
  - C5-43: "the waitlist hears first."
  - C5-44: "just first in line."
  - C5-45: "first edition, coming soon."
  - C5-47: "one step to join."
  - C5-50: "waitlist closes [date]."
  - C4-35: "waitlist members see it first."
  
  These follow the deck's copy, but they go beyond its on-image text.
- **C3 stacked lines:** the plan's arrow or check marks are missing on C3-21, C3-22 and C3-26 (no "→") and on C3-30 (no "✓"). C3-23, C3-24, C3-25, C3-27, C3-28 and C3-29 keep them. This is formatting only.
- **C4-36:** the quote uses straight quotes ("…"), while C4-37 and C4-38 use curly quotes (“…”). All three show "@creator" where the plan has "[creator]".
- **Plan [CONFIRM]/[HOLD] flags that appear nowhere on the design:**
  - C1-06: "No proprietary blends. No guesswork."
  - C3-23: "promises we can't keep"
  - C3-25: "Two capsules", which needs the dose confirmed
  - C3-30: "no proprietary blends"
  - C5-43: "the first run is small."
  - C5-46: "founding pricing"
  
  C5-43 and C5-46 are flagged only by their title and folder ("CONFIRM").
- **Organic:** every cover and story frame matches `on_image`. The inner carousel slides have no on-image text in the plan to check against.

## 5. Designs outside the expected folder
None.
- Every C ad sits in its planned ad-set folder: C1 AS1–AS3, C2 AS1–AS3, C3 AS1–AS3, C4 AS1–AS3 and C5 AS1–AS3.
- Every L ad sits in its L1–L4 folder.
- Every S post sits in its planned week folder. S081–S085 are in "LAUNCH | Thu 3 Dec".

## 6. Other findings
- **Placeholders still on live designs:** 65 designs. The 42 frames that show only "[sticker]" are expected; these mark where Instagram stickers go. The ones that must be filled before use are:
  - **Ads:**
    - C4-39 "[founder note, 40 to 60 words]"
    - C5-48 "[third perk]"
    - C5-50 "[date]"
    - L1-05 and L2-03 "[ingredient 4]"
    - L1-08 "[price] · [shipping offer] [CONFIRM]"
    - L3-01 "[date] [CONFIRM]"
    - L3-02 "[CONFIRM]"
    - L3-04 "[run size] [CONFIRM]"
    - L3-05 "[date] [CONFIRM]"
    - L4-03 "[dose]" and "[details]"
    - L4-05 "[save x%] [CONFIRM]"
    - L4-06 "[review] [first name], [city] [REVIEW]"
  - **Organic:**
    - S004 (the meaning of maison and belasi, the promise)
    - S018 and S075 [CONFIRM]
    - S023 (founder Q&A)
    - S052 [creator]
    - S060 [dose CONFIRM]
    - S065 [price]
    - S071 [ingredient 4] and [dose] ×4
    - S085 [dose] and [price]
    - S091 [details] and [dose]
    - S096 [accessory] and [ritual set]
    - S098 and S099 [date]
  
  On the L ads and on S004, S018, S060, S065 and S075, the literal "[CONFIRM]" text is printed on the image itself.
- **Legacy ads with no spec in the deck:** 12 live designs, in 4x5 and 9x16 pairs. The inventory maps them as `LEGACY-0n`:
  - "MR 01 the object" (C2 AS1)
  - "MR 02 in her bag" (C2 AS2)
  - "MR 05 biohacking dressed up" (C2 AS3)
  - "MR 04 third coffee" (C3 AS1)
  - "MR 03 precision not promises" (C3 AS3)
  - "MR 09 first edition" (C5 AS1)
  
  These are older ads, not copies of C1-01..C1-09. They have different text: for example, MR 04 reads "POV: it's 3pm and you're on coffee number three…" and MR 09 reads "first edition. limited run. waitlist first." The deck lists them only as "legacy 01/02/05/03/04/09", with no on-image copy, so their text was not checked. MR 09 also says "limited run" with no [CONFIRM] flag.
- **Empty folders:**
  - Each pre-launch "Archive 3x4 originals" folder still holds empty "4x5 Feed" and "9x16 Story" subfolders, 10 empty folders in total.
  - "C4 AS4 | HOLD ingredients" (FAHYbmKmj1M) is empty and now sits inside L2 | Formula reveal.
- **Archive contents:**
  - Four untitled pre-launch originals sit in the archives: "Metabolic Reset Instagram ad" in the C2, C3 and C5 archives, and "Metabolic Reset Instagram feed ad" in the C3 archive.
  - The organic "_ARCHIVE | old wrong-size copies | safe to delete" folder holds three OLD 9x16 copies, of S017, S081 and S099. Each has a correct 1080x1440 live replacement.
- **Concurrent renames during the audit:** five organic titles changed between the first folder listing and the re-check:
  - S003: "Thu 22 Oct" became "Sun 25 Oct"
  - S025: "biohacking then and now" became "biohacking redesigned"
  - S054: "creator 2 vanity" became "creator 2 waitlist spot"
  - S079: "the night before" became "first edition packed by hand"
  - S095: "packed with intention product" became "travel with metabolic reset"
  
  The new titles match posts.csv, which was itself modified at 04:48 UTC today. The inventory uses the current titles. Every organic title now matches its plan row: id, day, date, format and title. The C1–C4 ad folders were re-checked and had not changed. The C5 and L folders were not re-listed.
- **Timestamps:** every live design's `updated_at` now falls at about 04:40–04:57 UTC on 23 Oct, matching the order in which the designs were read. Reading a design appears to update this timestamp, so `updated_at` cannot be used to judge recent edits.
