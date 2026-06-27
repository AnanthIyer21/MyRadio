# Voice, Summaries & TTS

MyRadio summarizes news / podcasts / audiobooks and reads the summary aloud.
That's two separate jobs: **generate the summary text** and **speak it**.

## What's wired up today (zero keys, zero cost)

- **Summary text** = the source's own abstract (RSS standfirst / book subjects),
  trimmed by `backend/src/lib/summary.js`.
- **Voice** = the **browser's built-in speech engine** (Web Speech API,
  `speechSynthesis`). Runs client-side, free, works offline. Quality is "OS voice".

Per-type playback is chosen in the player's ⚙ Settings: **AI summary (spoken)**
vs **Full** (full article text / full episode audio).

## Upgrade path — better summaries

Replace `toSummary()` with an LLM call so summaries are genuinely generated
(condensed, neutral, radio-style) rather than just the source blurb.

| Tool | Notes |
|---|---|
| **OpenAI** `gpt-4o-mini` | Cheap, fast, great for summarize/condense. Needs `OPENAI_API_KEY`. |
| **Anthropic Claude Haiku** | Cheap, fast alternative. |

## Upgrade path — better voices (real TTS)

| Tool | Quality | Cost | Notes |
|---|---|---|---|
| **Browser Web Speech** | ★★ | free | In use now. No key, no network. |
| **OpenAI TTS** (`gpt-4o-mini-tts`) | ★★★★ | ~$15 / 1M chars | Simple API, natural voices, fast. Easiest first paid upgrade. |
| **ElevenLabs** | ★★★★★ | from ~$5/mo | Best quality, custom/branded host voices per content type. The product's intended production voice. |
| **Google / Azure / Polly** | ★★★–★★★★ | low | Cheap, many languages; good if you're already on that cloud. |

**Recommendation:** keep browser TTS for the local demo; for the beta, generate
summaries with `gpt-4o-mini` and speak them with **OpenAI TTS** (one vendor, one
key) — then move to **ElevenLabs** when you want distinctive per-type host voices.
Pre-generate audio server-side and cache it (R2/S3) so it isn't re-synthesized per play.

Keys go in `backend/.env` (see `.env.example`): `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`,
and the `ELEVENLABS_*_VOICE_ID` per content type.

## Content sources (current)

- **News** — multi-outlet RSS (BBC, NPR, TechCrunch, Ars Technica, The Guardian),
  matched to onboarding topics. Spoken Guardian bulletins are treated as **news with audio**, not podcasts.
- **Podcasts** — real shows discovered via the **iTunes Search API** (free, no key),
  latest episode audio pulled from each show's RSS.
- **Audiobooks** — public-domain catalogue via **Gutendex** (Project Gutenberg).
- **Music** — royalty-free, directly playable tracks (SoundHelix), tagged by vibe + genre + energy.

### On "podcasts from YouTube"

Not wired up, and not a quick add: YouTube has no legal direct-audio endpoint.
Pulling audio needs server-side `yt-dlp`-style extraction, which is brittle and
runs against YouTube's Terms of Service. The clean path to "more podcasts" is the
iTunes Search API (already integrated) and, later, the Podcast Index / Listen Notes
APIs — these index essentially the whole open-podcast ecosystem with proper RSS audio.
