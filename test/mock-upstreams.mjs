/**
 * Test doubles for the two upstream providers.
 *
 * Point the app at them with:
 *   GEMINI_API_BASE=http://127.0.0.1:<port>/gemini
 *   ELEVENLABS_API_BASE=http://127.0.0.1:<port>/eleven
 *   TRELLO_API_BASE=http://127.0.0.1:<port>/trello
 *
 * Control plane:
 *   POST /__control  { gemini: scenario, eleven: scenario, trello: scenario }
 *   GET  /__last     what the app actually sent upstream
 */

import http from 'node:http';

const state = {
  gemini: 'ok',
  eleven: 'ok',
  trello: 'ok',
  geminiCalls: 0,
  elevenCalls: 0,
  trelloCalls: 0,
  trelloCreates: 0,
  lastGemini: null,
  lastEleven: null,
  lastTrello: null,
  trelloCards: []
};

const held = new Set(); // responses deliberately left hanging

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const GEMINI_SCENARIOS = {
  ok: () => [200, {
    candidates: [{
      // A thought part must never reach the user or the speaker.
      content: { parts: [{ text: 'internal reasoning', thought: true }, { text: 'Mock Gemini reply.' }] },
      finishReason: 'STOP'
    }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 }
  }],
  'function-call': () => [200, {
    candidates: [{
      content: { parts: [{ functionCall: { name: 'create_follow_up_task', args: { title: 'Review deployment logs', details: 'Inspect the visible errors and record the next fix.' } } }] },
      finishReason: 'STOP'
    }],
    usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 8 }
  }],
  'maxtokens-partial': () => [200, {
    candidates: [{ content: { parts: [{ text: 'Half an ans' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 }
  }],
  'maxtokens-empty': () => [200, {
    // The real-world "thinking ate the whole budget" shape.
    candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 282, thoughtsTokenCount: 400 }
  }],
  safety: () => [200, { candidates: [{ content: {}, finishReason: 'SAFETY' }] }],
  429: () => [429, { error: { message: 'Resource has been exhausted (quota).' } }],
  503: () => [503, { error: { message: 'The model is overloaded.' } }],
  400: () => [400, { error: { message: 'Thinking budget is not supported for this model.' } }]
};

export function startMockUpstreams() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const raw = await readBody(req);

    if (url.pathname === '/__control') {
      const next = JSON.parse(raw || '{}');
      Object.assign(state, next);
      state.geminiCalls = 0;
      state.elevenCalls = 0;
      state.trelloCalls = 0;
      state.trelloCreates = 0;
      state.lastGemini = null;
      state.lastEleven = null;
      state.lastTrello = null;
      if (next.resetTrello) state.trelloCards = [];
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/__last') {
      return json(res, 200, {
        geminiCalls: state.geminiCalls,
        elevenCalls: state.elevenCalls,
        trelloCalls: state.trelloCalls,
        trelloCreates: state.trelloCreates,
        lastGemini: state.lastGemini,
        lastEleven: state.lastEleven,
        lastTrello: state.lastTrello,
        trelloCards: state.trelloCards
      });
    }

    if (url.pathname.startsWith('/gemini/')) {
      state.geminiCalls++;
      state.lastGemini = {
        path: url.pathname.replace('/gemini/', ''),
        query: Object.fromEntries(url.searchParams),
        headers: { 'x-goog-api-key': req.headers['x-goog-api-key'] || null },
        body: JSON.parse(raw || '{}')
      };
      // 400 only on the first call so the "retry without thinkingConfig" path
      // can succeed on the second.
      if (state.gemini === '400-then-ok' && state.geminiCalls === 1) {
        const [status, payload] = GEMINI_SCENARIOS[400]();
        return json(res, status, payload);
      }
      if (state.gemini === '400-then-ok') {
        const [status, payload] = GEMINI_SCENARIOS.ok();
        return json(res, status, payload);
      }
      if (state.gemini === 'hang') {
        held.add(res);
        return undefined;
      }
      const [status, payload] = (GEMINI_SCENARIOS[state.gemini] || GEMINI_SCENARIOS.ok)();
      return json(res, status, payload);
    }

    if (url.pathname.startsWith('/eleven/')) {
      state.elevenCalls++;
      state.lastEleven = {
        path: url.pathname.replace('/eleven/', ''),
        query: Object.fromEntries(url.searchParams),
        headers: { 'xi-api-key': req.headers['xi-api-key'] || null, accept: req.headers.accept || null },
        body: JSON.parse(raw || '{}')
      };
      if (state.eleven === 'hang') {
        held.add(res);
        return undefined;
      }
      if (state.eleven === '429') {
        res.writeHead(429, { 'content-type': 'text/plain' });
        return res.end('too many requests');
      }
      if (state.eleven === '401') {
        res.writeHead(401, { 'content-type': 'text/plain' });
        return res.end('invalid api key');
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.from('ID3\u0004mock-mp3-bytes'));
    }

    if (url.pathname.startsWith('/trello/')) {
      state.trelloCalls++;
      const relativePath = url.pathname.replace('/trello/', '');
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.lastTrello = {
        method: req.method,
        path: relativePath,
        query: Object.fromEntries(url.searchParams),
        headers: { authorization: req.headers.authorization || null },
        body: form
      };

      if (state.trello === 'hang') {
        held.add(res);
        return undefined;
      }
      if (state.trello === '429') return json(res, 429, { message: 'Trello rate limit' });
      if (state.trello === '401') return json(res, 401, { message: 'invalid Trello token' });

      if (req.method === 'GET' && relativePath.startsWith('lists/')) {
        return json(res, 200, state.trelloCards);
      }

      if (req.method === 'POST' && relativePath === 'cards') {
        state.trelloCreates++;
        const card = {
          id: `card-${state.trelloCards.length + 1}`,
          name: form.name,
          desc: form.desc,
          idList: form.idList,
          closed: false,
          shortUrl: `https://trello.com/c/mock${state.trelloCards.length + 1}`
        };
        state.trelloCards.push(card);
        return json(res, 200, card);
      }

      if (req.method === 'GET' && relativePath.startsWith('cards/')) {
        const id = relativePath.slice('cards/'.length);
        const card = state.trelloCards.find(item => item.id === id);
        if (!card) return json(res, 404, { message: 'card not found' });
        if (state.trello === 'verify-mismatch') return json(res, 200, { ...card, name: 'Changed elsewhere' });
        return json(res, 200, card);
      }
    }

    return json(res, 404, { error: 'unknown mock route' });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        async close() {
          for (const res of held) res.destroy();
          held.clear();
          server.closeAllConnections?.();
          await new Promise(done => server.close(done));
        }
      });
    });
  });
}
