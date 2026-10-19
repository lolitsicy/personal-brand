# Delivery Playbook (Meta, NZ/AU)

Ask the user for anything marked [CONFIRM]. Don't assume budgets.

## Phase-aware objective
| Phase | Objective | Optimisation event | CTA |
|---|---|---|---|
| Pre-launch / waitlist | Leads (instant form) or Sales on a "Lead"/"CompleteRegistration" pixel event | Lead | Join the waitlist |
| Launch | Sales | Purchase | Shop / Discover |
| Post-launch scale | Sales (Advantage+ shopping) | Purchase | Shop |

If the pixel/dataset isn't firing the optimisation event, fix that first (`ads_get_dataset_quality`). Creative work is wasted on a broken signal.

## Audience structure
1. **Broad (default for cold):** Women 25–45, NZ + AU, no interests, Advantage+ audience on. At small budgets Meta's algorithm usually beats hand-picked interests; creative does the targeting.
2. **Interest test (only if broad underperforms after the learning phase):** wellness/clean-eating publications, Pilates/reformer, premium skincare brands, gut-health topics. One interest stack per ad set.
3. **Lookalike:** 1–3% from waitlist sign-ups once there are ≥100 (≥1,000 preferred).
4. **Retargeting:** 30-day site visitors + IG/FB engagers 60d, excluding waitlist/purchasers. Use proof and mechanism ads here, not hooks.

Special ad category: not required for supplements. But Meta's health & wellness policy restricts targeting on health conditions and bans before/after and body-negative imagery, so personal-attribute callouts like "Are you insulin resistant?" get rejected.

## Placements
Advantage+ placements on. Make sure every pack has 4:5 (feed) and 9:16 (Stories/Reels) assets so Meta isn't auto-cropping.

## Test matrix (creative-first)
- 1 campaign, 1 broad ad set, 3–5 concepts (angles) × 2–3 hooks each.
- Change one variable per concept (hook OR visual), not both.
- Budget: enough for ~50 optimisation events/week per ad set is the learning-phase target. If budget can't reach that, optimise for a higher-funnel event, or run fewer ad sets. [CONFIRM daily budget in NZD/AUD]

## Kill / scale rules (starting point, adjust to the account's data)
- Kill after spend ≥ 2–3× target CPL/CPA with zero conversions, or thumb-stop (3s view ÷ impressions) under ~20% on video.
- Iterate: hook rate fine but CTR low → body/offer problem; CTR fine but CVR low → landing page.
- Scale winners by 20–30% budget steps every 48–72h, or duplicate into a new ad set.
- Measurement window: no decisions before 3–4 days / exiting learning.

## Ads Manager build checklist (only after approval)
```
Campaign:  MB | [Phase] | [Objective] | [YYYY-MM]          status PAUSED
Ad set:    MB | Broad | W25-45 | NZ+AU | [budget]           status PAUSED
Creative:  MB | [angle-slug] | [hook code] | [4x5|9x16]
Ad:        MB | [angle-slug] | [hook code] | v[n]            status PAUSED
```
Call order: `ads_create_campaign` → `ads_create_ad_set` → upload media (`ads_creative_upload_media`) → `ads_create_creative` → `ads_create_ad`. Report each returned ID.
