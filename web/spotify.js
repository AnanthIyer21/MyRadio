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
    const [artists, tracks, lists] = await Promise.all([
      api("/me/top/artists?limit=20").catch(() => ({ items: [] })),
      api("/me/top/tracks?limit=20").catch(() => ({ items: [] })),
      api("/me/playlists?limit=20").catch(() => ({ items: [] })),
    ]);
    const genres = [...new Set(artists.items.flatMap((a) => a.genres || []))].slice(0, 12);
    return {
      premium,
      displayName: me.display_name,
      genres,
      topArtists: artists.items.map((a) => a.name),
      playlists: lists.items.map((p) => p.name),
      topTracks: tracks.items.map((t) => ({ uri: t.uri, title: t.name, artist: t.artists?.[0]?.name || "" })),
    };
  }

  // ---- Web Playback SDK (Premium full-track playback) ----
  function initPlayer() {
    return new Promise((resolve) => {
      if (player) return resolve(true);
      const boot = () => {
        player = new window.Spotify.Player({
          name: "MyRadio AI",
          getOAuthToken: (cb) => token().then((t) => cb(t)),
          volume: 0.8,
        });
        player.addListener("ready", ({ device_id }) => { deviceId = device_id; ready = true; });
        player.addListener("player_state_changed", (s) => { if (stateCb) stateCb(s); });
        player.connect();
        resolve(true);
      };
      if (window.Spotify && window.Spotify.Player) return boot();
      window.onSpotifyWebPlaybackSDKReady = boot;
      const s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      document.head.appendChild(s);
    });
  }

  async function play(uri) {
    const at = await token(); if (!at || !deviceId) return false;
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
