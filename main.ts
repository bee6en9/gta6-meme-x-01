// Meme generator for make.fun bounty gta6-meme-x-01 ("Post a GTA 6 meme on X").
// Node 22, standard library only. No network, no wall clock, no files outside
// the repository: the two runs of this program write the same bytes.
//
// The joke: you waited 13 years for GTA 6 — but your AI agent got paid first
// on make.fun. The picture is a Vice City sunset: the white make.fun ghost
// (sparkle eyes, magenta star coin) standing on the beach at golden hour,
// palm trees, skyline, ocean. Classic top/bottom meme captions in a big
// hand-rolled 5x7 bitmap font, white with a black outline, plus the
// "make.fun" wordmark in magenta.
//
// What the program does (the kit's starter behaviour, kept):
//   1. copies POST.json from the repository root to /output/POST.json,
//      where the gate reads it (the post's address on X — filled in later,
//      after the user posts the meme from their phone);
//   2. draws the meme picture and writes it to /output/meme.png.
//
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// PNG encoder (truecolour RGB, filter 0, zlib level 9, deterministic)
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePNG(rgb: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    // Uint8Array has no .copy — use .set with a subarray view instead.
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Raster canvas: a plain RGB buffer with tiny shape helpers
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const px = new Uint8Array(W * H * 3);

function setPixel(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(H, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPixel(xx, yy, c);
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(x, y, c);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPixel(x, y, c);
    }
  }
}

function drawLine(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    setPixel(x, y, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function fillPolygon(points: Array<[number, number]>, c: RGB): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) setPixel(x, y, c);
    }
  }
}

// Five-point star, points alternating outer/inner radius.
function star(cx: number, cy: number, rOuter: number, rInner: number, c: RGB): void {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  fillPolygon(pts, c);
}

// Four-point sparkle (the ghost's eyes): a diamond with pinched sides.
function sparkle(cx: number, cy: number, r: number, c: RGB): void {
  const k = 0.26;
  fillPolygon(
    [
      [cx, cy - r],
      [cx + r * k, cy - r * k],
      [cx + r, cy],
      [cx + r * k, cy + r * k],
      [cx, cy + r],
      [cx - r * k, cy + r * k],
      [cx - r, cy],
      [cx - r * k, cy - r * k],
    ],
    c,
  );
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font. '#' = on, '.' = off. Uppercase, digits, punctuation and
// the lowercase letters of "make.fun" (the wordmark is drawn lowercase).
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  $: ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01000', '01000', '11110', '01000', '01000', '01000'],
  k: ['00000', '10000', '10000', '10100', '11000', '10100', '10010'],
  m: ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  n: ['00000', '00000', '11110', '10001', '10001', '10001', '10001'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
};

function textWidth(s: string, scale: number): number {
  return s.length * 6 * scale - scale;
}

function drawTextRaw(x: number, y: number, s: string, scale: number, c: RGB): void {
  for (let ci = 0; ci < s.length; ci++) {
    const glyph = FONT[s[ci]] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '1') {
          fillRect(x + (ci * 6 + col) * scale, y + row * scale, scale, scale, c);
        }
      }
    }
  }
}

