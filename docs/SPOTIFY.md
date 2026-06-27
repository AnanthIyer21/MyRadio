# Spotify Connect

Premium listeners can connect Spotify so MyRadio plays **full tracks from their own
library** and feeds their **top artists / genres / playlists** into the context hub
(used to rank music and podcasts). Everyone else falls back to royalty-free music +
iTunes podcasts automatically.

## One-time setup (you)

1. Go to the **Spotify Developer Dashboard**: https://developer.spotify.com/dashboard
2. **Create app** → any name/description. For "Which API/SDKs are you planning to use?"
   tick **Web Playback SDK** (Web API access comes with every app — if its checkbox is
   greyed/locked you can ignore it; it isn't required to get a Client ID).
3. In the app's **Settings → Redirect URIs**, add **exactly**:
   ```
   http://127.0.0.1:8080
   ```
   ⚠️ Spotify rejects `http://localhost` as "not secure" — you must use the loopback IP
   `127.0.0.1`. HTTP is allowed for `127.0.0.1` specifically.
4. Copy the **Client ID** and paste it into `web/config.js`:
   ```js
   window.MYRADIO_CONFIG = { SPOTIFY_CLIENT_ID: "PASTE_HERE", SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8080" };
   ```
   (No client secret — the browser uses the secure PKCE flow.)
5. **Open the app at `http://127.0.0.1:8080`** (not `localhost`) so the page origin
   matches the redirect URI.

## Using it

- Build a station, then click **Connect Spotify** (top-right of the player).
- Log in and approve. You'll bounce back and your station rebuilds automatically.
- **Premium** → music plays as full tracks via the Web Playback SDK; ±10s seek and the
  progress bar drive Spotify directly.
- **Free account** → MyRadio stays on royalty-free music; your genres still inform ranking.

## How it's wired

- `web/spotify.js` — Authorization Code + PKCE login, token refresh, Web Playback SDK,
  and the context calls (`/me`, `/me/top/artists`, `/me/top/tracks`, `/me/playlists`).
- `web/app.js` — swaps royalty-free music for the listener's Spotify top tracks when
  Premium is connected, and routes play/pause/seek to the SDK.

## Limits / next steps

- Full playback **requires Premium** (Spotify's rule, not ours).
- Spotify **podcast episode** playback is reachable via the same SDK but not yet wired
  into the queue — iTunes podcasts remain the default. Adding "play my Spotify shows"
  is a follow-up.
- For deployment beyond localhost, add your real redirect URI to the Spotify app and
  to `config.js`.
