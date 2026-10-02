/**
 * VoiceSync Agent — client workflow.
 *
 * Pipeline, in order:
 *   1. CAPTURE   voice (Web Speech) or typed text  +  optional camera/screen video
 *   2. FRAME     capture a JPEG and, when useful, a small prior comparison frame
 *   3. REASON    POST /api/chat  -> Google Gemini (text + vision)
 *   4. SPEAK     POST /api/tts   -> ElevenLabs, with browser speechSynthesis as fallback
 *   5. APPROVE   exact Trello/session writes stop at an editable human gate
 *   6. VERIFY    read an approved Trello card back before recording its receipt
 *
 * Visual frames leave the browser only in step 3 for a submitted turn. Speech
 * recognition is browser-managed and may use the browser vendor's service.
 */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const els = {
  messages: $('#messages'),
  prompt: $('#prompt'),
  toast: $('#toast'),
  video: $('#video'),
  documentPreview: $('#documentPreview'),
  documentInput: $('#documentInput'),
  latency: $('#latency'),
  sendBtn: $('#sendBtn'),
  emptyPreview: $('.empty-preview'),
  overlay: $('#previewOverlay'),
  sourceName: $('#sourceName'),
  contextStatus: $('#contextStatus'),
  micLabel: $('#micLabel'),
  liveBadge: $('#liveBadge'),
  liveBadgeText: $('#liveBadgeText'),
  modal: $('#approvalModal'),
  approvalActionTitle: $('#approvalActionTitle'),
  approvalActionDetails: $('#approvalActionDetails'),
  approvalTarget: $('#approvalTarget'),
  approvalProgress: $('#approvalProgress'),
  infoModal: $('#infoModal'),
  infoTitle: $('#infoTitle'),
  infoContent: $('#infoContent')
};

/** Single source of truth for the session. */
const state = {
  stream: null,
  source: '', // '' | 'Camera' | 'Screen' | 'Document'
  uploadedImage: '',
  uploadedSignature: null,
  uploadedComparisonImage: '',
  previousFrame: null, // compact previous submitted frame; never persisted
  visualComparisonEnabled: true,
  recognition: null,
  listeningSession: false,
  continuousListening: true,
  recognitionRestartTimer: null,
  busy: false,
  history: [], // [{ role: 'user' | 'agent', text }]
  tasks: [], // approval-gated receipts restored from private browser storage
  diagnostics: [], // per-turn latency/outcome metadata; never raw microphone audio
  pendingAction: null,
  actionBusy: false,
  trelloConfigured: false,
  trelloDestination: '',
  speechEnabled: true,
  lastSpokenText: '',
  language: 'en-IN'
};

const MAX_SESSION_TURNS = 100;
const MAX_CONTEXT_TURNS = 8;
const RECEIPT_STORAGE_KEY = 'voicesync.action-receipts.v1';
const SETTINGS_STORAGE_KEY = 'voicesync.settings.v1';

function storageRead(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function storageWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked */ }
}

function safeTrelloUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    const allowedHost = parsed.hostname === 'trello.com' || parsed.hostname.endsWith('.trello.com');
    return parsed.protocol === 'https:' && allowedHost ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function restoreLocalState() {
  const storedTasks = storageRead(RECEIPT_STORAGE_KEY, []);
  if (Array.isArray(storedTasks)) {
    state.tasks = storedTasks.filter(task =>
      task && typeof task.id === 'string' && typeof task.title === 'string' &&
      typeof task.createdAt === 'string' && ['trello', 'session'].includes(task.target)
    ).slice(-50).map(task => ({ ...task, externalUrl: safeTrelloUrl(task.externalUrl) }));
  }

  const settings = storageRead(SETTINGS_STORAGE_KEY, {});
  if (settings && typeof settings === 'object') {
    if (typeof settings.speechEnabled === 'boolean') state.speechEnabled = settings.speechEnabled;
    if (typeof settings.continuousListening === 'boolean') state.continuousListening = settings.continuousListening;
    if (typeof settings.visualComparisonEnabled === 'boolean') state.visualComparisonEnabled = settings.visualComparisonEnabled;
    if (['en-IN', 'en-US', 'hi-IN', 'ta-IN'].includes(settings.language)) state.language = settings.language;
  }
}

function persistReceipts() {
  // Only approved action receipts persist. Conversation text, visual frames,
  // transcripts, and diagnostics remain memory-only and vanish on reset/close.
  storageWrite(RECEIPT_STORAGE_KEY, state.tasks.slice(-50));
}

function persistSettings() {
  storageWrite(SETTINGS_STORAGE_KEY, {
    speechEnabled: state.speechEnabled,
    continuousListening: state.continuousListening,
    visualComparisonEnabled: state.visualComparisonEnabled,
    language: state.language
  });
}

restoreLocalState();

/* ------------------------------------------------------------------ */
/* UI primitives                                                       */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function notify(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent, never innerHTML
  return node;
}

/**
 * Render a chat bubble. Built with DOM nodes + textContent so that model
 * output or spoken transcripts can never inject markup into the page.
 */
function addMessage(text, who = 'user', pill = '') {
  const row = el('div', `message ${who}`);
  row.style.marginTop = '22px';

  const avatar = el('div', 'message-avatar', who === 'user' ? 'KP' : '⌁');
  if (who === 'user') {
    avatar.style.background = '#244661';
    avatar.style.border = '0';
    avatar.style.color = '#b8e7ed';
  }

  const body = el('div');
  const meta = el('div', 'message-meta');
  meta.append(el('b', null, who === 'user' ? 'You' : 'VoiceSync'), el('span', null, 'now'));
  body.append(meta, el('p', null, text));
  if (pill) body.append(el('div', 'context-pill', pill));

  row.append(avatar, body);
  els.messages.append(row);
  els.messages.scrollTop = els.messages.scrollHeight;
  return row;
}

