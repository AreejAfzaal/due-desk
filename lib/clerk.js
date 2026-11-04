// Clerk authentication without an SDK: the browser sends Clerk's short-lived session token
// as "Authorization: Bearer <token>". We check its RS256 signature against the instance's
// public keys (JWKS) and its claims, then look the user up in Clerk's Backend API once.
import crypto from 'node:crypto';

export function clerkConfig() {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || '';
  const secretKey = process.env.CLERK_SECRET_KEY || '';
  return { publishableKey, secretKey, frontendApi: frontendApiFromKey(publishableKey) };
}

// pk_test_<base64("example.clerk.accounts.dev$")> -> "example.clerk.accounts.dev"
export function frontendApiFromKey(pk) {
  const part = String(pk).split('_')[2];
  if (!part) return '';
  try { return Buffer.from(part, 'base64').toString('utf8').replace(/\$$/, ''); } catch { return ''; }
}

export function clerkProblem() {
  const c = clerkConfig();
  if (!c.publishableKey || !c.frontendApi) return 'Sign-in is not set up yet. Add CLERK_PUBLISHABLE_KEY to the environment.';
  if (!c.secretKey) return 'Sign-in is not set up yet. Add CLERK_SECRET_KEY to the environment.';
  return null;
}

let jwks = null, jwksAt = 0;
async function publicKey(kid, frontendApi) {
  const stale = !jwks || Date.now() - jwksAt > 6 * 3600e3 || !jwks.some((k) => k.kid === kid);
  if (stale) {
    const r = await fetch(`https://${frontendApi}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`JWKS ${r.status}`);
    jwks = (await r.json()).keys || [];
    jwksAt = Date.now();
  }
  const jwk = jwks.find((k) => k.kid === kid);
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Returns the token's claims, or null if it isn't a valid, current session token for this Clerk instance.
export async function verifyClerkToken(token, { origin } = {}) {
  const { frontendApi } = clerkConfig();
  if (!token || !frontendApi) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64json(parts[0]), claims = b64json(parts[1]);
    if (header.alg !== 'RS256') return null;
    const key = await publicKey(header.kid, frontendApi);
    if (!key) return null;
    const good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!good) return null;
    const nowSec = Math.floor(Date.now() / 1000), skew = 10;
    if (!claims.sub || !claims.exp || claims.exp < nowSec - skew) return null;
    if (claims.nbf && claims.nbf > nowSec + skew) return null;
    if (claims.iss !== `https://${frontendApi}`) return null;
    // azp is the site the token was made for; reject tokens minted for another site
    if (claims.azp && origin && claims.azp !== origin) return null;
    return claims;
  } catch { return null; }
}

// Name and primary email for a Clerk user id, from Clerk's Backend API.
export async function fetchClerkUser(userId) {
  const { secretKey } = clerkConfig();
  const r = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Clerk users API ${r.status}`);
  const u = await r.json();
  const primary = (u.email_addresses || []).find((e) => e.id === u.primary_email_address_id) || (u.email_addresses || [])[0];
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || (primary ? primary.email_address.split('@')[0] : 'Student');
  return { email: primary ? primary.email_address.toLowerCase() : '', name };
}
