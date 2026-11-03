// Storage backends. Both expose the same async interface.
//   getAll()            -> { deadlines, projects, members, tasks, version }
//   getVersion()        -> number
//   get(coll, id)       -> item | null
//   put(coll, ...items) -> bumps version
//   del(coll, id)       -> bumps version
//   presence(clientId)  -> number of clients seen in the last 20 s
//   seedIfEmpty(fn), reset(fn)

import fs from 'node:fs';

export const COLLECTIONS = ['deadlines', 'projects', 'members', 'tasks'];
const PRESENCE_WINDOW_MS = 20000;

// ---------- In-memory (local dev), optionally persisted to a JSON file ----------
export class MemoryStore {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.version = 0;
    this.seen = new Map();
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, raw[c] || []]));
        this.version = raw.version || 1;
      } catch { this.data = null; }
    }
  }
  _save() {
    this.version += 1;
    if (!this.file) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => fs.writeFile(this.file, JSON.stringify({ ...this.data, version: this.version }, null, 2), () => {}), 50);
  }
  async seedIfEmpty(seedFn) { if (!this.data) { this.data = seedFn(); this._save(); } }
  async reset(seedFn) { this.data = seedFn(); this._save(); }
  async getAll() { return { ...structuredClone(this.data), version: this.version }; }
  async getVersion() { return this.version; }
  async get(coll, id) { return structuredClone(this.data[coll].find((x) => x.id === id) || null); }
  async put(coll, ...items) {
    for (const item of items) {
      const list = this.data[coll];
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item; else list.push(item);
    }
    this._save();
  }
  async del(coll, id) { this.data[coll] = this.data[coll].filter((x) => x.id !== id); this._save(); }
  async presence(clientId) {
    const now = Date.now();
    if (clientId) this.seen.set(clientId, now);
    for (const [k, t] of this.seen) if (now - t > PRESENCE_WINDOW_MS) this.seen.delete(k);
    return this.seen.size;
  }
}

// ---------- Upstash Redis over its REST API (Vercel) — no SDK needed ----------
export class RedisStore {
  constructor(url, token, prefix = 'qkh') {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.p = prefix;
  }
  key(name) { return `${this.p}:${name}`; }
  async pipeline(cmds) {
    const r = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error(`Redis error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    for (const x of out) if (x && x.error) throw new Error(`Redis: ${x.error}`);
    return out.map((x) => x.result);
  }
  async seedIfEmpty(seedFn) {
    const [ok] = await this.pipeline([['SET', this.key('seeded'), '1', 'NX']]);
    if (ok === 'OK') await this._write(seedFn());
  }
  async reset(seedFn) {
    await this.pipeline([['DEL', ...COLLECTIONS.map((c) => this.key(c))], ['SET', this.key('seeded'), '1']]);
    await this._write(seedFn());
  }
  async _write(data) {
    const cmds = [];
    for (const c of COLLECTIONS) {
      if (!data[c].length) continue;
      cmds.push(['HSET', this.key(c), ...data[c].flatMap((x) => [x.id, JSON.stringify(x)])]);
    }
    cmds.push(['INCR', this.key('ver')]);
    await this.pipeline(cmds);
  }
  async getAll() {
    const res = await this.pipeline([...COLLECTIONS.map((c) => ['HVALS', this.key(c)]), ['GET', this.key('ver')]]);
    const out = {};
    COLLECTIONS.forEach((c, i) => { out[c] = (res[i] || []).map((s) => JSON.parse(s)); });
    out.version = Number(res[COLLECTIONS.length]) || 0;
    return out;
  }
  async getVersion() {
    const [v] = await this.pipeline([['GET', this.key('ver')]]);
    return Number(v) || 0;
  }
  async get(coll, id) {
    const [v] = await this.pipeline([['HGET', this.key(coll), id]]);
    return v ? JSON.parse(v) : null;
  }
  async put(coll, ...items) {
    if (!items.length) return;
    await this.pipeline([['HSET', this.key(coll), ...items.flatMap((x) => [x.id, JSON.stringify(x)])], ['INCR', this.key('ver')]]);
  }
  async del(coll, id) {
    await this.pipeline([['HDEL', this.key(coll), id], ['INCR', this.key('ver')]]);
  }
  async presence(clientId) {
    const now = Date.now();
    const cmds = [];
    if (clientId) cmds.push(['ZADD', this.key('online'), String(now), clientId]);
    cmds.push(['ZREMRANGEBYSCORE', this.key('online'), '0', String(now - PRESENCE_WINDOW_MS)], ['ZCARD', this.key('online')]);
    const res = await this.pipeline(cmds);
    return Number(res[res.length - 1]) || 0;
  }
}

// Pick the store from the environment. Vercel's Upstash integration sets KV_REST_API_* or UPSTASH_REDIS_REST_*.
export function storeFromEnv({ file } = {}) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStore(url, token);
  return new MemoryStore(file);
}
