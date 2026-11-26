// Verifies the Cloudflare Access login token that Access adds to every request
// for a protected path (header Cf-Access-Jwt-Assertion). The admin API refuses
// any request without a valid token, even if Access is misconfigured.
//
// Environment variables:
//   ACCESS_TEAM_DOMAIN  e.g. "furniswap.cloudflareaccess.com"
//   ACCESS_AUD          the Access application's "Application Audience (AUD) tag"
//   ADMIN_EMAILS        optional comma-separated allow-list, checked in addition to Access

let jwksCache = null; // { keys, fetchedAt, team }

export async function verifyAccess(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = String(env.ACCESS_AUD || '');
  if (!team || !aud) return { ok: false, status: 503, error: 'Admin login is not configured yet.' };

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || readCookie(request, 'CF_Authorization');
  if (!jwt) return { ok: false, status: 401, error: 'Please log in.' };

  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, error: 'Invalid login token.' };

  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]));
    payload = JSON.parse(b64urlDecodeText(parts[1]));
  } catch {
    return { ok: false, status: 401, error: 'Invalid login token.' };
  }
  if (header.alg !== 'RS256') return { ok: false, status: 401, error: 'Invalid login token.' };

  const key = await getKey(team, header.kid);
  if (!key) return { ok: false, status: 401, error: 'Invalid login token.' };

  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    b64urlDecodeBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, status: 401, error: 'Invalid login token.' };

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, status: 403, error: 'Login is for a different application.' };
  if (payload.iss !== `https://${team}`) return { ok: false, status: 403, error: 'Login issuer mismatch.' };
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return { ok: false, status: 401, error: 'Login expired. Please refresh the page.' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return { ok: false, status: 401, error: 'Login not valid yet.' };

  const email = String(payload.email || '').toLowerCase();
  if (!email) return { ok: false, status: 403, error: 'Login has no email address.' };
  const allow = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(email)) return { ok: false, status: 403, error: 'This email is not allowed.' };

  return { ok: true, email };
}

async function getKey(team, kid) {
  const fresh = jwksCache && jwksCache.team === team && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (!fresh || !jwksCache.keys.has(kid)) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const data = await res.json();
    const keys = new Map();
    for (const jwk of data.keys || []) {
      if (jwk.kty !== 'RSA') continue;
      const key = await crypto.subtle.importKey(
        'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
      );
      keys.set(jwk.kid, key);
    }
    jwksCache = { keys, fetchedAt: Date.now(), team };
  }
  return jwksCache.keys.get(kid) || null;
}

function readCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function b64urlDecodeBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeText(s) {
  return new TextDecoder().decode(b64urlDecodeBytes(s));
}
