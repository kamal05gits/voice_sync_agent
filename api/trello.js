/**
 * Approval-gated Trello executor.
 *
 * This route is intentionally separate from Gemini. The model may only propose
 * a task; the browser calls this executor after the user has reviewed and
 * approved the exact card title and description.
 *
 * Safety properties:
 * - Trello credentials never reach the browser or URL query string.
 * - A client-generated operation id is written into the card description.
 * - Before creating, the target list is checked for that marker, making a
 *   retry idempotent even if it lands on another serverless instance.
 * - The created card is read back from Trello and contract-checked before the
 *   API reports it as verified.
 */

const DEFAULT_API_ROOT = 'https://api.trello.com/1';
const MAX_TITLE = 120;
const MAX_DETAILS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_RE = /^[A-Za-z0-9_-]{8,80}$/;

// Warm-instance shortcut. Cross-instance idempotency is handled by the marker
// lookup in the Trello list, so this map is only a latency optimization.
const completed = new Map();

export function trelloConfig() {
  return {
    apiKey: (process.env.TRELLO_API_KEY || '').trim(),
    token: (process.env.TRELLO_API_TOKEN || '').trim(),
    listId: (process.env.TRELLO_LIST_ID || '').trim(),
    listName: (process.env.TRELLO_LIST_NAME || '').trim(),
    apiRoot: (process.env.TRELLO_API_BASE || DEFAULT_API_ROOT).replace(/\/+$/, '')
  };
}

export function trelloConfigured() {
  const config = trelloConfig();
  return Boolean(config.apiKey && config.token && config.listId);
}

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function detailsText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_DETAILS);
}

