// Generates a 1024x1024 PNG app icon (no external deps) using zlib.
// Design: dark rounded tile + emerald spade + magnifier dot accent.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { Buffer } from "node:buffer";

const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple alpha blend over existing
  const inv = (255 - a) / 255;
  buf[i] = Math.round(r * (a / 255) + buf[i] * inv);
  buf[i + 1] = Math.round(g * (a / 255) + buf[i + 1] * inv);
  buf[i + 2] = Math.round(b * (a / 255) + buf[i + 2] * inv);
  buf[i + 3] = Math.max(buf[i + 3], a);
}

// Rounded-rect background with vertical gradient.
const radius = 190;
function inRoundRect(x, y) {
  const minX = 0, minY = 0, maxX = S - 1, maxY = S - 1;
  let cx = x, cy = y;
  if (x < minX + radius && y < minY + radius) { cx = minX + radius; cy = minY + radius; }
  else if (x > maxX - radius && y < minY + radius) { cx = maxX - radius; cy = minY + radius; }
  else if (x < minX + radius && y > maxY - radius) { cx = minX + radius; cy = maxY - radius; }
  else if (x > maxX - radius && y > maxY - radius) { cx = maxX - radius; cy = maxY - radius; }
  else return true;
  return Math.hypot(x - cx, y - cy) <= radius;
}

for (let y = 0; y < S; y++) {
  const t = y / S;
  // gradient from #131a23 to #0b0f14
  const r = Math.round(0x13 + (0x0b - 0x13) * t);
  const g = Math.round(0x1a + (0x0f - 0x1a) * t);
  const b = Math.round(0x23 + (0x14 - 0x23) * t);
  for (let x = 0; x < S; x++) {
    if (inRoundRect(x, y)) px(x, y, r, g, b, 255);
  }
}

// Subtle felt-green glow ring near center.
const gcx = S / 2, gcy = S * 0.46;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRoundRect(x, y)) continue;
    const d = Math.hypot(x - gcx, y - gcy);
    if (d > 300 && d < 470) {
      const a = Math.max(0, 26 - Math.abs(d - 385) * 0.12);
      if (a > 0) px(x, y, 0x2e, 0xa0, 0x43, a);
    }
  }
}

// --- Spade (pointing up) centered ---
// Built from two lobe circles (bottom), a triangle (top), and a stem.
const cx = S / 2;
const cyTop = S * 0.30; // apex
const cyBase = S * 0.62; // where lobes sit
const lobeR = 138;
const lobeOffset = 118;
const emerald = [0x36, 0xd3, 0x6b];

function inTriangle(x, y) {
  // apex (cx, cyTop), base corners at lobe centers extended
  const ax = cx, ay = cyTop;
  const bx = cx - (lobeOffset + lobeR), by = cyBase + 20;
  const ccx = cx + (lobeOffset + lobeR), ccy = cyBase + 20;
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, ccx, ccy);
  const d3 = sign(x, y, ccx, ccy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function sign(px1, py1, ax, ay, bx, by) {
  return (px1 - bx) * (ay - by) - (ax - bx) * (py1 - by);
}

function inSpade(x, y) {
  if (inTriangle(x, y)) return true;
  if (Math.hypot(x - (cx - lobeOffset), y - cyBase) <= lobeR) return true;
  if (Math.hypot(x - (cx + lobeOffset), y - cyBase) <= lobeR) return true;
  return false;
}

// Stem (trapezoid) below the spade body.
function inStem(x, y) {
  const top = cyBase + 70, bot = cyBase + 215;
  if (y < top || y > bot) return false;
  const tt = (y - top) / (bot - top);
  const halfW = 26 + tt * 92;
  return Math.abs(x - cx) <= halfW;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inSpade(x, y) || inStem(x, y)) {
      px(x, y, emerald[0], emerald[1], emerald[2], 255);
    }
  }
}

// White highlight on spade upper-left for depth.
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inSpade(x, y)) {
      const d = Math.hypot(x - (cx - 70), y - (cyTop + 120));
      if (d < 120) px(x, y, 255, 255, 255, Math.max(0, 60 - d * 0.5));
    }
  }
}

// --- PNG encode ---
function crc32(b) {
  let c, table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < b.length; i++) crc = (crc >>> 8) ^ table[(crc ^ b[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// rest zero

// Add filter byte (0) at start of each row.
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(new URL("../src-tauri/icons/", import.meta.url), { recursive: true });
const out = new URL("../src-tauri/icons/source.png", import.meta.url);
writeFileSync(out, png);
console.log("wrote", out.pathname, png.length, "bytes");
