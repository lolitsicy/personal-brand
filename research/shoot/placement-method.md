# Placing shoot photos into the Canva creatives

Asset ids: `canva-assets.csv`. What each photo shows: `location-catalogue.csv`, `studio-catalogue.csv`.
Pilot (approved method): C2-11 4x5, design DAHYbDPiK9A, photo 0604.

## Method (per design, per page)
1. `read-design` with `open_transaction: true`, fields `design_content`, `page_metadata`, `thumbnails`.
2. `insert_fill` the photo full-bleed, covering the page with the photo's aspect kept (all location frames are 2:3 portrait):
   - 4:5 page 1080x1350: width 1080, height 1620, top -135 (shift top between -270 and 0 so the subject avoids the text).
   - 3:4 page 1080x1440: width 1080, height 1620, top -90.
   - 9:16 page 1080x1920: height 1920, width 1280, left -100 (shift left between -200 and 0 to keep the jar in frame).
   - Studio frames (4000x6000) are also 2:3: same numbers.
3. `layer_element` the new photo to `back`, then the existing flat #E4EDF4 rectangle to `back` (order: rectangle, photo, text).
4. Check the thumbnail. Text must sit on calm, light parts of the photo and stay readable:
   - if a line crosses a busy area, `position_element` the text into the photo's clean space (catalogue `text_space`), or nudge the photo with `position_element`;
   - if it still fights, add a soft panel behind the text block: `insert_shape` rectangle in #E4EDF4 at opacity 0.85, corner_rounding 0, then layer it so it sits above the photo and below the text (send it to back, then send the photo to back, then the flat rectangle to back);
   - text that sits on a dark area can be recoloured to #F4F7FA instead.
   - The jar and its label must never be covered by text.
5. Keep all wording, sizes, the wordmark and safe zones (9:16: nothing important above 250px or below 1580px). `update_title` is unchanged.
6. `commit`, one design at a time.

## Choosing the photo
- Match the plan's "Image" note / angle to the catalogue `suited_for` and `shot`.
- Paid ads (C1–C5, L1–L4): never use a frame where `other_brands_visible` lists anything (rhode, Aesop, Byredo, Emma Lewisham, Color Wow, Goyard, Louis Vuitton print). Location frames to avoid in ads: 0646, 0650, 0776, 0779, 0796, 0856, 0922. Organic posts may use them.
- Formula/ingredient ads: use packaging or capsule shots; don't add ingredient names.
- Spread photos: no photo more than twice inside one campaign, and the 4x5 and 9x16 of the same ad use the same photo.
- Type-led statics (C1 hook test) keep their text-only look: give them a subtle texture only if the plan asks for one (chrome/gradient); otherwise leave them.
- Stories and Reel covers: use the photo when the post's `needs` asks for a still or the frame is about the product; leave poll/quiz/sticker-only frames as they are unless the post names a photo.
