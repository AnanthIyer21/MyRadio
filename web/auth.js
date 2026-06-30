// MyRadio accounts — passwordless "magic link" login via Supabase Auth (no SDK, just the
// REST endpoints over fetch, same approach as spotify.js). Exposes window.MyRadioAuth.
//
// Flow: user types email -> we ask Supabase to email them a one-time link -> they click it
// -> the link returns to this page with the session tokens in the URL hash -> we store them
// and the user is logged in. The account id (uid) becomes the userId the app sends, so the
// listener's profile + feed follow them to any device they log in from.
//
// Gated on SUPABASE_URL + SUPABASE_ANON_KEY in config.js — when those are blank the whole
// login UI stays hidden and the app runs anonymously (per-device id), exactly as before.
(function () {
  const CFG = window.MYRADIO_CONFIG || {};
  const BASE = CFG.SUPABASE_URL || "";
  const ANON = CFG.SUPABASE_ANON_KEY || "";               // safe to expose (public anon key)
  const REDIRECT = location.origin + location.pathname;    // magic link returns here
  const LS = { at: "sb_at", rt: "sb_rt", exp: "sb_exp", uid: "sb_uid", email: "sb_email" };

  const configured = () => !!(BASE && ANON);

  function store(t) {
    if (!t) return;
    if (t.access_token) localStorage.setItem(LS.at, t.access_token);
    if (t.refresh_token) localStorage.setItem(LS.rt, t.refresh_token);
    if (t.expires_in) localStorage.setItem(LS.exp, String(Date.now() + Number(t.expires_in) * 1000 - 30000));
    const u = t.user;
    if (u?.id) { localStorage.setItem(LS.uid, u.id); if (u.email) localStorage.setItem(LS.email, u.email); }
  }
  function clear() { for (const k of Object.values(LS)) localStorage.removeItem(k); }

  // Email the listener a one-time login link.
  async function sendLink(email) {
    if (!configured()) throw new Error("accounts not configured");
    // redirect_to MUST be a QUERY param on the OTP endpoint — a body field is silently
    // ignored, which makes Supabase fall back to the project's Site URL (the bug that sent
    // the link to pulsarla.com instead of back here). create_user lets new emails sign up.
    const r = await fetch(`${BASE}/auth/v1/otp?redirect_to=${encodeURIComponent(REDIRECT)}`, {
      method: "POST",
      headers: { apikey: ANON, "content-type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!r.ok) throw new Error(`couldn't send link (${r.status}): ${(await r.text().catch(() => "")).slice(0, 140)}`);
    return true;
  }

  // On page load: capture session tokens the magic link left in the URL hash. Returns true
  // if a fresh login just happened (so the app can run the one-time profile migration).
  function handleRedirect() {
    if (!configured()) return false;
    const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    const p = new URLSearchParams(raw);
    const at = p.get("access_token");
    if (at) {
      // Fresh login: drop any previously-cached identity so loadUser re-resolves THIS token's
      // user (otherwise a stale sb_uid from an earlier account would keep showing).
      localStorage.removeItem(LS.uid); localStorage.removeItem(LS.email);
      store({ access_token: at, refresh_token: p.get("refresh_token"), expires_in: p.get("expires_in") || 3600 });
      clean();
      return true;
    }
    if (p.get("error") || p.get("error_description")) { lastError = p.get("error_description") || p.get("error"); clean(); }
    return false;
  }
  let lastError = "";
  // Strip the tokens from the address bar. Prefer replaceState (no "#" left behind); if the
  // History API is unavailable, fall back to clearing the hash directly so the token never
  // lingers in the URL.
  function clean() {
    try { history.replaceState({}, "", REDIRECT); return; } catch { /* fall through */ }
    try { location.hash = ""; } catch { /* give up — cosmetic only */ }
  }

  async function refresh() {
    const rt = localStorage.getItem(LS.rt);
    if (!rt) return false;
    try {
      const r = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST", headers: { apikey: ANON, "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) return false;
      store(await r.json());
      return true;
    } catch { return false; }
  }

  // A valid access token (refreshing if the stored one expired), or null if logged out.
  async function token() {
    const at = localStorage.getItem(LS.at), exp = Number(localStorage.getItem(LS.exp) || 0);
    if (at && Date.now() < exp) return at;
    if (await refresh()) return localStorage.getItem(LS.at);
    return null;
  }

  // Ensure we know the uid/email for the stored session (backfills from /auth/v1/user once).
  async function loadUser() {
    const at = await token();
    if (!at) return null;
    const uid = localStorage.getItem(LS.uid);
    if (uid) return { id: uid, email: localStorage.getItem(LS.email) };
    try {
      const r = await fetch(`${BASE}/auth/v1/user`, { headers: { apikey: ANON, authorization: "Bearer " + at } });
      if (r.ok) { const u = await r.json(); if (u?.id) { store({ user: u }); return { id: u.id, email: u.email }; } }
    } catch { /* offline — caller falls back to anonymous */ }
    return null;
  }

  const currentUser = () => { const id = localStorage.getItem(LS.uid); return id ? { id, email: localStorage.getItem(LS.email) } : null; };
  function signOut() { clear(); }

  window.MyRadioAuth = { configured, sendLink, handleRedirect, token, loadUser, currentUser, signOut, lastError: () => lastError };
})();
