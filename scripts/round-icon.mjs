// Clips the app icon to a full circle (poker chip) with a gold ring, then writes
// the 1024px source that `tauri icon` expands into the full icon set. A circle
// (rather than a rounded square) means the chip never looks clipped at the corners.
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
// Small transparent margin so the circle isn't flush to the canvas edge; the
// corners are transparent, so the chip can fill most of the tile.
const PAD = 44;
const BORDER = 18; // gold ring thickness
const inner = SIZE - PAD * 2;
const cx = SIZE / 2;
const cy = SIZE / 2;
const r = inner / 2;

const src = "public/assets/casinospy-poker-chip.png";

// Circular mask (everything outside the circle becomes transparent).
const clip = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/></svg>`
);
// Gold ring drawn just inside the circle's edge.
const border = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}">
     <circle cx="${cx}" cy="${cy}" r="${r - BORDER / 2}"
             fill="none" stroke="#eccb62" stroke-width="${BORDER}"/>
   </svg>`
);

const art = await sharp(src)
  .resize(inner, inner, { fit: "cover" })
  .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

const out = await sharp(art)
  .composite([
    { input: clip, blend: "dest-in" },
    { input: border, blend: "over" },
  ])
  .png()
  .toBuffer();

writeFileSync("src-tauri/icons/source.png", out);
console.log("wrote src-tauri/icons/source.png", out.length, "bytes");
