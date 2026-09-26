// Synthetic handwriting generator.
//
// Takes text with a tiny inline-markdown subset and produces pen strokes
// (SVG path data + true lengths) in the Hershey Script single-stroke font,
// with seeded per-vertex jitter and per-character baseline wobble so no two
// renders are identical — like real handwriting.
//
// Markdown theme:
//   **bold**        thicker ink
//   *italic*        slanted letters
//   ==highlight==   a highlighter swipe drawn behind the words
//
// Parsing is optimistic and streaming-stable: an unclosed marker styles
// "from here on", so when text arrives token-by-token the characters already
// drawn never change position or restyle retroactively.
//
// Pure and framework-free: handwritten-text.tsx animates the strokes in
// React, and Node scripts can import this to emit sample SVGs.

import { GLYPHS, FONT_METRICS } from "./handwriting-glyphs";

export type PenStroke = {
  d: string; // SVG path data (M/L polyline), screen coords (y-down)
  len: number; // exact stroke length in px (polylines: no curves to estimate)
  charIndex: number; // which visible character this stroke belongs to
  kind: "ink" | "hl"; // pen stroke or highlighter swipe
  w: number; // stroke-width multiplier (bold ink > 1)
};

export type Handwriting = {
  strokes: PenStroke[];
  width: number;
  height: number;
};

export type SynthOptions = {
  size?: number; // em size in px (default 28)
  maxWidth?: number; // wrap width in px (default 640)
  seed?: number; // jitter seed — same seed, same handwriting
  jitter?: number; // vertex wobble in font units (default 16)
  lineGap?: number; // extra gap between lines, in ems (default 0.15)
};

type StyledChar = { ch: string; bold: boolean; italic: boolean; hl: boolean };

// mulberry32 — tiny seeded PRNG so streaming re-renders don't re-wiggle
// already-drawn characters.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseInlineMarkdown(raw: string): StyledChar[] {
  // Hold back a single trailing "*" or "=" — it's likely a marker still
  // streaming in; emitting it as a literal would reflow on the next chunk.
  let text = raw;
  if (/(^|[^*])\*$/.test(text)) text = text.slice(0, -1);
  else if (/(^|[^=])=$/.test(text)) text = text.slice(0, -1);

  const out: StyledChar[] = [];
  let bold = false;
  let italic = false;
  let hl = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("**", i)) {
      bold = !bold;
      i++;
      continue;
    }
    if (text.startsWith("==", i)) {
      hl = !hl;
      i++;
      continue;
    }
    if (text[i] === "*") {
      // markdown adjacency rule: opening * hugs the next word, closing * hugs
      // the previous one — keeps "4 * x" from italicizing.
      const opens = !italic && text[i + 1] && !/\s/.test(text[i + 1]);
      const closes = italic && i > 0 && !/\s/.test(text[i - 1]);
      if (opens || closes) {
        italic = !italic;
        continue;
      }
    }
    out.push({ ch: text[i], bold, italic, hl });
  }
  return out;
}

const UPM = FONT_METRICS.unitsPerEm; // 1000
const TOP = FONT_METRICS.maxY; // tallest flourish above baseline
const BOTTOM = -FONT_METRICS.minY; // deepest descender below baseline
const X_HEIGHT = FONT_METRICS.xHeight; // 300
const ITALIC_SHEAR = 0.21; // ~12° slant

