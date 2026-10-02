import {
  apiKey,
  callGemini,
  clientStatus,
  finishReason,
  firstText,
  imagePart,
  textModel,
  fallbackModel,
  thinkingConfigFor
} from './_gemini.js';

const SYSTEM = `You are VoiceSync Agent, a concise, safety-first real-time multimodal assistant.
You help the user understand a live camera or screen-share context.

Rules:
- Only describe visual details when an image was actually attached to this turn. Never invent one.
- Only describe what changed when both an earlier and current frame are attached. Otherwise say that a comparison baseline is unavailable.
- Your reply is read aloud by text to speech. Write plain spoken prose: no markdown, no bullet points, no emoji, no code fences.
- Never perform or claim to perform a destructive action.
- If the user explicitly asks to create, add, record, or queue a follow-up task, call create_follow_up_task. The call only proposes the write; the client handles approval and routes it to configured tools such as Trello.
- Stay under 110 words.`;

const TOOLS = [{
  functionDeclarations: [{
    name: 'create_follow_up_task',
    description: 'Propose a local follow-up task. This does not execute the write; explicit user approval is required in the client.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, ideally under 80 characters.' },
        details: { type: 'string', description: 'What should be reviewed or done, including relevant visible or conversation context.' }
      },
      required: ['title', 'details']
    }
  }]
}];

const MAX_MESSAGE = 4000;
const MAX_HISTORY_TURNS = 8;

/**
 * Room for a full spoken answer. Thinking is disabled by default in
 * _gemini.js; if someone re-enables it this budget is shared with the thinking
 * tokens, which is exactly why it is not set anywhere near the ~160 tokens a
 * 110-word reply actually needs.
 */
const MAX_OUTPUT_TOKENS = 1024;

/** The only context labels the client is allowed to put in front of the model. */
const SOURCES = new Set(['Camera', 'Screen', 'Document']);

/** Deterministic offline answer so the demo never dead-ends without a key. */
function demoReply(message, hasImage) {
  const m = message.toLowerCase();
  const prefix = hasImage
    ? 'I received the shared visual context. '
    : 'No visual source was attached, so I am working from your words only. ';
  if (m.includes('summar')) {
    return prefix + 'The VoiceSync session is active. I can inspect the shared context, answer a focused question, and stage an action for your approval.';
  }
  if (m.includes('see') || m.includes('visible') || m.includes('detail')) {
    return prefix + (hasImage
      ? 'Add a Gemini API key and this frame goes straight to the vision model, which will read the text, objects, and layout for you.'
      : 'Connect your camera or share your screen and I can analyse it.');
  }
  return prefix + 'I can handle questions, summaries, visible details, and approval-gated tasks.';
}

