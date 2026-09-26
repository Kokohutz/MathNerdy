"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownLatex } from "./markdown-latex";
import { HandwrittenText } from "./handwritten-text";

// A handwriting whiteboard the student draws on. Two loops:
//
//   FAST LOOP  – a ~120ms heartbeat that watches the stroke buffer for a pause
//                (boundary detection). It never touches the network.
//   SLOW LOOP  – fires when the fast loop detects a pause. It rasterizes the
//                canvas, sends it to /api/handwriting (vision), and streams the
//                reading + feedback. Guarded so only one call runs at a time and
//                unchanged content is never re-analyzed.
//
// Tools: pen (ink) and highlighter (translucent marker). Every page of work
// can be saved as a role-tagged JSON "working" (localStorage) and reopened
// later, like flipping back through paper.

type Point = { x: number; y: number; t: number; pressure: number };
type Tool = "pen" | "highlighter";
type Stroke = { tool: Tool; points: Point[] };

// One saved page. Roles are explicit so anything reading the JSON knows what
// the tutor asked, what the student wrote, and what the AI said about it.
export type Working = {
  id: string;
  createdAt: number;
  question: { author: "tutor"; content: string | null };
  work: { author: "user"; strokes: Stroke[] };
  analysis: { author: "assistant"; reading: string; feedback: string };
};

const WORKINGS_KEY = "mathnerdy-workings";
const HEARTBEAT_MS = 120; // fast-loop tick
const PAUSE_MS = 800; // silence that counts as a boundary

// Must match FEEDBACK_DELIMITER in app/api/handwriting/route.ts. The streamed
// text is "<reading> ###FEEDBACK### <feedback>"; we split the live accumulator
// on it so both panels fill in word-by-word.
const FEEDBACK_DELIMITER = "###FEEDBACK###";

type Feedback = { reading: string; feedback: string };

// Split the streamed accumulator into the two sections. While the delimiter is
// still arriving we keep everything in "reading"; a trailing partial delimiter
// is hidden so it doesn't flicker on screen.
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

export function HandwritingCanvas({ question = null }: { question?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const inkColorRef = useRef("#1e4a5f");
  const hlColorRef = useRef("rgba(125,200,235,0.55)");

  // Stroke buffer (strokes, not pixels). Kept in refs so the loops read live
  // values without forcing re-renders on every pointer event.
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const prevPointRef = useRef<Point | null>(null);
  const drawingRef = useRef(false);
  const lastPointTimeRef = useRef(0);

  // Slow-loop guards.
  const analyzingRef = useRef(false);
  const lastSignatureRef = useRef("");
  const feedbackRef = useRef<Feedback>({ reading: "", feedback: "" });

  const [tool, setTool] = useState<Tool>("pen");
  const [stats, setStats] = useState({ strokes: 0, points: 0 });
  const [status, setStatus] = useState<"idle" | "drawing" | "analyzing">("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [workings, setWorkings] = useState<Working[]>([]);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);

  const applyToolStyle = (ctx: CanvasRenderingContext2D, t: Tool, pressure: number) => {
    if (t === "highlighter") {
      ctx.strokeStyle = hlColorRef.current;
      ctx.lineWidth = 22;
      ctx.lineCap = "round";
    } else {
      ctx.strokeStyle = inkColorRef.current;
      ctx.lineWidth = 1.5 + pressure * 3;
      ctx.lineCap = "round";
    }
    ctx.lineJoin = "round";
  };

  const drawSegment = (a: Point, b: Point, t: Tool) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    applyToolStyle(ctx, t, b.pressure);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };

  const redrawAll = useCallback((strokes: Stroke[]) => {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) {
      // highlighter first-class: draw in recorded order so layering matches
      for (let i = 1; i < s.points.length; i++) {
        drawSegment(s.points[i - 1], s.points[i], s.tool);
      }
      if (s.points.length === 1) {
        drawSegment(s.points[0], s.points[0], s.tool); // dot
      }
    }
  }, []);

  const refreshStats = () => {
    setStats({
      strokes: strokesRef.current.length,
      points: strokesRef.current.reduce((n, s) => n + s.points.length, 0),
    });
  };

  /* ---- canvas setup (handles HiDPI for crisp strokes) ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    // Match the design system (blue ink on paper, chalk on slate)
    const css = getComputedStyle(document.documentElement);
    inkColorRef.current = css.getPropertyValue("--pencil").trim() || "#1e4a5f";
    hlColorRef.current = css.getPropertyValue("--highlight").trim() || "rgba(125,200,235,0.55)";
    ctxRef.current = ctx;
    setWorkings(loadWorkings());
  }, []);

  const pointFromEvent = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      t: performance.now(),
      pressure: e.pressure > 0 ? e.pressure : 0.5,
    };
  };

  /* ---- input layer: pointer events -> stroke buffer ---- */
  const onPointerDown = (e: React.PointerEvent) => {
    if (!ctxRef.current) return;
    drawingRef.current = true;
    const p = pointFromEvent(e);
    currentStrokeRef.current = { tool, points: [p] };
    prevPointRef.current = p;
    lastPointTimeRef.current = p.t;
    setStatus("drawing");
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const stroke = currentStrokeRef.current;
    const prev = prevPointRef.current;
    if (!stroke || !prev) return;
    const p = pointFromEvent(e);
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

  /* ---- workings notebook: JSON pages you can flip back to ---- */
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
    }),
    [question]
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
    setFeedback(
      w.analysis.reading || w.analysis.feedback ? { ...feedbackRef.current } : null
    );
    setCurrentPageId(w.id);
    refreshStats();
    redrawAll(w.work.strokes);
    setStatus("idle");
  };

  const newPage = () => {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
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
  };

  /* ---- slow loop: rasterize -> vision -> streamed feedback ---- */
  const runSlowLoop = useCallback(async () => {
    if (analyzingRef.current) return; // only one call at a time
    const strokes = strokesRef.current;
    if (strokes.length === 0) return;

    // Cheap content signature so unchanged drawings are never re-analyzed.
    const points = strokes.reduce((n, s) => n + s.points.length, 0);
    const signature = `${strokes.length}:${points}`;
    if (signature === lastSignatureRef.current) return;

    analyzingRef.current = true;
    setStatus("analyzing");
    feedbackRef.current = { reading: "", feedback: "" };
    setFeedback({ ...feedbackRef.current });
    try {
      const image = canvasRef.current!.toDataURL("image/png");
      const res = await fetch("/api/handwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, strokeCount: strokes.length, question }),
      });

      if (!res.ok || !res.body) {
        console.error("handwriting endpoint returned", res.status);
        return;
      }

      // Stream the response and update both panels as tokens arrive.
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

  /* ---- fast loop: heartbeat boundary detection (no network) ---- */
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
      : "Write your working, then pause";

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

      <div className="flex items-center justify-between w-full max-w-2xl px-1 text-sm" style={{ color: "var(--pencil-soft)" }}>
        <span>
          {statusLabel}
          {status === "analyzing" && (
            <span className="ml-2 inline-block animate-pulse">●</span>
          )}
        </span>
        <span className="tabular-nums">
          {stats.strokes} strokes · {stats.points} points
        </span>
      </div>

      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerLeave={finishStroke}
        onPointerCancel={finishStroke}
        className="sketchy hwCanvas w-full max-w-2xl"
        style={{ touchAction: "none", cursor: "crosshair" }}
      />

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
