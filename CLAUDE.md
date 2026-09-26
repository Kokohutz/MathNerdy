# MathNerdy — Architecture & Developer Notes

A voice-enabled AI **calculus tutor**. The student speaks; the app replies with
synthesized speech **and** renders live LaTeX/Markdown math on an interactive
"whiteboard." Built on **8090's xRx framework**. The reasoning tutor and the
handwriting-vision call both run on **Claude Opus 5.5** by default — the tutor
through the OpenAI-compatible `claude-code` wrapper, vision straight through the
Anthropic API (models via env; `claude-fable-5-1` or OpenAI `gpt-5.4` are
config-only switches). STT is **Whisper on Groq** and TTS is **ElevenLabs**
(both swappable, separate services).

> Fork of `bklieger-groq/mathtutor-on-groq` ("Math Tutor on Groq").

---

## Repository layout

```
.
├── docker-compose.yaml      # Orchestrates all services
├── env-example.txt          # Copy to .env and fill in API keys
├── reasoning/               # ★ The custom agent (Python / FastAPI) — owned here
├── nextjs-client/           # ★ The frontend (Next.js / React / TS) — owned here
├── test/                    # Integration tests hitting the reasoning endpoint
└── xrx-core/                # git SUBMODULE (8090-inc/xrx-core) — framework code
```

**Important:** `xrx-core/` is a git submodule and is **not** part of this repo's
source. The orchestrator, STT, TTS services, the `agent_framework` Python
library, and the `react-xrx-client` React hook all live there. Clone with
`--recursive` (or run `git submodule update --init`) or the build will fail.

The only application code this repo actually owns is **`reasoning/`** and
**`nextjs-client/`**.

---

## Service topology (`docker-compose.yaml`)

```
Browser (nextjs-client :3000)
        │  WebSocket  /api/v1/ws
        ▼
  xrx-orchestrator :8000  ──┬── xrx-stt        :8001   speech → text  (Groq Whisper)
  (xrx-core submodule)      ├── xrx-tts        :8002   text → speech  (ElevenLabs)
                            ├── xrx-reasoning  :8003   ← the agent in reasoning/
                            ├── claude-code    :8005   OpenAI-compatible wrapper → Claude Code (Opus 5.5)
                            └── xrx-redis      :6379   task / cancellation state
```

`xrx-guardrails` is defined but commented out. The reasoning and client images
build from the repo root context so they can copy code out of `xrx-core/`.

---

## The reasoning agent (`reasoning/app/`)

The brain of the app. Each conversational turn runs a **two-LLM-call pipeline**.

### Files
| File | Role |
|------|------|
| `main.py` | Wires `run_agent` into the framework's `xrx_reasoning` app wrapper. |
| `agent/executor.py` | The pipeline: context call → SymPy → response call. |
| `agent/context_manager.py` | `contextvars`-based per-request `session` state. |
| `agent/utils/calculator.py` | Deterministic SymPy math + `calc_solve` call parsing. |

### Turn flow (`executor.py`)

1. **`context_agent`** — first LLM call (`CONTEXT_SYSTEM_PROMPT`). Decides
   *"does this turn need math computed?"* If so it emits a `calc_solve(...)`
   call **as text**.
2. **`process_calc_solve`** (`calculator.py`) — extracts the `calc_solve` call(s)
   and runs them through **SymPy** (`derivative`, `integral`, `limit`, `series`),
   producing a real step-by-step worked solution.
3. **`single_turn_agent`** — second LLM call (`SYSTEM_PROMPT`) with the SymPy
   result injected as context. Forced to `response_format=json_object`, returning:
   - `widgets[]` — e.g. `defineWhiteboard` with LaTeX `content`
   - `response`  — the text that gets spoken
4. Emits two messages to the orchestrator: a `Widget` node (whiteboard) and a
   `CustomerResponse` node (spoken reply). Before emitting it checks Redis for a
   `cancelled` flag on `task-<task_id>` so in-flight turns can be aborted.

### Design insight
Solve the math **deterministically with SymPy first**, then hand the result to
the LLM. This keeps arithmetic/algebra accurate instead of trusting the model to
compute it, at the cost of one extra LLM call per turn.

The reasoning client (`initialize_llm_client` from `xrx-core`) is the OpenAI
SDK driven entirely by `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL_ID`, so
switching providers/models is a config change. Default: `LLM_BASE_URL` points
at the **`claude-code` wrapper** and `LLM_MODEL_ID="claude-opus-5-5"`. Swap to
Fable with `claude-fable-5-1`, or to OpenAI by pointing `LLM_BASE_URL` at
`https://api.openai.com/v1` with `gpt-5.4`.

The tutor turn uses **Structured Outputs** (`response_format` `json_schema`,
`strict: true` — see `TUTOR_TURN_SCHEMA` in `executor.py`), which guarantees the
`{widgets, response}` shape on the GPT-5 / GPT-4.1 families. `_create_tutor_turn`
falls back to legacy JSON mode (`json_object`) + a JSON-repair retry for models
that don't support it.

