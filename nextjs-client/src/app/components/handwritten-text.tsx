"use client";

import { useEffect, useMemo, useRef } from "react";
import { parseInlineMarkdown, synthesizeHandwriting } from "./handwriting-synth";

// Renders text as synthetic handwriting that draws itself out like a pencil.
//
// Built for streamed text: strokes are keyed and jitter is seeded per character,
// so when `text` grows (tokens arriving from the slow loop) the characters
// already on screen stay exactly as drawn and only the new ones animate in.
// If `text` is not a continuation of the previous value, the board resets with
// a fresh seed — a new "hand".
//
// Requires the global `hwdraw` keyframes (globals.css).

type HandwrittenTextProps = {
  text: string;
  size?: number; // em height in px
  maxWidth?: number; // wrap width in px
  color?: string;
  speed?: number; // pencil travel in px/sec
  className?: string;
};

export function HandwrittenText({
  text,
  size = 26,
  maxWidth = 640,
  color = "var(--pencil, #3d3d3f)",
  speed = 1100,
  className = "",
}: HandwrittenTextProps) {
  const seedRef = useRef(0);
  if (seedRef.current === 0) {
    seedRef.current = (Math.random() * 0x7fffffff) | 0;
  }

  // Text committed as of the previous paint; characters below this index are
  // rendered fully drawn (no animation restart on re-render).
  const committedRef = useRef("");
  if (!text.startsWith(committedRef.current)) {
    committedRef.current = "";
    seedRef.current = (Math.random() * 0x7fffffff) | 0;
  }
  // Stroke charIndex counts VISIBLE characters (markdown markers stripped),
  // so the committed boundary must be measured the same way.
  const drawnChars = parseInlineMarkdown(committedRef.current).length;

  useEffect(() => {
    committedRef.current = text;
  }, [text]);

  const hw = useMemo(
    () => synthesizeHandwriting(text, { size, maxWidth, seed: seedRef.current }),
    [text, size, maxWidth]
  );

  if (!text.trim()) return null;

  const strokeW = Math.max(1.1, size * 0.045);
  let delay = 0;

  return (
    <svg
      viewBox={`0 0 ${Math.ceil(hw.width)} ${Math.ceil(hw.height)}`}
      width={Math.ceil(hw.width)}
      className={className}
      style={{ maxWidth: "100%", height: "auto" }}
      role="img"
      aria-label={text}
    >
      {hw.strokes.map((s, i) => {
        const isHl = s.kind === "hl";
        const style: React.CSSProperties = isHl
          ? {
              fill: "none",
              stroke: "var(--highlight, rgba(125,200,235,0.55))",
              strokeWidth: size * 0.55,
              strokeLinecap: "butt",
            }
          : {
              fill: "none",
              stroke: color,
              strokeWidth: strokeW * s.w,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              opacity: 0.92,
            };
        if (s.charIndex >= drawnChars) {
          const dur = Math.max(s.len / speed, 0.02);
          style.strokeDasharray = s.len;
          style.strokeDashoffset = s.len;
          style.animation = `hwdraw ${dur.toFixed(3)}s linear ${delay.toFixed(3)}s forwards`;
          delay += dur;
        }
        return <path key={i} d={s.d} style={style} />;
      })}
    </svg>
  );
}

export default HandwrittenText;
