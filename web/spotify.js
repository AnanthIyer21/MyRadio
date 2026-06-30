// Spotify connector — Authorization Code with PKCE (no client secret in the browser)
// + Web Playback SDK for full-track playback (Premium only). Exposes window.MyRadioSpotify.
// Falls back gracefully when no Client ID is set, not connected, or not Premium.
(function () {
  const CFG = window.MYRADIO_CONFIG || {};
  const CLIENT_ID = CFG.SPOTIFY_CLIENT_ID || "";
  // Auto-detect the redirect URI from wherever the app is served (location.origin) unless
  // explicitly overridden in config. So the SAME build works on 127.0.0.1:8080 locally AND
  // on https://pulsarla.com in production — just register BOTH origins in the Spotify
  // dashboard. (Uses origin only — no path/trailing slash — to match the registered URIs.)
  const REDIRECT = CFG.SPOTIFY_REDIRECT_URI || location.origin;
  const SCOPES = [
    "streaming", "user-read-email", "user-read-private",
    "user-read-playback-state", "user-modify-playback-state",
    "user-library-read", "playlist-read-private", "user-top-read",
    "user-read-recently-played",
  ].join(" ");
  const AUTH = "https://accounts.spotify.com/authorize";
  const TOKEN = "https://accounts.spotify.com/api/token";
  const LS = { at: "sp_at", rt: "sp_rt", exp: "sp_exp", cv: "sp_cv" };

  let player = null, deviceId = null, premium = false, ready = false;
  let stateCb = null;
  let lastError = "";

  // Capture the OAuth redirect params SYNCHRONOUSLY at script load, before any await.
  // The ?code lives in the URL only briefly after Spotify redirects back — privacy
  // extensions, the browser, or async boot delays can strip it before handleRedirect
  // runs, which silently aborts the login. Grabbing it here makes the flow robust.
  const _initial = new URLSearchParams(location.search);
  const CAPTURED_CODE = _initial.get("code");
  const CAPTURED_ERROR = _initial.get("error");

  const configured = () => !!CLIENT_ID;

  // ---- PKCE helpers ----
  const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (x) => ("0" + (x & 0xff).toString(16)).slice(-2)).join(""); };
  async function challenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  async function connect() {
    if (!configured()) { alert("Add your Spotify Client ID in web/config.js first (see the comments there)."); return; }
    const verifier = rand(48);
    localStorage.setItem(LS.cv, verifier);
    const params = new URLSearchParams({
      client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT,
      scope: SCOPES, code_challenge_method: "S256", code_challenge: await challenge(verifier),
    });
    location.href = `${AUTH}?${params}`;
  }

  async function exchange(code) {
    const verifier = localStorage.getItem(LS.cv) || "";
    if (!verifier) throw new Error("missing PKCE verifier — was 'Connect' clicked from a different origin (e.g. localhost vs 127.0.0.1)?");
    const body = new URLSearchParams({
      client_id: CLIENT_ID, grant_type: "authorization_code", code,
      redirect_uri: REDIRECT, code_verifier: verifier,
    });
    const r = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`token exchange failed (${r.status}): ${detail}`);
    }
    store(await r.json());
  }

  async function refresh() {
    const rt = localStorage.getItem(LS.rt);
    if (!rt) return false;
    const body = new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: rt });
    const r = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) return false;
    store(await r.json());
    return true;
  }

  function store(t) {
    if (t.access_token) localStorage.setItem(LS.at, t.access_token);
    if (t.refresh_token) localStorage.setItem(LS.rt, t.refresh_token);
    if (t.expires_in) localStorage.setItem(LS.exp, String(Date.now() + t.expires_in * 1000 - 30000));
  }

  async function token() {
    const at = localStorage.getItem(LS.at), exp = Number(localStorage.getItem(LS.exp) || 0);
    if (at && Date.now() < exp) return at;
    if (await refresh()) return localStorage.getItem(LS.at);
    return null;
  }

  const isConnected = () => !!localStorage.getItem(LS.at) || !!localStorage.getItem(LS.rt);

  async function api(path) {
    const at = await token(); if (!at) throw new Error("no token");
    const r = await fetch(`https://api.spotify.com/v1${path}`, { headers: { authorization: "Bearer " + at } });
    if (!r.ok) throw new Error(`spotify ${path} -> ${r.status}`);
    return r.json();
  }

  // ---- context hub: who is this listener on Spotify ----
  async function loadContext() {
    let me = null;
    try { me = await api("/me"); }
    catch { await new Promise((r) => setTimeout(r, 700)); try { me = await api("/me"); } catch {} }
    if (me) {
      premium = me.product === "premium";
      try { localStorage.setItem("sp_premium", premium ? "1" : "0"); localStorage.setItem("sp_name", me.display_name || ""); } catch {}
    } else {
      // Transient /me failure — keep the last known state instead of flipping to "free".
      premium = localStorage.getItem("sp_premium") === "1";
      me = { display_name: localStorage.getItem("sp_name") || "" };
    }
    const artists = (await api("/me/top/artists?limit=20").catch(() => ({ items: [] }))).items;
    const lists = (await api("/me/playlists?limit=20").catch(() => ({ items: [] }))).items;
    const genres = [...new Set(artists.flatMap((a) => a.genres || []))].slice(0, 12);
    const [topTracks, topShows] = await Promise.all([getTracks(artists), getShows()]);
    return {
      premium, displayName: me.display_name, genres,
      topArtists: artists.map((a) => a.name), playlists: lists.map((p) => p.name),
      topTracks, topShows,
    };
  }

  // Build a DEEP, varied playable pool from everywhere the listener has music — not just
  // their top 30. Sources: top tracks across all 3 time ranges, the entire saved/"liked"
  // library (paginated), recently played, and the tracks inside their playlists. Deduped by
  // URI *and* by song identity (title+artist) so the same song under different URIs (single
  // vs album vs playlist copy) can't reappear — that was the "same song again and again" bug.
  // Capped at MAX so a huge library stays bounded; fresh/empty accounts cascade to fallbacks.
  const TRACK_CAP = 800;
  async function getTracks(artists = []) {
    const out = [];
    const seenUri = new Set();
    const seenSong = new Set();      // normalized title|artist — kills same-song-different-uri
    const songKey = (x) => `${(x.name || "").toLowerCase().trim()}|${(x.artists?.[0]?.name || "").toLowerCase().trim()}`;
    const add = (arr) => {
      for (const x of arr) {
        if (out.length >= TRACK_CAP) return;
        // Only real, playable catalogue tracks (drop local files, podcast episodes, nulls).
        if (!x || !x.uri || !x.uri.startsWith("spotify:track:") || x.is_local) continue;
        const k = songKey(x);
        if (seenUri.has(x.uri) || seenSong.has(k)) continue;
        seenUri.add(x.uri); seenSong.add(k);
        out.push({ uri: x.uri, title: x.name, artist: x.artists?.[0]?.name || "" });
      }
    };

    // 1) Top tracks — all three time ranges (recent, 6-month, all-time), 50 each.
    const ranges = ["short_term", "medium_term", "long_term"];
    const tops = await Promise.all(ranges.map((r) =>
      api(`/me/top/tracks?limit=50&time_range=${r}`).catch(() => ({ items: [] }))));
    for (const t of tops) add(t.items || []);

    // 2) Recently played (last 50 distinct).
    add(((await api("/me/player/recently-played?limit=50").catch(() => ({ items: [] }))).items || []).map((i) => i.track).filter(Boolean));

    // 3) Saved / "Liked Songs" — paginate the whole library (bounded by TRACK_CAP).
    for (let off = 0; off < 1000 && out.length < TRACK_CAP; off += 50) {
      const page = (await api(`/me/tracks?limit=50&offset=${off}`).catch(() => ({ items: [] }))).items || [];
      add(page.map((i) => i.track).filter(Boolean));
      if (page.length < 50) break;
    }

    // 4) Playlists — pull tracks from the listener's playlists for breadth/variety.
    if (out.length < TRACK_CAP) {
      const lists = ((await api("/me/playlists?limit=50").catch(() => ({ items: [] }))).items || []).filter((p) => p && p.id);
      for (const pl of lists.slice(0, 25)) {
        if (out.length >= TRACK_CAP) break;
        const page = (await api(`/playlists/${pl.id}/tracks?limit=50&fields=${encodeURIComponent("items(track(uri,name,is_local,artists(name)))")}`).catch(() => ({ items: [] }))).items || [];
        add(page.map((i) => i.track).filter(Boolean));
      }
    }

    // Fallbacks for fresh/empty accounts (no listening history yet): artist top tracks, then search.
    if (out.length < 5) for (const a of artists.slice(0, 3)) {
      if (!a.id) continue;
      add(((await api(`/artists/${a.id}/top-tracks?market=from_token`).catch(() => ({ tracks: [] }))).tracks) || []);
      if (out.length >= 10) break;
    }
    if (out.length < 5) add(((await api("/search?type=track&limit=25&q=top%20hits").catch(() => ({ tracks: { items: [] } }))).tracks?.items) || []);

    return out;
  }

  // Search the catalogue for tracks matching the listener's stated vibe/genre, so the music
  // honours what they ASKED for (e.g. "upbeat electronic / lo-fi") even when it differs from
  // their top tracks. Each query carries an `energy` (audio-features is deprecated for new
  // apps, so we infer energy from the vibe term) — the player uses it to match context.
  // Returns tracks tagged { uri, title, artist, energy }.
  async function searchTracks(queries = [], perQuery = 20) {
    const out = []; const seen = new Set();
    const PAGE = 10;                      // Spotify search rejects limit > 10 ("Invalid limit"),
    const reqs = [];                      // so page through with offset to build a deep pool.
    queries.forEach((q, qi) => { for (let off = 0; off < perQuery; off += PAGE) reqs.push({ qi, off }); });
    const results = await Promise.all(reqs.map((rq) =>
      api(`/search?type=track&market=from_token&limit=${PAGE}&offset=${rq.off}&q=${encodeURIComponent(queries[rq.qi].q)}`).catch(() => null)
    ));
    results.forEach((r, idx) => {
      const energy = queries[reqs[idx].qi]?.energy ?? 0.5;
      for (const t of (r?.tracks?.items || [])) {
        if (!t?.uri || !t.uri.startsWith("spotify:track:") || t.is_local || seen.has(t.uri)) continue;
        seen.add(t.uri);
        out.push({ uri: t.uri, title: t.name, artist: t.artists?.[0]?.name || "", energy });
      }
    });
    return out;
  }

  // Latest episode from the listener's saved Spotify shows (podcasts).
  async function getShows() {
    const saved = (await api("/me/shows?limit=10").catch(() => ({ items: [] }))).items.map((i) => i.show).filter(Boolean);
    const out = [];
    for (const sh of saved.slice(0, 4)) {
      try { const ep = (await api(`/shows/${sh.id}/episodes?limit=1&market=from_token`)).items?.[0]; if (ep) out.push({ uri: ep.uri, title: ep.name, show: sh.name }); } catch {}
    }
    return out;
  }

  // Search the Spotify catalogue for shows matching the listener's interests, then pull
  // the latest episode from each. A far wider pool than saved shows alone — this is the
  // Premium "so many more podcasts" path. Playback is still Web-SDK only (Premium), so
  // callers gate on isPremium()/isReady().
  async function searchPodcasts(terms = [], perTerm = 3) {
    const uniq = [...new Set(terms.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length > 2))].slice(0, 5);
    if (!uniq.length) return [];
    // Find candidate shows across the interest terms (deduped by show id).
    const found = await Promise.all(uniq.map((q) =>
      api(`/search?type=show&market=from_token&limit=${perTerm}&q=${encodeURIComponent(q)}`).catch(() => null)
    ));
    const shows = new Map();
    for (const r of found) for (const sh of (r?.shows?.items || [])) if (sh?.id && !shows.has(sh.id)) shows.set(sh.id, sh);
    // Pull the latest episode from each distinct show, in parallel.
    const eps = await Promise.all([...shows.values()].slice(0, 12).map(async (sh) => {
      try { const ep = (await api(`/shows/${sh.id}/episodes?limit=1&market=from_token`)).items?.[0]; return ep ? { uri: ep.uri, title: ep.name, show: sh.name } : null; }
      catch { return null; }
    }));
    return eps.filter(Boolean);
  }

  // ---- Web Playback SDK (Premium full-track playback) ----
  function initPlayer() {
    return new Promise((resolve) => {
      if (ready) return resolve(true);
      const boot = () => {
        player = new window.Spotify.Player({ name: "MyRadio AI", getOAuthToken: (cb) => token().then((t) => cb(t)), volume: 0.8 });
        player.addListener("ready", ({ device_id }) => { deviceId = device_id; ready = true; resolve(true); });
        player.addListener("not_ready", () => {});
        player.addListener("player_state_changed", (s) => { if (stateCb) stateCb(s); });
        ["initialization_error", "authentication_error", "account_error"].forEach((ev) => player.addListener(ev, () => resolve(false)));
        player.connect();
        setTimeout(() => resolve(ready), 9000); // resolve anyway so boot never hangs
      };
      if (window.Spotify && window.Spotify.Player) return boot();
      window.onSpotifyWebPlaybackSDKReady = boot;
      const s = document.createElement("script"); s.src = "https://sdk.scdn.co/spotify-player.js"; document.head.appendChild(s);
    });
  }

  async function play(uri) {
    const at = await token(); if (!at) return false;
    if (!deviceId) await new Promise((r) => { const t0 = Date.now(); const iv = setInterval(() => { if (deviceId || Date.now() - t0 > 6000) { clearInterval(iv); r(); } }, 200); });
    if (!deviceId) return false;
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT", headers: { authorization: "Bearer " + at, "content-type": "application/json" },
      body: JSON.stringify({ uris: [uri] }),
    });
    return true;
  }
  const togglePlay = () => player && player.togglePlay();
  const seek = (ms) => player && player.seek(Math.max(0, ms));
  const getState = () => (player ? player.getCurrentState() : Promise.resolve(null));
  const pause = () => player && player.pause();

  // Cosmetic only: clear ?code from the address bar after we've captured it. Wrapped
  // because some privacy extensions/browsers remove history.replaceState — if that throws,
  // the login must still complete (the code is already captured in CAPTURED_CODE).
  function cleanUrl() { try { history.replaceState({}, "", REDIRECT); } catch { /* history API unavailable; harmless */ } }

  // Handle the redirect back from Spotify; returns true if a fresh login happened.
  async function handleRedirect() {
    // Use the params captured at script load, not the (possibly already-stripped) live URL.
    const err = CAPTURED_ERROR;
    const code = CAPTURED_CODE;
    if (err) {
      lastError = `Spotify declined the login: ${err}. (If the app is in Development mode, your Spotify account must be added under "User Management" in the dashboard.)`;
      cleanUrl();
      return false;
    }
    if (!code) return false;
    // Already hold a valid token (boot ran twice / reload)? Don't re-exchange a used code.
    if (localStorage.getItem(LS.at) && Date.now() < Number(localStorage.getItem(LS.exp) || 0)) { cleanUrl(); return true; }
    try { await exchange(code); cleanUrl(); return true; }
    catch (e) { lastError = String(e.message || e); console.warn("Spotify token exchange failed:", e); cleanUrl(); return false; }
  }

  window.MyRadioSpotify = {
    configured, connect, handleRedirect, isConnected, loadContext,
    initPlayer, play, pause, togglePlay, seek, getState,
    onState: (cb) => { stateCb = cb; },
    isPremium: () => premium, isReady: () => ready, lastError: () => lastError,
    search: (q, type = "track") => api(`/search?type=${type}&limit=10&q=${encodeURIComponent(q)}`),
    searchPodcasts, searchTracks,
  };
})();
