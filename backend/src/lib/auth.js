// Verify a Supabase magic-link session token, so the backend can TRUST the account id a
// request claims. We don't decode/verify the JWT ourselves (Supabase may sign with a
// symmetric secret OR rotating asymmetric keys) — instead we ask Supabase's own
// /auth/v1/user endpoint, which validates the token for every signing method, and cache
// the (token -> user) result for a few minutes so /api/next doesn't pay a round-trip each
// call. Zero dependency: built-in fetch, same spirit as the rest of the backend.
// Read env at CALL time (see supabase-store.js): ESM import hoisting means these would be
// undefined if captured into module-load-time consts before loadEnv() runs.
const base = () => process.env.SUPABASE_URL;
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

const cache = new Map(); // token -> { user, at }
const TTL = 5 * 60 * 1000;

// Pull the bearer token out of an Authorization header.
export function bearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// Resolve a token to { id, email } or null. Cached; never throws.
export async function verifyUser(token, ms = 5000) {
  if (!token || !base() || !key()) return null;
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL) return hit.user;
  try {
    const r = await fetch(`${base()}/auth/v1/user`, {
      headers: { apikey: key(), authorization: "Bearer " + token },
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return null;
    const u = await r.json();
    const user = u?.id ? { id: u.id, email: u.email || null } : null;
    if (user) {
      cache.set(token, { user, at: Date.now() });
      if (cache.size > 5000) cache.clear(); // crude bound; tokens rotate anyway
    }
    return user;
  } catch { return null; }
}
