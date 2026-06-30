# Deploying MyRadio (so other people can use it)

Two pieces: the **backend** (Node API) on Render, and the **frontend** (static `web/`) on
Cloudflare Pages. The app works for visitors **anonymously** — login is optional and only
adds cross-device sync (and needs a verified email domain, which can come later).

Do the steps in order; step 2 needs the URL from step 1.

---

## 1. Backend → Render (free)

1. Go to https://render.com → sign up (use "Sign in with GitHub").
2. **New → Blueprint** → pick the `AnanthIyer21/MyRadio` repo. Render reads `render.yaml`.
   - (Or: **New → Web Service**, repo `MyRadio`, **Root Directory** `backend`,
     **Build** `npm install`, **Start** `node src/server.js`, plan **Free**.)
3. When prompted, paste the **environment variables** (copy the values from your local
   `backend/.env`):
   - `GROQ_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. **Create** and wait for it to go live. Copy the service URL, e.g.
   `https://myradio-backend.onrender.com`.
5. Sanity check: open `https://<your-backend>.onrender.com/health` → should show
   `{"ok":true,...}`.

> Free tier sleeps after ~15 min idle, so the first request after a nap takes ~30–60s to
> wake. Fine for testing; upgrade later for always-on.

## 2. Point the frontend at the backend

In `web/config.js`, set:

```js
API_BASE: "https://<your-backend>.onrender.com",
```

Commit and push (so Cloudflare picks it up):

```bash
git add web/config.js && git commit -m "Point frontend at deployed backend" && git push
```

## 3. Frontend → Cloudflare Pages (free)

1. https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** →
   pick `AnanthIyer21/MyRadio`.
2. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `web`
3. **Save and Deploy.** You get a URL like `https://myradio.pages.dev`.

## 4. Tell Supabase + Spotify about the new URL

Replace the old `pulsarla.com` entries with your real deployed URL (keep the local one).

- **Supabase** → Authentication → URL Configuration:
  - **Site URL:** `https://myradio.pages.dev`
  - **Redirect URLs:** add `https://myradio.pages.dev` (keep `http://127.0.0.1:8080`); remove `pulsarla.com`.
- **Spotify** dashboard → your app → Settings → Redirect URIs:
  - add `https://myradio.pages.dev` (keep `http://127.0.0.1:8080`); remove `pulsarla.com`.
  - (`SPOTIFY_REDIRECT_URI` in `config.js` is blank = auto-detects the current origin, so no code change needed.)

## 5. Share it

Send people `https://myradio.pages.dev`. They can build a station immediately (anonymous,
per-device profile). No login required to test.

---

## Later: login by email for *other* people
Magic-link emails to arbitrary recipients need a **verified sending domain** in Resend,
which needs a domain you own. Until then:
- visitors use the app without logging in, **or**
- you can hand specific testers a one-off login link.

When you get a domain: add it in Resend, add its DNS records, verify, then set the Supabase
SMTP sender to `login@yourdomain` and switch Supabase Site URL to your domain.
