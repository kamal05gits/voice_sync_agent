# VoiceSync Agent — Workflow

**Reasoning: Google Gemini. Speech: ElevenLabs. Actions: Trello.** Each external provider is isolated behind a serverless route. Camera/screen frames stay local until a submitted turn; one compact prior frame may remain in memory for opt-out before/after comparison. Speech recognition is browser-managed.

---

## 1. End-to-end pipeline

```
┌──────────────────── BROWSER (visual frames stay local until step 4) ────────────────────┐
│                                                                                          │
│  ① CAPTURE INPUT                          ② CAPTURE CONTEXT                              │
│  ┌───────────────────┐                    ┌───────────────────────────┐                  │
│  │ Web Speech API    │  transcript        │ getUserMedia  (camera)    │                  │
│  │ or typed text     │ ─────────┐         │ getDisplayMedia (screen)  │                  │
│  └───────────────────┘          │         └────────────┬──────────────┘                  │
│                                 │                      │ live MediaStream → <video>      │
│                                 │                      ▼                                 │
│                                 │         ③ FRAME  current JPEG + local change signature │
│                                 │                      │ optional compact earlier frame  │
│                                 └──────────┬───────────┘                                 │
│                                            ▼                                             │
└────────────────────────────────── POST /api/chat ───────────────────────────────────────┘
                                             │  { message, image, previousImage?, source, history[8] }
                                             ▼
                    ┌────────────────────────────────────────────┐
                    │ ④ REASON — api/chat.js                     │
                    │    validate → build Gemini `contents`      │
                    │    systemInstruction = safety + TTS style  │
                    │    thinkingLevel low · maxOutputTokens 1024 │
                    │    POST generativelanguage.googleapis.com    │
                    │         models/gemini-3.8-flash              │
                    │         :generateContent                   │
                    │    header auth: x-goog-api-key             │
                    │    1 retry on 429/5xx · 18s per attempt    │
                    └────────────────────┬───────────────────────┘
                                         │ { reply, mode, usedImage, usage }
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  ⑤ RENDER   DOM nodes + textContent (never innerHTML)                                    │
│  ⑥ SPEAK    POST /api/tts ──► ElevenLabs text-to-speech ──► audio/mpeg ──► <audio>        │
│                   └─ { enabled:false } ─► browser speechSynthesis fallback                │
│  ⑦ ACT      proposal ─► editable exact-scope modal ─► approval ─► POST /api/trello       │
│  ⑧ VERIFY   GET created card from Trello ─► verified URL in conversation/history        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

The included write tool is a real Trello integration when configured. After approval, `/api/trello` performs an idempotency lookup, creates the card, reads it back, and contract-checks the title, list, open state, and operation marker before returning a verified URL. Without all three required Trello values, the modal explicitly switches to a local-only fallback and never claims an external system changed.

The Web Speech API is controlled by the browser. Its implementation may send microphone audio to the browser vendor's speech service; VoiceSync itself receives the resulting transcript, not the raw audio stream.

---

## 2. Provider split

| Stage | Provider | Route | Env | If the key is missing |
|---|---|---|---|---|
| Speech → text | Browser Web Speech API | — | none | Button explains it; user types instead |
| Reasoning + vision | **Google Gemini** | `POST /api/chat` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `GEMINI_THINKING_LEVEL` | Deterministic demo replies, same JSON shape |
| Text → speech | **ElevenLabs** | `POST /api/tts` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | `{enabled:false}` → browser `speechSynthesis` |
| Approved task execution | **Trello** | `POST /api/trello` | `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, `TRELLO_LIST_ID` | Clearly labelled local-only fallback |
| Status | — | `GET /api/health` | — | Reports each provider independently without IDs/secrets |

All credentials stay server-side. The browser never sees them.

---

## 3. Request / response contracts

### `POST /api/chat`