### `calc_solve` contract (`calculator.py`)
```python
calc_solve(expression, operation='derivative', point=None, terms=None)
```
- `^` is auto-converted to `**`; variable is always `x`.
- `process_calc_solve` finds calls anywhere in model output via balanced-paren
  scanning + `ast` parsing, so it accepts every documented shape:
  `calc_solve("x^2")`, `calc_solve("3*x^2", operation="integral")`,
  `calc_solve("sin(x)/x", operation="limit", point=0)`,
  `calc_solve("exp(x)", operation="series", point=0, terms=4)`.

---

## Claude Code wrapper (`claude-code-wrapper/`)

The `claude-code` service exposes Claude behind an **OpenAI-compatible**
`POST /v1/chat/completions` endpoint (plus `POST /run` and `GET /health`).
Default model: **Claude Opus 5.5** (`claude-opus-5-5`, via `CLAUDE_CODE_MODEL`).
Two backends, chosen by `CLAUDE_WRAPPER_MODE` (default `api` when
`ANTHROPIC_API_KEY` is set): **api** calls the Anthropic Messages API directly
(~2s/turn, proper role-mapped history), **cli** shells out to the Claude Code
CLI headless (`claude -p`, login auth).

Because the reasoning agent is driven entirely by env, switching it to Opus 5.5
is config-only:

```
LLM_BASE_URL="http://claude-code:8005/v1"
LLM_MODEL_ID="claude-opus-5-5"
```

Notes:
- Auth is `ANTHROPIC_API_KEY` **inside the wrapper container**; the OpenAI-style
  `Authorization` header from callers is ignored (`LLM_API_KEY` just needs to be
  non-empty for the OpenAI SDK).
- `response_format` (`json_schema` / `json_object`) is **emulated via prompt
  instructions** — not constrained decoding — and the wrapper strips markdown
  fences from JSON replies. `_create_tutor_turn`'s JSON-repair fallback covers
  rare misses.
- Text-only and non-streaming: the handwriting vision route stays on OpenAI,
  and `stream: true` returns a 400.
- Tested via `CLAUDE_BIN` override (see `server.mjs`), which points the server
  at a stub CLI in tests.

---

## The frontend (`nextjs-client/src/app/`)

| File | Role |
|------|------|
| `page.tsx` | Main UI. Uses the `xRxClient` hook (from `xrx-core`) for all WebSocket/audio/state plumbing; adds Voice Activity Detection (`@ricky0123/vad-react`), the mic toggle, and the whiteboard renderer. |
| `components/markdown-latex.tsx` | Renders whiteboard content via `react-markdown` + `remark-math` + `rehype-katex` (KaTeX). |
| `components/header.tsx`, `intro-popup.tsx`, `ui/*` | GroqLabs branding, beta-disclaimer modal (localStorage-gated), shadcn-style Button/Card. |
| `types/skinConfig.ts` | UI theming per agent. Skins: `math-tutor` (default), plus inherited `pizza-agent`/`shoe-agent` demos. Selected by `NEXT_PUBLIC_AGENT`. |
| `types/chat.ts`, `utils/utils.ts` | Chat message type; `cn()` class-name helper. |

**Widget rendering:** `renderedWidgets` (a `useMemo` over `chatHistory`) finds the
last `widget` message, `JSON.parse`s its `details`, and renders each entry by
`type`. Today only `defineWhiteboard` is handled — add new widget types by
extending that `switch`.

### Handwriting whiteboard (A4 page, input + vision feedback)

`components/handwriting-canvas.tsx` is an **A4 sheet** (world coordinates,
portrait or landscape via the 📄 toggle) the student writes on: ✏️ pen, 🖍️
highlighter, 🖐️ pan, pinch/wheel zoom (view clamped so the sheet is never
lost), +/−/⌖ controls. A vision model reads the work and gives feedback.
Two-loop architecture:

- **Fast loop** — a ~120ms `setInterval` heartbeat that watches the stroke buffer
  for a pause (boundary detection). It never touches the network. Pointer events
  capture `{x, y, t, pressure}` into a stroke buffer ("strokes, not pixels").
- **Slow loop** — on a detected pause it rasterizes the **content bounding
  box** (not the viewport — the AI reads the whole working wherever it is on
  the sheet) and POSTs to `/api/handwriting` with the tutor's current
  `question`. Guarded so only one request runs at a time; a content signature
  (`strokes:points`) prevents re-analyzing unchanged work. The response is
  **streamed** and rendered live.

**Tools & workings notebook:** the student can switch between ✏️ pen and 🖍️
highlighter. Each page of work can be saved and reopened like paper — a
role-tagged JSON `Working` in `localStorage` (`mathnerdy-workings`):

```jsonc
{
  "id": "w…", "createdAt": 0,
  "question": { "author": "tutor", "content": "…whiteboard content…" },
  "work":     { "author": "user", "strokes": [{ "tool": "pen|highlighter", "points": [{"x":0,"y":0,"t":0,"pressure":0.5}] }] },
  "analysis": { "author": "assistant", "reading": "…", "feedback": "…" },
  "view": { "x": 0, "y": 0, "k": 1 }, "orientation": "portrait|landscape"
}
```