function setThinking(on) {
  state.busy = on;
  els.sendBtn.disabled = on;
  els.sendBtn.style.opacity = on ? '.5' : '1';
}

function remember(role, text) {
  state.history.push({ role, text });
  if (state.history.length > MAX_SESSION_TURNS) {
    state.history.splice(0, state.history.length - MAX_SESSION_TURNS);
  }
}

/* ------------------------------------------------------------------ */
/* 2. FRAME — capture one still from the live video                    */
/* ------------------------------------------------------------------ */

/**
 * The server rejects an inline image over 3 MB decoded, and Vercel rejects the
 * whole request over 4.5 MB, so cap the encoded data URL well under both
 * rather than letting a 4K screen share silently lose its frame.
 */
const MAX_FRAME_CHARS = 3_200_000;

function encode(canvas, quality) {
  return canvas.toDataURL('image/jpeg', quality);
}

function frameSignature(canvas) {
  const sample = document.createElement('canvas');
  sample.width = 16;
  sample.height = 10;
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const signature = [];
  for (let index = 0; index < pixels.length; index += 4) {
    signature.push(Math.round((pixels[index] * .299) + (pixels[index + 1] * .587) + (pixels[index + 2] * .114)));
  }
  return signature;
}

function compactComparisonFrame(canvas) {
  const compact = document.createElement('canvas');
  compact.width = Math.min(canvas.width, 480);
  compact.height = Math.max(1, Math.round(compact.width * canvas.height / canvas.width));
  compact.getContext('2d').drawImage(canvas, 0, 0, compact.width, compact.height);
  return compact.toDataURL('image/jpeg', .55);
}

function signatureDifference(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length || !before.length) return null;
  const total = before.reduce((sum, value, index) => sum + Math.abs(value - after[index]), 0);
  return Math.min(1, total / (before.length * 255));
}

function wantsVisualComparison(text) {
  return /\b(change|changed|different|difference|before|after|updated|happen|progress)\b/i.test(text);
}

/**
 * Capture the current frame and prepare a small, memory-only comparison
 * baseline. The earlier frame is attached only when a change is detected or
 * the user explicitly asks for a comparison. Nothing is uploaded on a timer.
 */
function snapshotForTurn(text) {
  let image = '';
  let signature = null;
  let comparisonImage = '';

  if (state.source === 'Document' && state.uploadedImage) {
    image = state.uploadedImage;
    signature = state.uploadedSignature;
    comparisonImage = state.uploadedComparisonImage;
  } else {
    // Guard on `state.source` too: after Clear, the <video> can still hold a
    // frozen last frame, and sending that would leak context the user revoked.
    const track = state.stream?.getVideoTracks?.()[0];
    if (!state.source || !els.video.srcObject || !els.video.videoWidth || track?.readyState !== 'live') return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(els.video.videoWidth, 1280);
    canvas.height = Math.round((canvas.width * els.video.videoHeight) / els.video.videoWidth);
    canvas.getContext('2d').drawImage(els.video, 0, 0, canvas.width, canvas.height);

    // Step the quality down before giving up — a softer frame beats no frame.
    for (const quality of [0.72, 0.55, 0.4]) {
      const candidate = encode(canvas, quality);
      if (candidate.length <= MAX_FRAME_CHARS) {
        image = candidate;
        break;
      }
    }
    if (!image) return null;
    signature = frameSignature(canvas);
    comparisonImage = compactComparisonFrame(canvas);
  }

  const capturedAt = new Date().toISOString();
  const previous = state.visualComparisonEnabled && state.previousFrame?.source === state.source
    ? state.previousFrame
    : null;
  const changeScore = previous ? signatureDifference(previous.signature, signature) : null;
  const includePrevious = Boolean(previous && previous.image && (wantsVisualComparison(text) || changeScore >= .012));

  return {
    image,
    previousImage: includePrevious ? previous.image : null,
    visualContext: {
      capturedAt,
      previousCapturedAt: includePrevious ? previous.capturedAt : null,
      changeScore: includePrevious ? changeScore : null,
      changedSinceLastTurn: changeScore == null ? null : changeScore >= .025
    },
    baseline: state.visualComparisonEnabled && comparisonImage && signature
      ? { source: state.source, image: comparisonImage, signature, capturedAt }
      : null
  };
}

function commitVisualFrame(frame) {
  if (!frame?.baseline) return;
  state.previousFrame = frame.baseline;
  const score = frame.visualContext?.changeScore;
  if (score == null) {
    els.contextStatus.textContent = `${state.source} submitted · comparison baseline saved`;
  } else {
    const percent = Math.round(score * 100);
    els.contextStatus.textContent = `${state.source} submitted · ${percent}% visual change from prior turn`;
  }
}

/* ------------------------------------------------------------------ */
/* 4. SPEAK — ElevenLabs, falling back to the browser voice            */
/* ------------------------------------------------------------------ */

let currentAudio = null;
let currentAudioUrl = '';
let speechController = null;
let speechRun = 0;

