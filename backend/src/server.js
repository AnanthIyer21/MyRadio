// Zero-dependency HTTP server for the MyRadio MVP.
// Endpoints: GET /health, POST /api/onboarding, POST /api/session-plan,
//            POST /api/events, GET /api/profile/:userId
import { createServer } from "node:http";
import { detectContext } from "./context.js";
import { orchestrate } from "./agents/orchestrator.js";

const PORT = process.env.PORT || 8787;

// In-memory profile store (replace with Postgres later).
const profiles = new Map();

function getProfile(userId = "demo") {
  if (!profiles.has(userId)) profiles.set(userId, { rewards: {}, contentMix: { music: 40, news: 25, podcast: 20, audiobook: 15 } });
  return profiles.get(userId);
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
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" });
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "myradio-backend", version: "0.2.0" });
    }

    // Onboarding interview -> store taste profile -> return profile + first station.
    if (req.method === "POST" && url.pathname === "/api/onboarding") {
      const body = await readJson(req);
      const userId = body.userId || "demo";
      const profile = getProfile(userId);
      Object.assign(profile, {
        name: body.name || profile.name,
        topics: body.topics || profile.topics || [],
        musicVibe: body.musicVibe || profile.musicVibe,
        contexts: body.contexts || profile.contexts || [],
        contentMix: body.contentMix || profile.contentMix,
      });
      const context = detectContext(body.signals || {});
      const plan = await orchestrate(profile, context);
      return send(res, 200, { profile, context, ...plan });
    }

    if (req.method === "POST" && url.pathname === "/api/session-plan") {
      const body = await readJson(req);
      const context = detectContext(body.signals || {});
      const profile = getProfile(body.userId);
      const plan = await orchestrate(profile, context);
      return send(res, 200, { context, ...plan });
    }

    if (req.method === "POST" && url.pathname === "/api/events") {
      const { userId, itemId, type } = await readJson(req);
      if (!itemId || !type) return send(res, 400, { error: "itemId and type required" });
      const profile = getProfile(userId);
      profile.rewards[itemId] = (profile.rewards[itemId] || 0) + (REWARD[type] || 0);
      return send(res, 200, { ok: true, itemId, reward: profile.rewards[itemId] });
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