function cleanActionField(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Convert a supported Gemini function call into an unexecuted client proposal. */
function actionFromGemini(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const call = parts.find(part => part?.functionCall?.name === 'create_follow_up_task')?.functionCall;
  if (!call || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return null;

  const title = cleanActionField(call.args.title, 120);
  const details = cleanActionField(call.args.details, 600);
  if (!title || !details) return null;
  return { type: 'create_session_task', title, details };
}

/** Keep no-key demos behaviorally aligned with the live action proposal path. */
function demoAction(message, source) {
  const asksForTask = /\b(create|add|record|queue)\b[\s\S]{0,80}\b(task|follow[- ]?up|reminder)\b/i.test(message);
  if (!asksForTask) return null;
  const scope = source ? `${source.toLowerCase()} context` : 'latest conversation';
  return {
    type: 'create_session_task',
    title: `Review ${scope}`,
    details: `Create one local follow-up task for the ${scope}. Requested in this turn: ${cleanActionField(message, 240)}`
  };
}

/**
 * Map the client's lightweight history into Gemini `contents` entries.
 * Gemini expects a conversation that starts with the user, so any leading
 * model turns left over after trimming are dropped rather than sent.
 */
function historyContents(history) {
  if (!Array.isArray(history)) return [];

  const turns = history
    .filter(turn => turn && typeof turn.text === 'string' && turn.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map(turn => ({
      role: turn.role === 'agent' || turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: turn.text.trim().slice(0, MAX_MESSAGE) }]
    }));

  while (turns.length && turns[0].role === 'model') turns.shift();
  return turns;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, image, previousImage, visualContext, source, history } = req.body || {};

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > MAX_MESSAGE) {
      return res.status(413).json({ error: `message must be under ${MAX_MESSAGE} characters` });
    }

    const visual = imagePart(image);
    // The earlier comparison frame is deliberately small. A separate lower
    // cap protects the request budget and prevents a client from attaching two
    // full-size images to one serverless invocation.
    const earlierVisual = visual ? imagePart(previousImage, 400_000) : null;
    const imageRejected = Boolean(image) && !visual;
    const previousImageRejected = Boolean(previousImage) && !earlierVisual;
    // Never interpolate a client string into the prompt unchecked.
    const safeSource = SOURCES.has(source) ? source : null;
    const rawChange = Number(visualContext?.changeScore);
    const changeScore = Number.isFinite(rawChange) ? Math.max(0, Math.min(1, rawChange)) : null;
    const capturedAt = typeof visualContext?.capturedAt === 'string' && !Number.isNaN(Date.parse(visualContext.capturedAt))
      ? visualContext.capturedAt
      : null;

    // No key -> safe deterministic demo mode. Same shape as a live response.
    if (!apiKey()) {
      const action = demoAction(message, safeSource);
      return res.status(200).json({
        reply: action
          ? `I prepared the follow-up task “${action.title}”. Review the exact write before approving it.`
          : demoReply(message, Boolean(visual)),
        mode: 'demo',
        provider: 'google-gemini',
        model: null,
        source: safeSource,
        usedImage: false,
        usedPreviousImage: false,
        imageRejected,
        previousImageRejected,
        visualChange: null,
        capturedAt,
        truncated: false,
        action,
        usage: null
      });
    }

    const parts = [];
    if (earlierVisual) {
      parts.push({ text: `Earlier submitted ${safeSource || 'visual'} frame, provided only for before-and-after comparison:` });
      parts.push(earlierVisual);
    }
    if (visual) {
      const changeHint = earlierVisual && changeScore != null
        ? ` The browser's local pixel-change score is ${Math.round(changeScore * 100)} percent; use the images, not that score alone, to explain any meaningful change.`
        : '';
      parts.push({ text: `Current ${safeSource || 'visual'} frame captured for this turn.${changeHint}` });
      parts.push(visual);
    }
    parts.push({ text: message.trim() });

    const model = textModel();
    const thinkingConfig = thinkingConfigFor(model);
    const generationConfig = {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(thinkingConfig ? { thinkingConfig } : {})
    };

    // Gemini 3.8 rejects the legacy sampling knobs. Keep them for the 2.5
    // compatibility path, but send the 3.x request in the format documented
    // for the current model.
    if (!/^gemini-3(?:\.|$)/.test(model)) {
      generationConfig.temperature = 0.4;
      generationConfig.topP = 0.95;
    }
    const request = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [...historyContents(history), { role: 'user', parts }],
      tools: TOOLS,
      generationConfig
    };

    let activeModel = model;
    let result = await callGemini(model, request);

    // 503 means the selected model's serving pool is overloaded. Retrying the
    // same pool repeatedly makes a spike worse, so make one fast attempt with
    // the lighter fallback model. The request and safety rules stay identical.
    const fallback = fallbackModel();
    if (!result.ok && result.status === 503 && fallback && fallback !== model) {
      activeModel = fallback;
      const fallbackThinking = thinkingConfigFor(fallback);
      const fallbackConfig = {
        ...generationConfig,
        ...(fallbackThinking ? { thinkingConfig: fallbackThinking } : {})
      };
      if (!fallbackThinking) delete fallbackConfig.thinkingConfig;
      result = await callGemini(fallback, { ...request, generationConfig: fallbackConfig }, { attempts: 1 });
    }

    // A model that does not accept thinkingBudget rejects the whole request;
    // retry once without it rather than failing a turn over a tuning knob.
    if (activeModel === model && !result.ok && result.status === 400 && thinkingConfig && /thinking/i.test(result.data?.error?.message || '')) {
      const { thinkingConfig: _drop, ...plain } = generationConfig;
      result = await callGemini(model, { ...request, generationConfig: plain });
    }

    const { ok, status, data } = result;
    if (!ok) {
      return res.status(clientStatus(status)).json({
        error: 'Gemini request failed',
        detail: data?.error?.message || 'upstream failure',
        upstreamStatus: status
      });
    }

    const action = actionFromGemini(data);
    const visibleText = firstText(data);
    const reply = visibleText || (action
      ? `I prepared the follow-up task “${action.title}”. Review the exact write before approving it.`
      : '');
    const reason = finishReason(data);

    if (!reply) {
      // MAX_TOKENS with no text is the classic "thinking ate the budget" case.
      const detail = reason === 'MAX_TOKENS'
        ? 'the token budget was exhausted before any text was produced — lower the thinking level or raise maxOutputTokens'
        : reason
          ? `stopped early: ${reason}`
          : 'empty candidate';
      return res.status(502).json({ error: 'Gemini returned no text', detail, finishReason: reason });
    }

    return res.status(200).json({
      reply,
      mode: 'live',
      provider: 'google-gemini',
      model: activeModel,
      source: safeSource,
      usedImage: Boolean(visual),
      usedPreviousImage: Boolean(earlierVisual),
      imageRejected,
      previousImageRejected,
      visualChange: earlierVisual && changeScore != null ? changeScore : null,
      capturedAt,
      truncated: reason === 'MAX_TOKENS',
      action,
      usage: data.usageMetadata || null
    });
  } catch {
    return res.status(500).json({ error: 'Unable to process request' });
  }
}
