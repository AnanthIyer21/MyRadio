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
├── backend/          Node API: context, planner, personalization, content agents
│   ├── src/
│   └── package.json
├── docs/             Product spec + architecture
├── web/              (later) browser demo client
├── ios/              (later) SwiftUI app
└── database/         (later) Postgres schema
```

## Run The Backend

```bash
cd backend
npm install
npm start
```

API runs on `http://localhost:8787`. Health check: `GET /health`.

## Status

Early scaffold — fresh start. Backend exposes a health check and a stubbed
session-plan endpoint. See `docs/MVP_SPEC.md` for scope and `docs/ARCHITECTURE.md`
for the agent design and build roadmap.

## Product Constraints (carry these through every feature)

- **Music** — start royalty-free / licensed; Spotify SDK only for Premium users; full licensing later.
- **Podcasts** — original RSS audio when allowed; AI summaries only when opted-in and legally safe.
- **Audiobooks** — public-domain first (LibriVox / Project Gutenberg / Gutendex).
- **News** — licensed APIs/RSS with mandatory source attribution; no broad scraping.
- **Personal data** — explicit consent for location, HealthKit, calendar, and contextual signals.
