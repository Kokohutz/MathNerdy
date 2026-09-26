"use client";

import { useMemo, useRef, useState } from "react";
import { parseExpr, evalExpr, usesParam, type Expr } from "./math-expr";
import { HandwrittenText } from "./handwritten-text";

// An INTERACTIVE hand-drawn function plot. Everything is sketched like pencil
// on paper — jittered axes, a curve that draws itself on — but it's live SVG:
// drag/hover to trace (x, f(x)), and if the expression uses the parameter `a`,
// a slider morphs the curve in real time.
//
// The tutor's LLM can emit this as a widget:
//   { "type": "defineGraph",
//     "parameters": { "expression": "sin(a*x)", "xmin": -6.28, "xmax": 6.28,
//                     "title": "How a stretches sine" } }

type HandDrawnPlotProps = {
  expression: string;
  xmin?: number;
  xmax?: number;
  ymin?: number;
  ymax?: number;
  title?: string;
};

const W = 560;
const H = 340;
const PAD = 44;
const SAMPLES = 180;

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

// A straight "hand-drawn" line: subdivided and wobbled.
function sketchLine(x0: number, y0: number, x1: number, y1: number, seed: number, wobble = 2.2) {
  const rand = rng(seed);
  const n = 14;
  let d = "";
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t + (rand() - 0.5) * wobble;
    const y = y0 + (y1 - y0) * t + (rand() - 0.5) * wobble;
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
  }
  return d;
}

