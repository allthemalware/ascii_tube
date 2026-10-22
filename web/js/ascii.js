// Frame -> character-cell conversion: a port of ascii_tube.py's pure helpers
// (ramps, ordered dither, quantize, xterm-256 mapping, grid fitting), kept
// DOM-free so test_ascii_tube.py can check it against the Python originals.

// Dark -> light. Plain ASCII
export const DEFAULT_RAMP = " .:-=+*#%@";
export const LONG_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao" +
  "*#MW&8%B@$";

export const SEEK_STEP = 5.0; // seconds per left/right keypress

export const COLOR_MODES = ["none", "256", "truecolor", "halfblock"];

// 4x4 Bayer matrix for ordered dithering (stateless -> safe for video).
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/** numpy.rint / Python round(): round half to even. */
export function rint(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** Seconds from a number or a [hh:]mm:ss string. 0 on empty/garbage. */
export function parseTime(s) {
  s = String(s ?? "").trim();
  if (!s) return 0;
  const num = (p) => (p = p.trim(), /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(p) ? parseFloat(p) : NaN);
  let sec;
  if (s.includes(":")) {
    sec = 0;
    for (const part of s.split(":")) sec = sec * 60 + (part ? num(part) : 0);
  } else {
    sec = num(s);
  }
  return Number.isNaN(sec) ? 0 : sec;
}

/** A rows*cols ordered-dither offset map tiled from BAYER4, in [-0.5, 0.5). */
export function makeDither(rows, cols) {
  const d = new Float32Array(rows * cols);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      d[y * cols + x] = (BAYER4[y & 3][x & 3] + 0.5) / 16 - 0.5;
  return d;
}

/** Map luminance (0..255) to a ramp index (0..nlevels), optionally dithered. */
export function quantize(v, nlevels, dither) {
  if (dither === undefined || dither === null) return Math.floor((v * nlevels + 127) / 255);
  // float32 like numpy's, so ties land on the same side
  const t = Math.fround(Math.fround(v * Math.fround(nlevels / 255)) + dither);
  return Math.min(nlevels, Math.max(0, rint(t)));
}

/** ~Rec.601 luminance, 0..255 (same integer weights as ascii_tube.py). */
export function luma(r, g, b) {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

/**
 * Map RGB (0..255) to an xterm-256 palette index. Near-neutral pixels use the
 * 24-step grayscale ramp (232..255) for smoother darks; everything else snaps
 * to the 6x6x6 colour cube (16..231).
 */
export function rgbTo256(r, g, b, lum) {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 16) return 232 + Math.min(23, Math.max(0, Math.floor((lum - 8) / 10)));
  const q = (c) => Math.floor((c * 5 + 127) / 255);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** The RGB an xterm draws for palette index 16..255. */
export function xterm256(i) {
  if (i >= 232) {
    const v = 8 + 10 * (i - 232);
    return [v, v, v];
  }
  i -= 16;
  return [CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]];
}

/**
 * Pick character grid (cols, rows) that preserves aspect and fits the screen.
 * termCols/termLines stand in for the terminal size; the last line is kept
 * free for the status bar, as in the terminal.
 */
export function computeDims(srcW, srcH, widthOverride, charAspect, termCols, termLines) {
  const aspect = srcW && srcH ? srcH / srcW : 9 / 16;
  if (widthOverride) {
    const cols = Math.max(1, widthOverride);
    return [cols, Math.max(1, rint(cols * aspect * charAspect))];
  }
  let cols = Math.max(1, termCols);
  let rows = Math.max(1, rint(cols * aspect * charAspect));
  const maxRows = Math.max(1, termLines - 1);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.min(termCols, Math.max(1, rint(rows / (aspect * charAspect))));
  }
  return [cols, rows];
}

/**
 * 256-entry tone curve standing in for ffmpeg's eq filter: contrast about
 * mid-grey, brightness offset, then gamma. null when everything is default.
 */
export function makeEq(brightness, contrast, gamma) {
  if (!brightness && contrast === 1 && gamma === 1) return null;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, Math.max(0, contrast * (i / 255 - 0.5) + 0.5 + brightness));
    lut[i] = Math.round(255 * Math.pow(v, 1 / gamma));
  }
  return lut;
}

/**
 * Turn one RGBA frame (cols x rows, or cols x 2*rows for halfblock) into cells.
 * Returns { glyph, color }: glyph is a ramp index per cell (null in halfblock),
 * color is RGB per cell (null in monochrome). In halfblock, color holds the
 * top pixel of each cell and `bottom` the pixel below it.
 */
export function buildCells(px, cols, rows, mode, nlevels, dither, eq) {
  const n = cols * rows;
  const tone = eq ? (c) => eq[c] : (c) => c;
  if (mode === "halfblock") {
    const top = new Uint8Array(n * 3), bottom = new Uint8Array(n * 3);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = y * cols + x, t = ((2 * y) * cols + x) * 4, b = t + cols * 4;
        for (let k = 0; k < 3; k++) {
          top[c * 3 + k] = tone(px[t + k]);
          bottom[c * 3 + k] = tone(px[b + k]);
        }
      }
    }
    return { glyph: null, color: top, bottom };
  }
  const glyph = new Uint8Array(n);
  const color = mode === "none" ? null : new Uint8Array(n * 3);
  for (let c = 0; c < n; c++) {
    const i = c * 4;
    const r = tone(px[i]), g = tone(px[i + 1]), b = tone(px[i + 2]);
    const lum = luma(r, g, b);
    glyph[c] = quantize(lum, nlevels, dither ? dither[c] : null);
    if (!color) continue;
    if (mode === "256") {
      const rgb = xterm256(rgbTo256(r, g, b, lum));
      color[c * 3] = rgb[0]; color[c * 3 + 1] = rgb[1]; color[c * 3 + 2] = rgb[2];
    } else {
      color[c * 3] = r; color[c * 3 + 1] = g; color[c * 3 + 2] = b;
    }
  }
  return { glyph, color };
}
