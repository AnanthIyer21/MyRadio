// MyRadio client config.
// 1. Create a free app at https://developer.spotify.com/dashboard
// 2. In the app settings, add this EXACT Redirect URI: http://127.0.0.1:8080
//    (Spotify no longer allows "localhost" — you must use the loopback IP 127.0.0.1.)
// 3. Paste the app's Client ID below.
// 4. IMPORTANT: open the web app at http://127.0.0.1:8080 (not localhost) so the
//    origin matches the redirect URI.
// Spotify Premium is required for full-track playback (Web Playback SDK);
// without it, MyRadio falls back to royalty-free music + iTunes podcasts.
window.MYRADIO_CONFIG = {
  SPOTIFY_CLIENT_ID: "4b27d1b7c74841cfa13ff4d6ec757ae2",
  SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8080",
};
