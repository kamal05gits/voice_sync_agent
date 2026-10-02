/**
 * Shared Google Gemini helpers.
 *
 * Gemini is the ONLY reasoning provider in VoiceSync:
 *   text + vision -> models/<GEMINI_MODEL>:generateContent
 *
 * Speech synthesis is handled separately by ElevenLabs in api/tts.js.
 *
 * Underscore prefix matters: Vercel skips `api/_*` when it turns files into
 * functions, so this stays a plain shared module and not a broken route.
 */

const DEFAULT_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

/** Overridable so tests (and corporate proxies) can point at another host. */
export function apiRoot() {
  return (process.env.GEMINI_API_BASE || DEFAULT_API_ROOT).replace(/\/+$/, '');
}

/** GOOGLE_API_KEY is accepted as an alias so either common name works. */
export function apiKey() {
  // Vercel injects environment variables as strings. Trim accidental spaces
  // or newlines so a copied key is not treated as configured but rejected by
  // Gemini. Keep GOOGLE_API_KEY as a backwards-compatible alias.
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

export function textModel() {
  const configured = (process.env.GEMINI_MODEL || '').trim();
  return configured || DEFAULT_MODEL;
}

/**
 * A lighter model used only when the primary model reports that its serving
 * pool is overloaded. Set to an empty string to disable failover.
 *
 * Keep the legacy 2.5 lite value out of the request path. Google now directs
 * new users to 3.5 Flash-Lite, so an old Vercel environment variable should
 * not reintroduce the model that caused the original failure.
 */
export function fallbackModel() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'GEMINI_FALLBACK_MODEL')) {
    const configured = (process.env.GEMINI_FALLBACK_MODEL || '').trim();
    if (!configured) return '';
    if (configured === 'gemini-2.5-flash-lite') return DEFAULT_FALLBACK_MODEL;
    return configured;
  }
  return DEFAULT_FALLBACK_MODEL;
}

/**
 * Keep thinking settings compatible with both the legacy 2.5 API and Gemini 3.
 * Gemini 3 models use the string-valued `thinkingLevel` field; sending the old
 * numeric `thinkingBudget` field makes a 3.x request fail with HTTP 400.
 *
 *   Gemini 2.5: GEMINI_THINKING_BUDGET=0 (default), -1, or a fixed token count
 *   Gemini 3:   GEMINI_THINKING_LEVEL=low (default), medium, or high
 *
 * VoiceSync is a low-latency spoken assistant, so 3.x defaults to low thinking.
 * 3.5 Flash-Lite also supports `minimal`, which is its lowest setting.
 */
export function thinkingConfigFor(model) {
  if (/^gemini-2\.5-/.test(model)) {
    const raw = process.env.GEMINI_THINKING_BUDGET;
    const budget = raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(budget)) return { thinkingBudget: 0 };

    // flash-lite does not accept a 0 budget as "off" the same way flash does.
    if (/flash-lite/.test(model) && budget === 0) return null;
    return { thinkingBudget: Math.trunc(budget) };
  }

  if (!/^gemini-3(?:\.|$)/.test(model)) return null;

  const requested = (process.env.GEMINI_THINKING_LEVEL || '').trim().toLowerCase();
  const isLite = /flash-lite/.test(model);
  const supportsMinimal = isLite || /^gemini-3\.5-flash$/.test(model);
  const allowed = new Set(supportsMinimal
    ? ['minimal', 'low', 'medium', 'high']
    : ['low', 'medium', 'high']);
  const level = allowed.has(requested) ? requested : (isLite ? 'minimal' : 'low');
  return { thinkingLevel: level };
}

/** Transient upstream conditions worth one more attempt. */
export function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Map an upstream status onto the status this API returns, so callers can tell
 * "you are rate limited" apart from "Gemini is down" apart from "we timed out".
 */
export function clientStatus(upstream) {
  if (upstream === 429) return 429; // quota / rate limit
  if (upstream === 503) return 503; // model overloaded
  if (upstream === 504) return 504; // our own deadline
  if (upstream === 401 || upstream === 403) return 500; // our key is wrong: server misconfig
  return 502; // anything else is an upstream failure
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `Retry-After` in seconds, clamped so a hostile value can't stall a function. */
function retryAfterMs(response, fallback) {
  const header = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(header) || header <= 0) return fallback;
  return Math.min(header * 1000, 5000);
}

/**
 * POST to a Gemini model endpoint with a hard per-attempt timeout and one
 * retry on transient failures. Never throws — always resolves to a result.
 *
 * Worst case wall clock stays under the 60s function budget in vercel.json:
 *   2 attempts x 18s + 5s backoff.
 */
export async function callGemini(model, body, options = {}) {
  const envTimeout = Number(process.env.GEMINI_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 18000);
  const attempts = options.attempts ?? 2;
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 401, data: { error: { message: 'GEMINI_API_KEY is not configured' } } };
  }

  const url = `${apiRoot()}/models/${encodeURIComponent(model)}:generateContent`;
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        // Header auth keeps the key out of URLs, logs and proxy traces.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok) return { ok: true, status: response.status, data, attempts: attempt };

      last = { ok: false, status: response.status, data, attempts: attempt };
      if (attempt < attempts && isRetryable(response.status)) {
        await sleep(retryAfterMs(response, 600 * attempt));
        continue;
      }
      return last;
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      last = {
        ok: false,
        status: aborted ? 504 : 502,
        data: { error: { message: aborted ? 'Gemini request timed out' : 'Could not reach Gemini' } },
        attempts: attempt
      };
      // A timeout already burned the budget; only retry genuine network blips.
      if (attempt < attempts && !aborted) {
        await sleep(600 * attempt);
        continue;
      }
      return last;
    } finally {
      clearTimeout(timer);
    }
  }

  return last;
}

/**
 * Concatenate the visible text parts of the first candidate.
 * Thought summaries (`thought: true`) are internal reasoning and are skipped so
 * they can never be read aloud as if they were the answer.
 */
export function firstText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(part => part && part.thought !== true)
    .map(part => part.text || '')
    .join('')
    .trim();
}

/** Why Gemini stopped (SAFETY, MAX_TOKENS, a block reason...) so errors stay honest. */
export function finishReason(data) {
  return data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || null;
}

/** Convert a `data:image/...;base64,...` URL into a Gemini inlineData part. */
export function imagePart(dataUrl, maxBytes = 3_000_000) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;

  const data = match[2].replace(/\s+/g, '');
  // Base64 inflates by 4/3. 3 MB decoded ≈ 4 MB on the wire, which keeps the
  // whole JSON body under Vercel's 4.5 MB request ceiling.
  if (data.length * 0.75 > maxBytes) return null;

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  return { inlineData: { mimeType, data } };
}
