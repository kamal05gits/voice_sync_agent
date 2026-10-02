/**
 * Local dev server for VoiceSync Agent.
 *
 * Serves the static front end and mounts the same /api handlers Vercel runs,
 * so `npm run dev` exercises the Gemini + ElevenLabs + Trello workflow with no
 * Vercel CLI and no login. Reads .env if present.
 *
 *   node dev-server.mjs            → http://localhost:4173
 *   PORT=8080 node dev-server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textModel, thinkingConfigFor } from './api/_gemini.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 4.5 * 1024 * 1024; // matches Vercel's request body ceiling

/* --- .env loader (no dependencies) ---------------------------------- */
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const value = (match[2] || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}
loadEnv();

/* --- route table ----------------------------------------------------- */
const routes = {
  '/api/chat': (await import('./api/chat.js')).default,
  '/api/tts': (await import('./api/tts.js')).default,
  '/api/trello': (await import('./api/trello.js')).default,
  '/api/health': (await import('./api/health.js')).default
};

/* --- static policy ---------------------------------------------------
 * The server binds 0.0.0.0, so "everything under the repo root" is not an
 * acceptable static rule: it would hand out .env — i.e. the Gemini and
 * ElevenLabs keys — to anyone on the network. Serve the browser bundle only.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

/** Never served, even though they live beside index.html. */
const PRIVATE_FILES = new Set(['package.json', 'package-lock.json', 'vercel.json', 'dev-server.mjs']);
const PRIVATE_DIRS = ['api', 'test', 'node_modules', '.git', '.vercel'];

function isPublic(relPath) {
  const parts = relPath.split(path.sep);
  if (parts.some(part => part.startsWith('.'))) return false; // .env, .git, dotfiles
  if (PRIVATE_DIRS.includes(parts[0])) return false; // server code is not static content
  if (PRIVATE_FILES.has(relPath)) return false;
  return Object.hasOwn(MIME, path.extname(relPath).toLowerCase());
}

/** Give the Node response the Express-ish shape the Vercel handlers expect. */
function decorate(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = payload => {
    if (!res.headersSent) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  res.send = payload => {
    res.end(Buffer.isBuffer(payload) ? payload : String(payload));
    return res;
  };
  return res;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  decorate(res);
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Browser media APIs need a secure context; localhost counts as one.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');

  const handler = routes[pathname];
  if (handler) {
    try {
      req.body = await readBody(req);
    } catch {
      return res.status(413).json({ error: 'payload too large' });
    }
    try {
      return await handler(req, res);
    } catch (error) {
      console.error(`[api] ${pathname}`, error);
      if (!res.writableEnded) res.status(500).json({ error: 'handler crashed' });
      return undefined;
    }
  }

  // Static files, with cleanUrls parity ("/health" → "/health.html").
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return res.status(400).json({ error: 'malformed path' });
  }
  let file = path.resolve(ROOT, rel);

  const inside = path.relative(ROOT, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    return res.status(403).json({ error: 'forbidden' }); // traversal guard
  }
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;

  const relFromRoot = path.relative(ROOT, file);
  if (!isPublic(relFromRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.status(404).json({ error: 'not found', path: pathname });
  }

  res.setHeader('content-type', MIME[path.extname(file).toLowerCase()]);
  res.setHeader('cache-control', 'no-store');
  return res.status(200).send(fs.readFileSync(file));
});

server.listen(PORT, HOST, () => {
  const gemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const budget = process.env.GEMINI_THINKING_BUDGET ?? '0';
  console.log(`\n  VoiceSync Agent  →  http://localhost:${PORT}\n`);
  const model = textModel();
  const thinkingConfig = thinkingConfigFor(model);
  const thinking = thinkingConfig?.thinkingLevel ?? `budget ${thinkingConfig?.thinkingBudget ?? budget}`;
  console.log(`  reasoning : Gemini     ${gemini ? `live (${model}, thinking ${thinking})` : 'demo mode — set GEMINI_API_KEY'}`);
  console.log(`  speech    : ElevenLabs ${process.env.ELEVENLABS_API_KEY ? 'live' : 'off — falls back to browser voice'}`);
  const trello = process.env.TRELLO_API_KEY && process.env.TRELLO_API_TOKEN && process.env.TRELLO_LIST_ID;
  console.log(`  actions   : Trello     ${trello ? `live (${process.env.TRELLO_LIST_NAME || 'configured list'})` : 'off — uses labelled local fallback'}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