/** Cancel audio, browser TTS, and an in-flight ElevenLabs request (barge-in). */
function stopSpeaking() {
  speechRun++;
  speechController?.abort();
  speechController = null;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.removeAttribute('src');
    currentAudio.load();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = '';
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function browserSpeak(text, run) {
  if (!state.speechEnabled || run !== speechRun || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = state.language;
  utterance.rate = 1.03;
  window.speechSynthesis.speak(utterance);
}

async function speak(text) {
  // Keep only reply text for an explicit replay. Raw microphone audio is never
  // recorded; replay requests synthesize the text again.
  if (typeof text === 'string' && text.trim()) state.lastSpokenText = text.trim();
  // A new reply owns the audio channel; an older fetch must never start later.
  stopSpeaking();
  if (!state.speechEnabled || typeof text !== 'string' || !text.trim()) return;

  const run = speechRun;
  const controller = new AbortController();
  speechController = controller;

  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });

    if (run !== speechRun) return;
    const type = response.headers.get('content-type') || '';
    if (response.ok && type.includes('audio')) {
      const url = URL.createObjectURL(await response.blob());
      if (run !== speechRun) {
        URL.revokeObjectURL(url);
        return;
      }

      const audio = new Audio(url);
      currentAudio = audio;
      currentAudioUrl = url;
      audio.onended = () => {
        if (currentAudio === audio) {
          currentAudio = null;
          URL.revokeObjectURL(url);
          currentAudioUrl = '';
        }
      };
      try {
        await audio.play();
      } catch {
        if (currentAudio === audio) {
          currentAudio = null;
          URL.revokeObjectURL(url);
          currentAudioUrl = '';
        }
        browserSpeak(text, run);
      }
      return;
    }
    browserSpeak(text, run); // { enabled:false } → ElevenLabs unavailable
  } catch (error) {
    if (error?.name !== 'AbortError') browserSpeak(text, run);
  } finally {
    if (speechController === controller) speechController = null;
  }
}

/* ------------------------------------------------------------------ */
/* 3. REASON — Gemini via /api/chat                                    */
/* ------------------------------------------------------------------ */

/** Offline answer used only when /api/chat itself is unreachable (static hosting). */
function localFallback(text) {
  const t = text.toLowerCase();
  const lead = state.source
    ? `Your ${state.source.toLowerCase()} is connected, but the Gemini API is unreachable, so I cannot analyse its frame. `
    : 'No visual source is attached, and the Gemini API is unreachable. ';
  if (t.includes('summar')) return lead + 'The local fallback can only confirm that voice, visual capture, and approval controls are available.';
  if (t.includes('see') || t.includes('visible')) {
    return lead + (state.source ? 'Try again when the API is available for real vision analysis.' : 'Connect a camera or screen, then try again when the API is available.');
  }
  return lead + 'You can keep typing, but live reasoning needs the server API.';
}

/** Plain-English reason for an API error, so the UI never has to guess. */
function explain(status, data) {
  if (status === 429) return 'Gemini is rate limiting this key — wait a moment and try again';
  if (status === 503) return 'Gemini is overloaded right now — try again in a few seconds';
  if (status === 504) return 'Gemini took too long to answer';
  if (status === 413) return 'That turn was too large to send';
  return data.detail || data.error || `request failed (${status})`;
}

async function respond(text) {
  const started = performance.now();
  const pending = addMessage('Thinking…', 'agent');
  const turnSource = state.source || 'Text';
  const turnFrame = snapshotForTurn(text);
  let outcome = 'failed';
  let providerMode = 'unknown';
  setThinking(true);

  try {
    let response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: text,
          source: state.source,
          image: turnFrame?.image || null,
          previousImage: turnFrame?.previousImage || null,
          visualContext: turnFrame?.visualContext || null,
          // Exclude the current user turn and send only the context window.
          history: state.history.slice(-(MAX_CONTEXT_TURNS + 1), -1)
        })
      });
    } catch (networkError) {
      // The API is genuinely unreachable (static hosting, offline). This is the
      // one case where answering locally is honest rather than misleading.
      pending.remove();
      const answer = localFallback(text);
      addMessage(answer, 'agent', state.source ? '◉ Local fallback · source connected, not analysed' : '⌁ Local fallback · no API');
      remember('agent', answer);
      notify('Offline demo mode · /api/chat is unreachable');
      outcome = 'fallback';
      providerMode = 'local';
      speak(answer);
      return;
    }

    // A server response proves the submitted frame left the browser; it can now
    // become the memory-only baseline for a later before/after turn.
    commitVisualFrame(turnFrame);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // The server answered, so do NOT invent a reply and read it out as if it
      // came from the model — surface what actually happened.
      pending.remove();
      const reason = explain(response.status, data);
      addMessage(`I could not complete that turn. ${reason}.`, 'agent', '⚠ Gemini request failed');
      notify(reason);
      return;
    }

    if (typeof data.reply !== 'string' || !data.reply.trim()) {
      pending.remove();
      addMessage('I could not complete that turn because the server returned an invalid reply.', 'agent', '⚠ Invalid API response');
      notify('The chat API returned an invalid response');
      return;
    }

    pending.remove();
    const pill = data.mode === 'demo'
      ? (state.source ? '⌁ Demo mode · frame received but not analysed' : '⌁ Demo mode · local reply')
      : data.usedImage
        ? (data.usedPreviousImage
            ? `◉ Gemini vision · ${data.source || 'visual'} before/after comparison`
            : `◉ Gemini vision · ${data.source || 'visual'} frame`)
        : '⌁ Gemini · text context';
    addMessage(data.reply, 'agent', pill);
    remember('agent', data.reply);
    outcome = 'completed';
    providerMode = data.mode || 'live';

    if (data.imageRejected) notify('The captured frame was too large to send — reply used text only');
    if (data.previousImageRejected) notify('The earlier comparison frame was rejected — current frame analysis still completed');
    if (data.truncated) notify('The reply hit the token cap and may be cut short');
    if (data.mode === 'demo') notify('Demo mode · add GEMINI_API_KEY for live Gemini reasoning');

    speak(data.reply);

    // Gemini function calls are proposals only. Validate again at the trust
    // boundary, then show the same exact-scope approval gate as manual actions.
    if (data.action != null) {
      const validAction = data.action?.type === 'create_session_task'
        && typeof data.action.title === 'string' && data.action.title.trim()
        && typeof data.action.details === 'string' && data.action.details.trim();
      if (validAction) {
        openApproval({
          type: 'create_session_task',
          title: data.action.title.trim().slice(0, 120),
          details: data.action.details.trim().slice(0, 600)
        });
      } else {
        notify('Gemini proposed an unsupported action, so nothing was executed');
      }
    }
  } finally {
    setThinking(false);
    const latencyMs = Math.round(performance.now() - started);
    els.latency.textContent = (latencyMs / 1000).toFixed(1) + 's';
    state.diagnostics.push({
      at: new Date().toISOString(),
      latencyMs,
      outcome,
      mode: providerMode,
      source: turnSource,
      transcriptCharacters: text.length
    });
    if (state.diagnostics.length > 100) state.diagnostics.shift();
    queueRecognitionRestart();
  }
}

