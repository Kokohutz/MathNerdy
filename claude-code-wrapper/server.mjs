// OpenAI-compatible HTTP wrapper for Claude models.
//
// Exposes POST /v1/chat/completions so any OpenAI-SDK client in this stack —
// notably the reasoning agent, which is driven entirely by LLM_BASE_URL /
// LLM_MODEL_ID — can run on Claude (default: Opus 5.5) by pointing at this
// service. Two backends:
//
//   api mode (default when ANTHROPIC_API_KEY is set): direct fetch to the
//     Anthropic Messages API — no process spawn, ~2s per tutor turn.
//   cli mode (fallback, or CLAUDE_WRAPPER_MODE=cli): shells out to the
//     Claude Code CLI headless (`claude -p`), using its login auth.
//
// Endpoints:
//   GET  /health                 liveness probe (reports mode + model)
//   POST /v1/chat/completions    OpenAI chat-completions shape (no streaming)
//   POST /run                    { prompt, system?, model? } -> { result }

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT || "8005", 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude"; // overridable for tests
const DEFAULT_MODEL = process.env.CLAUDE_CODE_MODEL || "claude-opus-5-5";
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000", 10);
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const MODE =
  process.env.CLAUDE_WRAPPER_MODE ||
  (process.env.ANTHROPIC_API_KEY ? "api" : "cli");

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Multimodal parts: keep text, drop images (this wrapper is text-only).
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// Convert OpenAI-style messages (+ response_format) into a system prompt and a
// flat transcript prompt for `claude -p`. Structured Outputs are emulated via
// instructions; callers keep their JSON-repair fallbacks for rare misses.
export function buildPromptParts(body) {
  const systemParts = [];
  const transcript = [];
  for (const m of body.messages || []) {
    const text = flattenContent(m.content);
    if (!text) continue;
    if (m.role === "system") systemParts.push(text);
    else transcript.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${text}`);
  }

  const rf = body.response_format;
  if (rf?.type === "json_schema" && rf.json_schema?.schema) {
    systemParts.push(
      "Respond with ONLY a single valid JSON object that conforms to this JSON Schema. " +
        "No markdown fences, no commentary:\n" +
        JSON.stringify(rf.json_schema.schema)
    );
  } else if (rf?.type === "json_object") {
    systemParts.push(
      "Respond with ONLY a single valid JSON object. No markdown fences, no commentary."
    );
  }

  transcript.push("Assistant:");
  return { system: systemParts.join("\n\n"), prompt: transcript.join("\n\n") };
}

// Claude sometimes wraps JSON in ```json fences despite instructions.
export function stripFences(text) {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return m ? m[1] : text;
}

// Proper role-mapped messages for the Anthropic Messages API (api mode).
// Consecutive same-role turns are merged and the list must start with a user
// turn (the tutor seeds an assistant greeting first).
export function buildApiMessages(body) {
  const msgs = [];
  for (const m of body.messages || []) {
    if (m.role === "system") continue;
    const text = flattenContent(m.content);
    if (!text) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    if (msgs.length && msgs[msgs.length - 1].role === role) {
      msgs[msgs.length - 1].content += "\n\n" + text;
    } else {
      msgs.push({ role, content: text });
    }
  }
  if (msgs.length === 0 || msgs[0].role === "assistant") {
    msgs.unshift({ role: "user", content: "(The conversation begins.)" });
  }
  return msgs;
}

async function callAnthropic({ system, messages, model, maxTokens }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`anthropic api ${res.status}: ${detail.slice(0, 400)}`);
    }
    const j = await res.json();
    const text = (j.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      result: text,
      usage: {
        input_tokens: j.usage?.input_tokens ?? 0,
        output_tokens: j.usage?.output_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function runClaude({ system, prompt, model }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", model, "--max-turns", "1"];
    if (system) args.push("--system-prompt", system);

    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${err.slice(0, 2000)}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`could not parse claude output: ${out.slice(0, 2000)}`));
      }
    });

    child.stdin.write(prompt); // prompt via stdin avoids argv length limits
    child.stdin.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { status: "ok", mode: MODE, model: DEFAULT_MODEL });
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readJsonBody(req);
      if (body.stream) {
        return sendJson(res, 400, {
          error: { message: "streaming is not supported by this wrapper", type: "invalid_request_error" },
        });
      }
      const model = body.model || DEFAULT_MODEL;
      const { system, prompt } = buildPromptParts(body);
      const result =
        MODE === "api"
          ? await callAnthropic({
              system,
              messages: buildApiMessages(body),
              model,
              maxTokens: body.max_tokens ?? 4096,
            })
          : await runClaude({ system, prompt, model });

      let content = typeof result.result === "string" ? result.result : "";
      if (body.response_format) content = stripFences(content).trim();

      return sendJson(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: result.usage?.input_tokens ?? 0,
          completion_tokens: result.usage?.output_tokens ?? 0,
          total_tokens:
            (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
        },
      });
    }

    if (req.method === "POST" && req.url === "/run") {
      const body = await readJsonBody(req);
      if (!body.prompt || typeof body.prompt !== "string") {
        return sendJson(res, 400, { error: "missing 'prompt' string" });
      }
      const result =
        MODE === "api"
          ? await callAnthropic({
              system: body.system || "",
              messages: [{ role: "user", content: body.prompt }],
              model: body.model || DEFAULT_MODEL,
              maxTokens: body.max_tokens ?? 2048,
            })
          : await runClaude({
              system: body.system || "",
              prompt: body.prompt,
              model: body.model || DEFAULT_MODEL,
            });
      return sendJson(res, 200, { result: result.result ?? "", raw: result });
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("request failed:", e);
    sendJson(res, 500, { error: { message: String(e.message || e), type: "server_error" } });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `claude wrapper listening on :${PORT} (mode: ${MODE}, default model: ${DEFAULT_MODEL})`
  );
});