function authHeader(config) {
  // Trello explicitly supports this OAuth header format for API key + token
  // authentication. Keeping credentials in a header prevents them appearing
  // in request URLs, access logs, or error screenshots.
  const escape = value => value.replace(/(["\\])/g, '\\$1');
  return `OAuth oauth_consumer_key="${escape(config.apiKey)}", oauth_token="${escape(config.token)}"`;
}

async function trelloFetch(config, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.apiRoot}/${path.replace(/^\/+/, '')}`, {
      ...options,
      headers: {
        accept: 'application/json',
        authorization: authHeader(config),
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    // Trello sometimes returns plain-text errors (for example an invalid key,
    // token, or list ID). Preserve that text instead of replacing it with a
    // generic idempotency failure so deployment configuration is diagnosable.
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { message: raw.trim().slice(0, 240) };
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === 'AbortError' ? 504 : 502,
      data: { message: error?.name === 'AbortError' ? 'Trello request timed out' : 'Could not reach Trello' }
    };
  } finally {
    clearTimeout(timer);
  }
}

function markerFor(operationId) {
  return `VoiceSync operation: ${operationId}`;
}

function safeTrelloUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    const allowedHost = parsed.hostname === 'trello.com' || parsed.hostname.endsWith('.trello.com');
    return parsed.protocol === 'https:' && allowedHost ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function cardReceipt(card, operationId, reused = false) {
  return {
    provider: 'trello',
    id: card.id,
    title: card.name,
    url: safeTrelloUrl(card.shortUrl || card.url),
    operationId,
    reused,
    verifiedAt: new Date().toISOString()
  };
}

function cardMatches(card, { title, details, marker, listId }) {
  return Boolean(
    card &&
    typeof card.id === 'string' && card.id &&
    card.name === title &&
    card.idList === listId &&
    card.closed !== true &&
    typeof card.desc === 'string' &&
    card.desc.startsWith(`${details}\n\n---\n`) &&
    card.desc.includes(marker)
  );
}

function remember(operationId, payload, approved) {
  completed.set(operationId, { payload, ...approved });
  if (completed.size > 100) completed.delete(completed.keys().next().value);
  return payload;
}

function clientStatus(upstream) {
  if (upstream === 429) return 429;
  if (upstream === 504) return 504;
  if (upstream === 401 || upstream === 403) return 502;
  return 502;
}

function upstreamMessage(result, fallback) {
  const value = result?.data?.message || result?.data?.error;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 240);
  if (result?.status === 401 || result?.status === 403) {
    return 'Trello authentication failed. Check that the API key and token belong together and that the token has read and write access';
  }
  if (result?.status === 404) {
    return 'The configured Trello list was not found or is not accessible to this token. Check TRELLO_LIST_ID';
  }
  if (result?.status === 429) return 'Trello rate limit reached. Wait briefly and retry with the same operation';
  return fallback;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const title = clean(req.body?.title, MAX_TITLE);
  const details = detailsText(req.body?.details);
  const operationId = clean(req.body?.operationId, 80);

  if (!title || !details || !OPERATION_RE.test(operationId)) {
    return res.status(400).json({
      error: 'A title, details, and valid operationId are required',
      limits: { title: MAX_TITLE, details: MAX_DETAILS }
    });
  }

  const config = trelloConfig();
  if (!config.apiKey || !config.token || !config.listId) {
    return res.status(503).json({
      error: 'Trello is not configured',
      detail: 'Set TRELLO_API_KEY, TRELLO_API_TOKEN, and TRELLO_LIST_ID on the server.'
    });
  }

  const cached = completed.get(operationId);
  if (cached) {
    if (cached.title !== title || cached.details !== details) {
      return res.status(409).json({
        error: 'This operation already completed with different approved fields',
        created: true,
        verified: false,
        receipt: { ...cached.payload.receipt, reused: true }
      });
    }
    return res.status(200).json({
      ...cached.payload,
      reused: true,
      receipt: { ...cached.payload.receipt, reused: true }
    });
  }

  const marker = markerFor(operationId);
  const contract = { title, details, marker, listId: config.listId };

  // Durable idempotency check: a retry must find an earlier successful card
  // before it is allowed to create another one.
  const existingResult = await trelloFetch(
    config,
    `lists/${encodeURIComponent(config.listId)}/cards?fields=id,name,desc,idList,shortUrl,url,closed&filter=open&limit=1000`
  );
  if (!existingResult.ok) {
    return res.status(clientStatus(existingResult.status)).json({
      error: 'Unable to check Trello for an existing operation',
      detail: upstreamMessage(existingResult, 'Trello idempotency check failed'),
      upstreamStatus: existingResult.status
    });
  }

  const existing = Array.isArray(existingResult.data)
    ? existingResult.data.find(card => typeof card?.desc === 'string' && card.desc.includes(marker))
    : null;
  if (existing) {
    if (!cardMatches(existing, contract)) {
      // The operation id already exists but its fields no longer match this
      // request. Never create a second card: surface the conflict for review.
      return res.status(409).json({
        error: 'This operation already created a different Trello card',
        detail: 'Review the existing card instead of retrying with edited fields.',
        created: true,
        verified: false,
        receipt: cardReceipt(existing, operationId, true)
      });
    }
    const payload = {
      ok: true,
      verified: true,
      reused: true,
      receipt: cardReceipt(existing, operationId, true)
    };
    return res.status(200).json(remember(operationId, payload, { title, details }));
  }

  const description = `${details}\n\n---\nCreated through VoiceSync after explicit approval.\n${marker}`;
  const form = new URLSearchParams({
    idList: config.listId,
    name: title,
    desc: description,
    pos: 'top'
  });
  const created = await trelloFetch(config, 'cards', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: form.toString()
  });

  if (!created.ok || typeof created.data?.id !== 'string') {
    return res.status(clientStatus(created.status)).json({
      error: 'Trello card creation failed',
      detail: upstreamMessage(created, 'Trello did not return a card'),
      upstreamStatus: created.status
    });
  }

  // Do not trust a successful POST alone. Read the card back and verify the
  // exact destination, title, marker, and open status.
  const verifiedResult = await trelloFetch(
    config,
    `cards/${encodeURIComponent(created.data.id)}?fields=id,name,desc,idList,shortUrl,url,closed`
  );

  const receiptCard = verifiedResult.data || created.data;
  if (!verifiedResult.ok || !cardMatches(verifiedResult.data, contract)) {
    return res.status(502).json({
      error: 'The Trello card was created but could not be verified',
      detail: upstreamMessage(verifiedResult, 'Read-back did not match the approved write'),
      created: true,
      verified: false,
      receipt: cardReceipt(receiptCard, operationId, false)
    });
  }

  const payload = {
    ok: true,
    verified: true,
    reused: false,
    receipt: cardReceipt(verifiedResult.data, operationId, false)
  };
  return res.status(200).json(remember(operationId, payload, { title, details }));
}
