// MyRadio client config.
// 1. Create a free app at https://developer.spotify.com/dashboard
// 2. In the app settings, add this EXACT Redirect URI: http://127.0.0.1:8080
//    (Spotify no longer allows "localhost" — you must use the loopback IP 127.0.0.1.)
// 3. Paste the app's Client ID below.
// 4. IMPORTANT: open the web app at http://127.0.0.1:8080 (not localhost) so the
//    origin matches the redirect URI.
// Spotify Premium is required for full-track playback (Web Playback SDK);
// without it, MyRadio falls back to royalty-free music + iTunes podcasts.
// Accounts (optional): paste your Supabase project URL + PUBLIC anon key to turn on
// passwordless "magic link" login, so users get the SAME personalised feed on any device.
// Leave blank to run anonymously (per-device profile), exactly as before. Setup: create a
// free project at https://supabase.com, run database/schema.sql, then copy Project URL +
// the anon (public) key from Settings → API. The anon key is safe in the browser; the
// service-role key is NOT — it goes only in backend/.env.
window.MYRADIO_CONFIG = {
  SPOTIFY_CLIENT_ID: "4b27d1b7c74841cfa13ff4d6ec757ae2",
  // Leave blank → auto-detects the current origin (127.0.0.1:8080 locally, pulsarla.com in
  // production). Register BOTH origins as Redirect URIs in the Spotify dashboard. Only set a
  // value here to force one specific origin.
  SPOTIFY_REDIRECT_URI: "",
  SUPABASE_URL: "https://dxlmkclyqxrdmgpgtnxp.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Znvk5O3jCnWHJbXaD4-UDg_tg3mUOCM",  // publishable key — safe in the browser
  // Deployed backend URL (used when the site is served from anywhere except localhost).
  API_BASE: "https://myradio-backend.onrender.com",
};
