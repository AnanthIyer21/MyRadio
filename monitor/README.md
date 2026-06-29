# MyRadio background monitor

An agent that checks MyRadio is working — runs the tests, boots the backend, exercises
the real listening loop (onboarding → session-plan → playable audio → feedback), and
reports. Quiet when healthy; alerts when something breaks.

## Run it yourself

```bash
node monitor/check.mjs          # readable report, exit code 0 = healthy, 1 = critical failure
node monitor/check.mjs --json   # JSON report (what the agent consumes)
```

No dependencies, no setup. It boots the backend on port 8799 (override with `CHECK_PORT`)
and tears it down when done.

## How it runs in the background

Two layers share the one script above:

1. **Deterministic core — `check.mjs`.** All the pass/fail logic lives in code so results
   are reproducible and cheap. This is the source of truth.

2. **Agent wrapper.** A Claude run executes `check.mjs --json`, then on failure: triages
   the root cause from the failing step, notifies (Slack + email draft), writes a report
   under `monitor/reports/`, and may add a new guard to `CHECKS.md` / `check.mjs`.

### Always-on (cloud schedule)

A scheduled cloud agent (cron) clones the repo, runs the wrapper on an interval, and
notifies on failure — works even when your laptop is off. See the setup the assistant
created via the `/schedule` skill.

### Local (laptop on)

```
/loop 30m run node monitor/check.mjs and alert me only if it fails
```

Runs every 30 min while a Claude Code session is open.

## UX probe (find real "using the site" bugs)

`ux-probe.mjs` drives the API the way the web client does and flags issues a *user*
would hit — garbled text read aloud, Gutenberg license spoken as an audiobook,
placeholder/seed content in a live station, malformed media URLs, missing fields.

```bash
node monitor/ux-probe.mjs          # prints findings + rewrites monitor/HANDOFF.md
node monitor/ux-probe.mjs --json
```

It writes [`monitor/HANDOFF.md`](./HANDOFF.md) — the handoff the dev session reads for
prioritized recommendations. The file is git-ignored (regenerated locally).

### After every commit
`bash monitor/install-hooks.sh` installs a `post-commit` hook that re-runs the probe in
the background and refreshes `HANDOFF.md` after each commit by either session. In CI the
`ux` job does the same on every push and Slacks any high/med findings (advisory — it
never blocks the build).

## Checks

See [`CHECKS.md`](./CHECKS.md) for the live registry and the backlog of checks to add.

## Notifications

- **Slack** — failure summary to your DM/channel.
- **Email** — a Gmail draft addressed to you with the report (the Gmail tool drafts; you send).
- **Report file** — full markdown under `monitor/reports/<timestamp>.md`, always written.
- Healthy runs stay silent (only the report file is updated).