/* ------------------------------------------------------------------ */
/* 1. CAPTURE — text, voice, camera, screen                            */
/* ------------------------------------------------------------------ */

function send(text = els.prompt.value.trim()) {
  if (!text || state.busy) return;
  const clean = text.trim();
  if (clean.length > 4000) {
    notify('Messages must be 4,000 characters or fewer');
    return;
  }

  stopSpeaking(); // typed or spoken input interrupts the previous reply
  addMessage(clean, 'user');
  remember('user', clean);
  els.prompt.value = '';
  els.prompt.style.height = 'auto';
  respond(clean);
}

els.sendBtn.onclick = () => send();

els.prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

els.prompt.addEventListener('input', () => {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = Math.min(els.prompt.scrollHeight, 100) + 'px';
});

$$('[data-prompt]').forEach(btn => {
  btn.onclick = () => {
    els.prompt.value = btn.dataset.prompt;
    send();
  };
});

/* --- visual context ------------------------------------------------ */

function resetSourceButtons() {
  for (const kind of ['camera', 'screen']) {
    $(`#${kind}Label`).textContent = 'off';
    $(`#${kind}Btn`).classList.remove('active');
  }
  $('#documentLabel').textContent = 'upload';
  $('#documentBtn').classList.remove('active');
}

/** The badge must track reality — "LIVE" with no feed connected is a lie. */
function setLiveBadge(live) {
  els.liveBadge.classList.toggle('idle', !live);
  els.liveBadgeText.textContent = live ? 'LIVE' : 'IDLE';
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(track => {
    track.onended = null; // a replaced source must not tear down its successor
    track.stop();
  });
}

/** Tear the visual context down completely — tracks, element, and state. */
function clearContext({ quiet = false } = {}) {
  stopStream(state.stream);
  state.stream = null;
  state.source = '';
  state.uploadedImage = '';
  state.uploadedSignature = null;
  state.uploadedComparisonImage = '';
  state.previousFrame = null;

  els.video.srcObject = null; // critical: otherwise snapshotForTurn() could send a revoked frame
  els.video.hidden = true;
  els.documentPreview.removeAttribute('src');
  els.documentPreview.hidden = true;
  els.documentInput.value = '';
  els.emptyPreview.hidden = false;
  els.overlay.hidden = true;
  els.contextStatus.textContent = 'Awaiting visual context';
  resetSourceButtons();
  setLiveBadge(false);

  if (!quiet) notify('Visual context cleared');
}

async function getMedia(kind) {
  const wantedSource = kind === 'camera' ? 'Camera' : 'Screen';
  const activeTrack = state.stream?.getVideoTracks?.()[0];

  // The source buttons are true toggles, not repeated permission prompts.
  if (state.source === wantedSource && activeTrack?.readyState === 'live') {
    clearContext();
    return;
  }
  if (!navigator.mediaDevices) {
    notify('Camera and screen capture are not supported in this browser');
    return;
  }

  let stream;
  try {
    // Acquire first. If the user declines, the current working source remains live.
    stream = kind === 'camera'
      ? await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
    notify(denied
      ? 'Permission was not granted. The existing source is unchanged.'
      : 'That visual source was unavailable. You can still use voice or text.');
    return;
  }

  const previous = state.stream;
  state.stream = stream;
  state.source = wantedSource;
  state.uploadedImage = '';
  state.uploadedSignature = null;
  state.uploadedComparisonImage = '';
  state.previousFrame = null;
  if (previous && previous !== stream) stopStream(previous);

  els.documentPreview.removeAttribute('src');
  els.documentPreview.hidden = true;
  els.video.srcObject = stream;
  els.video.hidden = false;
  els.emptyPreview.hidden = true;
  els.overlay.hidden = false;
  els.sourceName.textContent = kind === 'camera' ? 'Camera feed' : 'Screen share';
  els.contextStatus.textContent = `${state.source} connected · frame is sent only with a turn`;

  resetSourceButtons();
  $(`#${kind}Label`).textContent = 'on';
  $(`#${kind}Btn`).classList.add('active');
  setLiveBadge(true);

  // Browser-side "Stop sharing" must switch the UI back to no-context. Ignore
  // an ended track if the user has already replaced it with another source.
  stream.getVideoTracks().forEach(track => {
    track.onended = () => {
      if (state.stream !== stream) return;
      clearContext({ quiet: true });
      notify('The shared source ended — visual context is off');
    };
  });

  notify(`${state.source} connected — visual context is live`);
}