The roles make it unambiguous what the tutor asked, what the student wrote,
and what the AI said about it.

`api/handwriting/route.ts` is a **server-side** Next.js route that calls
**Claude vision** via the Anthropic Messages API (`VISION_MODEL_ID`, default
`claude-opus-5-5`; auth `ANTHROPIC_API_KEY`; plain `fetch` + SSE parsing, no
SDK). It re-emits the model's stream as plain text shaped as
`<reading> ###FEEDBACK### <feedback>`; the client splits the live accumulator
on the `FEEDBACK_DELIMITER` so both panels fill in word-by-word. The delimiter
constant must stay in sync between the route and
`components/handwriting-canvas.tsx`.

### Hand-drawn design system (CONVENTION: everything is hand-drawn)

The whole UI reads as **blue ink on light blue paper** (dark mode: chalk on
slate blue). Any new UI, model, chart or visualization must use this system —
nothing should look computer-drawn:

- **Theme tokens** (`globals.css`): `--pencil`, `--pencil-soft`, `--paper`,
  `--paper-card`, `--paper-line`, `--highlight`. Classes: `.sketchy` (wobbly
  hand-drawn card/border), `.sketchy-btn` (+ `.active`), `.hand-accent`,
  `.hlBadge`. Fonts: Patrick Hand (body) + Caveat (accents) via `next/font`.
- **`components/handwriting-glyphs.ts`** — vendored Hershey Script single-stroke
  glyphs (regenerate via the hersheytext npm package; keep the acknowledgement
  header).
- **`components/handwriting-synth.ts`** — the synthetic handwriting generator:
  text → jittered pen strokes (seeded; streaming-stable). Supports the markdown
  theme: `**bold**` (thicker ink), `*italic*` (slant), `==highlight==`
  (highlighter swipe drawn behind the words). `toAnimatedSVG()` emits
  standalone samples.
- **`components/handwritten-text.tsx`** — React renderer that animates the
  strokes drawing on (`hwdraw` keyframes); streamed text only animates the new
  characters.
- **`components/hand-drawn-plot.tsx` + `math-expr.ts`** — INTERACTIVE
  hand-drawn function plots: sketched axes, animated curve, hover/drag tracing
  of (x, f(x)), and a live parameter slider when the expression uses `a`.
  Expressions are parsed with a safe AST parser (never `eval`). The tutor emits
  these via the `defineGraph` widget (see `SYSTEM_PROMPT` in `executor.py`):
  `{ "type": "defineGraph", "parameters": { "expression": "sin(a*x)", "xmin": -6.3, "xmax": 6.3, "title": "…" } }`

> Known gaps vs. a production handwriting product: the fast loop does boundary
> detection but not true online handwriting recognition (that needs an SDK like
> MyScript/Google), and the slow loop sends the whole canvas image rather than a
> true stroke-diff. Swapping those two pieces in is the path from demo to product.

---

## Running locally

```bash
git clone --recursive <repo>          # --recursive pulls xrx-core
cp env-example.txt .env               # then add your API keys
docker-compose up --build             # app at http://localhost:3000
```

Required `.env` keys (see `env-example.txt`): `ANTHROPIC_API_KEY` (tutor +
vision), `GROQ_STT_API_KEY`, `ELEVENLABS_API_KEY`; `LLM_API_KEY` only needs to
be non-empty unless running the tutor on OpenAI. `NEXT_PUBLIC_AGENT` selects
the UI skin (default `math-tutor`); `LLM_MODEL_ID`, `CLAUDE_CODE_MODEL` and
`VISION_MODEL_ID` select the models.

---

## Tests (`test/`)

Integration tests POST to `http://127.0.0.1:8003/run-reasoning-agent` and parse
the SSE stream. They require the reasoning service to be running. `test.py`
covers single-turn, repeated, and multi-turn math conversations.

```bash
pip install -r test/requirements.txt
python -m unittest test/test.py
```

---

## Evaluation / verification workflow

Prefer **visual verification with screenshots** when changing anything
user-facing. When a change is ready to evaluate, run the app and capture a
screenshot of the relevant screen, and ask the maintainer to confirm against a
screenshot too. To run the UI locally:

```bash
cd nextjs-client && npm install && npm run dev   # needs xrx-core submodule present
```

Note: a screenshot is only meaningful with the `xrx-core` submodule initialized
and an `OPENAI_API_KEY` set (the handwriting feedback needs a live vision call).
Headless/CI containers without a browser or key can't produce one — fall back to
running locally and sharing the image.

## Conventions & gotchas

- **Don't compute math in prompts.** Route anything that needs a real answer
  through `calc_solve` so SymPy does it.
- The reasoning service must always return a JSON object with **both**
  `widgets` and `response`; `single_turn_agent` repairs malformed JSON by
  feeding the broken output back to the model once.
- LaTeX in whiteboard content needs **double backslashes** (`\\frac`, `\\lim`)
  because it travels through JSON before KaTeX sees it.
- `xrx-core/` changes belong upstream in `8090-inc/xrx-core`, not here.
