import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// The slow loop of the handwriting whiteboard posts a rasterized snapshot of
// what the student has drawn. We read it with a vision model and STREAM back a
// short reading + feedback so it appears word-by-word. Runs server-side so the
// API key never reaches the browser.

// Now that all LLM usage is OpenAI, fall back to LLM_API_KEY so a single key
// works for both the reasoning agent and this vision route.
const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
const openai = new OpenAI({ apiKey });
const VISION_MODEL = process.env.VISION_MODEL_ID || "gpt-4o";

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

export async function POST(req: NextRequest) {
  try {
    const { image } = await req.json();

    if (!image || typeof image !== "string") {
      return NextResponse.json(
        { error: "missing or invalid 'image' (expected a data URL)" },
        { status: 400 }
      );
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "No OpenAI key configured (set OPENAI_API_KEY or LLM_API_KEY)" },
        { status: 500 }
      );
    }

    const completion = await openai.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: 500,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read the handwritten math on this whiteboard and give brief feedback.",
            },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) controller.enqueue(encoder.encode(delta));
          }
        } catch (err) {
          console.error("handwriting stream error:", err);
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
