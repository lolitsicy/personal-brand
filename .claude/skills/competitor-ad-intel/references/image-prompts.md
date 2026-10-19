# Image & Video Prompt Templates

## Visual identity anchors (apply to every prompt)
- Editorial, clinical-luxe. Think Seed, Aesop, Apple product photography. Not supplement-aisle.
- Palette: warm neutrals (bone, oat, stone), one deep accent. Confirm the brand accent with the user if unknown; never invent hex codes as "brand colours".
- Light: soft directional daylight, long gentle shadows, no ring-light flatness.
- Composition: generous negative space top or bottom third for text overlay.
- People: women 25–45, real skin texture, calm expression, mid-routine (not "after").
- Product: only once real packshots exist. Pre-launch, use ingredient-agnostic or abstract imagery and don't render a fake bottle.

## Always-avoid list (append as negative prompt / "avoid")
before-and-after bodies, measuring tape, scales, stomach pinching, syringes or injection pens, pill-spill, neon colours, gym-bro aesthetic, cartoon gut illustrations, lab coats with clipboards, stock-photo smiles, any text or logos rendered in-image, distorted hands

## Master template
```
[SUBJECT doing ACTION] in [SETTING], [TIME OF DAY] light,
editorial still-life / lifestyle photograph, [LENS e.g. 50mm, f/2.8],
[PALETTE], calm restrained mood, generous negative space in the [top/bottom] third for headline,
shot for a premium wellness brand, high detail, natural skin texture.
Aspect ratio [4:5 | 9:16 | 1:1].
Avoid: [always-avoid list]
```

## Angle archetypes → starter prompts

**A. Effort–result gap (H1)**
Woman 30s at a sunlit kitchen bench, untouched nourishing breakfast in front of her, hand resting on her abdomen, subtle frustration, morning light through linen curtains, oat and stone palette, 50mm, negative space top third. 4:5.

**B. Mechanism made visible (H3)**
Abstract macro: a single glass of water with a slow, clean ripple, a soft gradient from warm amber to calm neutral suggesting a steadying curve, minimal studio set on travertine, overhead soft box. 4:5.

**C. 3pm crash (H3/H1)**
Desk scene mid-afternoon, laptop half-closed, cold coffee, phone face-down, low-angle golden light raking across the desk, no person visible or only a hand, quiet stillness. 9:16, negative space bottom third.

**D. Ritual (H10)**
Close crop of hands placing a minimal unbranded glass vessel on a stone bathroom shelf beside a folded linen towel, early morning blue-to-warm light, Aesop-like restraint. 1:1. (Swap in real packshot post-launch.)

**E. Identity / "tried everything" (H4)**
Flat lay of a drawer of mismatched half-used supplement tubs, deliberately muted, one empty clear space in the centre, soft top light. Overlay: "For the drawer you've stopped opening." 4:5.

## Tool-specific formatting
- **Higgsfield (`generate_image`)**: use the master template; run `models_explore(action:'recommend')` first if unsure of model; quote credits before generating.
- **Canva (`generate-image`)**: shorter prompt (1–2 sentences), then place overlay copy in a Canva design using brand kit fonts.
- **Midjourney**: append `--ar 4:5 --style raw --s 150 --no text, logo, scale, measuring tape, syringe`.
- **Firefly / ChatGPT image**: natural-language version of the master template; put avoid list as a sentence.

## Video (UGC / Reels) prompt structure
```
0–3s HOOK: [visual + on-screen text]
3–10s TENSION: [the gap, shown not told]
10–20s REFRAME: [mechanism, one idea]
20–25s INVITE: [CTA card, waitlist]
Captions: burned-in, sentence case, max 6 words per card
VO tone: calm, close-mic, no hype
```
