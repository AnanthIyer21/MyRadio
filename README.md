# MyRadio AI

A **personal AI radio**. Open the app, tap one play button, and an agent-driven engine
builds a context-aware listening queue across **news, podcasts, audiobooks, and music** —
then learns from your play / skip / like / save feedback so the next queue gets better.

## The Bet

> Can the app learn what you want to hear *right now* better than a manual playlist or feed?

The MVP proves the passive, context-aware radio loop first. Full music replacement comes
later, after licensing.

## Repo Layout

```
MyRadio/
├── backend/
│   └── src/
│       ├── agents/        specialist agents + orchestrator
│       │   ├── news.js        RSS news, matched to the listener's topics
│       │   ├── podcasts.js     RSS episodes (real, playable audio)
│       │   ├── audiobooks.js   public-domain books via Gutendex
│       │   ├── music.js        royalty-free, directly playable tracks
│       │   └── orchestrator.js fans out to all agents, scores + diversifies
│       ├── lib/           http + rss helpers
│       ├── context.js     raw signals -> listening mode
│       ├── planner.js     scoring + diversification
│       └── server.js      REST API
├── web/              onboarding interview + audio player
├── docs/             product spec + architecture
├── ios/              (later) SwiftUI app
└── database/         (later) Postgres schema
```

## How It Works

1. The **onboarding interview** (web landing page) captures name, topics, music vibe, and listening contexts.
2. The **orchestrator agent** fans out to the news, podcast, audiobook, and music agents in parallel.
3. Each specialist agent fetches **real, live content** (Guardian RSS, Gutendex, royalty-free MP3s).
4. The **planner** scores every candidate (context-energy match + taste rewards + content-mix preference + freshness) and round-robins types into a balanced queue.
5. The player streams audio, and **like / save / skip / dislike** events update the taste profile so the next plan improves.

### API

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /api/onboarding` | interview answers → profile + first station |
| `POST /api/session-plan` | context-aware queue via the orchestrator |
| `POST /api/events` | play / skip / like / save / dislike feedback |
| `GET /api/profile/:userId` | current taste profile |

## Run The Backend

```bash
cd backend
npm install
npm start
```

API runs on `http://localhost:8787`. Health check: `GET /health`.

## Run The Web App

```bash
cd web && python3 -m http.server 8080   # then open http://localhost:8080
```

Start the backend too (above) for live content + personalization; without it the
app runs in a local demo mode that still plays music.

## Status

Working vertical slice: onboarding interview (topics, multi-select vibe + genres,
contexts) → orchestrated, **live** cross-format station → audio player with
seek, time-remaining, go-back / skip, and taste-learning feedback. News / podcast /
audiobook items can play as a **spoken AI summary** or in **full** (⚙ Settings).

See `docs/MVP_SPEC.md` for scope, `docs/ARCHITECTURE.md` for the agent design, and
`docs/VOICE_AND_TTS.md` for the summary + text-to-speech options (and how to upgrade
from the free browser voice to OpenAI TTS / ElevenLabs).

## Product Constraints (carry these through every feature)

- **Music** — start royalty-free / licensed; Spotify SDK only for Premium users; full licensing later.
- **Podcasts** — original RSS audio when allowed; AI summaries only when opted-in and legally safe.
- **Audiobooks** — public-domain first (LibriVox / Project Gutenberg / Gutendex).
- **News** — licensed APIs/RSS with mandatory source attribution; no broad scraping.
- **Personal data** — explicit consent for location, HealthKit, calendar, and contextual signals.