$('#cameraBtn').onclick = () => getMedia('camera');
$('#screenBtn').onclick = () => getMedia('screen');
$('#connectBtn').onclick = () => getMedia('camera');
$('#clearContext').onclick = () => clearContext();

$('#documentBtn').onclick = () => {
  if (state.source === 'Document') {
    clearContext();
    return;
  }
  els.documentInput.click();
};

els.documentInput.onchange = async () => {
  const file = els.documentInput.files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15_000_000) {
    notify('Choose a JPG, PNG, or WebP image under 15 MB');
    els.documentInput.value = '';
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(image.naturalWidth, 1280);
    canvas.height = Math.max(1, Math.round(canvas.width * image.naturalHeight / image.naturalWidth));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    let encoded = '';
    for (const quality of [0.78, 0.6, 0.42]) {
      encoded = encode(canvas, quality);
      if (encoded.length <= MAX_FRAME_CHARS) break;
    }
    if (!encoded || encoded.length > MAX_FRAME_CHARS) throw new Error('encoded image is too large');

    stopStream(state.stream);
    state.stream = null;
    state.source = 'Document';
    state.uploadedImage = encoded;
    state.uploadedSignature = frameSignature(canvas);
    state.uploadedComparisonImage = compactComparisonFrame(canvas);
    state.previousFrame = null;
    els.video.srcObject = null;
    els.video.hidden = true;
    els.documentPreview.src = encoded;
    els.documentPreview.hidden = false;
    els.emptyPreview.hidden = true;
    els.overlay.hidden = false;
    els.sourceName.textContent = file.name.slice(0, 80);
    els.contextStatus.textContent = 'Document ready · image is sent only with a turn';
    resetSourceButtons();
    $('#documentLabel').textContent = 'ready';
    $('#documentBtn').classList.add('active');
    setLiveBadge(true);
    notify('Document image ready for questions and summaries');
  } catch {
    notify('That image could not be prepared');
    els.documentInput.value = '';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

/* --- voice input ---------------------------------------------------- */

function setMicUi(active, label = active ? 'listening…' : 'click to speak') {
  els.micLabel.textContent = label;
  $('#micBtn').classList.toggle('active', active);
  $('#micBtn').setAttribute('aria-pressed', String(active));
}

function stopListeningSession({ quiet = false } = {}) {
  state.listeningSession = false;
  clearTimeout(state.recognitionRestartTimer);
  state.recognitionRestartTimer = null;
  const recognition = state.recognition;
  state.recognition = null;
  try { recognition?.stop(); } catch { /* already ended */ }
  setMicUi(false);
  if (!quiet) notify('Microphone paused');
}

function queueRecognitionRestart() {
  clearTimeout(state.recognitionRestartTimer);
  if (!state.listeningSession || !state.continuousListening) return;
  state.recognitionRestartTimer = setTimeout(() => {
    const speaking = Boolean(speechController) || Boolean(currentAudio) || Boolean(window.speechSynthesis?.speaking);
    if (state.busy || speaking || state.recognition) {
      queueRecognitionRestart();
      return;
    }
    startRecognition();
  }, 350);
}

function startRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    state.listeningSession = false;
    setMicUi(false);
    notify('Speech recognition is not supported here — type your request instead');
    return;
  }
  if (state.recognition || state.busy) {
    queueRecognitionRestart();
    return;
  }

  stopSpeaking(); // barge-in: do not let the agent's voice feed the recognizer
  const recognition = new SpeechRecognition();
  state.recognition = recognition;
  recognition.lang = state.language;
  recognition.interimResults = true;
  recognition.continuous = false;
  setMicUi(true, state.continuousListening ? 'continuous · listening' : 'listening…');

  recognition.onresult = event => {
    const results = Array.from(event.results);
    const transcript = results.map(result => result[0].transcript.trim()).filter(Boolean).join(' ');
    const isFinal = results.length > 0 && results.every(result => result.isFinal);
    els.prompt.value = transcript; // live interim transcription
    if (isFinal) {
      state.recognition = null;
      try { recognition.stop(); } catch { /* browser already stopped */ }
      send(transcript);
    }
  };
  recognition.onerror = event => {
    if (event.error === 'not-allowed') {
      state.listeningSession = false;
      notify('Microphone permission was not granted');
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      notify('Microphone input was unavailable');
    }
  };
  recognition.onend = () => {
    if (state.recognition === recognition) state.recognition = null;
    if (!state.listeningSession) setMicUi(false);
    else if (!state.continuousListening) {
      state.listeningSession = false;
      setMicUi(false);
    } else if (state.busy) setMicUi(true, 'waiting for reply');
    else queueRecognitionRestart();
  };

  try {
    recognition.start();
  } catch {
    state.recognition = null;
    queueRecognitionRestart();
  }
}

