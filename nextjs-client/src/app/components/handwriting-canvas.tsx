"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownLatex } from "./markdown-latex";
import { HandwrittenText } from "./handwritten-text";

// An A4-PAGE handwriting whiteboard. Strokes live in world coordinates on a
// fixed A4 sheet (1:sqrt(2)); the canvas is a window onto it. Pan with the 🖐️
// tool (or two-finger drag), zoom with pinch / mouse wheel / the +/− controls,
// and ⌖ frames the whole sheet. The view is clamped so you can never lose the
// page. The vision export rasterizes the CONTENT bounding box — the AI reads
// your whole working wherever on the sheet it is.
//
// Two loops (unchanged):
//   FAST LOOP  – ~120ms heartbeat watching the stroke buffer for a pause
//                (boundary detection). Never touches the network.
//   SLOW LOOP  – on a pause, rasterizes the working, sends it to
//                /api/handwriting (Claude vision), streams reading + feedback.
//
// Tools: pen, highlighter, pan. Every page of work can be saved as a
// role-tagged JSON "working" (localStorage) and reopened later, like flipping
// back through paper.

type Point = { x: number; y: number; t: number; pressure: number }; // world coords
type Tool = "pen" | "highlighter" | "pan";
type Stroke = { tool: Exclude<Tool, "pan">; points: Point[] };
type View = { x: number; y: number; k: number }; // screen = (world - x|y) * k

// One saved page. Roles are explicit so anything reading the JSON knows what
// the tutor asked, what the student wrote, and what the AI said about it.
export type Working = {
  id: string;
  createdAt: number;
  question: { author: "tutor"; content: string | null };
  work: { author: "user"; strokes: Stroke[] };
  analysis: { author: "assistant"; reading: string; feedback: string };
  view?: View; // where on the A4 page the student was looking
  orientation?: Orientation;
};

const WORKINGS_KEY = "mathnerdy-workings";
const HEARTBEAT_MS = 120; // fast-loop tick
const PAUSE_MS = 800; // silence that counts as a boundary
const MAX_ZOOM = 5;
// The page is a fixed A4 sheet in world units (1 : sqrt(2)), either way up.
const A4 = {
  portrait: { w: 1000, h: 1414 },
  landscape: { w: 1414, h: 1000 },
} as const;
type Orientation = keyof typeof A4;
const PAGE_MARGIN = 60; // desk visible around the sheet
const RULE_STEP = 44; // ruled-line spacing on the sheet

// Must match FEEDBACK_DELIMITER in app/api/handwriting/route.ts.
const FEEDBACK_DELIMITER = "###FEEDBACK###";

type Feedback = { reading: string; feedback: string };

function splitStream(text: string): Feedback {
  const idx = text.indexOf(FEEDBACK_DELIMITER);
  if (idx !== -1) {
    return {
      reading: text.slice(0, idx).trim(),
      feedback: text.slice(idx + FEEDBACK_DELIMITER.length).trim(),
    };
  }
  for (let n = FEEDBACK_DELIMITER.length - 1; n > 0; n--) {
    if (text.endsWith(FEEDBACK_DELIMITER.slice(0, n))) {
      return { reading: text.slice(0, text.length - n).trim(), feedback: "" };
    }
  }
  return { reading: text.trim(), feedback: "" };
}

