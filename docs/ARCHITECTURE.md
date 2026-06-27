# Architecture

## Agents

| Agent | Responsibility |
|---|---|
| **Context** | Raw signals → labels (e.g. `morning_commute`, `focus_block`, `workout`). |
| **Session Planner** | Builds the next queue; balances relevance, freshness, novelty, licensing. |
| **Personalization** | Updates taste profile from explicit + implicit events; keeps per-context prefs separate from global taste. |
| **News** | Fetch by topic/source/region, dedupe into stories, generate cited radio scripts. |
| **Podcast** | Discover/import shows, fetch RSS audio, prepare summaries when allowed. |
| **Audiobook** | Ingest public-domain books/chapters, match to interests/context. |
| **Music** | Rank royalty-free tracks by genre/tempo/energy/mode; Spotify only for Premium. |
| **Voice Producer** | Text summaries → spoken audio (ElevenLabs), per-type voices, stored audio. |
| **Report Correction** | Handle bad-summary / wrong-source / boring / bad-voice reports → feedback to planner. |

## Flow (one session)

```
context signals → Context Agent → mode label
              ↓
content agents fetch/reuse candidates → Content Store
              ↓
Session Planner scores + diversifies (news/podcast/audiobook/music)
              ↓
Voice Producer prepares scripts or original audio URLs
              ↓
App plays item → feedback events → Personalization Agent → better next queue
```

## Scoring (MVP — intentionally simple)

```
score = taste_match + context_match + content_type_preference + freshness
      + explicit_reward + novelty_bonus
      - fast_skip_penalty - fatigue_penalty - license_unavailable_penalty
```

Upgrade path: replace linear scoring with a contextual bandit + pgvector embeddings
once enough real listening data exists.

## Build Roadmap

1. **Backend core** — context agent, session planner, personalization, in-memory store, REST API.
2. **Web demo** — exercise the full loop in the browser.
3. **Content adapters** — News (NewsAPI/Guardian), Podcasts (Listen Notes/RSS), Audiobooks (Gutendex), Music (royalty-free seed).
4. **Voice** — OpenAI summary → ElevenLabs TTS → audio storage.
5. **Persistence** — Postgres + pgvector, object storage for audio.
6. **iOS app** — SwiftUI, AVPlayer, onboarding, permissions, TestFlight.

## Recommended Services (when leaving local scaffold)

OpenAI · ElevenLabs · NewsAPI/Guardian · Listen Notes/Podcast Index · Gutendex ·
Neon/Supabase Postgres · Cloudflare R2/S3 · Upstash Redis · Temporal/Inngest · Sentry · PostHog.
