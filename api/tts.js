/**
 * Speech synthesis via ElevenLabs.
 *
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
 *   headers: xi-api-key, content-type: application/json, accept: audio/mpeg
 *   body:    { text, model_id, voice_settings }
 *
 * Contract with the client:
 *   200 + audio/mpeg            -> play it
 *   200 + { enabled: false }    -> speech is off/unavailable, fall back to browser speechSynthesis
 *   4xx                         -> malformed request
 *
 * A speech failure must NEVER break the conversation, so soft failures return
 * 200 with `enabled:false` rather than an error status.
 */

const DEFAULT_API_ROOT = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel"
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * Not an API limit (mp3_44100_128 accepts far more) — a latency and quota cap.
 * Chat replies are capped at ~110 words, so this only trips on an outlier, and
 * trimming on a sentence boundary beats cutting a word in half.
 */
const MAX_TEXT = 1500;

function clamp(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_TEXT) return clean;

  const slice = clean.slice(0, MAX_TEXT);
  const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  return cut > MAX_TEXT * 0.5 ? slice.slice(0, cut + 1) : slice;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(200).json({ enabled: false, reason: 'ELEVENLABS_API_KEY is not configured' });
  }

  const root = (process.env.ELEVENLABS_API_BASE || DEFAULT_API_ROOT).replace(/\/+$/, '');
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL || DEFAULT_MODEL;
  const url = `${root}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
  const payload = JSON.stringify({
    text: clamp(text),
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }
  });

  let soft = { enabled: false, reason: 'TTS unavailable' };

  // One retry: 429s and 5xx from ElevenLabs are usually transient.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'content-type': 'application/json',
          accept: 'audio/mpeg'
        },
        body: payload,
        signal: controller.signal
      });

      if (upstream.ok) {
        const audio = Buffer.from(await upstream.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', String(audio.length));
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(audio);
      }

      const detail = await upstream.text().catch(() => '');
      soft = {
        enabled: false,
        reason: `ElevenLabs responded ${upstream.status}`,
        detail: detail.slice(0, 200) || undefined
      };

      const retryable = upstream.status === 429 || upstream.status >= 500;
      if (attempt < 2 && retryable) {
        await sleep(600);
        continue;
      }
      return res.status(200).json(soft);
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      soft = { enabled: false, reason: aborted ? 'TTS timed out' : 'TTS unavailable' };
      if (attempt < 2 && !aborted) {
        await sleep(600);
        continue;
      }
      return res.status(200).json(soft);
    } finally {
      clearTimeout(timer);
    }
  }

  return res.status(200).json(soft);
}
