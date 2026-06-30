# Accounts, login & data storage

## Where data lives today (beta)

| Data | Where | Persists? |
|---|---|---|
| Taste profile, rewards, learned affinity, **seen-news** (never-repeat), **played-music** (same-day) | `backend/data/profiles.json`, keyed by `userId` | ✅ survives restarts |
| Live radio session (candidate pool + served ids) | in-memory `sessions` map | ❌ ephemeral by design |
| Podcast/audiobook resume positions, same-day Spotify history, onboarding draft | browser `localStorage` | ✅ per browser |
| News / podcasts / audiobooks / music / LLM | fetched live from external APIs | not stored |

The backend is **already keyed by `userId`** everywhere (`getProfile(userId)`, per-user
sessions, per-user history). The only thing between "single shared account" and "real
multi-user" is **how `userId` is assigned**.

### Stage 1 — per-device id (DONE)
`web/app.js` now generates a stable UUID per browser (`localStorage: myradio_uid`) and
sends it as `userId`. So every browser already gets its **own** profile, learning and
no-repeat history instead of a shared `demo`. Not portable across devices — that's Stage 2.

## Stage 2 — real login + cloud database (Supabase + Google)

Goal: a user logs in (Google), and on any device they get the **same** profile, backed by
a real database. Recommended stack: **Supabase** = Postgres + Auth + row-level security in
one, and it slots straight into the existing `userId` design.

### One-time setup
1. **Create a Supabase project** (supabase.com) → Project Settings → API. Copy:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY` (server-only — never ship to the client)
   - `anon` public key → used by the browser login
2. **Create the table:** open the SQL editor, paste & run [`database/schema.sql`](../database/schema.sql).
3. **Enable Google login:** Supabase → Authentication → Providers → Google → on. It needs a
   Google OAuth client:
   - Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Web).
   - Authorized redirect URI = the callback Supabase shows you (`https://<ref>.supabase.co/auth/v1/callback`).
   - Put the client id/secret into Supabase's Google provider; also set `GOOGLE_CLIENT_ID` in `.env`.
4. **Backend env** (`backend/.env`): set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### Wiring the backend (adapter is ready)
`backend/src/lib/supabase-store.js` already implements `getProfile(userId)` /
`saveProfile(userId, data, email)` over Supabase, gated on `supabaseEnabled()`. To switch
the store over:
- In `server.js`, when `supabaseEnabled()`, load a user's profile via `await getProfile(id)`
  (fall back to the in-memory default if null) and `await saveProfile(id, profile, email)`
  where it currently calls `saveProfiles(profiles)`. This makes `getProfile` async — await it
  in the onboarding/session-plan/next/events handlers (they're already `async`). Keep
  `lib/store.js` (JSON) as the fallback when Supabase is off.
- A tiny per-request in-memory cache avoids a DB round-trip on every `/api/next`.

### Wiring the client (login)
- Add Supabase JS (or call the auth REST endpoint) and a **"Sign in with Google"** button.
- After auth, use `session.user.id` (the Supabase uid) as `USER` instead of the device UUID.
- **Migration:** on first login, send the old device-UUID profile so the backend copies it
  to the account id (so users don't lose their beta history). One `POST /api/onboarding`
  with the merged profile does it.
- For true end-to-end security, send the Supabase JWT in `Authorization` and have the
  backend verify it (Supabase JWKS) before trusting the `userId`.

### "Do users get their own database?"
No — and they shouldn't. **One** database, one `profiles` table, every row tagged by
`user_id`, with **row-level security** isolating each user to their own row. That's the
standard, scalable model (separate per-user databases are an enterprise/edge case).

### Alternatives to Supabase
- **SQLite** — zero-infra single-file DB on the server; good if you want a DB without a
  hosted service, but no built-in auth and single-machine only.
- **Clerk / Auth0 / Firebase Auth** — managed auth you pair with any database; more moving
  parts than Supabase's all-in-one.
