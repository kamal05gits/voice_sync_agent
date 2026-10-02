import { apiKey, textModel, thinkingConfigFor } from './_gemini.js';
import { trelloConfig, trelloConfigured } from './trello.js';

/**
 * Honest status for the UI badge and for uptime checks.
 * Reasoning = Gemini, speech = ElevenLabs. Each is reported independently.
 */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const hasGemini = Boolean(apiKey());
  const hasEleven = Boolean(process.env.ELEVENLABS_API_KEY);
  const hasTrello = trelloConfigured();
  const trello = trelloConfig();
  const model = textModel();
  const thinking = thinkingConfigFor(model);

  return res.status(200).json({
    ok: true,
    service: 'voicesync-agent',
    mode: hasGemini ? 'live' : 'demo',
    reasoning: {
      provider: 'google-gemini',
      configured: hasGemini,
      model: hasGemini ? model : null,
      vision: hasGemini,
      thinkingBudget: hasGemini ? (thinking?.thinkingBudget ?? null) : null,
      thinkingLevel: hasGemini ? (thinking?.thinkingLevel ?? null) : null
    },
    speech: {
      provider: 'elevenlabs',
      configured: hasEleven,
      model: hasEleven ? process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2' : null,
      voiceId: hasEleven ? process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM' : null
    },
    tools: {
      trello: {
        provider: 'trello',
        configured: hasTrello,
        // A friendly label is safe to expose; list IDs and credentials are not.
        destination: hasTrello ? (trello.listName || 'configured list') : null,
        approvalRequired: true,
        readBackVerification: true
      }
    },
    timestamp: new Date().toISOString()
  });
}
