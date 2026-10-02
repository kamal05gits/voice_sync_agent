# VoiceSync Agent

A browser-first real-time voice and multimodal agent for **PS-05: Real-Time Voice & Multimodal Agents**.
VoiceSync combines spoken input with camera/screen context, before-and-after visual reasoning, and approval-gated real-world actions in one console.

**Reasoning and vision: Google Gemini. Speech synthesis: ElevenLabs. Verified task execution: Trello.**

> Full architecture and API contracts: **[WORKFLOW.md](./WORKFLOW.md)** · PS-05 capability audit: **[AUDIT.md](./AUDIT.md)**

---

## How it works

```
voice / text  ──┐
                ├──►  POST /api/chat  ──►  Gemini (gemini-3.8-flash, multimodal)
camera / screen ┘                                      │
  → current frame + optional compact prior frame       ▼
                                            reply text ──► POST /api/tts ──► ElevenLabs ──► 🔊
                                                       └──► write proposal ──► edit/approve
                                                                              └──► Trello create + read-back ──► verified URL
```

1. **Capture** — Web Speech API for live transcription, or type. Camera via `getUserMedia`, screen via `getDisplayMedia`, or upload a document image.
2. **Frame** — a JPEG is grabbed *only* for the turn you send. When comparison is enabled, one compact prior submitted frame stays in memory and accompanies a turn only after a detected change or an explicit “what changed?” request.
3. **Reason** — transcript + current/earlier frame + the last 8 turns go to Gemini through `/api/chat`.
4. **Speak** — the reply is voiced by ElevenLabs via `/api/tts`, falling back to the browser voice. Continuous microphone mode resumes after each spoken reply until paused.
5. **Approve** — a manual or Gemini function-call proposal shows an editable title, description, and exact destination, then waits for human confirmation.
6. **Execute and verify** — configured deployments create a Trello card through `/api/trello`, read it back from Trello, and return the verified card URL. An idempotency marker prevents duplicate cards on retry. Without Trello, the UI clearly labels a local-only fallback.

---

## Quick start

```bash
git clone https://github.com/kamal05gits/voice_sync_agent.git
cd voice_sync_agent

cp .env.example .env     # add your keys
npm run dev              # → http://localhost:4173
```

No install step and no dependencies — `dev-server.mjs` runs on plain Node 18+.
It serves the static console *and* mounts the same `/api` handlers Vercel runs, so
local behaviour matches production.

Verify everything:

```bash
npm run smoke            # checks static host, UI contract, demo mode, and live mode
```

Live mode is covered too — `test/mock-upstreams.mjs` stands in for Gemini and
ElevenLabs, so the request shape, retries, timeouts and audio path are all
verified without spending a real key.

---

## Configuration

Copy `.env.example` → `.env` (gitignored, never commit it):

```env
# Reasoning — Google Gemini  (required for live mode)
GEMINI_API_KEY=your_gemini_key          # https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite
GEMINI_THINKING_LEVEL=low               # low (default) · medium · high
# Only used when intentionally selecting a Gemini 2.5 model:
GEMINI_THINKING_BUDGET=0                # 0 off · -1 dynamic · 512+ fixed

# Speech — ElevenLabs  (optional)
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_MODEL=eleven_multilingual_v2

# Approval-gated external task execution — Trello (optional)
TRELLO_API_KEY=your_trello_api_key
TRELLO_API_TOKEN=your_trello_token
TRELLO_LIST_ID=your_destination_list_id
TRELLO_LIST_NAME=VoiceSync Follow-ups
```

> **Thinking and model compatibility.** Gemini 3 models use the string-valued
> `thinkingLevel` setting, not the legacy numeric `thinkingBudget`. VoiceSync
> defaults Gemini 3.8 Flash to `low` for responsive spoken replies; set
> `GEMINI_THINKING_LEVEL=medium` or `high` when a turn needs deeper reasoning.
> The code still supports Gemini 2.5 when selected explicitly and only sends
> that model family its `thinkingBudget` setting.

| Key missing | What happens |
|---|---|
| `GEMINI_API_KEY` | **Demo mode** — deterministic local replies, identical response shape, app fully usable |
| `ELEVENLABS_API_KEY` | Speech falls back to the browser's built-in `speechSynthesis` voice |
| Any Trello value | The action modal explicitly uses a local-only fallback; it never claims an external write |

For Trello, create an API key and a user token with read/write access, copy the ID of the destination list, and set all three required values. `TRELLO_LIST_NAME` is only a friendly approval-dialog label. The token and list ID are never returned by `/api/health`.

Check what's actually live at any time:

```bash
curl localhost:4173/api/health
```

