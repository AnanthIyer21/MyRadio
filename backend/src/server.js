// Zero-dependency HTTP server for the MyRadio MVP.
// Endpoints: GET /health, POST /api/onboarding, POST /api/session-plan,
//            POST /api/events, GET /api/profile/:userId
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Load backend/.env (if present) into process.env before anything reads keys — so you
// can enable Claude/OpenAI/ElevenLabs by pasting keys into one file, no shell exports.
(function loadEnv() {
  try {
    const p = fileURLToPath(new URL("../.env", import.meta.url));
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] != null) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* no .env / unreadable → use real env */ }
})();
import { detectContext } from "./context.js";
import { orchestrate, nextBatch } from "./agents/orchestrator.js";
import { getText } from "./lib/http.js";
import { extractArticle, cleanBookText } from "./lib/extract.js";
import { synthesize } from "./lib/tts.js";
import { loadProfiles, saveProfiles } from "./lib/store.js";
import { supabaseEnabled, getProfile as getProfileDB, saveProfile as saveProfileDB } from "./lib/supabase-store.js";
import { verifyUser, bearer } from "./lib/auth.js";
import { parseInterview } from "./lib/llm.js";

const PORT = process.env.PORT || 8787;

// Durable taste-profile store: loaded from disk on boot, saved on change, so learning
// (rewards + affinity) persists across restarts. (Sessions stay in-memory — they're
// the ephemeral candidate pool, rebuilt each run.)
const profiles = loadProfiles();

const defaultProfile = () => ({ rewards: {}, topics: [], musicVibes: [], genres: [], contexts: [], contentMix: { music: 40, news: 25, podcast: 20, audiobook: 15 } });

function getProfile(userId = "demo") {
  if (!profiles.has(userId)) profiles.set(userId, defaultProfile());
  return profiles.get(userId);
}

// Resolve WHO a request is for. With Supabase login enabled, a valid bearer token wins —
// that account id is the same on every device the user logs in from, so their feed follows
// them. Without a token (or with Supabase off) we fall back to the body's per-device id, so
// the app still works exactly as before for anonymous/keyless use.
async function resolveUser(req, body = {}) {
  if (supabaseEnabled()) {
    const u = await verifyUser(bearer(req));
    if (u) return { id: u.id, email: u.email, authed: true };
  }
  return { id: body.userId || "demo", email: null, authed: false };
}

// Load a user's profile. Logged-in users come from the cloud DB (cached in memory after the
// first read, mutated in place during a session, written back on save). Anonymous users use
// the local JSON store as before.
async function ensureProfile(user) {
  if (profiles.has(user.id)) return profiles.get(user.id);
  if (supabaseEnabled() && user.authed) {
    let data = null;
    try { data = await getProfileDB(user.id); } catch (e) { console.warn("[supabase] load failed:", e?.message || e); }
    const p = data || defaultProfile();
    profiles.set(user.id, p);
    return p;
  }
  return getProfile(user.id);
}

// Persist a user's profile: cloud DB for logged-in users (write-through), local JSON file
// for anonymous. Never throws — a DB blip must not break playback.
async function persistProfile(user) {
  if (supabaseEnabled() && user.authed) {
    try { await saveProfileDB(user.id, profiles.get(user.id), user.email); }
    catch (e) { console.warn("[supabase] save failed:", e?.message || e); }
  } else {
    saveProfiles(profiles);
  }
}

// Per-user radio session: the candidate pool + already-served ids, so refill
// batches (/api/next) continue from where the listener is instead of restarting.
const sessions = new Map();
function getSession(userId = "demo") {
  if (!sessions.has(userId)) sessions.set(userId, { pool: [], served: new Set() });
  return sessions.get(userId);
}

