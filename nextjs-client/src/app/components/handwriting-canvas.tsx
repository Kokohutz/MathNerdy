"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownLatex } from "./markdown-latex";

// A handwriting whiteboard the student draws on. Two loops:
//
//   FAST LOOP  – a ~120ms heartbeat that watches the stroke buffer for a pause
//                (boundary detection). It never touches the network.
//   SLOW LOOP  – fires when the fast loop detects a pause. It rasterizes the
//                canvas, sends it to /api/handwriting (vision), and renders the
//                reading + feedback. Guarded so only one call runs at a time and
//                unchanged content is never re-analyzed.

type Point = { x: number; y: number; t: number; pressure: number };
type Stroke = Point[];

const HEARTBEAT_MS = 120; // fast-loop tick
const PAUSE_MS = 800; // silence that counts as a boundary

type Feedback = { reading: string; feedback: string };

export function HandwritingCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Stroke buffer (strokes, not pixels). Kept in refs so the loops read live
  // values without forcing re-renders on every pointer event.
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);
  const lastPointTimeRef = useRef(0);

  // Slow-loop guards.
  const analyzingRef = useRef(false);
  const lastSignatureRef = useRef("");

  const [stats, setStats] = useState({ strokes: 0, points: 0 });
  const [status, setStatus] = useState<"idle" | "drawing" | "analyzing">("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

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
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1f2937";
    ctxRef.current = ctx;
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
    const ctx = ctxRef.current;
    if (!ctx) return;
    drawingRef.current = true;
    const p = pointFromEvent(e);
    currentStrokeRef.current = [p];
    lastPointTimeRef.current = p.t;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setStatus("drawing");
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const ctx = ctxRef.current;
    const stroke = currentStrokeRef.current;
    if (!ctx || !stroke) return;
    const p = pointFromEvent(e);
    stroke.push(p);
    lastPointTimeRef.current = p.t;
    ctx.lineWidth = 1.5 + p.pressure * 3;
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const finishStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const stroke = currentStrokeRef.current;
    if (stroke && stroke.length > 0) {
      strokesRef.current.push(stroke);
    }
    currentStrokeRef.current = null;
    lastPointTimeRef.current = performance.now();
    setStats({
      strokes: strokesRef.current.length,
      points: strokesRef.current.reduce((n, s) => n + s.length, 0),
    });
    setStatus("idle");
  };

  /* ---- slow loop: rasterize -> vision -> feedback ---- */
  const runSlowLoop = useCallback(async () => {
    if (analyzingRef.current) return; // only one call at a time
    const strokes = strokesRef.current;
    if (strokes.length === 0) return;

    // Cheap content signature so unchanged drawings are never re-analyzed.
    const points = strokes.reduce((n, s) => n + s.length, 0);
    const signature = `${strokes.length}:${points}`;
    if (signature === lastSignatureRef.current) return;

    analyzingRef.current = true;
    setStatus("analyzing");
    try {
      const image = canvasRef.current!.toDataURL("image/png");
      const res = await fetch("/api/handwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, strokeCount: strokes.length }),
      });
      if (res.ok) {
        const data: Feedback = await res.json();
        setFeedback(data);
        lastSignatureRef.current = signature;
      } else {
        console.error("handwriting endpoint returned", res.status);
      }
    } catch (err) {
      console.error("handwriting analysis failed", err);
    } finally {
      analyzingRef.current = false;
      setStatus("idle");
    }
  }, []);

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

  const clear = () => {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokesRef.current = [];
    currentStrokeRef.current = null;
    drawingRef.current = false;
    lastPointTimeRef.current = 0;
    lastSignatureRef.current = "";
    setStats({ strokes: 0, points: 0 });
    setFeedback(null);
    setStatus("idle");
  };

  const statusLabel =
    status === "analyzing"
      ? "Reading your work…"
      : status === "drawing"
      ? "Drawing…"
      : "Draw a problem, then pause";

  return (
    <div className="flex flex-col items-center w-full gap-3">
      <div className="flex items-center justify-between w-full max-w-2xl px-1 text-sm text-gray-600">
        <span>
          {statusLabel}
          {status === "analyzing" && (
            <span className="ml-2 inline-block animate-pulse">●</span>
          )}
        </span>
        <span className="tabular-nums text-gray-400">
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
        className="w-full max-w-2xl rounded-xl border-2 border-gray-200 bg-white shadow-sm"
        style={{ height: 320, touchAction: "none", cursor: "crosshair" }}
      />

      <div className="flex w-full max-w-2xl justify-end">
        <button
          onClick={clear}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:bg-gray-50"
        >
          Clear
        </button>
      </div>

      {feedback && (feedback.reading || feedback.feedback) && (
        <div className="w-full max-w-2xl rounded-xl border border-orange-200 bg-orange-50/60 p-4">
          {feedback.reading && (
            <div className="mb-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">
                I read
              </div>
              <MarkdownLatex content={feedback.reading} />
            </div>
          )}
          {feedback.feedback && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">
                Feedback
              </div>
              <MarkdownLatex content={feedback.feedback} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HandwritingCanvas;