```json
{
  "mode": "live",
  "reasoning": { "provider": "google-gemini", "configured": true, "model": "gemini-3.8-flash", "vision": true, "thinkingBudget": null, "thinkingLevel": "low" },
  "speech":    { "provider": "elevenlabs",    "configured": true, "model": "eleven_multilingual_v2", "voiceId": "21m00Tcm4TlvDq8ikWAM" },
  "tools":     { "trello": { "provider": "trello", "configured": true, "destination": "VoiceSync Follow-ups", "approvalRequired": true, "readBackVerification": true } }
}
```

The console's top-right badge reads from this endpoint, so it shows which providers are configured. A key is validated only when a live turn reaches that provider.

---

## Deploy

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Add the Gemini, ElevenLabs, and optional Trello values from `.env.example` as Environment Variables in the Vercel dashboard. Credentials stay server-side in `/api/chat`, `/api/tts`, and `/api/trello`; Gemini, ElevenLabs, and Trello authentication is sent in headers, never in URLs.

---

## Privacy and action model

- Camera and screen are accessed **only** after an explicit browser permission prompt.
- Visual frames are sent **only** on the turn you submit — there is no background visual streaming.
- Speech recognition is supplied by the browser. Depending on the browser, microphone audio may be processed by the browser vendor's online speech service; VoiceSync receives only the transcript.
- **Clear** stops every visual track *and* releases the video element, so no stale frame can be captured afterwards.
- Stopping a share from the browser's own bar immediately switches the agent back to text-only context.
- Read-only analysis runs directly. One compact comparison frame may remain in memory between submitted turns; it is never uploaded continuously and **Clear** removes it.
- A write proposal exposes editable title/description fields and its exact destination. The server executes it only after approval.
- Trello writes use a unique operation marker, check for an existing card before creation, and are read back after creation. The external card URL is recorded only when the approved write verifies.
- Only approved action receipts and user settings persist in browser storage. Conversation text, diagnostics, transcripts, and visual frames are never persisted.
- Replies are rendered as text nodes, so model output cannot inject markup into the page.
- The context source label is whitelisted to `Camera`/`Screen`/`Document`, so nothing the client sends can be smuggled into the prompt.
- The dev server only serves front-end files: `.env`, `api/`, `test/` and config files are never reachable over HTTP.

---

## Project layout

| Path | Role |
|---|---|
| `index.html` / `styles.css` | Console UI, responsive at 900px and 620px |
| `app.js` | 6-stage client pipeline: capture → frame → reason → speak → approve → verify |
| `api/_gemini.js` | Shared Gemini client (auth, 18s attempt timeout, retry, response parsing, image parts) |
| `api/chat.js` | Gemini text + vision reasoning |
| `api/tts.js` | ElevenLabs speech synthesis |
| `api/trello.js` | Approval-only Trello executor with idempotency and read-back verification |
| `api/health.js` | Per-provider and tool status without secret/list-ID exposure |
| `dev-server.mjs` | Local host for static + API, loads `.env`, serves only front-end files |
| `test/smoke.mjs` | 113 route, UI-contract, external-action and failure-mode checks |
| `test/mock-upstreams.mjs` | Gemini + ElevenLabs test doubles used by the smoke test |
| `AUDIT.md` | PS-05 capability matrix, verified behavior, and honest prototype boundaries |

---

## Demo flow (3 minutes)

1. Frame the problem: voice assistants can't see what you're working on.
2. Ask "What do you see?" — shows the conversational loop and the TTS reply.
3. Connect Camera, Screen, or a document image; the context panel goes **LIVE**.
4. Submit one turn, change the shared screen, then ask **What changed?** — the pill confirms Gemini received the before/after frames.
5. Say **Create a follow-up card for this issue** — Gemini proposes the action and the modal exposes editable fields plus the Trello destination.
6. Approve it, open the verified Trello URL, then open **Session history** to show the persistent external receipt and latency diagnostics.
7. Hit **Clear** and show that the live track and comparison baseline are genuinely released.

---

## AI disclosure

UI and prototype implementation were built with AI-assisted development.
Current stack: Web Speech API (STT) · Google Gemini `gemini-3.8-flash` (reasoning + vision) · ElevenLabs `eleven_multilingual_v2` (TTS) · Trello REST API (verified writes) · Vercel serverless functions. The production path to media streaming and additional OAuth/MCP tools is documented in [WORKFLOW.md](./WORKFLOW.md).

---

## Project information

- **Team:** Tech Arise
- **Member:** Kamalesh P
- **Track:** PS-05 · Real-Time Voice & Multimodal Agents
- **College:** Government College of Engineering, Bargur
"# voice_sync_agent" 