function loadWorkings(): Working[] {
  try {
    const raw = localStorage.getItem(WORKINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistWorkings(w: Working[]) {
  try {
    localStorage.setItem(WORKINGS_KEY, JSON.stringify(w));
  } catch {
    // storage unavailable (private mode etc.) — the page still works, unsaved
  }
}

function strokesBBox(strokes: Stroke[]) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of strokes)
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

export function HandwritingCanvas({ question = null }: { question?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const inkColorRef = useRef("#1e4a5f");
  const hlColorRef = useRef("rgba(125,200,235,0.55)");
  const gridColorRef = useRef("rgba(30,120,160,0.16)");
  const paperColorRef = useRef("#f7fbfd");
  const deskColorRef = useRef("#eef6fa");

  // The window onto the A4 page.
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const didInitViewRef = useRef(false);
  const pageRef = useRef<{ w: number; h: number }>(A4.portrait);
  const pendingViewRef = useRef<View | null>(null);
  const cssSizeRef = useRef({ w: 0, h: 0 });

  // Stroke buffer (strokes, not pixels), world coordinates.
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const prevPointRef = useRef<Point | null>(null);
  const drawingRef = useRef(false);
  const lastPointTimeRef = useRef(0);

  // Pointer gestures: pan drag + two-finger pinch.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panStartRef = useRef<{ px: number; py: number; view: View } | null>(null);
  const pinchStartRef = useRef<{ d: number; wx: number; wy: number; k: number } | null>(null);

  // Slow-loop guards.
  const analyzingRef = useRef(false);
  const lastSignatureRef = useRef("");
  const feedbackRef = useRef<Feedback>({ reading: "", feedback: "" });

  const [tool, setTool] = useState<Tool>("pen");
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [zoomPct, setZoomPct] = useState(100);
  const [stats, setStats] = useState({ strokes: 0, points: 0 });
  const [status, setStatus] = useState<"idle" | "drawing" | "analyzing">("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [workings, setWorkings] = useState<Working[]>([]);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);

  /* ---------- rendering ---------- */

  const toScreen = (wx: number, wy: number) => {
    const v = viewRef.current;
    return { x: (wx - v.x) * v.k, y: (wy - v.y) * v.k };
  };
  const toWorld = (px: number, py: number) => {
    const v = viewRef.current;
    return { x: v.x + px / v.k, y: v.y + py / v.k };
  };

  const drawSegment = (a: Point, b: Point, t: Exclude<Tool, "pan">) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const v = viewRef.current;
    if (t === "highlighter") {
      ctx.strokeStyle = hlColorRef.current;
      ctx.lineWidth = 22 * v.k;
    } else {
      ctx.strokeStyle = inkColorRef.current;
      ctx.lineWidth = (1.5 + b.pressure * 3) * v.k;
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const sa = toScreen(a.x, a.y);
    const sb = toScreen(b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  };

  const drawSheet = (ctx: CanvasRenderingContext2D) => {
    const v = viewRef.current;
    const { w, h } = cssSizeRef.current;
    // desk behind the sheet
    ctx.fillStyle = deskColorRef.current;
    ctx.fillRect(0, 0, w, h);
    const p0 = toScreen(0, 0);
    const p1 = toScreen(pageRef.current.w, pageRef.current.h);
    // drop shadow, then the sheet itself
    ctx.fillStyle = "rgba(30, 74, 95, 0.12)";
    ctx.fillRect(p0.x + 4, p0.y + 5, p1.x - p0.x, p1.y - p0.y);
    ctx.fillStyle = paperColorRef.current;
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    // ruled lines + margin line, like real paper
    ctx.strokeStyle = gridColorRef.current;
    ctx.lineWidth = 1;
    for (let wy = RULE_STEP * 2; wy < pageRef.current.h - RULE_STEP / 2; wy += RULE_STEP) {
      const a = toScreen(24, wy);
      const b = toScreen(pageRef.current.w - 24, wy);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const m0 = toScreen(90, 16);
    const m1 = toScreen(90, pageRef.current.h - 16);
    ctx.beginPath();
    ctx.moveTo(m0.x, m0.y);
    ctx.lineTo(m1.x, m1.y);
    ctx.stroke();
    // sheet border
    ctx.strokeStyle = gridColorRef.current;
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  };

  const redrawAll = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { w, h } = cssSizeRef.current;
    ctx.clearRect(0, 0, w, h);
    drawSheet(ctx);
    for (const s of strokesRef.current) {
      for (let i = 1; i < s.points.length; i++) {
        drawSegment(s.points[i - 1], s.points[i], s.tool);
      }
      if (s.points.length === 1) drawSegment(s.points[0], s.points[0], s.tool);
    }
    // the in-progress stroke too (mid-pinch redraws)
    const cur = currentStrokeRef.current;
    if (cur) {
      for (let i = 1; i < cur.points.length; i++) {
        drawSegment(cur.points[i - 1], cur.points[i], cur.tool);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Smallest zoom = the whole sheet (plus a little desk) fits the viewport.
  const minZoom = () => {
    const { w, h } = cssSizeRef.current;
    if (!w || !h) return 0.1;
    return Math.min(w / (pageRef.current.w + 2 * PAGE_MARGIN), h / (pageRef.current.h + 2 * PAGE_MARGIN));
  };

  const clampAxis = (v: number, pageLen: number, viewLen: number) => {
    const lo = -PAGE_MARGIN;
    const hi = pageLen + PAGE_MARGIN - viewLen;
    if (hi < lo) return (pageLen - viewLen) / 2; // viewport bigger: center sheet
    return Math.min(hi, Math.max(lo, v));
  };

  const applyView = useCallback(
    (next: Partial<View>) => {
      const v = viewRef.current;
      const { w, h } = cssSizeRef.current;
      const k = Math.min(MAX_ZOOM, Math.max(minZoom(), next.k ?? v.k));
      const x = clampAxis(next.x ?? v.x, pageRef.current.w, w / k);
      const y = clampAxis(next.y ?? v.y, pageRef.current.h, h / k);
      viewRef.current = { x, y, k };
      setZoomPct(Math.round(k * 100));
      redrawAll();
    },
    [redrawAll]
  );

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      const v = viewRef.current;
      const k = Math.min(MAX_ZOOM, Math.max(minZoom(), v.k * factor));
      const wx = v.x + px / v.k;
      const wy = v.y + py / v.k;
      applyView({ k, x: wx - px / k, y: wy - py / k });
    },
    [applyView]
  );

  const fitPage = useCallback(() => {
    const k = minZoom();
    const { w, h } = cssSizeRef.current;
    applyView({ k, x: (pageRef.current.w - w / k) / 2, y: (pageRef.current.h - h / k) / 2 });
  }, [applyView]);

  const refreshStats = () => {
    setStats({
      strokes: strokesRef.current.length,
      points: strokesRef.current.reduce((n, s) => n + s.points.length, 0),
    });
  };

  // Rotate the sheet when orientation changes; restore a saved view if a
  // page is being reopened, otherwise frame the whole sheet.
  useEffect(() => {
    pageRef.current = A4[orientation];
    if (pendingViewRef.current) {
      const v = pendingViewRef.current;
      pendingViewRef.current = null;
      applyView(v);
    } else if (didInitViewRef.current) {
      fitPage();
    }
  }, [orientation, applyView, fitPage]);

  /* ---------- canvas setup: HiDPI + resize + theme + wheel zoom ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const css = getComputedStyle(document.documentElement);
    inkColorRef.current = css.getPropertyValue("--pencil").trim() || "#1e4a5f";
    hlColorRef.current = css.getPropertyValue("--highlight").trim() || "rgba(125,200,235,0.55)";
    gridColorRef.current = css.getPropertyValue("--paper-line").trim() || "rgba(30,120,160,0.16)";
    paperColorRef.current = css.getPropertyValue("--paper-card").trim() || "#f7fbfd";
    deskColorRef.current = css.getPropertyValue("--paper").trim() || "#eef6fa";

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      cssSizeRef.current = { w: rect.width, h: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctxRef.current = ctx;
      if (!didInitViewRef.current && rect.width > 0) {
        didInitViewRef.current = true;
        const k = Math.min(
          rect.width / (pageRef.current.w + 2 * PAGE_MARGIN),
          rect.height / (pageRef.current.h + 2 * PAGE_MARGIN)
        );
        viewRef.current = {
          k,
          x: (pageRef.current.w - rect.width / k) / 2,
          y: (pageRef.current.h - rect.height / k) / 2,
        };
        setZoomPct(Math.round(k * 100));
      }
      redrawAll();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Non-passive wheel handler so we can preventDefault page scroll.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    setWorkings(loadWorkings());
    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [redrawAll, zoomAt]);

  const screenFromEvent = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  const worldPointFromEvent = (e: React.PointerEvent): Point => {
    const { px, py } = screenFromEvent(e);
    const w = toWorld(px, py);
    return {
      x: Math.min(pageRef.current.w, Math.max(0, w.x)), // ink stays on the sheet
      y: Math.min(pageRef.current.h, Math.max(0, w.y)),
      t: performance.now(),
      pressure: e.pressure > 0 ? e.pressure : 0.5,
    };
  };

  /* ---------- input layer: draw / pan / pinch ---------- */
  const onPointerDown = (e: React.PointerEvent) => {
    if (!ctxRef.current) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const { px, py } = screenFromEvent(e);
    pointersRef.current.set(e.pointerId, { x: px, y: py });

    if (pointersRef.current.size === 2) {
      // second finger: switch to pinch, drop any in-progress stroke
      drawingRef.current = false;
      currentStrokeRef.current = null;
      prevPointRef.current = null;
      panStartRef.current = null;
      const [a, b] = Array.from(pointersRef.current.values());
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const w = toWorld(midX, midY);
      pinchStartRef.current = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        wx: w.x,
        wy: w.y,
        k: viewRef.current.k,
      };
      redrawAll();
      return;
    }

    if (tool === "pan") {
      panStartRef.current = { px, py, view: { ...viewRef.current } };
      return;
    }

    drawingRef.current = true;
    const p = worldPointFromEvent(e);
    currentStrokeRef.current = { tool, points: [p] };
    prevPointRef.current = p;
    lastPointTimeRef.current = p.t;
    setStatus("drawing");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { px, py } = screenFromEvent(e);
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: px, y: py });
    }

    // pinch zoom
    if (pinchStartRef.current && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const start = pinchStartRef.current;
      const k = Math.min(MAX_ZOOM, Math.max(minZoom(), (start.k * d) / start.d));
      applyView({ k, x: start.wx - midX / k, y: start.wy - midY / k });
      return;
    }

    // pan drag
    if (panStartRef.current) {
      const s = panStartRef.current;
      applyView({
        x: s.view.x - (px - s.px) / s.view.k,
        y: s.view.y - (py - s.py) / s.view.k,
        k: s.view.k,
      });
      return;
    }

    if (!drawingRef.current) return;
    const stroke = currentStrokeRef.current;
    const prev = prevPointRef.current;
    if (!stroke || !prev) return;
    const p = worldPointFromEvent(e);
    stroke.points.push(p);
    lastPointTimeRef.current = p.t;
    drawSegment(prev, p, stroke.tool);
    prevPointRef.current = p;
  };

  const finishStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const stroke = currentStrokeRef.current;
    if (stroke && stroke.points.length > 0) {
      if (stroke.points.length === 1) {
        drawSegment(stroke.points[0], stroke.points[0], stroke.tool); // dot
      }
      strokesRef.current.push(stroke);
    }
    currentStrokeRef.current = null;
    prevPointRef.current = null;
    lastPointTimeRef.current = performance.now();
    refreshStats();
    setStatus("idle");
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointersRef.current.size === 0) panStartRef.current = null;
    finishStroke();
  };

  /* ---------- vision export: the CONTENT, not the viewport ---------- */
  const rasterizeWork = (): string | null => {
    const strokes = strokesRef.current;
    const bbox = strokesBBox(strokes);
    if (!bbox) return null;
    const pad = 30;
    const bw = bbox.x1 - bbox.x0 + 2 * pad;
    const bh = bbox.y1 - bbox.y0 + 2 * pad;
    const scale = Math.min(1400 / bw, 1400 / bh, 2);
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(bw * scale));
    off.height = Math.max(1, Math.round(bh * scale));
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = paperColorRef.current;
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const sx = (wx: number) => (wx - bbox.x0 + pad) * scale;
    const sy = (wy: number) => (wy - bbox.y0 + pad) * scale;
    for (const s of strokes) {
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1];
        const b = s.points[i];
        if (s.tool === "highlighter") {
          ctx.strokeStyle = hlColorRef.current;
          ctx.lineWidth = 22 * scale;
        } else {
          ctx.strokeStyle = inkColorRef.current;
          ctx.lineWidth = (1.5 + b.pressure * 3) * scale;
        }
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.stroke();
      }
    }
    return off.toDataURL("image/png");
  };

  /* ---------- workings notebook: JSON pages you can flip back to ---------- */
  const snapshotWorking = useCallback(
    (id: string): Working => ({
      id,
      createdAt: Date.now(),
      question: { author: "tutor", content: question ?? null },
      work: { author: "user", strokes: strokesRef.current },
      analysis: {
        author: "assistant",
        reading: feedbackRef.current.reading,
        feedback: feedbackRef.current.feedback,
      },
      view: { ...viewRef.current },
      orientation,
    }),
    [question, orientation]
  );

  const savePage = useCallback(() => {
    const id = currentPageId ?? `w${Date.now().toString(36)}`;
    const next = [...loadWorkings().filter((w) => w.id !== id), snapshotWorking(id)].sort(
      (a, b) => a.createdAt - b.createdAt
    );
    persistWorkings(next);
    setWorkings(next);
    setCurrentPageId(id);
  }, [currentPageId, snapshotWorking]);

  const openPage = (w: Working) => {
    strokesRef.current = w.work.strokes;
    currentStrokeRef.current = null;
    drawingRef.current = false;
    lastPointTimeRef.current = 0; // don't re-analyze a reopened page
    lastSignatureRef.current = `${w.work.strokes.length}:${w.work.strokes.reduce(
      (n, s) => n + s.points.length,
      0
    )}`;
    feedbackRef.current = { reading: w.analysis.reading, feedback: w.analysis.feedback };
    setFeedback(w.analysis.reading || w.analysis.feedback ? { ...feedbackRef.current } : null);
    setCurrentPageId(w.id);
    refreshStats();
    setStatus("idle");
    const nextOrientation: Orientation = w.orientation ?? "portrait";
    if (nextOrientation !== orientation) {
      pendingViewRef.current = w.view ?? null;
      setOrientation(nextOrientation); // effect applies the view / refits
    } else if (w.view) {
      applyView(w.view);
    } else {
      fitPage();
    }
  };

  const newPage = () => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    drawingRef.current = false;
    lastPointTimeRef.current = 0;
    lastSignatureRef.current = "";
    feedbackRef.current = { reading: "", feedback: "" };
    setStats({ strokes: 0, points: 0 });
    setFeedback(null);
    setCurrentPageId(null);
    setStatus("idle");
    fitPage();
  };

  /* ---------- slow loop: rasterize -> vision -> streamed feedback ---------- */
  const runSlowLoop = useCallback(async () => {
    if (analyzingRef.current) return; // only one call at a time
    const strokes = strokesRef.current;
    if (strokes.length === 0) return;

    const points = strokes.reduce((n, s) => n + s.points.length, 0);
    const signature = `${strokes.length}:${points}`;
    if (signature === lastSignatureRef.current) return;

    analyzingRef.current = true;
    setStatus("analyzing");
    feedbackRef.current = { reading: "", feedback: "" };
    setFeedback({ ...feedbackRef.current });
    try {
      const image = rasterizeWork();
      if (!image) return;
      const res = await fetch("/api/handwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, strokeCount: strokes.length, question }),
      });

      if (!res.ok || !res.body) {
        console.error("handwriting endpoint returned", res.status);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        feedbackRef.current = splitStream(acc);
        setFeedback({ ...feedbackRef.current });
      }
      feedbackRef.current = splitStream(acc);
      setFeedback({ ...feedbackRef.current });
      lastSignatureRef.current = signature;
      // Keep the saved page in sync with its latest analysis.
      if (currentPageId) savePage();
    } catch (err) {
      console.error("handwriting analysis failed", err);
    } finally {
      analyzingRef.current = false;
      setStatus("idle");
    }
  }, [question, currentPageId, savePage]);

  /* ---------- fast loop: heartbeat boundary detection (no network) ---------- */
  useEffect(() => {
    const id = setInterval(() => {
      if (drawingRef.current) return; // never fire mid-stroke
      if (lastPointTimeRef.current === 0) return; // nothing drawn yet
      const sincePause = performance.now() - lastPointTimeRef.current;
      if (sincePause > PAUSE_MS) {
        runSlowLoop();
      }
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [runSlowLoop]);

  const statusLabel =
    status === "analyzing"
      ? "Reading your work…"
      : status === "drawing"
      ? tool === "highlighter"
        ? "Highlighting…"
        : "Writing…"
      : "Your A4 page — write anywhere, pinch or scroll to zoom";

  const pageNumber = (id: string) => workings.findIndex((w) => w.id === id) + 1;

  return (
    <div className="flex flex-col items-center w-full gap-3">
      <div className="hwToolbar flex flex-wrap items-center justify-between w-full max-w-2xl gap-2 px-1">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTool("pen")}
            className={`sketchy-btn text-sm ${tool === "pen" ? "active" : ""}`}
            aria-pressed={tool === "pen"}
          >
            ✏️ Pen
          </button>
          <button
            onClick={() => setTool("highlighter")}
            className={`sketchy-btn text-sm ${tool === "highlighter" ? "active" : ""}`}
            aria-pressed={tool === "highlighter"}
          >
            🖍️ Highlight
          </button>
          <button
            onClick={() => setTool("pan")}
            className={`sketchy-btn text-sm ${tool === "pan" ? "active" : ""}`}
            aria-pressed={tool === "pan"}
            title="Move around the page (or drag with two fingers)"
          >
            🖐️ Pan
          </button>
          <button
            onClick={() => setOrientation(orientation === "portrait" ? "landscape" : "portrait")}
            className="sketchy-btn text-sm"
            title="Flip the page between portrait and landscape"
          >
            {orientation === "portrait" ? "📄 Portrait" : "📄 Landscape"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={savePage} className="sketchy-btn text-sm">
            Save page{currentPageId ? ` ${pageNumber(currentPageId)}` : ""}
          </button>
          <button onClick={newPage} className="sketchy-btn text-sm">
            New page
          </button>
        </div>
      </div>

      {workings.length > 0 && (
        <div className="flex flex-wrap items-center w-full max-w-2xl gap-1 px-1 text-sm">
          <span className="hand-accent mr-1">My workings:</span>
          {workings.map((w, i) => (
            <button
              key={w.id}
              onClick={() => openPage(w)}
              className={`sketchy-btn text-xs ${currentPageId === w.id ? "active" : ""}`}
              title={new Date(w.createdAt).toLocaleString()}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <div
        className="flex items-center justify-between w-full max-w-2xl px-1 text-sm"
        style={{ color: "var(--pencil-soft)" }}
      >
        <span>
          {statusLabel}
          {status === "analyzing" && <span className="ml-2 inline-block animate-pulse">●</span>}
        </span>
        <span className="tabular-nums">
          {zoomPct}% · {stats.strokes} strokes · {stats.points} points
        </span>
      </div>

      <div className="relative w-full max-w-2xl">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerCancel={onPointerUp}
          className="sketchy hwCanvas w-full"
          style={{ touchAction: "none", cursor: tool === "pan" ? "grab" : "crosshair" }}
        />
        <div className="absolute right-2 bottom-2 flex flex-col gap-1">
          <button
            className="sketchy-btn text-sm"
            onClick={() => {
              const { w, h } = cssSizeRef.current;
              zoomAt(w / 2, h / 2, 1.25);
            }}
            aria-label="zoom in"
          >
            +
          </button>
          <button
            className="sketchy-btn text-sm"
            onClick={() => {
              const { w, h } = cssSizeRef.current;
              zoomAt(w / 2, h / 2, 0.8);
            }}
            aria-label="zoom out"
          >
            −
          </button>
          <button className="sketchy-btn text-sm" onClick={fitPage} aria-label="fit the page">
            ⌖
          </button>
        </div>
      </div>

      {feedback && (feedback.reading || feedback.feedback) && (
        <div className="sketchy w-full max-w-2xl p-4">
          {feedback.reading && (
            <div className="mb-2">
              <div className="hand-accent text-lg">I read:</div>
              <MarkdownLatex content={feedback.reading} />
            </div>
          )}
          {feedback.feedback && (
            <div>
              <div className="hand-accent text-lg">Feedback:</div>
              {/* Plain prose is drawn out as synthetic handwriting (with the
                  markdown theme); anything carrying LaTeX falls back to KaTeX
                  so the math stays exact. */}
              {/[\\$]/.test(feedback.feedback) ? (
                <MarkdownLatex content={feedback.feedback} />
              ) : (
                <HandwrittenText text={feedback.feedback} size={24} maxWidth={620} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HandwritingCanvas;
