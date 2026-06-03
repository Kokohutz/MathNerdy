import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// The slow loop of the handwriting whiteboard posts a rasterized snapshot of
// what the student has drawn. We read it with a vision model and return a short
// reading + feedback. This runs server-side so OPENAI_API_KEY never reaches the
// browser.

// Now that all LLM usage is OpenAI, fall back to LLM_API_KEY so a single key
// works for both the reasoning agent and this vision route.
const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
const openai = new OpenAI({ apiKey });
const VISION_MODEL = process.env.VISION_MODEL_ID || "gpt-4o";

const SYSTEM_PROMPT = `You are a friendly calculus tutor reading a student's handwritten work on a whiteboard.

Look at the image and:
1. Transcribe the math you see, using LaTeX for any equations.
2. Give brief, encouraging feedback: point out mistakes if any, or confirm correctness and suggest a next step.

If the image is blank or unreadable, say so in "reading" and leave "feedback" empty.

Respond with a single JSON object of exactly this shape:
{
  "reading": "<what you see, LaTeX where appropriate>",
  "feedback": "<one or two short sentences of tutoring feedback>"
}`;

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
      response_format: { type: "json_object" },
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

    const raw = completion.choices[0]?.message?.content || "{}";

    let parsed: { reading?: string; feedback?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fall back to treating the whole response as the reading.
      parsed = { reading: raw, feedback: "" };
    }

    return NextResponse.json({
      reading: parsed.reading ?? "",
      feedback: parsed.feedback ?? "",
    });
  } catch (err) {
    console.error("handwriting analysis failed:", err);
    return NextResponse.json({ error: "analysis_failed" }, { status: 500 });
  }
}
