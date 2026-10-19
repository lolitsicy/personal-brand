---
name: competitor-ad-intel
description: "Competitor ad intelligence pipeline for Maison Belasi / Metabolic Reset. Pulls competitor ads from the Meta Ad Library, ranks them by longevity and variant count, tears them down, then turns the findings into image-generation prompts, compliant ad copy, and a delivery plan (audience, placements, test structure). Use when the user says competitor ads, ad library, spy on competitors, what are competitors running, teardown, swipe file, or wants image prompts / copy / targeting informed by what's in market for metabolism, blood sugar, gut health, or weight-management supplements in NZ/AU."
---

# Competitor Ad Intel — Maison Belasi

A five-stage pipeline: **Pull → Enrich → Analyse → Create → Deliver.**
Run every stage in order unless the user asks for one stage only. Each stage ends with a saved output so later stages (and later sessions) can reuse it.

This skill does the competitive research. It does NOT redefine brand voice or regulatory rules. For those, read and obey:
- `meta-ads-strategist` skill: brand context, ICP, regulatory boundaries, creative principles (Prompt 41 is the teardown this skill automates).
- `brand-copywriting-guide` skill: voice, tone and claim rules for all copy.

If those skills conflict with anything here, they win.

---

## Tools this skill uses

| Stage | Primary tool | Fallback |
|---|---|---|
| Pull | `mcp__Meta_Ads__ads_library_search` (Meta Ads connector) | User pastes Ad Library URLs or exports |
| Enrich | `chrome-browser` / `built-in-browser` skill to open each `ad_snapshot_url` and screenshot it | User uploads screenshots |
| Analyse | Claude vision on screenshots + `scripts/rank_ads.py` | — |
| Create (images) | `mcp__Higgsfield_MCP__generate_image`, `mcp__Canva__generate-image`, `mcp__Figma__generate_image` | Copy-paste prompts into Midjourney / Firefly / ChatGPT |
| Create (copy) | `meta-ads-strategist` + `brand-copywriting-guide` | — |
| Deliver | `mcp__Meta_Ads__ads_create_campaign` / `ads_create_ad_set` / `ads_create_creative` / `ads_create_ad` (always PAUSED) | Written launch plan only |

Load any deferred tool with ToolSearch before calling it. If the Meta Ads connector is not connected, say so and stop at Pull; do not invent ad data.

---

## Stage 1: Pull

1. **Start from the watchlist.** Read `references/competitors.md`. Use saved `page_id`s where present; page-id queries are far more precise than keyword queries. `search_terms` matches ad body text, not page names: to find a new brand's page_id, search a word that appears in their ads (their domain, e.g. `twoislandsco`, or a product name) rather than the brand name.
2. **Discovery queries** (when the watchlist is thin or the user asks "who's out there"): run `ads_library_search` with `ad_active_status: ACTIVE`, `limit: 50`, and `countries: ["NZ","AU"]` first. Keyword set, one call each:
   - `metabolic reset`, `metabolism support`, `blood sugar support`, `glucose`, `berberine`, `gut health supplement`, `bloating`, `GLP-1 natural`, `inositol`, `hormone belly`
   Only widen to `["US","GB"]` if NZ/AU returns fewer than ~15 relevant ads, and label those results as out-of-market.
