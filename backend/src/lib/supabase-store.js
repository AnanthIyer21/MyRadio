// Optional Supabase-backed profile store (per-user rows in the `profiles` table).
//
// Gated on SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. When those are unset the server keeps
// using the local JSON store (lib/store.js) — so nothing changes until you opt in. Zero
// dependency: talks to Supabase's PostgREST API over built-in fetch (same spirit as the
// rest of the backend). The service-role key is SERVER-ONLY — never expose it to the client.
//
// Wiring (see docs/AUTH.md): swap server.js getProfile()/save to these async calls when
// supabaseEnabled(), keyed by the authenticated user id.
// Read env at CALL time, not module-load time: in ESM, imports are hoisted and evaluated
// BEFORE server.js's loadEnv() populates process.env from backend/.env. Capturing these into
// top-level consts froze them as undefined and silently disabled Supabase — the "profiles
// never persisted to the cloud" bug.
const base = () => process.env.SUPABASE_URL;
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseEnabled = () => !!(base() && key());

function headers(extra = {}) {
  const k = key();
  return { apikey: k, authorization: "Bearer " + k, "content-type": "application/json", ...extra };
}

// Fetch one user's profile blob, or null if they have no row yet.
export async function getProfile(userId, ms = 7000) {
  const url = `${base()}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=data`;
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`supabase get ${r.status}`);
  const rows = await r.json();
  return rows[0]?.data || null;
}

// Upsert the user's profile blob (insert or merge on user_id).
export async function saveProfile(userId, data, email = null, ms = 7000) {
  const url = `${base()}/rest/v1/profiles?on_conflict=user_id`;
  const body = JSON.stringify([{ user_id: userId, email, data }]);
  const r = await fetch(url, { method: "POST", headers: headers({ prefer: "resolution=merge-duplicates,return=minimal" }), body, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`supabase upsert ${r.status}`);
}
