# Analysis Framework

## Enriched ad record (one per ad)

```
### [Advertiser] — [ad id]
- Snapshot: [ad_snapshot_url]
- Page ID: [page_id]
- Market: [country codes] | Currency: [ccy]
- Live since: [delivery start date] ([N] days) | Status: active/inactive
- Rank score: [from rank_ads.py]
- Format: static / video ([length]s) / carousel ([n] cards) / DPA
- Primary text: "..."
- Headline: "..." | Description: "..." | CTA button: [..]
- Landing URL: [..] | Landing offer: [price / discount / quiz / free trial]
- Visual: [one-paragraph description: subject, setting, palette, type, product presence]
- Video beats (if video): 0–3s: .. | mid: .. | end card: ..
```

## 8-question teardown (per top ad)

1. **Hook:** What stops the scroll for *their* audience? Classify it with the hook taxonomy below.
2. **Emotional trigger:** Which one is primary? (frustration, shame, hope, belonging, curiosity, fear of missing out, identity)
3. **Copy structure:** PAS / AIDA / testimonial / listicle / founder story / myth-bust / us-vs-them / native-UGC
4. **Visual:** Why does it earn attention? (pattern interrupt, face, contrast, product clarity, lo-fi authenticity)
5. **Objections handled:** price, "tried everything", safety, taste/routine, scepticism of supplements
6. **Implied funnel:** Cold or warm? Direct to PDP, quiz, advertorial, lead magnet, waitlist?
7. **Compliance grade:**
   - **A:** structure/function language, qualified ("may support"), no implied disease claims
   - **B:** borderline. Implied weight-loss outcome, unqualified "clinically proven", testimonial implying a result
   - **C:** clear breach. Treats/cures/prevents, GLP-1/Ozempic equivalence, before/after bodies, kg-lost claims, diagnosing (e.g. "insulin resistance? take this")
   Reference: NZ Dietary Supplement Regulations 1985, ASA NZ Therapeutic & Health Advertising Code, AU TGA Advertising Code. Give a grade and a one-line reason. You are not giving legal advice, so recommend review for anything B or C that the user wants to approach.
8. **Underlying principle:** One sentence, execution-free. Example: "Names the invisible effort the viewer already makes, then reframes failure as a mechanism problem."

## Hook taxonomy
| Code | Hook type | Example shape |
|---|---|---|
| H1 | Effort–result gap | "Eating well, training 4x a week, still bloated?" |
| H2 | Myth bust | "Your metabolism isn't slow. It's ..." |
| H3 | Mechanism reveal | "The 3pm crash is a blood sugar story." |
| H4 | Identity callout | "For women who've tried every supplement." |
| H5 | Social proof / testimonial | "I didn't expect to notice a difference ..." |
| H6 | Authority | doctor / pharmacist / dietitian on camera |
| H7 | Offer-led | "% off", "free gift", "trial" |
| H8 | Trend / GLP-1 adjacency | "Nature's Ozempic" ← usually grade C |
| H9 | Curiosity / pattern interrupt | odd visual, ASMR, unboxing |
| H10 | Ritual / aesthetic | morning routine, product-as-object |

## Pattern map (across all ads)
| Dimension | Count by type | Most common among top-5 ranked | Observation |
|---|---|---|---|
| Hook type | | | |
| Trigger | | | |
| Format | | | |
| Visual archetype | | | |
| Offer mechanic | | | |
| Compliance grade | | | |

## White-space test
For each candidate angle, answer:
- Is anyone in NZ/AU doing it? (cite or "none seen")
- Does it trace back to "the gap is the message" (effort vs result)?
- Can it be executed at compliance grade A?
- Does it reinforce clinical restraint, or would it pull us toward category hype?
Only angles that pass all four go to Stage 4.