export function HandDrawnPlot({
  expression,
  xmin = -5,
  xmax = 5,
  ymin,
  ymax,
  title,
}: HandDrawnPlotProps) {
  const seedRef = useRef((Math.random() * 0x7fffffff) | 0);
  const [a, setA] = useState(1);
  const [trace, setTrace] = useState<{ x: number; y: number } | null>(null);

  const ast = useMemo<Expr | null>(() => {
    try {
      return parseExpr(expression);
    } catch {
      return null;
    }
  }, [expression]);

  const hasParam = useMemo(() => (ast ? usesParam(ast) : false), [ast]);

  const plot = useMemo(() => {
    if (!ast) return null;
    // sample
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const x = xmin + ((xmax - xmin) * i) / SAMPLES;
      let y = NaN;
      try {
        y = evalExpr(ast, x, a);
      } catch {
        /* leave NaN */
      }
      xs.push(x);
      ys.push(y);
    }
    // y-range: given, or robust auto from finite samples
    let lo = ymin;
    let hi = ymax;
    if (lo === undefined || hi === undefined) {
      const finite = ys.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
      if (finite.length === 0) return null;
      const q = (t: number) => finite[Math.floor((finite.length - 1) * t)];
      lo = lo ?? Math.min(q(0.02), 0) - 0.5;
      hi = hi ?? Math.max(q(0.98), 0) + 0.5;
      if (hi - lo < 1e-9) {
        hi = lo + 1;
      }
    }
    const sx = (x: number) => PAD + ((x - xmin) / (xmax - xmin)) * (W - 2 * PAD);
    const sy = (y: number) => H - PAD - ((y - (lo as number)) / ((hi as number) - (lo as number))) * (H - 2 * PAD);

    // curve pieces (break on discontinuities / out-of-range blowups)
    const rand = rng(seedRef.current ^ 0x9e3779b9);
    const pieces: string[] = [];
    let d = "";
    let pen = false;
    for (let i = 0; i <= SAMPLES; i++) {
      const y = ys[i];
      const ok = Number.isFinite(y) && y >= (lo as number) - (hi - lo) && y <= (hi as number) + (hi - lo);
      if (!ok) {
        if (d) pieces.push(d);
        d = "";
        pen = false;
        continue;
      }
      const px = sx(xs[i]) + (rand() - 0.5) * 1.6;
      const py = sy(Math.max(Math.min(y, hi as number), lo as number)) + (rand() - 0.5) * 1.6;
      d += (pen ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
      pen = true;
    }
    if (d) pieces.push(d);

    const zeroY = 0 >= (lo as number) && 0 <= (hi as number) ? sy(0) : H - PAD;
    const zeroX = 0 >= xmin && 0 <= xmax ? sx(0) : PAD;
    return { pieces, sx, sy, lo: lo as number, hi: hi as number, zeroX, zeroY, xs, ys };
  }, [ast, a, xmin, xmax, ymin, ymax]);

  if (!ast || !plot) {
    return (
      <div className="sketchy p-4">
        <HandwrittenText text={`could not plot: ${expression}`} size={22} maxWidth={480} />
      </div>
    );
  }

  const onTrace = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const x = xmin + ((px - PAD) / (W - 2 * PAD)) * (xmax - xmin);
    if (x < xmin || x > xmax) return setTrace(null);
    let y = NaN;
    try {
      y = evalExpr(ast, x, a);
    } catch {
      /* ignore */
    }
    if (!Number.isFinite(y) || y < plot.lo || y > plot.hi) return setTrace(null);
    setTrace({ x, y });
  };

  const seed = seedRef.current;
  const fmt = (v: number) => (Math.abs(v) < 1e-10 ? "0" : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

  return (
    <div className="flex flex-col items-center gap-2 w-full" style={{ maxWidth: W }}>
      {title && <HandwrittenText text={title} size={26} maxWidth={W - 40} />}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="sketchy w-full"
        style={{ touchAction: "none" }}
        onPointerMove={onTrace}
        onPointerDown={onTrace}
        onPointerLeave={() => setTrace(null)}
      >
        {/* axes */}
        <g stroke="var(--pencil-soft)" strokeWidth="1.6" fill="none" strokeLinecap="round">
          <path d={sketchLine(PAD - 8, plot.zeroY, W - PAD + 14, plot.zeroY, seed ^ 1)} />
          <path d={sketchLine(plot.zeroX, H - PAD + 8, plot.zeroX, PAD - 14, seed ^ 2)} />
          {/* arrowheads */}
          <path d={`M${W - PAD + 6} ${plot.zeroY - 4}L${W - PAD + 14} ${plot.zeroY}L${W - PAD + 6} ${plot.zeroY + 4}`} />
          <path d={`M${plot.zeroX - 4} ${PAD - 6}L${plot.zeroX} ${PAD - 14}L${plot.zeroX + 4} ${PAD - 6}`} />
        </g>
        {/* axis labels, hand font */}
        <g fill="var(--pencil-soft)" fontSize="13" fontFamily="var(--font-hand), cursive">
          <text x={W - PAD + 2} y={plot.zeroY + 18}>x</text>
          <text x={plot.zeroX + 8} y={PAD - 2}>y</text>
          <text x={PAD - 6} y={plot.zeroY + 16}>{fmt(xmin)}</text>
          <text x={W - PAD - 16} y={plot.zeroY + 16}>{fmt(xmax)}</text>
          <text x={plot.zeroX + 6} y={plot.sy(plot.hi) + 12}>{fmt(plot.hi)}</text>
          <text x={plot.zeroX + 6} y={plot.sy(plot.lo) - 4}>{fmt(plot.lo)}</text>
        </g>
        {/* the curve, drawn on like ink (key restarts the draw when the
            expression changes, but NOT on slider moves) */}
        <g key={expression} stroke="var(--pencil)" strokeWidth="2.4" fill="none" strokeLinecap="round">
          {plot.pieces.map((d, i) => (
            <path
              key={i}
              d={d}
              style={
                hasParam
                  ? undefined // live morphing: no dash animation while sliding
                  : {
                      strokeDasharray: 2000,
                      strokeDashoffset: 2000,
                      animation: `hwdraw 1.4s ease ${0.15 * i}s forwards`,
                    }
              }
            />
          ))}
        </g>
        {/* interactive trace point */}
        {trace && (
          <g>
            <path
              d={`M${plot.sx(trace.x)} ${plot.zeroY}L${plot.sx(trace.x)} ${plot.sy(trace.y)}L${plot.zeroX} ${plot.sy(trace.y)}`}
              stroke="var(--pencil-soft)"
              strokeDasharray="5 6"
              fill="none"
            />
            <circle cx={plot.sx(trace.x)} cy={plot.sy(trace.y)} r="5" fill="var(--highlight)" stroke="var(--pencil)" strokeWidth="1.5" />
            <text
              x={Math.min(plot.sx(trace.x) + 10, W - 130)}
              y={Math.max(plot.sy(trace.y) - 10, 18)}
              fill="var(--pencil)"
              fontSize="15"
              fontFamily="var(--font-hand), cursive"
            >
              ({fmt(trace.x)}, {fmt(trace.y)})
            </text>
          </g>
        )}
      </svg>
      {hasParam && (
        <label className="flex items-center gap-3 w-full px-2" style={{ color: "var(--pencil)" }}>
          <span className="hand-accent text-lg whitespace-nowrap">a = {a.toFixed(2)}</span>
          <input
            type="range"
            min={-3}
            max={3}
            step={0.05}
            value={a}
            onChange={(e) => setA(parseFloat(e.target.value))}
            className="w-full accent-current"
            aria-label="parameter a"
          />
        </label>
      )}
    </div>
  );
}

export default HandDrawnPlot;
