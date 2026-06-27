# MyRadio MVP Spec

## Thesis

Not a Spotify replacement. A personal AI radio that proves one behavior:

> A user opens the app, taps one play button, and the station knows what they
> probably want to hear right now.

If users don't love that passive, context-aware experience, kill or rework the
idea before investing in licensing.

## Launch Scope

- **Platform:** iOS-first, with a browser demo for fast iteration.
- **Market:** invite-only TestFlight beta (Switzerland).
- **Language:** English first.
- **Monetization:** none during beta.

## Content Types

1. **News** — personalized briefings; source attribution required; APIs/RSS only.
2. **Podcasts** — discover/import; original RSS audio when available; optional AI summary.
3. **Audiobooks** — public-domain first (LibriVox + Gutendex); licensed catalogues later.
4. **Music** — royalty-free/licensed for everyone; Spotify SDK for Premium users only.

## Core Loop

1. User opens app.
2. Context engine detects situation (time, day, session length, inferred mode).
3. Session planner builds a cross-format queue.
4. User plays / skips / likes / dislikes / saves / reports.
5. Personalization agent updates the taste profile.
6. The next queue gets better.

## Feedback Signals

play · pause · skip · fast-skip · like · dislike · save · replay · completion ·
search · report-problem · manual prompt/dictation

## Context Signals

- **V1:** time of day, day of week, session length, inferred mode
  (commute / focus / workout / walking / evening / idle), headphones/car if available,
  approximate location *category* (not raw location by default).
- **Later:** Apple Health/Watch, calendar, Focus mode, weather, work context.

## Success Metrics

- Day-1 activation: 70%+ finish onboarding and start a station.
- Session starts: 4+ / week per beta user.
- Skip rate: < 35% after week 1.
- Save/like rate: 10%+ of played items.
- 7-day retention: 35%+.

## Kill Criteria

Pivot if beta users don't start sessions unprompted, don't use the one-button flow,
don't feel personalization improving, or don't prefer it over manual choosing.
