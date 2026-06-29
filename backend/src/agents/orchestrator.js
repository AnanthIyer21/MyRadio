// Orchestration agent — fans out to every specialist agent, builds a deep
// candidate POOL once, then serves short BATCHES from it so the station plays
// like continuous radio: a few items to start, more produced as the listener
// skips or listens on. Session state (pool + already-served ids) is held by the
// caller in a `session` object so it survives across batch requests.
import { newsAgent } from "./news.js";
import { podcastAgent } from "./podcasts.js";
import { audiobookAgent } from "./audiobooks.js";
import { musicAgent } from "./music.js";
import { scoreAndDiversify, explain } from "../planner.js";
import { generateScript } from "../lib/llm.js";

const AGENTS = [
  ["news", newsAgent],
  ["podcast", podcastAgent],
  ["audiobook", audiobookAgent],
  ["music", musicAgent],
];

// Fan out to all specialist agents in parallel → flat candidate list + per-agent counts.
async function fetchCandidates(profile, context) {
  const settled = await Promise.allSettled(AGENTS.map(([, fn]) => fn(profile, context)));
  const sources = {};
  const candidates = [];
  settled.forEach((r, i) => {
    const name = AGENTS[i][0];
    if (r.status === "fulfilled") { sources[name] = r.value.length; candidates.push(...r.value); }
    else sources[name] = 0;
  });
  return { candidates, sources };
}

// Producer pass over one batch: Claude writes a spoken segue per item and
// upgrades the blurbs to spoken summaries. `opening` greets the listener by name
// on the very first batch; continuation batches use natural transitions instead.
async function produce(batch, profile, context, opening) {
  try {
    const script = await generateScript(batch, { lengths: profile.lengths, context, profile, opening });
    if (script) for (const it of batch) {
      const s = script.get(it.id);
      if (!s) continue;
      if (s.segue) it.segue = s.segue;
      if (s.summary && it.type !== "music") it.summary = s.summary;
    }
  } catch { /* keep extractive summaries + static lead */ }
  return batch;
}

// Pull the next n items from the pool, score+diversify, and mark them served.
// Spoken content (news/podcast/audiobook) is never repeated within a session.
// Music cycles: play each distinct track once, then recycle when all are heard,
// so the catalogue varies instead of looping the single top-scored track.
function pickBatch(session, profile, context, n) {
  session.served ||= new Set();
  const pool = session.pool || [];

  const nonMusic = pool.filter((it) => it.type !== "music" && !session.served.has(it.id));
  let music = pool.filter((it) => it.type === "music" && !session.served.has(it.id));
  if (!music.length) {
    // All tracks heard — forget served music so the catalogue can play again.
    for (const it of pool) if (it.type === "music") session.served.delete(it.id);
    music = pool.filter((it) => it.type === "music");
  }

  const batch = scoreAndDiversify([...nonMusic, ...music], profile, context, n);
  for (const it of batch) session.served.add(it.id);
  // Keep all music in the pool (it recycles); drop served spoken content.
  session.pool = pool.filter((it) => it.type === "music" || !session.served.has(it.id));
  return batch;
}

// INITIAL station: build the pool and serve the first short batch.
export async function orchestrate(profile = {}, context = {}, session = {}, n = 4) {
  const { candidates, sources } = await fetchCandidates(profile, context);
  session.served = new Set();
  session.pool = candidates;
  session.sources = sources;
  const queue = await produce(pickBatch(session, profile, context, n), profile, context, true);
  return { mode: context.mode || "idle", explanation: explain(context.mode), queue, sources };
}

// CONTINUATION: serve the next batch, replenishing the pool from the agents when
// the fresh (non-music) supply runs low so the radio never dries up.
export async function nextBatch(profile = {}, context = {}, session = {}, n = 3) {
  session.served ||= new Set();
  session.pool ||= [];
  const freshSpoken = session.pool.filter((it) => it.type !== "music" && !session.served.has(it.id)).length;
  if (freshSpoken < n) {
    const { candidates } = await fetchCandidates(profile, context);
    const have = new Set(session.pool.map((it) => it.id));
    for (const c of candidates) if (!have.has(c.id)) session.pool.push(c);
  }
  const queue = await produce(pickBatch(session, profile, context, n), profile, context, false);
  return { mode: context.mode || "idle", explanation: explain(context.mode), queue };
}
