# Architecture

> The tables below describe the **conceptual agent design**. The Mermaid diagrams in
> [System Diagrams (as-built)](#system-diagrams-as-built) document what the code actually
> does today; [Suggested Improvements](#suggested-improvements) lists where they diverge and
> what to do about it.

## System Diagrams (as-built)

### 1. Deployment topology

The backend never calls Spotify — Spotify is entirely client-side; the browser folds the
user's derived top-artists/genres into the onboarding payload. Every external provider is
optional and key-gated, with a deterministic keyless fallback.

```mermaid
flowchart TB
    subgraph Browser["🌐 Browser — static web/ (Cloudflare Pages / 127.0.0.1:8080)"]
        UI["index.html · app.js · spotify.js<br/>auth.js · wispr.js · config.js"]
    end

    subgraph Backend["⚙️ Render — myradio-backend (node:http, zero-dep, :8787)"]
        API["server.js REST API"]
        ORCH["orchestrator + agents<br/>planner · context"]
        API --> ORCH
    end

    subgraph Spotify["🎵 Spotify (client-side only)"]
        SPAUTH["accounts.spotify.com<br/>authorize + token (PKCE)"]
        SPAPI["api.spotify.com/v1"]
        SPSDK["Web Playback SDK<br/>(Premium)"]
    end

    subgraph Data["🗄️ Supabase"]
        SBAUTH["Auth — magic link"]
        SBDB["Postgres — profiles (JSONB)"]
    end

    subgraph Ext["🔌 External content & AI (all key-gated)"]
        RSS["RSS: BBC/NPR/Guardian/…<br/>Google News RSS"]
        ITUNES["iTunes Search (podcasts)"]
        LIBRI["LibriVox (audiobooks)"]
        MUSIC["SoundHelix (royalty-free)"]
        LLM["LLM: Groq llama-3.3-70b<br/>│ Anthropic claude-haiku-4-5"]
        TTS["TTS: ElevenLabs │ OpenAI<br/>│ Google translate_tts (free)"]
        EMB["Embeddings: Gemini │ OpenAI"]
    end

    UI -- "REST /api/*" --> API
    UI -- "PKCE OAuth" --> SPAUTH
    UI -- "Web API" --> SPAPI
    UI -- "full-track playback" --> SPSDK
    UI -- "magic-link login" --> SBAUTH
    UI -- "voice token via /api/wispr-token" --> WISPR["Wispr Flow (WebSocket dictation)"]

    ORCH --> RSS & ITUNES & LIBRI & MUSIC & LLM & TTS & EMB
    API -- "service-role key" --> SBDB
```

### 2. Backend request pipeline

```mermaid
flowchart TB
    IN["HTTP request"] --> ROUTES{"server.js router"}
    ROUTES --> H1["/health"]
    ROUTES --> H2["POST /api/onboarding"]
    ROUTES --> H3["POST /api/session-plan · /api/next"]
    ROUTES --> H4["POST /api/events (feedback)"]
    ROUTES --> H5["GET /api/article · /api/booktext"]
    ROUTES --> H6["POST /api/tts"]
    ROUTES --> H7["GET /api/profile/:userId · /api/wispr-token"]

    H2 --> PARSE["parseInterview (LLM)"]
    PARSE --> CTX["context.js detectContext()<br/>→ mode: morning_commute / workout /<br/>focus_block / evening_wind_down / idle"]
    H3 --> CTX
    CTX --> PLAN["planSources (LLM) picks agents"]

    PLAN --> FANOUT{{"Promise.allSettled — parallel fan-out"}}
    FANOUT --> NEWS["news.js (RSS + Google News)"]
    FANOUT --> POD["podcasts.js (iTunes → RSS audio)"]
    FANOUT --> BOOK["audiobooks.js (LibriVox)"]
    FANOUT --> MUS["music.js (royalty-free catalogue)"]

    NEWS & POD & BOOK & MUS --> SCORE["planner.js scoreAndDiversify()<br/>contextMatch + reward + typePref +<br/>freshness + type/topic affinity<br/>→ smooth weighted round-robin"]
    SCORE --> ARR["arrangeShow (LLM) running order"]
    ARR --> PROD["produce(): enrichBatch fetches real<br/>bodies → generateScript writes segues +<br/>length-matched spoken summaries"]
    PROD --> OUT["{ mode, explanation, queue, sources }"]

    H4 --> REWARD["update profile.rewards +<br/>affinity.{type,topic}"]
    OUT & REWARD --> STORE{"store selection"}
    STORE -->|"Supabase env set"| SB["supabase-store.js (JSONB upsert)"]
    STORE -->|"else"| FILE["store.js (local JSON)"]
```

### 3. End-to-end session (login → station → playback → learning)

```mermaid
sequenceDiagram
    actor U as User
    participant W as web/app.js
    participant SP as Spotify (client)
    participant B as Backend
    participant X as Content/LLM/TTS

    U->>W: open app (force 127.0.0.1, read DEVICE_ID)
    W->>B: GET /health
    opt logged in
        W->>B: magic-link session → Authorization: Bearer
    end
    opt Spotify connect
        W->>SP: PKCE authorize → token
        SP-->>W: top artists / genres, Premium?
    end
    U->>W: onboarding (typed or Wispr voice)
    W->>B: POST /api/onboarding {profile, signals, spotify}
    B->>B: resolveUser → parseInterview → detectContext
    B->>X: fan-out agents + LLM plan/script
    X-->>B: real content + spoken show
    B-->>W: profile + first station
    loop playback
        U->>W: ▶ play item
        alt music (Premium)
            W->>SP: Web Playback SDK full track
        else news/pod/book
            W->>B: GET /api/article or /api/booktext
            W->>B: POST /api/tts → MP3 (ambient bed)
        end
        U->>W: like / skip / save
        W->>B: POST /api/events → update taste
        Note over W: queue runs low
        W->>B: POST /api/next → replenish
        B-->>W: smarter next batch
    end
```

### 4. Identity tiers & profile migration

```mermaid
flowchart LR
    subgraph Anon["Anonymous"]
        DEV["DEVICE_ID (uuid)<br/>local JSON store"]
    end
    subgraph Acct["Logged-in"]
        UID["Supabase account id<br/>profiles.data JSONB (cross-device)"]
    end
    DEV -- "first login: migrateFrom device→cloud" --> UID

    RESOLVE["resolveUser():<br/>valid bearer token → account id<br/>else body.userId → device id<br/>else 'demo'"]
```

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

## Suggested Improvements

Ordered roughly by leverage. Each notes the concrete gap in today's code.

### Reliability & correctness
1. **No TTS/content caching → duplicate cost + latency.** `POST /api/tts` re-synthesizes the
   same narration on every play/refresh, and `enrichBatch` re-fetches article bodies. Add a
   content-addressed cache (hash of text/URL → object storage for MP3, short-TTL in-memory or
   Redis for article bodies). This is the single biggest cost and latency win.
2. **Render free tier cold-starts (~30–60s).** First request after idle stalls onboarding.
   Add a cheap keep-warm cron (the existing `monitor/` job could ping `/health`), and show a
   "waking up" state in the client instead of a silent hang.
3. **`sessions` Map is in-process and unbounded.** Session pools live only in one Node process
   (lost on restart/redeploy, and Render may run >1 instance later) and never evict. Move
   session state into Supabase or Redis with a TTL, or at minimum cap + LRU-evict the Map.
4. **No timeout/circuit-breaker budget on fan-out.** `Promise.allSettled` waits on the slowest
   RSS/LLM call; one slow feed drags the whole plan. Wrap each agent call in a per-source
   timeout (`AbortSignal.timeout`) and degrade to whatever returned in time.
5. **LLM/TTS output isn't validated before playback.** `generateScript` output is trusted; a
   malformed or over-length script degrades the show silently. Validate against the JSON schema
   already used in `llm.js` and fall back to the extractive summary on mismatch.

### Security & privacy
6. **CORS is `access-control-allow-origin: *`.** Fine while anonymous, but once magic-link
   tokens flow it lets any origin call the API with a stolen token. Restrict to the known
   frontend origins (Cloudflare Pages + localhost).
7. **No rate limiting or abuse protection on the backend.** Every endpoint fans out to paid
   LLM/TTS providers unauthenticated — a trivial abuse vector. Add per-IP/per-user token-bucket
   limiting on `/api/onboarding`, `/api/next`, `/api/tts`.
8. **`/api/tts` is an open synthesis proxy.** It will synthesize arbitrary posted text on your
   ElevenLabs/OpenAI bill. Gate it behind a session/user and cap length + daily quota.

### Architecture & scale
9. **Server-side embeddings/ranking exists but nothing is persisted.** `embeddings.js` computes
   vectors per request and throws them away. Store them in Supabase **pgvector** so news dedup
   and semantic ranking work across sessions and get cheaper over time — this is the natural
   bridge to the "contextual bandit + pgvector" upgrade path already noted above.
10. **Taste state is one JSONB blob.** Simple and good for now, but read-modify-write on the
    whole profile races under concurrent events and can't be queried analytically. When events
    grow, split an append-only `events` table from the derived `profile` snapshot.
11. **Producer LLM calls are on the hot path and serial-ish.** `planSources` → agents →
    `arrangeShow` → `generateScript` runs on every plan. Prefetch the *next* batch during
    playback (the client already does `ensureAhead`; move more of that work server-side and
    cache it) so refills feel instant.
12. **Provider selection is implicit (first key wins).** `provider()` silently picks Groq over
    Anthropic. Make it explicit via a `LLM_PROVIDER` env and log the resolved provider/model at
    boot so deploys are debuggable.

### Observability
13. **No structured logging, metrics, or error tracking.** Add request logging with timing per
    stage (context → fan-out → score → produce), and wire Sentry/PostHog (already on the
    recommended list) so skips, cold-starts, and provider failures are visible in production.
14. **CI covers the loop but not the providers.** `monitor/` exercises onboarding→playback
    keyless; add a smoke test that runs one plan with each provider key set to catch API/schema
    drift (e.g. an Anthropic Messages API change) before users hit it.
