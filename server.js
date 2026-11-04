// Local development server: `node server.js`
// Serves public/ and runs the same API as the Vercel function.
// Uses Upstash Redis if KV_REST_API_URL/TOKEN are set in .env, otherwise an in-memory store saved to data.json.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
(function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})(path.join(__dirname, '.env'));

const { handle, seed } = await import('./lib/core.js');
const { storeFromEnv, RedisStore } = await import('./lib/stores.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const store = storeFromEnv({ file: process.env.DATA_FILE || path.join(__dirname, 'data.json') });
if (process.argv.includes('--reset')) await store.reset(seed);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  try {
    const ctx = { authorization: req.headers.authorization, origin: req.headers.origin };
    const out = await handle(store, req.method, url.pathname.slice(5), Object.fromEntries(url.searchParams), body, ctx);
    res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...out.headers });
    res.end(JSON.stringify(out.body));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Something went wrong. Try again.' }));
  }
}).listen(PORT, '0.0.0.0', async () => {
  const os = await import('node:os');
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  console.log(`\n  Due Desk is running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  if (lan) console.log(`  Network: http://${lan.address}:${PORT}`);
  console.log(`  Storage: ${store instanceof RedisStore ? 'Upstash Redis' : 'local data.json'}`);
  console.log(`  AI:      ${process.env.ANTHROPIC_API_KEY ? `Claude (${process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'})` : 'offline suggestions (set ANTHROPIC_API_KEY for real AI)'}\n`);
});
