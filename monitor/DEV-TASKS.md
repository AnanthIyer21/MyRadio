# MyRadio — dev task queue (QA → dev session)

This is the actionable worklist the **dev session** consumes via its `/loop`.
The QA/monitor session appends tasks here from its probe + live-browser testing.

**Protocol**
- Dev session: implement the FIRST unchecked `- [ ]` task, verify it (loads with no
  console errors / relevant check passes), `git commit`, then change that line to
  `- [x]` with the commit hash and `git commit` the checkbox change. One task per loop.
- Only items in `web/` are for the dev session; backend items are handled by QA.
- Do NOT re-touch a `- [x]` item. If all are checked, do nothing.

---

## Open

- [ ] **(HIGH) Spoken summaries silently fail → only bed music, no narration.**
  `web/app.js` plays the ambient bed + advances the progress bar on independent
  timers that are never gated on speech actually starting, so any `speechSynthesis`
  hiccup yields music with no AI summary (progress bar still moves, so it looks fine).
  Fix in `startSpeakFrom` / `startPlayback`:
  1. Keep a module-level reference to the `SpeechSynthesisUtterance` (stop GC mid-speech).
  2. Don't call `speechSynthesis.cancel()` immediately before `speak()` in the same tick (cancel only in `stopPlayback`, or defer `speak()` a frame).
  3. Add `u.onerror` + a watchdog: if `onstart` hasn't fired within ~1.5s, retry once; else stop the bed and show "summary unavailable" instead of leaving music playing.
  4. Add a periodic `speechSynthesis.resume()` keepalive (~10s) to defeat Chrome's ~15s auto-pause that cuts long summaries to silence.
  5. Wait for voices (`onvoiceschanged`) before the first `speak()`.
  6. Only `startBed()` AFTER `onstart` fires; `stopBed()` on speech end/error.

- [ ] **(MED) Spotify Premium overrides the listener's stated music taste.**
  In `applyPlan` (`web/app.js`), every music item is replaced by plainly-shuffled
  Spotify top tracks regardless of the requested vibe/genres or the context energy
  (ask for "upbeat electronic/lo-fi", get unrelated top tracks). Rank/filter the
  Spotify pool by the requested vibe/genre and the item's energy before substituting.

- [ ] **(LOW) Queue rows always say "▶ audio".**
  `renderQueue` (`web/app.js`) renders a static "▶ audio" label on every row, even
  for spoken summaries (news/podcast/audiobook). Label by what each item actually
  plays: "audio" for music/full episode, "spoken" for summaries.

## Done

<!-- move completed tasks here as - [x] with commit hash -->