$('#micBtn').onclick = () => {
  if (state.listeningSession) {
    const speaking = Boolean(speechController) || Boolean(currentAudio) || Boolean(window.speechSynthesis?.speaking);
    if (speaking && !state.busy) {
      // Push-to-barge-in: an active continuous session normally waits while TTS
      // plays. Pressing the microphone at that moment stops the reply and
      // immediately opens a fresh recognition turn instead of pausing.
      stopSpeaking();
      clearTimeout(state.recognitionRestartTimer);
      state.recognitionRestartTimer = null;
      startRecognition();
      notify('Reply interrupted — listening now');
      return;
    }
    stopListeningSession();
    return;
  }
  state.listeningSession = true;
  startRecognition();
};

/* ------------------------------------------------------------------ */
/* 5–6. APPROVE + VERIFY — human gate and auditable session receipt    */
/* ------------------------------------------------------------------ */

let modalReturnFocus = null;

function operationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function setActionProgress(text, kind = '') {
  els.approvalProgress.textContent = text;
  els.approvalProgress.className = `action-progress${kind ? ` ${kind}` : ''}`;
}

function closeApproval({ force = false } = {}) {
  if (state.actionBusy && !force) return;
  els.modal.hidden = true;
  state.pendingAction = null;
  state.actionBusy = false;
  $('#confirmApproval').disabled = false;
  $('#cancelApproval').disabled = false;
  modalReturnFocus?.focus?.();
}

function openApproval(action) {
  const target = state.trelloConfigured ? 'trello' : 'session';
  state.pendingAction = { ...action, target, operationId: operationId() };
  modalReturnFocus = document.activeElement;
  els.approvalActionTitle.value = action.title;
  els.approvalActionDetails.value = action.details;
  els.approvalTarget.textContent = target === 'trello'
    ? `Trello · ${state.trelloDestination || 'configured list'} · verified by read-back`
    : 'Local session fallback · no external service will change';
  $('#confirmApproval').textContent = target === 'trello' ? 'Approve & create card' : 'Approve local fallback';
  setActionProgress('Nothing has been written yet. You may edit or reject this proposal.');
  els.modal.hidden = false;
  requestAnimationFrame(() => els.approvalActionTitle.focus());
}

function openInfo(title, render) {
  modalReturnFocus = document.activeElement;
  els.infoTitle.textContent = title;
  els.infoContent.replaceChildren();
  render(els.infoContent);
  els.infoModal.hidden = false;
  requestAnimationFrame(() => $('#closeInfo').focus());
}

function closeInfo() {
  els.infoModal.hidden = true;
  modalReturnFocus?.focus?.();
}

function infoParagraph(text) {
  return el('p', null, text);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

$$('[data-action]').forEach(btn => {
  btn.onclick = () => {
    const action = btn.dataset.action;
    if (action === 'task') {
      const scope = state.source ? `${state.source.toLowerCase()} context` : 'latest conversation';
      openApproval({
        type: 'create_session_task',
        title: `Review ${scope}`,
        details: `Review the ${scope}, capture the important finding, and record the next action. Created by VoiceSync only after this proposal is approved.`
      });
      return;
    }
    send(action === 'summarize'
      ? 'Summarize the current context'
      : 'Extract the visible details from my shared context');
  };
});

$('#cancelApproval').onclick = () => closeApproval();

function saveTaskReceipt(task) {
  const existing = state.tasks.findIndex(item => item.operationId && item.operationId === task.operationId);
  if (existing >= 0) state.tasks[existing] = task;
  else state.tasks.push(task);
  if (state.tasks.length > 50) state.tasks.splice(0, state.tasks.length - 50);
  persistReceipts();
}

function addReceiptMessage(text, task, pill) {
  const row = addMessage(text, 'agent', pill);
  if (task.externalUrl) {
    const link = el('a', 'receipt-link', 'Open verified Trello card ↗');
    link.href = task.externalUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    row.children[1]?.append(link);
  }
  remember('agent', text);
  speak(text);
}

function resetActionButtons() {
  state.actionBusy = false;
  $('#confirmApproval').disabled = false;
  $('#cancelApproval').disabled = false;
}

$('#confirmApproval').onclick = async () => {
  const action = state.pendingAction;
  if (!action || action.type !== 'create_session_task' || state.actionBusy) {
    if (!state.actionBusy) {
      closeApproval();
      notify('No valid action was pending');
    }
    return;
  }

  const title = els.approvalActionTitle.value.replace(/\s+/g, ' ').trim().slice(0, 120);
  const details = els.approvalActionDetails.value.trim().slice(0, 2000);
  if (!title || !details) {
    setActionProgress('A title and description are required before approval.', 'error');
    return;
  }
  action.title = title;
  action.details = details;

  if (action.target === 'session') {
    const task = {
      id: `VS-${Date.now().toString(36).toUpperCase()}-${state.tasks.length + 1}`,
      title,
      details,
      operationId: action.operationId,
      target: 'session',
      createdAt: new Date().toISOString(),
      status: 'created',
      verified: true
    };
    saveTaskReceipt(task);

    // Verify the local fallback by reading the receipt back from browser storage.
    const verified = state.tasks.some(item => item.id === task.id && item.status === 'created');
    closeApproval({ force: true });
    const text = verified
      ? `Approved and verified. Local session task ${task.id} was created: ${task.title}. Configure Trello to make this an external write.`
      : 'The local action was approved, but its receipt could not be verified.';
    addReceiptMessage(text, task, verified ? '✓ Write verified · local fallback' : '⚠ Verification failed');
    notify(verified ? `Local task ${task.id} created` : 'Task verification failed');
    return;
  }

  state.actionBusy = true;
  $('#confirmApproval').disabled = true;
  $('#cancelApproval').disabled = true;
  setActionProgress('Creating the approved Trello card…', 'working');

  let response;
  let data = {};
  try {
    response = await fetch('/api/trello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, details, operationId: action.operationId })
    });
    data = await response.json().catch(() => ({}));
  } catch {
    setActionProgress('The Trello API could not be reached. Nothing is confirmed; retry uses the same operation ID to prevent duplicates.', 'error');
    resetActionButtons();
    notify('Could not reach the Trello executor');
    return;
  }

  // If Trello accepted the write but read-back failed, preserve that receipt
  // and never invite a blind retry that could duplicate the card.
  if (!response.ok && data.created && data.receipt?.id) {
    const task = {
      id: data.receipt.id,
      title,
      details,
      operationId: action.operationId,
      target: 'trello',
      externalUrl: safeTrelloUrl(data.receipt.url),
      createdAt: new Date().toISOString(),
      status: 'created-unverified',
      verified: false
    };
    saveTaskReceipt(task);
    closeApproval({ force: true });
    const text = `Trello accepted the card “${title}”, but VoiceSync could not verify the read-back. Check the returned card before retrying.`;
    addReceiptMessage(text, task, '⚠ Trello write created · verification incomplete');
    notify('Card created, but verification needs attention');
    return;
  }

  if (!response.ok || !data.verified || !data.receipt?.id) {
    const reason = data.detail || data.error || `Trello request failed (${response.status})`;
    setActionProgress(`${reason}. No verified receipt was recorded.`, 'error');
    resetActionButtons();
    notify(reason);
    return;
  }

  const task = {
    id: data.receipt.id,
    title: data.receipt.title || title,
    details,
    operationId: action.operationId,
    target: 'trello',
    externalUrl: safeTrelloUrl(data.receipt.url),
    createdAt: data.receipt.verifiedAt || new Date().toISOString(),
    status: 'created',
    verified: true,
    reused: Boolean(data.receipt.reused || data.reused)
  };
  saveTaskReceipt(task);
  closeApproval({ force: true });
  const text = `${task.reused ? 'Found and verified the existing' : 'Created and verified a new'} Trello card: ${task.title}. Receipt ${task.id}.`;
  addReceiptMessage(text, task, '✓ External write verified · Trello read-back');
  notify(`Trello card ${task.id} verified`);
};