```jsonc
// request
{
  "message": "What changed?",               // required, ≤ 4000 chars
  "image":   "data:image/jpeg;base64,...",  // optional current frame, ≤ 3 MB decoded
  "previousImage": "data:image/jpeg;base64,...", // optional compact prior frame, ≤ 400 KB
  "visualContext": { "capturedAt": "...", "changeScore": 0.18 },
  "source":  "Screen",                      // "" | "Camera" | "Screen" | "Document"
  "history": [{ "role": "user", "text": "..." }]  // last 8 turns, trimmed server-side
}

// response
{
  "reply": "You're looking at a build log with three failing tests...",
  "mode": "live",                 // "live" | "demo"
  "provider": "google-gemini",
  "model": "gemini-3.8-flash",
  "source": "Screen",             // echoed back only if it was Camera | Screen | Document, else null
  "usedImage": true,              // drives the "Gemini vision" pill in the UI
  "usedPreviousImage": true,      // true only when Gemini received both frames
  "imageRejected": false,         // true if the current frame was malformed/oversized
  "previousImageRejected": false,
  "visualChange": 0.18,           // bounded browser-side hint; Gemini still compares images
  "capturedAt": "2026-10-02T10:00:00.000Z",
  "truncated": false,             // true when Gemini stopped at MAX_TOKENS
  "action": {                     // null, or an unexecuted Gemini function-call proposal
    "type": "create_session_task",
    "title": "Review deployment logs",
    "details": "Inspect the visible errors and record the next fix."
  },
  "usage": { "promptTokenCount": 312, "candidatesTokenCount": 88 }
}
```

Demo mode returns every one of those keys (`model` and `usage` are `null`), so
the client never needs to branch on which mode it is talking to. Gemini receives
a single `create_follow_up_task` function declaration. A function call is returned
as an `action` proposal only; the API never executes it. The browser validates the
proposal, displays editable exact fields plus the destination, and requires approval before either the verified Trello write or the clearly labelled local fallback.

| Status | When |
|---|---|
| `400` | blank message |
| `405` | wrong method |
| `413` | message over 4000 chars |
| `429` | Gemini rate-limited the key (already retried once) |
| `502` | Gemini failed, or returned a candidate with no text |
| `503` | Gemini reported the model as overloaded |
| `504` | no answer within the per-attempt deadline |

Error bodies carry `detail` and, for upstream failures, `upstreamStatus` — the
console prints the real reason instead of pretending to be offline.

**Thinking settings.** Gemini 3.8 uses `thinkingConfig.thinkingLevel`, not the
legacy numeric `thinkingBudget`. `api/chat.js` sends `thinkingLevel: low` by
default, plus `maxOutputTokens: 1024`, and omits the legacy `temperature` and
`topP` sampling fields that Gemini 3.8 rejects. The 2.5 compatibility path still
uses `GEMINI_THINKING_BUDGET` when a 2.5 model is selected. Any upstream `400`
that names the thinking setting gets one retry without it.

### `POST /api/trello`

This route is called only after the browser's approval modal confirms the final edited fields.

```jsonc
// request
{
  "title": "Review deployment logs",
  "details": "Inspect the visible errors and apply the proposed fix.",
  "operationId": "d6d1..." // generated once per proposal and reused on retry
}

// successful response after Trello read-back
{
  "ok": true,
  "verified": true,
  "reused": false,
  "receipt": {
    "provider": "trello",
    "id": "trello-card-id",
    "title": "Review deployment logs",
    "url": "https://trello.com/c/...",
    "operationId": "d6d1...",
    "verifiedAt": "2026-10-02T10:00:00.000Z"
  }
}
```

The executor first searches the configured list for the operation marker. It creates only when no match exists, then performs a `GET /cards/{id}` read-back and checks the approved title, configured list, open state, and marker. A card that was created but fails read-back is returned as `created: true, verified: false`; the client records that warning and does not encourage a blind retry. Trello's API key/token are carried in its supported OAuth `Authorization` header, never in the URL.

### `POST /api/tts`

