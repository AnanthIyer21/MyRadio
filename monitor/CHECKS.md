# MyRadio monitor — check registry

This is the living spec the background agent reads each run. When the agent learns
something new about the app (a new endpoint, a new failure mode it caught, a feature
that should be guarded), it adds a row here and, where possible, a real assertion in
`check.mjs` or a unit test in `backend/test/`.

## Active checks (implemented in `check.mjs`)

| # | Check | Severity | What "working" means |
|---|-------|----------|----------------------|
| 1 | `unit tests` | critical | `node --test` passes in `backend/` |
| 2 | `web static syntax` | critical | `app.js`, `spotify.js`, `wispr.js`, `config.js` parse with `node --check` |
| 3 | `backend boots + /health` | critical | server starts and `/health` returns `{ok:true}` |
| 4 | `onboarding → first station` | critical | `POST /api/onboarding` returns a non-empty queue |
| 5 | `session-plan` | critical | `POST /api/session-plan` returns ≥3 items spanning ≥2 formats |
| 6 | `content playable` | warn | sampled `audioUrl`s return 200/206 with an audio content-type |
| 7 | `feedback loop` | critical | `POST /api/events` (like) raises the item's reward in the profile |
| 8 | `deployed /health` | critical | only runs if `MYRADIO_HEALTH_URL` is set (for when MyRadio ships) |

## Backlog — checks to add as the app grows

- [ ] Spotify connect flow doesn't 500 when `SPOTIFY_CLIENT_ID` is unset (graceful degrade).
- [ ] `/api/wispr-token` returns `{configured:false}` cleanly with no API key.
- [ ] `/api/article` and `/api/booktext` extract non-empty text from a known-good URL.
- [ ] News items are fresh (published within N days) and match the listener's topics.
- [ ] Audiobook items point at real Gutendex text, not a dead book id.
- [ ] Queue has no duplicate items / no immediate same-type repetition (regression from `f8d5d65`).
- [ ] Once deployed: deployed `/health` + a smoke session-plan against the live URL.

## How the agent evolves this file

On each run, after reporting status, the agent may:
1. If it found a NEW failure mode, add a guard for it (here + a test) so it can't regress silently.
2. If a backlog item is now easy to implement, move it into `check.mjs` and mark it active.
3. Keep edits small and propose them on a branch / PR — never auto-push to `main`.