export function synthesizeHandwriting(text: string, opts: SynthOptions = {}): Handwriting {
  const size = opts.size ?? 28;
  const maxWidth = opts.maxWidth ?? 640;
  const jitter = opts.jitter ?? 16;
  const seed = opts.seed ?? 1;
  const scale = size / UPM;
  const lineH = TOP + BOTTOM + (opts.lineGap ?? 0.15) * UPM;

  const chars = parseInlineMarkdown(text);

  // Word-wrap into lines of positioned characters.
  const advOf = (ch: string) => (GLYPHS[ch] ?? GLYPHS["?"]).a;
  type Placed = StyledChar & { x: number; line: number; charIndex: number };
  const placed: Placed[] = [];
  let x = 0;
  let line = 0;
  const maxW = maxWidth / scale;

  for (let i = 0; i < chars.length; ) {
    const c = chars[i];
    if (/\s/.test(c.ch)) {
      if (c.ch === "\n") {
        line++;
        x = 0;
      } else {
        x += advOf(" ");
      }
      i++;
      continue;
    }
    // measure the whole word for wrapping
    let j = i;
    let wordW = 0;
    while (j < chars.length && !/\s/.test(chars[j].ch)) {
      wordW += advOf(chars[j].ch);
      j++;
    }
    if (x > 0 && x + wordW > maxW) {
      line++;
      x = 0;
    }
    for (; i < j; i++) {
      placed.push({ ...chars[i], x, line, charIndex: i });
      x += advOf(chars[i].ch);
    }
  }

  // Emit strokes. Jitter is seeded per character index so a growing
  // (streamed) text keeps earlier characters exactly as they were.
  const strokes: PenStroke[] = [];
  let width = 0;
  let lines = 0;

  // Highlighter swipes: one per contiguous highlighted run per line, drawn
  // before that run's ink so the pen writes on top of the highlight.
  type HlRun = { line: number; x0: number; x1: number; charIndex: number };
  let openRun: HlRun | null = null;
  const flushRun = () => {
    if (!openRun) return;
    const pad = 60; // font units of overshoot, like a real swipe
    const y = (TOP + openRun.line * lineH - X_HEIGHT / 2) * scale;
    const x0 = (openRun.x0 - pad) * scale;
    const x1 = (openRun.x1 + pad) * scale;
    strokes.push({
      d: `M${x0.toFixed(1)} ${y.toFixed(1)}L${x1.toFixed(1)} ${y.toFixed(1)}`,
      len: x1 - x0,
      charIndex: openRun.charIndex,
      kind: "hl",
      w: 1,
    });
    openRun = null;
  };

  for (const p of placed) {
    const glyph = GLYPHS[p.ch] ?? GLYPHS["?"];

    if (p.hl) {
      if (openRun && openRun.line === p.line) {
        openRun.x1 = p.x + glyph.a;
      } else {
        flushRun();
        openRun = { line: p.line, x0: p.x, x1: p.x + glyph.a, charIndex: p.charIndex };
      }
    } else {
      flushRun();
    }

    const rand = rng(seed ^ (p.charIndex * 2654435761));
    const baselineWobble = (rand() - 0.5) * 24; // font units
    const baseY = TOP + p.line * lineH + baselineWobble;
    lines = Math.max(lines, p.line + 1);
    width = Math.max(width, (p.x + glyph.a) * scale);

    const shear = p.italic ? ITALIC_SHEAR : 0;
    for (const poly of glyph.p) {
      let d = "";
      let len = 0;
      let px = 0;
      let py = 0;
      poly.forEach(([gx, gy], i) => {
        const sx = (p.x + gx + shear * gy + (rand() - 0.5) * jitter) * scale;
        const sy = (baseY - gy + (rand() - 0.5) * jitter) * scale;
        d += (i === 0 ? "M" : "L") + sx.toFixed(1) + " " + sy.toFixed(1);
        if (i > 0) len += Math.hypot(sx - px, sy - py);
        px = sx;
        py = sy;
      });
      strokes.push({ d, len, charIndex: p.charIndex, kind: "ink", w: p.bold ? 1.6 : 1 });
    }
  }
  flushRun();

  // The pen draws highlights right before the words they cover: order swipes
  // ahead of their first covered character's ink.
  strokes.sort((a, b) => a.charIndex - b.charIndex || (a.kind === "hl" ? -1 : 0) - (b.kind === "hl" ? -1 : 0));

  const height = (TOP + (lines > 0 ? lines - 1 : 0) * lineH + BOTTOM + 30) * scale;
  return { strokes, width: Math.max(width, 1), height: Math.max(height, size) };
}

// Standalone animated-SVG export (used by tests / previews; the React
// component builds its own markup).
export function toAnimatedSVG(text: string, opts: SynthOptions = {}): string {
  const { strokes, width, height } = synthesizeHandwriting(text, opts);
  const size = opts.size ?? 28;
  const strokeW = Math.max(1.2, size * 0.045);
  const speed = 900; // px of pencil line per second
  let t = 0;
  const paths = strokes
    .map((s) => {
      const dur = Math.max(s.len / speed, 0.02);
      const cls = s.kind === "hl" ? "hl" : "ink";
      const p = `<path class="${cls}" d="${s.d}" style="stroke-width:${
        s.kind === "hl" ? (size * 0.55).toFixed(1) : (strokeW * s.w).toFixed(2)
      };stroke-dasharray:${s.len.toFixed(1)};stroke-dashoffset:${s.len.toFixed(
        1
      )};animation:hwdraw ${dur.toFixed(2)}s linear ${t.toFixed(2)}s forwards"/>`;
      t += dur;
      return p;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(
    height
  )}" width="${Math.ceil(width)}">
<style>@keyframes hwdraw{to{stroke-dashoffset:0}} path{fill:none;stroke-linejoin:round} .ink{stroke:#1e4a5f;stroke-linecap:round;opacity:.92} .hl{stroke:rgba(125,200,235,.55);stroke-linecap:butt}</style>
${paths}
</svg>`;
}