// Centred text with a thick outline (drawn first, offset in 8 directions).
function drawTextCentered(cx: number, y: number, s: string, scale: number, fg: RGB, outline: RGB): void {
  const x = Math.round(cx - textWidth(s, scale) / 2);
  const o = Math.max(2, Math.round(scale / 2));
  for (const [dx, dy] of [
    [-o, 0],
    [o, 0],
    [0, -o],
    [0, o],
    [-o, -o],
    [o, -o],
    [-o, o],
    [o, o],
  ] as Array<[number, number]>) {
    drawTextRaw(x + dx, y + dy, s, scale, outline);
  }
  drawTextRaw(x, y, s, scale, fg);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const INK: RGB = [22, 10, 43]; // near-black violet (caption bands)
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [20, 16, 28];
const MAGENTA: RGB = [194, 24, 122]; // make.fun magenta
const GOLD: RGB = [255, 209, 102];
const SAND: RGB = [232, 201, 138];
const SEA: RGB = [15, 76, 92];
const SEA_LIGHT: RGB = [32, 120, 130];
const SKYLINE: RGB = [36, 21, 54];
const WINDOW: RGB = [255, 209, 102];

// ---------------------------------------------------------------------------
// Scene: Vice City sunset, 190..790; caption bands above and below
// ---------------------------------------------------------------------------

function drawSky(): void {
  // Sunset bands, deep violet at the top down to gold at the horizon.
  const bands: Array<[number, number, RGB]> = [
    [190, 260, [59, 29, 94]],
    [260, 330, [110, 38, 122]],
    [330, 400, [168, 32, 120]],
    [400, 470, [214, 74, 76]],
    [470, 540, [247, 140, 60]],
    [540, 600, [255, 209, 102]],
  ];
  for (const [y0, y1, c] of bands) fillRect(0, y0, W, y1 - y0, c);
  // Sun with a warm halo, low over the ocean, right of centre.
  fillCircle(740, 430, 96, [247, 168, 60]);
  fillCircle(740, 430, 72, [255, 209, 102]);
  fillCircle(740, 430, 58, [255, 226, 140]);
  // A few birds.
  for (const [bx, by, s] of [
    [180, 300, 14],
    [240, 270, 10],
    [880, 260, 12],
  ] as Array<[number, number, number]>) {
    drawLine(bx - s, by, bx, by - 6, BLACK);
    drawLine(bx, by - 6, bx + s, by, BLACK);
  }
}

function drawSkyline(): void {
  // Dark towers with lit windows, sitting on the horizon at y 600.
  const towers: Array<[number, number, number]> = [
    [30, 520, 90],
    [140, 490, 110],
    [270, 530, 70],
    [360, 500, 100],
    [820, 510, 90],
    [920, 480, 120],
  ];
  for (const [x, top, w] of towers) {
    fillRect(x, top, w, 600 - top, SKYLINE);
    // Antenna on the two tallest.
    if (w >= 100) fillRect(x + Math.floor(w / 2) - 2, top - 26, 4, 26, SKYLINE);
    // Lit windows: fixed pattern, deterministic.
    for (let wy = top + 14; wy < 592; wy += 24) {
      for (let wx = x + 10; wx < x + w - 12; wx += 22) {
        if ((wx * 7 + wy * 13) % 5 < 2) fillRect(wx, wy, 8, 10, WINDOW);
      }
    }
  }
  // The tallest tower's beacon.
  fillCircle(195, 460, 5, [255, 80, 80]);
}

function drawOceanAndSand(): void {
  fillRect(0, 600, W, 100, SEA);
  // Sun's reflection: a shimmering column under the sun.
  for (let y = 604; y < 696; y += 8) {
    const w = 60 + ((y - 600) / 4) * 2;
    fillRect(Math.round(740 - w / 2), y, Math.round(w), 4, SEA_LIGHT);
  }
  // Wave lines.
  for (const [wx, wy, wl] of [
    [80, 630, 90],
    [300, 660, 120],
    [520, 640, 80],
    [860, 670, 110],
    [180, 685, 100],
  ] as Array<[number, number, number]>) {
    fillRect(wx, wy, wl, 3, SEA_LIGHT);
  }
  fillRect(0, 700, W, 90, SAND);
  // Speckles on the sand.
  for (let i = 0; i < 40; i++) {
    const sx = (i * 173 + 41) % 1000;
    const sy = 712 + ((i * 97) % 64);
    fillRect(sx, sy, 4, 3, [206, 172, 104]);
  }
}

function drawPalm(x: number, baseY: number, h: number, lean: number): void {
  const topX = x + lean;
  const topY = baseY - h;
  // Trunk: three stacked segments, leaning.
  drawLine(x, baseY, topX, topY, [122, 84, 52]);
  drawLine(x + 5, baseY, topX + 5, topY, [122, 84, 52]);
  drawLine(x - 2, baseY, topX - 2, topY, [101, 68, 40]);
  // Fronds: long drooping arcs from the crown.
  const green: RGB = [34, 122, 74];
  const darkGreen: RGB = [24, 96, 56];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * (0.08 + i * 0.16);
    const ex = topX + Math.cos(a) * 78 * (i % 2 === 0 ? 1 : -1);
    const ey = topY + 26 + Math.abs(Math.sin(a)) * 42;
    drawLine(topX, topY, Math.round(ex), Math.round(ey), i % 2 === 0 ? green : darkGreen);
    drawLine(topX + 3, topY + 2, Math.round(ex) + 3, Math.round(ey) + 2, i % 2 === 0 ? green : darkGreen);
  }
  // Coconuts.
  fillCircle(topX - 8, topY + 12, 7, [101, 68, 40]);
  fillCircle(topX + 8, topY + 12, 7, [101, 68, 40]);
}

