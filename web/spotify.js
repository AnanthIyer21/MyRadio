// Spotify connector — Authorization Code with PKCE (no client secret in the browser)
// + Web Playback SDK for full-track playback (Premium only). Exposes window.MyRadioSpotify.
// Falls back gracefully when no Client ID is set, not connected, or not Premium.
(function () {
  const CFG = window.MYRADIO_CONFIG || {};
  const CLIENT_ID = CFG.SPOTIFY_CLIENT_ID || "";
  const REDIRECT = CFG.SPOTIFY_REDIRECT_URI || (location.origin + location.pathname);
  const SCOPES = [
    "streaming", "user-read-email", "user-read-private",
    "user-read-playback-state", "user-modify-playback-state",
    "user-library-read", "playlist-read-private", "user-top-read",
  ].join(" ");
  const AUTH = "https://accounts.spotify.com/authorize";
  const TOKEN = "https://accounts.spotify.com/api/token";
  const LS = { at: "sp_at", rt: "sp_rt", exp: "sp_exp", cv: "sp_cv" };

  let player = null, deviceId = null, premium = false, ready = false;
  let stateCb = null;

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
    const body = new URLSearchParams({
      client_id: CLIENT_ID, grant_type: "authorization_code", code,
      redirect_uri: REDIRECT, code_verifier: localStorage.getItem(LS.cv) || "",
    });
    const r = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) throw new Error("token exchange failed");
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
    const me = await api("/me");
    premium = me.product === "premium";
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

  // Robust playable-track set — fresh accounts have no "top tracks", and some catalog
  // endpoints are deprecated for new apps, so cascade: top -> saved -> artist top -> search.
  async function getTracks(artists = []) {
    let t = (await api("/me/top/tracks?limit=30").catch(() => ({ items: [] }))).items;
    if (t.length < 5) t = t.concat((await api("/me/tracks?limit=30").catch(() => ({ items: [] }))).items.map((i) => i.track).filter(Boolean));
    if (t.length < 5) for (const a of artists.slice(0, 3)) {
      if (!a.id) continue;
      t = t.concat(((await api(`/artists/${a.id}/top-tracks?market=from_token`).catch(() => ({ tracks: [] }))).tracks) || []);
      if (t.length >= 10) break;
    }
    if (t.length < 5) t = t.concat(((await api("/search?type=track&limit=25&q=top%20hits").catch(() => ({ tracks: { items: [] } }))).tracks?.items) || []);
    const seen = new Set();
    return t.filter((x) => x && x.uri && !seen.has(x.uri) && seen.add(x.uri)).map((x) => ({ uri: x.uri, title: x.name, artist: x.artists?.[0]?.name || "" }));
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

  // Handle the redirect back from Spotify; returns true if a fresh login happened.
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (p.get("code")) {
      try { await exchange(p.get("code")); } catch (e) { console.warn(e); }
      history.replaceState({}, "", REDIRECT);
      return true;
    }
    return false;
  }

  window.MyRadioSpotify = {
    configured, connect, handleRedirect, isConnected, loadContext,
    initPlayer, play, pause, togglePlay, seek, getState,
    onState: (cb) => { stateCb = cb; },
    isPremium: () => premium, isReady: () => ready,
    search: (q, type = "track") => api(`/search?type=${type}&limit=10&q=${encodeURIComponent(q)}`),
  };
})();
