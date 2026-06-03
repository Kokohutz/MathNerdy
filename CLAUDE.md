# MathNerdy — Architecture & Developer Notes

A voice-enabled AI **calculus tutor**. The student speaks; the app replies with
synthesized speech **and** renders live LaTeX/Markdown math on an interactive
"whiteboard." Built on **8090's xRx framework**. The reasoning LLM and the
handwriting-vision call both use the **OpenAI API** (model via env); STT is
**Whisper on Groq** and TTS is **ElevenLabs** (both swappable, separate services).

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
switching providers/models is a config change. `LLM_MODEL_ID` must support JSON
mode (`response_format=json_object`).

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

### Handwriting whiteboard (input + vision feedback)

`components/handwriting-canvas.tsx` lets the student **draw** math; a vision model
reads it and gives feedback. It implements a two-loop architecture:

- **Fast loop** — a ~120ms `setInterval` heartbeat that watches the stroke buffer
  for a pause (boundary detection). It never touches the network. Pointer events
  capture `{x, y, t, pressure}` into a stroke buffer ("strokes, not pixels").
- **Slow loop** — on a detected pause it rasterizes the canvas to a PNG data URL
  and POSTs to `/api/handwriting`. It is guarded so only one request runs at a
  time, and a cheap content signature (`strokes:points`) prevents re-analyzing
  unchanged work. The returned `{ reading, feedback }` is rendered via
  `MarkdownLatex` (LaTeX-aware).

`api/handwriting/route.ts` is a **server-side** Next.js route that calls the
**OpenAI vision API** (`VISION_MODEL_ID`, default `gpt-4o`) using
`OPENAI_API_KEY`. The key never reaches the browser. It returns a JSON object
`{ reading, feedback }`.

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

Required `.env` keys (see `env-example.txt`): `LLM_API_KEY` (OpenAI),
`GROQ_STT_API_KEY`, `ELEVENLABS_API_KEY`, and `OPENAI_API_KEY` for the
handwriting vision route (falls back to `LLM_API_KEY` if unset).
`NEXT_PUBLIC_AGENT` selects the UI skin (default `math-tutor`); `LLM_MODEL_ID`
and `VISION_MODEL_ID` select the models.

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

## Conventions & gotchas

- **Don't compute math in prompts.** Route anything that needs a real answer
  through `calc_solve` so SymPy does it.
- The reasoning service must always return a JSON object with **both**
  `widgets` and `response`; `single_turn_agent` repairs malformed JSON by
  feeding the broken output back to the model once.
- LaTeX in whiteboard content needs **double backslashes** (`\\frac`, `\\lim`)
  because it travels through JSON before KaTeX sees it.
- `xrx-core/` changes belong upstream in `8090-inc/xrx-core`, not here.