$('#historyBtn').onclick = () => openInfo('Session history', content => {
  const summary = el('div', 'info-summary');
  const latencies = state.diagnostics.map(turn => turn.latencyMs);
  const completed = state.diagnostics.filter(turn => turn.outcome === 'completed').length;
  summary.append(
    el('span', null, `${state.history.length} conversation turns`),
    el('span', null, `${state.tasks.length} approved writes`),
    el('span', null, `${completed}/${state.diagnostics.length} model turns completed`),
    el('span', null, `p50 ${percentile(latencies, .5)} ms · p95 ${percentile(latencies, .95)} ms`)
  );
  content.append(summary);

  if (state.lastSpokenText) {
    const replay = el('button', 'outline-btn', 'Replay latest spoken reply');
    replay.onclick = () => {
      stopListeningSession({ quiet: true });
      speak(state.lastSpokenText);
      notify('Replaying the latest reply');
    };
    content.append(replay);
  }

  if (!state.history.length && !state.tasks.length) {
    content.append(infoParagraph('No turns or approved actions have been recorded in this tab yet.'));
    return;
  }

  if (state.tasks.length) {
    content.append(el('h4', null, 'Action receipts'));
    for (const task of [...state.tasks].reverse()) {
      const row = el('div', 'ledger-row');
      const copy = el('div');
      copy.append(
        el('b', null, `${task.id} · ${task.title}`),
        el('small', null, `${task.target === 'trello' ? 'Trello' : 'Local fallback'} · ${task.verified ? 'verified' : 'verification incomplete'}`)
      );
      const meta = el('div', 'ledger-meta');
      meta.append(el('span', null, new Date(task.createdAt).toLocaleString()));
      if (task.externalUrl) {
        const link = el('a', null, 'Open ↗');
        link.href = task.externalUrl;
        link.target = '_blank';
        link.rel = 'noreferrer';
        meta.append(link);
      }
      row.append(copy, meta);
      content.append(row);
    }
  }

  if (state.diagnostics.length) {
    content.append(el('h4', null, 'Turn diagnostics'));
    for (const turn of [...state.diagnostics].reverse().slice(0, 20)) {
      const row = el('div', 'ledger-row');
      row.append(
        el('b', null, `${turn.outcome} · ${turn.source} · ${turn.mode}`),
        el('span', null, `${turn.latencyMs} ms`)
      );
      content.append(row);
    }
  }

  if (state.history.length) {
    content.append(el('h4', null, 'Conversation memory'));
    for (const turn of state.history) {
      const row = el('div', 'history-row');
      row.append(el('b', null, turn.role === 'user' ? 'You' : 'VoiceSync'), el('p', null, turn.text));
      content.append(row);
    }
  }
});