`{ "text": "..." }` → `audio/mpeg` bytes, **or** `200 {"enabled":false,"reason":"..."}`.

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
headers: xi-api-key · content-type: application/json · accept: audio/mpeg
body:    { text, model_id, voice_settings }
```

Speech never returns a hard error — a TTS outage must not break the conversation.
A 429 or 5xx is retried once and then soft-disabled, so the browser voice takes
over. Text longer than 1500 chars is trimmed on a sentence boundary rather than
rejected (a latency cap, not an API limit).

### `GET /api/health`

```json
{
  "ok": true,
  "mode": "live",
  "reasoning": { "provider": "google-gemini", "configured": true, "model": "gemini-3.8-flash", "vision": true, "thinkingBudget": null, "thinkingLevel": "low" },
  "speech":    { "provider": "elevenlabs",    "configured": true, "model": "eleven_multilingual_v2", "voiceId": "21m00Tcm4TlvDq8ikWAM" },
  "tools":     { "trello": { "provider": "trello", "configured": true, "destination": "VoiceSync Follow-ups", "approvalRequired": true, "readBackVerification": true } }
}
```

`GET`/`HEAD` only; anything else is `405`.

The console calls this on load and shows provider configuration in the top-right badge. A live turn is still the authority on whether a configured key is valid.

---

## 4. Safety & privacy rules enforced in code

| Rule | Where |
|---|---|
| Camera/screen media is captured only after an explicit browser permission prompt | `getMedia()` |
| Browser-managed speech recognition is disclosed separately; VoiceSync sends the transcript | microphone handler + Help panel |
| **Clear** stops every visual track *and* nulls `video.srcObject`, so no frozen frame can be sent later | `clearContext()` |
| Browser-side "Stop sharing" flips the UI back to no-context via `track.onended` | `getMedia()` |
| Frames are sent only for the turn the user submits — no background streaming | `snapshotForTurn()` called inside `respond()` |
| A compact previous frame is memory-only, opt-out, selectively attached, and removed by Clear | `previousFrame` + visual comparison setting |
| Model output is rendered with `textContent`, so a reply can't inject markup | `addMessage()` |
| Provider credentials are server-side only, sent as headers, never in URLs | `api/_gemini.js`, `api/tts.js`, `api/trello.js` |
| Gemini is instructed never to claim it sees or compares an image that wasn't attached | `SYSTEM` in `api/chat.js` |
| A write shows editable exact fields and destination, then halts at the human approval modal | `openApproval()` |
| Trello retries are idempotent across instances through an operation marker lookup | `markerFor()` + list preflight |
| Approved external writes are read back from Trello before receiving a verified URL | `cardMatches()` in `api/trello.js` |
| Only action receipts/settings persist; conversation text and visual frames do not | `persistReceipts()` / `persistSettings()` |
| Current image payloads are capped at 3 MB and prior images at 400 KB decoded | `imagePart()` |
| Oversized frames are re-encoded at lower quality client-side instead of being dropped | `snapshotForTurn()` |
| The context label is whitelisted to `Camera`/`Screen`/`Document`, so no client string reaches the prompt | `SOURCES` in `api/chat.js` |
| Thought parts (`thought: true`) are stripped, so internal reasoning is never read aloud | `firstText()` |
| The dev server serves front-end files only — `.env`, `api/`, `test/` and config are unreachable | `isPublic()` |
| A server-side failure shows the real error instead of a fabricated "offline" answer | `respond()` |
| The context badge reads LIVE only while a track is actually running | `setLiveBadge()` |

---

## 5. Files

```
index.html        console markup (stable element IDs — app.js binds to these)
styles.css        dark console theme, responsive at 900px / 620px
app.js            the 6-stage capture → frame → reason → speak → approve → verify pipeline
api/_gemini.js    shared Gemini client: auth, timeout, parsing, image parts
api/chat.js       stage ④ reasoning  (Gemini)
api/tts.js        stage ⑥ speech     (ElevenLabs)
api/trello.js     stages ⑦–⑧ approved execution + idempotency + read-back verification
api/health.js     provider/tool status without secret or list-ID exposure
dev-server.mjs    local host for static + /api, loads .env, no Vercel CLI needed
test/smoke.mjs         113 checks: static host, UI contracts, multimodal/action paths, failures
test/mock-upstreams.mjs Gemini + ElevenLabs + Trello test doubles
AUDIT.md          PS-05 capability matrix and explicit prototype boundaries
```

`vercel.json` gives the reasoning/speech routes 60 seconds and the Trello executor 30 seconds, leaving each route enough time to return an explicit timeout or verification result.

---

## 6. Running it

```bash
cp .env.example .env     # add Gemini; optionally ElevenLabs + all three Trello values
npm run dev              # http://localhost:4173
npm run smoke            # 113 route, UI, multimodal, action, security and failure checks
```

`vercel dev` / `vercel --prod` also work unchanged — `dev-server.mjs` only mirrors
what Vercel does with the same handler files.

---

## 7. Production hardening path

1. **Streaming** — swap `:generateContent` for `:streamGenerateContent` and pipe SSE to the client, then feed ElevenLabs' streaming endpoint sentence by sentence to cut time-to-first-audio.
2. **Scene-triggered vision** — promote the current local change detector into an opt-in watcher that submits on meaningful scene changes rather than on a fixed high-frequency timer.
3. **Server-side STT** — replace Web Speech with Whisper or Gemini audio input for cross-browser support.
4. **Rate limiting** — per-IP or per-session quota in front of `/api/chat` and `/api/trello`.
5. **Per-user OAuth / MCP tools** — replace the deployment-wide Trello token with user OAuth and add calendar, issue-tracker, or MCP adapters while preserving the existing exact-scope approval, idempotency, and post-write verification boundary.