function drawGhost(cx: number, topY: number, s: number): void {
  // The make.fun ghost: white body with a thick black outline, two black
  // sparkle eyes, a small arm holding a magenta coin with a white star.
  // s scales the whole figure (body width ~ 2.1*s, height ~ 2.5*s).
  const bodyW = Math.round(2.1 * s);
  const bodyH = Math.round(2.0 * s);
  const x0 = cx - Math.round(bodyW / 2);
  const y0 = topY;
  const out = Math.round(0.09 * s); // outline thickness
  // Outline: same shapes, slightly larger, in black, drawn first.
  fillEllipse(cx, y0 + Math.round(0.55 * s), Math.round(bodyW / 2) + out, Math.round(0.55 * s) + out, BLACK);
  fillRect(x0 - out, y0 + Math.round(0.5 * s), bodyW + 2 * out, bodyH - Math.round(0.4 * s) + out, BLACK);
  // Body: dome top + straight sides + three wavy bumps at the hem.
  fillEllipse(cx, y0 + Math.round(0.55 * s), Math.round(bodyW / 2), Math.round(0.55 * s), WHITE);
  fillRect(x0, y0 + Math.round(0.5 * s), bodyW, bodyH - Math.round(0.4 * s), WHITE);
  const hemY = y0 + bodyH;
  const bumpR = Math.round(bodyW / 6);
  for (let i = 0; i < 3; i++) {
    fillCircle(x0 + bumpR + i * 2 * bumpR, hemY - Math.round(0.1 * s), bumpR, WHITE);
  }
  // Two small notches between the hem bumps (the ghost's little feet).
  fillRect(x0 + 2 * bumpR - 4, hemY - Math.round(0.28 * s), 8, Math.round(0.3 * s), BLACK);
  fillRect(x0 + 4 * bumpR - 4, hemY - Math.round(0.28 * s), 8, Math.round(0.3 * s), BLACK);
  // Left arm: a small white nub with a black outline.
  fillCircle(x0 - Math.round(0.08 * s), y0 + Math.round(1.15 * s), Math.round(0.22 * s) + out, BLACK);
  fillCircle(x0 - Math.round(0.08 * s), y0 + Math.round(1.15 * s), Math.round(0.22 * s), WHITE);
  // Sparkle eyes.
  sparkle(cx - Math.round(0.42 * s), y0 + Math.round(0.85 * s), Math.round(0.26 * s), BLACK);
  sparkle(cx + Math.round(0.42 * s), y0 + Math.round(0.85 * s), Math.round(0.26 * s), BLACK);
  // Right arm + magenta star coin, held up at the ghost's side.
  const coinX = cx + Math.round(1.05 * s);
  const coinY = y0 + Math.round(1.05 * s);
  fillCircle(coinX, coinY, Math.round(0.42 * s) + out, BLACK);
  fillCircle(coinX, coinY, Math.round(0.42 * s), MAGENTA);
  star(coinX, coinY, Math.round(0.3 * s), Math.round(0.13 * s), WHITE);
  fillCircle(cx + Math.round(0.88 * s), y0 + Math.round(1.35 * s), Math.round(0.2 * s) + out, BLACK);
  fillCircle(cx + Math.round(0.88 * s), y0 + Math.round(1.35 * s), Math.round(0.2 * s), WHITE);
}

function drawScene(): void {
  // Caption bands.
  fillRect(0, 0, W, 190, INK);
  fillRect(0, 790, W, H - 790, INK);
  // A few tiny stars in the top band.
  sparkle(70, 60, 10, GOLD);
  sparkle(950, 50, 8, GOLD);
  sparkle(905, 140, 6, WHITE);
  sparkle(120, 150, 6, WHITE);
  drawSky();
  drawSkyline();
  drawOceanAndSand();
  drawPalm(96, 790, 330, -26);
  drawPalm(928, 790, 300, 24);
  drawGhost(512, 330, 130);
  // Captions.
  drawTextCentered(512, 42, 'WAITED 13 YEARS', 7, WHITE, BLACK);
  drawTextCentered(512, 118, 'FOR GTA 6', 7, WHITE, BLACK);
  drawTextCentered(512, 826, 'MY AGENT GOT PAID FIRST', 6, WHITE, BLACK);
  drawTextCentered(512, 916, 'make.fun', 7, MAGENTA, BLACK);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_DIR, { recursive: true });
try {
  copyFileSync(join(BOT_DIR, 'POST.json'), join(OUTPUT_DIR, 'POST.json'));
} catch (err) {
  console.error(`POST.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
  process.exit(1);
}

drawScene();
writeFileSync(join(OUTPUT_DIR, 'meme.png'), encodePNG(px, W, H));
console.log(`wrote ${join(OUTPUT_DIR, 'meme.png')} (${W}x${H}) and ${join(OUTPUT_DIR, 'POST.json')}`);
