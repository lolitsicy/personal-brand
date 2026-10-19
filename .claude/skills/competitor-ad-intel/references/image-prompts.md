# Image & Video Prompt Templates

## Visual identity anchors (apply to every prompt)
Positioning since Oct 2026: **biohacking made fashionable.** Source: "JCHQ x Maison Belasi: Shoot No. 1" deck (StudioVIC, shoot 11–14 Nov 2026).
- Materials: polished chrome (platter, tray, spoon, tweezers, martini cup), clear and frosted glass, white and translucent acrylic, water droplets and refraction.
- Palette: white, pale ice blue seamless, chrome silver, with high- or low-contrast gradient backdrops. No warm neutrals, no neon.
- Light: crisp studio light, specular highlights on chrome, soft gradient falloff. Product shot from beneath glass is a signature move.
- Props: fashion objects as context (lipstick, purse, silver jewelry, headphones, coffee cup tray, egg tray). The product sits among them like an accessory.
- Composition: generous negative space for overlay; frosted glass can carry the text.
- People: women 25–45, styled, hands and partial crops more than faces.
- Product: real packshots arrive ~22 Nov 2026. Until then, never render a fake bottle. Generate sets, props and textures only, and composite the real product in later.
- Ingredients shown: ginger root, green tea leaves, barberries. The deck lists bismuth as a stand-in for chromium. Never caption bismuth as chromium in an ad.

## Always-avoid list (append as negative prompt / "avoid")
before-and-after bodies, measuring tape, scales, stomach pinching, syringes or injection pens, pill-spill, neon colours, gym-bro aesthetic, cartoon gut illustrations, lab coats with clipboards, stock-photo smiles, any text or logos rendered in-image, distorted hands

## Master template
```
[SUBJECT doing ACTION] in [SETTING], [TIME OF DAY] light,
editorial still-life photograph, chrome and glass surfaces, [LENS e.g. 50mm, f/2.8],
white, ice blue and chrome palette, cool restrained mood, generous negative space in the [top/bottom] third for headline,
shot for a premium wellness brand, high detail, natural skin texture.
Aspect ratio [4:5 | 9:16 | 1:1].
Avoid: [always-avoid list]
```

## Angle archetypes → starter prompts

**A. Effort–result gap (H1)**
Woman 30s at a sunlit kitchen bench, untouched nourishing breakfast in front of her, hand resting on her abdomen, subtle frustration, morning light through linen curtains, white and ice-blue palette with chrome accents, 50mm, negative space top third. 4:5.

**B. Mechanism made visible (H3)**
Abstract macro: a single glass of water with a slow, clean ripple, a soft gradient from warm amber to calm neutral suggesting a steadying curve, minimal studio set on frosted acrylic, overhead soft box. 4:5.

**C. 3pm crash (H3/H1)**
Desk scene mid-afternoon, laptop half-closed, cold coffee, phone face-down, low-angle golden light raking across the desk, no person visible or only a hand, quiet stillness. 9:16, negative space bottom third.

**D. Ritual (H10)**
Close crop of hands placing a minimal unbranded glass vessel on a chrome tray beside silver jewelry, pale blue seamless backdrop, crisp studio light. 1:1. (Swap in real packshot post-launch.)

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
