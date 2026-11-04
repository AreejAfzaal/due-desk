// Vercel serverless entry point. vercel.json rewrites every /api/* request here.
import { handle } from '../lib/core.js';
import { storeFromEnv, RedisStore } from '../lib/stores.js';

const store = storeFromEnv();
// On Vercel, in-memory storage would give each server instance its own data, so require Redis.
const missingDb = process.env.VERCEL && !(store instanceof RedisStore);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const query = Object.fromEntries(url.searchParams);
  // the rewrite passes the original path as ?route=..., fall back to the URL path
  const route = query.route ?? url.pathname.replace(/^\/api\/?/, '').replace(/^index\/?/, '');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (missingDb) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'Database not connected yet. In Vercel, open Storage, add Upstash for Redis to this project, then redeploy.' }));
  }
  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const ctx = { cookie: req.headers.cookie, secure: true };
    const out = await handle(store, req.method, route, query, body, ctx);
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    res.end(JSON.stringify(out.body));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message.startsWith('Redis') ? 'Database not reachable. Check the Upstash Redis connection in Vercel.' : 'Something went wrong. Try again.' }));
  }
}