$('#settingsBtn').onclick = () => openInfo('Session settings', content => {
  const speechRow = el('label', 'setting-row-ui');
  const speechCopy = el('span');
  speechCopy.append(el('b', null, 'Spoken replies'), el('small', null, 'Use ElevenLabs when configured, otherwise the browser voice.'));
  const speechToggle = document.createElement('input');
  speechToggle.type = 'checkbox';
  speechToggle.checked = state.speechEnabled;
  speechToggle.onchange = () => {
    state.speechEnabled = speechToggle.checked;
    if (!state.speechEnabled) stopSpeaking();
    persistSettings();
  };
  speechRow.append(speechCopy, speechToggle);

  const continuousRow = el('label', 'setting-row-ui');
  const continuousCopy = el('span');
  continuousCopy.append(el('b', null, 'Continuous microphone session'), el('small', null, 'After each spoken response, resume listening until you pause the microphone.'));
  const continuousToggle = document.createElement('input');
  continuousToggle.type = 'checkbox';
  continuousToggle.checked = state.continuousListening;
  continuousToggle.onchange = () => {
    state.continuousListening = continuousToggle.checked;
    if (!state.continuousListening && state.listeningSession && !state.recognition) stopListeningSession({ quiet: true });
    persistSettings();
  };
  continuousRow.append(continuousCopy, continuousToggle);

  const comparisonRow = el('label', 'setting-row-ui');
  const comparisonCopy = el('span');
  comparisonCopy.append(
    el('b', null, 'Before/after visual comparison'),
    el('small', null, 'Keep one compact frame in memory and attach it only when a change is detected or you ask what changed. Clear removes it immediately.')
  );
  const comparisonToggle = document.createElement('input');
  comparisonToggle.type = 'checkbox';
  comparisonToggle.checked = state.visualComparisonEnabled;
  comparisonToggle.onchange = () => {
    state.visualComparisonEnabled = comparisonToggle.checked;
    if (!state.visualComparisonEnabled) state.previousFrame = null;
    persistSettings();
  };
  comparisonRow.append(comparisonCopy, comparisonToggle);

  const languageRow = el('label', 'setting-row-ui');
  const languageCopy = el('span');
  languageCopy.append(el('b', null, 'Recognition language'), el('small', null, 'Applied the next time the microphone starts.'));
  const select = document.createElement('select');
  for (const [value, label] of [['en-IN', 'English (India)'], ['en-US', 'English (US)'], ['hi-IN', 'Hindi (India)'], ['ta-IN', 'Tamil (India)']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === state.language;
    select.append(option);
  }
  select.onchange = () => {
    state.language = select.value;
    persistSettings();
  };
  languageRow.append(languageCopy, select);
  content.append(speechRow, continuousRow, comparisonRow, languageRow);
});

$('#helpBtn').onclick = () => openInfo('How VoiceSync works', content => {
  content.append(
    infoParagraph('Speak or type a turn, optionally connect a camera, screen, or document, and VoiceSync sends one current frame with that turn to Gemini.'),
    infoParagraph('When before/after comparison is enabled, one compact prior submitted frame stays in memory and is attached only after a detected change or an explicit comparison request. There is no background upload. Clear removes both frames immediately.'),
    infoParagraph('A proposed write is editable and executes only after approval. When Trello is configured, VoiceSync creates the card, reads it back from Trello, and records its verified URL. Without Trello it clearly uses a local fallback.'),
    infoParagraph('Press the active microphone while a reply is playing to interrupt it and listen immediately. Browser speech recognition may use your browser vendor’s service. Provider and Trello credentials remain on the server.')
  );
});

$('#closeInfo').onclick = closeInfo;
for (const backdrop of [els.modal, els.infoModal]) {
  backdrop.addEventListener('click', event => {
    if (event.target !== backdrop) return;
    if (backdrop === els.modal) closeApproval();
    else closeInfo();
  });
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!els.modal.hidden) closeApproval();
  else if (!els.infoModal.hidden) closeInfo();
});

/* --- session chrome -------------------------------------------------- */

$('#resetBtn').onclick = () => {
  stopSpeaking();
  clearContext({ quiet: true });
  try { localStorage.removeItem(RECEIPT_STORAGE_KEY); } catch { /* storage may be blocked */ }
  location.reload();
};
window.addEventListener('pagehide', () => {
  stopListeningSession({ quiet: true });
  stopSpeaking();
  clearContext({ quiet: true });
});

/* --- startup probe: show the real provider state --------------------- */

(async () => {
  try {
    const health = await fetch('/api/health').then(r => r.json());
    const status = $('.status');
    const voice = health.speech?.configured ? 'ElevenLabs' : 'browser voice';
    state.trelloConfigured = Boolean(health.tools?.trello?.configured);
    state.trelloDestination = health.tools?.trello?.destination || '';
    $('#taskActionLabel').textContent = state.trelloConfigured
      ? `Creates and verifies a card in ${state.trelloDestination}`
      : 'Local fallback · configure Trello for external writes';

    status.innerHTML = '<i></i> '; // static markup only — the rest is text
    status.append(health.mode === 'live'
      ? `Gemini ${health.reasoning.model} · ${voice} · ${state.trelloConfigured ? 'Trello ready' : 'Trello off'}`
      : `Demo mode · ${voice} · ${state.trelloConfigured ? 'Trello ready' : 'Trello off'}`);
    status.title = health.mode === 'live'
      ? `Configured reasoning: ${health.reasoning.provider} (${health.reasoning.model}). Speech: ${health.speech.provider}. Trello: ${state.trelloConfigured ? `ready for ${state.trelloDestination}` : 'not configured'}.`
      : `Set GEMINI_API_KEY for live reasoning. Trello is ${state.trelloConfigured ? 'ready' : 'not configured'}.`;
  } catch {
    const status = $('.status');
    status.innerHTML = '<i></i> ';
    status.append('API unavailable · local fallback');
    status.title = 'The server API could not be reached.';
    $('#taskActionLabel').textContent = 'Local fallback · API unavailable';
  }
})();
