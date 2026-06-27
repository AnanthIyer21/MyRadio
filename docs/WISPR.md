# Wispr Flow Dictation

The onboarding interview's 🎙 buttons dictate with **Wispr Flow** when configured,
and fall back to the browser's built-in speech recognition otherwise.

## How it's wired

- **Token minting (server):** `GET /api/wispr-token` calls
  `POST https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token` with your
  org API key and returns a short-lived client `access_token` + the WebSocket URL.
  The API key never reaches the browser.
- **Streaming (browser):** `web/wispr.js` captures the mic, downsamples to 16kHz mono
  PCM, and streams base64 `append` packets over the Wispr WebSocket, appending each
  `body.text` transcript into the focused textarea. `stop()` sends `commit` and closes.

## Setup

1. Get an org API key (`fl-…`) from https://wisprflow.ai/developers
2. Put it in `backend/.env`:
   ```
   WISPR_FLOW_API_KEY=fl-xxxxxxxx
   # optional override if the host differs:
   # WISPR_WS_URL=wss://platform-api.wisprflow.ai/api/v1/dash/ws
   ```
3. Restart the backend. The 🎙 buttons now use Wispr Flow.

## Status / caveats

- Built to spec but **not yet tested end-to-end** (needs a real Wispr API key). Two
  things may need a quick tweak once we test with your key:
  - the exact **WebSocket host** (docs show a localhost example; we default to the
    `platform-api.wisprflow.ai` host used for token minting), and
  - **transcript merge** — we append each `body.text`; if Wispr sends cumulative text
    we'll switch to replace-in-place.
- Without a key, dictation uses the browser engine (Chrome/Safari) automatically.
