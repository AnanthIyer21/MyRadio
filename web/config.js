// MyRadio client config.
// 1. Create a free app at https://developer.spotify.com/dashboard
// 2. In the app settings, add this exact Redirect URI: http://localhost:8080
// 3. Paste the app's Client ID below.
// Spotify Premium is required for full-track playback (Web Playback SDK);
// without it, MyRadio falls back to royalty-free music + iTunes podcasts.
window.MYRADIO_CONFIG = {
  SPOTIFY_CLIENT_ID: "", // <-- paste your Spotify app Client ID here
  SPOTIFY_REDIRECT_URI: "http://localhost:8080",
};
