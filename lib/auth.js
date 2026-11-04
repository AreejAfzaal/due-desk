// Email + password accounts: scrypt password hashes, and a signed, HttpOnly session cookie.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'dd_session';
const SESSION_DAYS = 30;

// Locally a random secret is fine (you just sign in again after a restart). On Vercel it must be set,
// or every server instance would sign cookies with a different key.
const devSecret = crypto.randomBytes(32).toString('hex');
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return process.env.VERCEL ? '' : devSecret;
}
export const authProblem = () => (secret() ? null : 'Sign-in is not set up yet. Add SESSION_SECRET to the environment.');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

// ---------- passwords: "scrypt$salt$hash" ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${b64url(salt)}$${b64url(await scrypt(password, salt, 64))}`;
}
export async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = fromB64url(hash);
  const got = await scrypt(String(password), fromB64url(salt), expected.length);
  return crypto.timingSafeEqual(expected, got);
}
// compared against when the email doesn't exist, so a wrong email takes as long as a wrong password
export const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$' + b64url(Buffer.alloc(64));

// ---------- session cookie: base64url(JSON payload) + "." + HMAC ----------
const sign = (data) => b64url(crypto.createHmac('sha256', secret()).update(data).digest());

export function sessionCookie(user, { secure }) {
  const payload = b64url(JSON.stringify({ ...user, exp: Date.now() + SESSION_DAYS * 86400000 }));
  return cookieHeader(`${payload}.${sign(payload)}`, SESSION_DAYS * 86400, secure);
}
export const clearCookie = ({ secure }) => cookieHeader('', 0, secure);
function cookieHeader(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function readSession(cookieHeaderValue) {
  if (!secret()) return null;
  const raw = String(cookieHeaderValue || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload)), given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(fromB64url(payload));
    return s.exp > Date.now() ? { sub: s.sub, name: s.name, email: s.email } : null;
  } catch { return null; }
}