3. **Then per competitor:** re-query with `page_ids: [<id>]` and `ad_active_status: ALL` to see their full active + historic set.
4. Save the raw JSON results to `research/competitor-ads/raw/<YYYY-MM-DD>-<query-slug>.json` in the working directory.
5. Add any new relevant advertiser (name + page_id + why it's relevant) to `references/competitors.md`.

Filter out noise before going further: med-spas, clinics selling injectables, gyms, personal trainers and coaches are not product competitors unless the user says otherwise. Keep them in a separate "adjacent" bucket; their hooks can still be useful.

### What the connector does and doesn't return
`ads_library_search` returns page name/id, link title, creation and delivery-start times, currency and `ad_snapshot_url`. It may **not** return body copy, image or video files, spend, or impressions. Never fill those gaps by guessing. Get the creative in Stage 2, and never present spend or performance numbers you do not have.

---

## Stage 2: Enrich

The ranking in Stage 3 decides what is worth enriching. Enrich the **top 10–15 ads**, not everything.

For each ad:
1. Open `ad_snapshot_url` with the browser skill, screenshot the full creative, and transcribe: primary text, headline, description, CTA button, landing URL, format (static / video / carousel / DPA).
2. Video: capture the first frame, the 3-second frame and the end card, and transcribe on-screen text and any audible VO/captions.
3. If no browser is available, ask the user for screenshots of the shortlisted IDs. Give them the exact list of `ad_snapshot_url`s.

Save enriched records to `research/competitor-ads/enriched/<YYYY-MM-DD>.md`, one block per ad, using the record template in `references/analysis-framework.md`.

---

## Stage 3: Analyse

1. **Rank.** Results come back newest first, so a 50-ad pull from a heavy spender may all be days old. When that happens, skip ranking and say so; read the batch pattern instead (how many ads launched together, how many share one headline). Otherwise run `python3 scripts/rank_ads.py <raw json files...>` from this skill's directory. It scores each ad on days live and on how many sibling variants the same page launched around it, since both are rough signals that an advertiser keeps paying for it. Treat the score as a proxy, never as proof of performance. Say this in the output.
2. **Teardown** each enriched ad with the 8-question framework in `references/analysis-framework.md` (it's Prompt 41 from `meta-ads-strategist`, extended with a compliance risk grade).
3. **Pattern map** across all ads: hook types, emotional triggers, visual archetypes, offer mechanics, claim levels. Use the tables in the framework file.
4. **White space.** Find what no one is doing, especially where competitors break NZ/AU rules or rely on transformation and before/after imagery. Maison Belasi's clinical restraint is the differentiator, so gaps where restraint wins are the priority.

Output: `research/competitor-ads/reports/<YYYY-MM-DD>-teardown.md` with:
- Top ads table (rank, advertiser, format, days live, hook, trigger, compliance grade, snapshot URL)
- Pattern map
- 3–5 strategic principles worth borrowing, each written as a principle and not a tactic to copy
- 3 white-space angles for Metabolic Reset
- "Do not replicate" list: specific claims and executions that would breach NZ Dietary Supplement Regulations / ASA NZ / AU TGA advertising rules

**Hard rule:** principles transfer, executions don't. Never reproduce a competitor's copy, layout, character or visual closely enough that it reads as theirs.

---

## Stage 4: Create

For each white-space angle (or the angles the user picks), produce a **creative pack**:

### 4a. Copy
Run `meta-ads-strategist` Prompt 41 output step plus the hook rules from its section 5. Deliver per angle:
- 3 hooks (first line / first 3 seconds)
- 2 primary-text variants (one short ≤125 chars, one long)
- 3 headlines (≤40 chars), 1 description
- CTA aligned to phase. Waitlist phase = "Join the waitlist" / "Be first to know"; never "Shop now" pre-launch.
- Mandatory footer where product or science is referenced.
Then run the regulatory check from `meta-ads-strategist` and the no-em-dash rule before showing anything.

### 4b. Image / video prompts
Use the templates in `references/image-prompts.md`. For each angle give:
- 1 static prompt for 4:5 feed, 1 for 9:16 Stories/Reels, and 1 alternative composition
- A tool-specific version for whichever generator the user uses (Higgsfield, Canva, Firefly, Midjourney, or ChatGPT image)
- A negative / avoid list (no before/after bodies, no scales or tape measures, no syringes, no pill-spill clichés)
- Text-overlay copy kept separate from the image prompt. Generators render type badly; overlays go on in Canva/Figma.

Only call a generation tool when the user asks to generate. Generation costs credits, so confirm the count first.

### 4c. Save
`research/competitor-ads/packs/<YYYY-MM-DD>-<angle-slug>.md`

---

## Stage 5: Deliver

Use `references/delivery-playbook.md` to produce a launch plan per pack: objective, audience structure (broad / interest / lookalike / retargeting), placements, budget split, test matrix, kill/scale rules, and the measurement window.

**Building in Meta Ads Manager** is opt-in and always staged:
1. Show the full plan and every object you'll create (campaign → ad set → creative → ad) with names, budgets and targeting.
2. Get explicit approval.
3. Create everything with status **PAUSED**. Never activate. The user activates in Ads Manager after review.
4. Report back the IDs created.

Never upload competitor creative to the user's ad account.

---

## Output style
- Lead with the finding, not the process.
- Every claim about a competitor ad cites its snapshot URL.
- Flag uncertainty explicitly ("ranked high on longevity; actual performance unknown").
- Brand outputs follow `meta-ads-strategist` rules: no em dashes, 6–18 word sentences, structure/function claims only.
