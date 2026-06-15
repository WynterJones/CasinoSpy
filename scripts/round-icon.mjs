// Rounds the app icon corners and adds a gold border, then writes the
// 1024px source that `tauri icon` expands into the full icon set.
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const PAD = 40;            // transparent margin around the rounded tile
const R = 200;             // corner radius
const BORDER = 18;         // gold border thickness
const inner = SIZE - PAD * 2;

const src = "public/assets/casinospy-poker-chip.png";

// Base art clipped to a rounded rectangle (inside the padding).
const clip = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}"><rect x="${PAD}" y="${PAD}" width="${inner}" height="${inner}" rx="${R}" ry="${R}" fill="#fff"/></svg>`
);
// Gold border drawn just inside the rounded edge.
const border = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}">
     <rect x="${PAD + BORDER / 2}" y="${PAD + BORDER / 2}"
           width="${inner - BORDER}" height="${inner - BORDER}"
           rx="${R - BORDER / 2}" ry="${R - BORDER / 2}"
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
