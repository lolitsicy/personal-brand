# Competitor Watchlist

`page_id` is what makes repeat pulls precise. Keyword search matches ad **body text**, not page names, so searching a brand name mostly returns noise. Find the page_id once, save it here, then always query by `page_ids`.

| Brand | Page name (as in Ad Library) | page_id | Market / currency | Tier | Why they matter | Last pulled |
|---|---|---|---|---|---|---|
| Two Islands | Two Islands | 1074937632620870 | NZ / NZD | Direct | NZ multi-SKU supplement brand: gut, hydration, creatine, lactation | 2026-10-19 |
| Arrae | Arrae | 108401623899597 | US/CA / CAD | Direct (US) | Bloat / metabolism / hair supplements; heavy creator-partnership volume | 2026-10-19 |
| NOON | NOON | 103531298749245 | US / USD | Aspirational | Sleep / focus / chill subscriptions; science + offer led. [CONFIRM this page is noon.world] | 2026-10-19 |
| rhode | rhode | 109162541773169 | US / USD | Aspirational (aesthetic) | Skincare, not a supplement. Benchmark for product-as-fashion-object creative | 2026-10-19 |
| FON | First or Nothing | 424710954065344 | AU / AUD (some UK GBP) | Direct | Biohacking all-in-one powder ("Your Whole Stack. One Scoop."), numbered batch drops. Closest positioning competitor | 2026-10-19 |

Arrae runs creator partnership ads from creator pages (e.g. "Amanda" 167551743099585, "Rylee Jenkins Collabs" 100672359430291, "KiaraKacvinsky" 334462080596111). A page_id pull on Arrae alone misses those, so search `arrae` as a keyword as well.

**Tiers**
- **Direct:** sells a supplement for metabolism / blood sugar / gut.
- **Aspirational:** premium brand whose creative standard Maison Belasi benchmarks against, any market.
- **Adjacent:** clinics, coaches, GLP-1 telehealth. Watch for hooks only. Their claims are usually not ones a supplement can make.

## Discovery log
| Date | Query | Countries | Result |
|---|---|---|---|
| 2026-10-19 | metabolic reset | AU, GB, US | Mostly adjacent (US/CA coaches, body-contouring clinics). |
| 2026-10-19 | FON / Two Islands / noon world / rhode skin | various | Brand-name keywords returned noise. Resolved via `arrae`, `twoislandsco`, `noonworld`, `rhode peptide lip`. |
| 2026-10-19 | usefon | AU, NZ, US, GB, CA | Found FON via its domain (usefon.com). The page name is "First or Nothing", which is why "FON" never matched. |
| 2026-10-19 | page_id pulls, status ALL | — | Library returns newest ads first; all 50 rhode/Arrae results were under 4 weeks old, so longevity ranking had nothing to work with. |
