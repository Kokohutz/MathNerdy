import { NextRequest, NextResponse } from "next/server";

// The slow loop of the handwriting whiteboard posts a rasterized snapshot of
// what the student has drawn. We read it with CLAUDE OPUS (vision) via the
// Anthropic Messages API and STREAM back a short reading + feedback so it
// appears word-by-word. Runs server-side so the API key never reaches the
// browser. No SDK — plain fetch + SSE parsing keeps the route dependency-free.

const VISION_MODEL = process.env.VISION_MODEL_ID || "claude-opus-5-5";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

// The model streams plain text: the transcription, then this delimiter on its
// own line, then the feedback. The client splits on it to fill the two panels
// progressively. Keep it in sync with FEEDBACK_DELIMITER in handwriting-canvas.
const FEEDBACK_DELIMITER = "###FEEDBACK###";

const SYSTEM_PROMPT = `You are a friendly calculus tutor reading a student's handwritten work on a whiteboard.

Look at the image and respond with PLAIN TEXT in exactly this structure:
1. First, transcribe the math you see, using LaTeX for any equations.
2. Then output the delimiter "${FEEDBACK_DELIMITER}" on its own line.
3. Then give one or two short, encouraging sentences of feedback: point out mistakes if any, or confirm correctness and suggest a next step.

If the image is blank or unreadable, say so before the delimiter and leave the feedback empty.
Never use the delimiter anywhere except to separate the two sections.`;

// Pull the base64 payload + media type out of a canvas data URL.
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

export async function POST(req: NextRequest) {
  try {
    const { image, question } = await req.json();

    if (!image || typeof image !== "string") {
      return NextResponse.json(
        { error: "missing or invalid 'image' (expected a data URL)" },
        { status: 400 }
      );
    }
    const img = parseDataUrl(image);
    if (!img) {
      return NextResponse.json(
        { error: "unsupported image data URL" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not configured on the server" },
        { status: 500 }
      );
    }

    const userText =
      (typeof question === "string" && question.trim()
        ? `The tutor's current whiteboard question (written by the TUTOR, not the student):\n${question}\n\n`
        : "") +
      "The image is the STUDENT's handwritten working. Read it and give brief feedback. You may use **bold**, *italics* and ==highlight== in the feedback for emphasis.";

    const upstream = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 600,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: img.mediaType, data: img.data },
              },
              { type: "text", text: userText },
            ],
          },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      console.error("anthropic vision call failed:", upstream.status, detail.slice(0, 500));
      return NextResponse.json({ error: "analysis_failed" }, { status: 502 });
    }

    // Re-emit the SSE stream as plain text deltas (the client's protocol).
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            // SSE events are separated by blank lines; data lines carry JSON.
            let sep;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
              const event = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              for (const line of event.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                try {
                  const j = JSON.parse(payload);
                  if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
                    controller.enqueue(encoder.encode(j.delta.text));
                  } else if (j.type === "error") {
                    throw new Error(j.error?.message || "stream error");
                  }
                } catch (e) {
                  if (e instanceof SyntaxError) continue; // partial/keepalive
                  throw e;
                }
              }
            }
          }
        } catch (err) {
          console.error("vision stream error:", err);
          controller.error(err);
          return;
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("handwriting analysis failed:", err);
    return NextResponse.json({ error: "analysis_failed" }, { status: 500 });
  }
}
