// Terminal grid on the content canvas. Characters are drawn from per-glyph
// alpha masks into fixed-size cells, so the grid is exact whatever the font's
// metrics, and every colour mode goes through one pixel buffer.

export const CELL_SIZES = [[6, 9], [8, 12], [10, 15], [12, 18], [16, 24]];
const FONT_STACK = '"DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace';
const BLACK = 0xff000000;

/** Pack an [r,g,b] (0..255) into the canvas's little-endian RGBA word. */
const pack = (r, g, b) => (BLACK | (b << 16) | (g << 8) | r) >>> 0;

export class Terminal {
  constructor(canvas) {
    this.W = canvas.width;
    this.H = canvas.height;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.image = this.ctx.createImageData(this.W, this.H);
    this.buf = new Uint32Array(this.image.data.buffer);
    this.scratch = document.createElement("canvas");
    this.sctx = this.scratch.getContext("2d", { willReadFrequently: true });
    this.setCellSize(8, 12);
  }

  setCellSize(cw, ch) {
    this.cw = cw;
    this.ch = ch;
    this.cols = Math.floor(this.W / cw);
    this.rows = Math.floor(this.H / ch);
    this.ox = (this.W - this.cols * cw) >> 1;
    this.oy = (this.H - this.rows * ch) >> 1;
    this.masks = new Map();
    this.scratch.width = cw;
    this.scratch.height = ch;
  }

  /** Alpha mask (cw*ch, 0..255) for one character, rendered once and cached. */
  mask(chr) {
    let m = this.masks.get(chr);
    if (m) return m;
    const { cw, ch, sctx } = this;
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, cw, ch);
    m = new Uint8Array(cw * ch);
    if (chr !== " ") {
      const px = Math.round(ch * 0.92);
      sctx.font = `${px}px ${FONT_STACK}`;
      sctx.textBaseline = "alphabetic";
      sctx.fillStyle = "#fff";
      const w = sctx.measureText(chr).width;
      sctx.fillText(chr, (cw - w) / 2, ch - Math.ceil(px * 0.22));   // room for descenders
      const data = sctx.getImageData(0, 0, cw, ch).data;
      for (let i = 0; i < m.length; i++) m[i] = data[i * 4];
    }
    m.blank = !m.some((a) => a);
    this.masks.set(chr, m);
    return m;
  }

  clear() {
    this.buf.fill(BLACK);
  }

  present() {
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** One glyph at (col,row): fg over bg (bg null = leave what's there). */
  put(col, row, chr, fg, bg) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return;
    const { cw, ch, buf, W } = this;
    const m = this.mask(chr);
    const x0 = this.ox + col * cw, y0 = this.oy + row * ch;
    const [fr, fg_, fb] = fg;
    const [br, bg_, bb] = bg || [0, 0, 0];
    for (let y = 0, k = 0; y < ch; y++) {
      let i = (y0 + y) * W + x0;
      for (let x = 0; x < cw; x++, k++, i++) {
        const a = m[k];
        if (!a && !bg) continue;
        const na = 255 - a;
        buf[i] = pack((fr * a + br * na) / 255, (fg_ * a + bg_ * na) / 255, (fb * a + bb * na) / 255);
      }
    }
  }

  /** A string from (col,row), clipped at the right edge. */
  text(col, row, str, fg, bg) {
    let c = col;
    for (const chr of str) {
      if (c >= this.cols) break;
      this.put(c++, row, chr, fg, bg);
    }
    return c;
  }

  /** Fill a run of cells with a solid colour. */
  fill(col, row, n, rgb) {
    const { cw, ch, buf, W } = this;
    const v = pack(rgb[0], rgb[1], rgb[2]);
    const x0 = this.ox + col * cw, x1 = this.ox + Math.min(this.cols, col + n) * cw;
    for (let y = 0; y < ch; y++) {
      const base = (this.oy + row * ch + y) * W;
      buf.fill(v, base + x0, base + x1);
    }
  }

  /**
   * A frame of cells from ascii.buildCells at (col0,row0): ramp glyphs tinted
   * by cell colour (or `fg` in monochrome), or half blocks in halfblock mode.
   */
  cells(col0, row0, cols, rows, frame, ramp, fg) {
    const { cw, ch, buf, W } = this;
    const { glyph, color, bottom } = frame;
    if (!glyph) {
      const top = Math.round(ch / 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const j = (r * cols + c) * 3;
          const vt = pack(color[j], color[j + 1], color[j + 2]);
          const vb = pack(bottom[j], bottom[j + 1], bottom[j + 2]);
          const x0 = this.ox + (col0 + c) * cw;
          for (let y = 0; y < ch; y++) {
            const i = (this.oy + (row0 + r) * ch + y) * W + x0;
            buf.fill(y < top ? vt : vb, i, i + cw);
          }
        }
      }
      return;
    }
    const masks = Array.from(ramp, (chr) => this.mask(chr));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n = r * cols + c;
        const m = masks[glyph[n]];
        if (m.blank) continue;
        let R = fg[0], G = fg[1], B = fg[2];
        if (color) { R = color[n * 3]; G = color[n * 3 + 1]; B = color[n * 3 + 2]; }
        const x0 = this.ox + (col0 + c) * cw, y0 = this.oy + (row0 + r) * ch;
        for (let y = 0, k = 0; y < ch; y++) {
          let i = (y0 + y) * W + x0;
          for (let x = 0; x < cw; x++, k++, i++) {
            const a = m[k];
            if (a) buf[i] = pack((R * a) / 255, (G * a) / 255, (B * a) / 255);
          }
        }
      }
    }
  }
}