const REWARD = { play: 0.1, listen_30s: 0.2, complete: 0.4, like: 0.5, save: 0.6, replay: 0.5, skip: -0.3, fast_skip: -0.5, dislike: -0.6, report: -0.4 };

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET,POST" });
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "myradio-backend", version: "0.2.0" });
    }

    // Onboarding interview -> store taste profile -> return profile + first station.
    if (req.method === "POST" && url.pathname === "/api/onboarding") {
      const body = await readJson(req);
      const user = await resolveUser(req, body);
      const profile = await ensureProfile(user);
      // First login on a fresh account: carry the listener's existing per-device profile
      // (taste + learning + no-repeat history) over so they don't start from scratch.
      if (user.authed && body.migrateFrom && profiles.has(body.migrateFrom)) {
        const src = profiles.get(body.migrateFrom);
        const empty = !(profile.topics?.length || profile.keywords?.length || profile.name || Object.keys(profile.rewards || {}).length);
        if (src && empty) Object.assign(profile, src);
      }
      // Onboarding agent (workflow #3): when an API key is set, Claude parses the raw
      // free-text answers into the structured taste profile (better than the client's
      // keyword matching). With no key it returns null and we keep the client-derived
      // fields — the agentic path takes precedence but never blocks onboarding.
      const llmProfile = await parseInterview({
        name: body.name, interestsText: body.interestsText, musicText: body.musicText, whenText: body.whenText,
      }).catch(() => null);
      Object.assign(profile, {
        name: body.name || profile.name,
        topics: llmProfile?.topics?.length ? llmProfile.topics : (body.topics || profile.topics || []),
        keywords: llmProfile?.keywords?.length ? llmProfile.keywords : (body.keywords || profile.keywords || []),
        interestsText: body.interestsText || profile.interestsText || "", // raw interests → web-search phrases
        musicVibes: llmProfile?.musicVibes?.length ? llmProfile.musicVibes : (body.musicVibes || profile.musicVibes || []),
        genres: llmProfile?.genres?.length ? llmProfile.genres : (body.genres || profile.genres || []),
        contexts: llmProfile?.contexts?.length ? llmProfile.contexts : (body.contexts || profile.contexts || []),
        lengths: body.lengths || profile.lengths,
        spotify: body.spotify || profile.spotify, // top artists/genres context, when connected
        contentMix: body.contentMix || profile.contentMix,
      });
      const context = detectContext(body.signals || {});
      const plan = await orchestrate(profile, context, getSession(user.id));
      await persistProfile(user); // persist taste + the seen-news / played-music history written during the build
      return send(res, 200, { profile, context, ...plan });
    }

    if (req.method === "POST" && url.pathname === "/api/session-plan") {
      const body = await readJson(req);
      const user = await resolveUser(req, body);
      const context = detectContext(body.signals || {});
      const profile = await ensureProfile(user);
      const done = new Set(body.done || []); // serial episodes/books the listener has finished
      const plan = await orchestrate(profile, context, getSession(user.id), 4, done);
      await persistProfile(user);
      return send(res, 200, { context, ...plan });
    }

    // Continuous radio: serve the next batch from the session pool (refilling
    // from the agents when it runs low). Called by the client as the queue nears its end.
    if (req.method === "POST" && url.pathname === "/api/next") {
      const body = await readJson(req);
      const user = await resolveUser(req, body);
      const context = detectContext(body.signals || {});
      const profile = await ensureProfile(user);
      const done = new Set(body.done || []); // serial episodes/books the listener has finished
      const plan = await nextBatch(profile, context, getSession(user.id), body.n || 3, done);
      await persistProfile(user); // persist the updated seen-news / played-music history
      return send(res, 200, { context, ...plan });
    }

    if (req.method === "POST" && url.pathname === "/api/events") {
      const body = await readJson(req);
      const { itemId, type, itemType, itemTopic } = body;
      if (!itemId || !type) return send(res, 400, { error: "itemId and type required" });
      const user = await resolveUser(req, body);
      const profile = await ensureProfile(user);
      const w = REWARD[type] || 0;
      profile.rewards[itemId] = (profile.rewards[itemId] || 0) + w;
      // Generalize the signal: learn affinity for the item's content-type and
      // topic so future batches lean toward what's liked, away from what's skipped.
      profile.affinity ||= { type: {}, topic: {} };
      if (itemType) profile.affinity.type[itemType] = (profile.affinity.type[itemType] || 0) + w;
      if (itemTopic) profile.affinity.topic[itemTopic] = (profile.affinity.topic[itemTopic] || 0) + w;
      await persistProfile(user); // persist the learning signal so it survives restarts
      return send(res, 200, { ok: true, itemId, reward: profile.rewards[itemId], affinity: profile.affinity });
    }

    // Full readable text of a news article (for read-aloud / condensing).
    if (req.method === "GET" && url.pathname === "/api/article") {
      const target = url.searchParams.get("url");
      if (!/^https?:\/\//.test(target || "")) return send(res, 400, { error: "valid url required" });
      try {
        const text = extractArticle(await getText(target, 9000));
        return send(res, 200, { text });
      } catch (e) { return send(res, 200, { text: "", error: String(e?.message || e) }); }
    }

    // Public-domain book plain text (Project Gutenberg).
    if (req.method === "GET" && url.pathname === "/api/booktext") {
      const target = url.searchParams.get("url");
      if (!/^https?:\/\//.test(target || "")) return send(res, 400, { error: "valid url required" });
      try {
        const text = cleanBookText(await getText(target, 9000));
        return send(res, 200, { text });
      } catch (e) { return send(res, 200, { text: "", error: String(e?.message || e) }); }
    }

    // Text-to-speech: synthesize spoken narration as MP3 audio so the client can
    // play it through its <audio> element (reliable, unlike the browser Web Speech API).
    if (req.method === "POST" && url.pathname === "/api/tts") {
      const { text, lang } = await readJson(req);
      if (!text || typeof text !== "string") return send(res, 400, { error: "text required" });
      try {
        const audio = await synthesize(text.slice(0, 8000), { lang: lang || "en" });
        if (!audio.length) return send(res, 502, { error: "tts unavailable" });
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "content-length": audio.length,
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        return res.end(audio);
      } catch (e) { return send(res, 502, { error: String(e?.message || e) }); }
    }

    // Mint a short-lived Wispr Flow client access token from the org API key.
    // The browser uses this to open the dictation WebSocket directly (low latency).
    if (req.method === "GET" && url.pathname === "/api/wispr-token") {
      const key = process.env.WISPR_FLOW_API_KEY;
      const ws = process.env.WISPR_WS_URL || "wss://platform-api.wisprflow.ai/api/v1/dash/ws";
      if (!key) return send(res, 200, { configured: false });
      try {
        const r = await fetch("https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({ client_id: "myradio-web", duration_secs: 3600 }),
        });
        if (!r.ok) return send(res, 200, { configured: true, error: `token ${r.status}` });
        const j = await r.json();
        return send(res, 200, { configured: true, access_token: j.access_token, expires_in: j.expires_in, ws });
      } catch (e) {
        return send(res, 200, { configured: true, error: String(e?.message || e) });
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/profile/")) {
      const userId = decodeURIComponent(url.pathname.split("/").pop());
      return send(res, 200, getProfile(userId));
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => console.log(`MyRadio backend on http://localhost:${PORT}`));

export { server };
