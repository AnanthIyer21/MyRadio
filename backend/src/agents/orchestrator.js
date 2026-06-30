// Orchestration agent — fans out to every specialist agent, builds a deep
// candidate POOL once, then serves short BATCHES from it so the station plays
// like continuous radio: a few items to start, more produced as the listener
// skips or listens on. Session state (pool + already-served ids) is held by the
// caller in a `session` object so it survives across batch requests.
import { newsAgent } from "./news.js";
import { podcastAgent } from "./podcasts.js";
import { audiobookAgent } from "./audiobooks.js";
import { musicAgent } from "./music.js";
import { scoreAndDiversify, scoreItem, explain } from "../planner.js";
import { generateScript, planSources, arrangeShow } from "../lib/llm.js";
import { enrichBatch } from "../lib/content.js";

const AGENTS = [
  ["news", newsAgent],
  ["podcast", podcastAgent],
  ["audiobook", audiobookAgent],
  ["music", musicAgent],
];

// Fan out to the chosen specialist agents in parallel → flat candidate list +
// per-agent counts. The producer (planSources) picks which sources to pull for the
// current context — like a producer deciding which desks to call — so we don't
// always fetch all four. With no API key it returns null and we fan out to all of them.
async function fetchCandidates(profile, context) {
  let chosen = AGENTS;
  const types = await planSources(profile, context).catch(() => null);
  if (types && types.length) {
    const picked = AGENTS.filter(([name]) => types.includes(name));
    if (picked.length) chosen = picked;
  }
  const settled = await Promise.allSettled(chosen.map(([, fn]) => fn(profile, context)));
  const sources = {};
  for (const [name] of AGENTS) sources[name] = 0; // unfetched types report 0
  const candidates = [];
  settled.forEach((r, i) => {
    const name = chosen[i][0];
    if (r.status === "fulfilled") { sources[name] = r.value.length; candidates.push(...r.value); }
  });
  return { candidates, sources };
}

// Producer pass over one batch: Claude writes a spoken segue per item and
// upgrades the blurbs to spoken summaries. `opening` greets the listener by name
// on the very first batch; continuation batches use natural transitions instead.
async function produce(batch, profile, context, opening) {
  try {
    // Summary agent step 1: enrich each item with its real content (article body,
    // book opening, episode notes) so the summary condenses the piece, not the teaser.
    await enrichBatch(batch);
    const script = await generateScript(batch, { lengths: profile.lengths, context, profile, opening });
    if (script) for (const it of batch) {
      const s = script.get(it.id);
      if (!s) continue;
      if (s.segue) it.segue = s.segue;
      // Mark LLM-written summaries so the client speaks them verbatim (already at the
      // listener's target length) instead of re-trimming the source text itself.
      if (s.summary && it.type !== "music") { it.summary = s.summary; it.summarized = true; }
    }
  } catch { /* keep extractive summaries + static lead */ }
  return batch;
}

// Select + order `n` items from the available set. The producer (arrangeShow)
// sequences a show arc from the strongest candidates; with no API key / on failure
// it falls back to the deterministic score + smooth round-robin (unchanged behaviour).
async function selectBatch(available, profile, context, n, opening, credit) {
  if (available.length <= 1) return available.slice(0, n);
  // Hand the producer a bounded menu of the strongest candidates so the prompt stays
  // cheap; it picks and orders from these. Fallback ranks the full set the old way.
  const ranked = available
    .map((it) => ({ it, score: scoreItem(it, profile, context) }))
    .sort((a, b) => b.score - a.score);
  const menu = ranked.slice(0, Math.max(n * 4, 16)).map((r) => r.it);

  const ids = await arrangeShow(menu, { n, context, profile, opening }).catch(() => null);
  if (ids && ids.length) {
    const byId = new Map(menu.map((it) => [it.id, it]));
    const picked = ids.map((id) => byId.get(id)).filter(Boolean).slice(0, n);
    if (picked.length) return picked;
  }
  // Pass the session's persistent round-robin credit so low-weight types (audiobooks)
  // aren't starved batch after batch.
  return scoreAndDiversify(available, profile, context, n, credit);
}

// Pull the next n items from the pool and mark them served.
// News is one-shot: each AI summary plays once. Podcast/audiobook are SERIAL — the
// real content plays in length-segments and the client resumes its saved position
// next time, so they recur (the same one until the listener finishes it: "finish one
// then next") rather than being consumed. Music recycles once the catalogue is heard.
const DAY_MS = 86400000;
async function pickBatch(session, profile, context, n, opening, done = new Set()) {
  session.served ||= new Set();
  const pool = session.pool || [];
  const now = Date.now();
  // Persistent history (survives restarts via the profile store):
  //   seenNews   id -> ts : a news story, once served, is NEVER served again.
  //   playedMusic id -> ts: a track can't play again within the same 24h.
  profile.seenNews ||= {};
  profile.playedMusic ||= {};
  profile.seenSerial ||= {};   // finished podcasts/audiobooks — NEVER served again
  // Remember every serial the client reports finished, so it stays gone even if the
  // browser's localStorage is later cleared (server-side never-repeat).
  for (const id of done) profile.seenSerial[id] = now;
  const finishedSerial = (id) => done.has(id) || profile.seenSerial[id];
  const playedToday = (it) => profile.playedMusic[it.id] && (now - profile.playedMusic[it.id] < DAY_MS);

  // News: never repeat — exclude anything already served this session OR ever seen before.
  const news = pool.filter((it) => it.type === "news" && !session.served.has(it.id) && !profile.seenNews[it.id]);

  // Serial (podcast/audiobook): expose only the current (first NOT-finished) one of each
  // type, so the same one resumes until done, then the next — and a finished one never
  // comes back (don't-repeat, persisted in seenSerial).
  const serial = [];
  for (const type of ["podcast", "audiobook"]) {
    const current = pool.find((it) => it.type === type && !finishedSerial(it.id));
    if (current) serial.push(current);
  }

  // Music: no same-day repeats while fresh tracks remain. Tiers: not-served-this-session
  // & not-today → then any not-today → then (catalogue exhausted today) least-recently-played.
  let music = pool.filter((it) => it.type === "music" && !session.served.has(it.id) && !playedToday(it));
  if (!music.length) {
    for (const it of pool) if (it.type === "music") session.served.delete(it.id);
    music = pool.filter((it) => it.type === "music" && !playedToday(it));
  }
  if (!music.length) {
    music = pool.filter((it) => it.type === "music").sort((a, b) => (profile.playedMusic[a.id] || 0) - (profile.playedMusic[b.id] || 0));
  }

  session.credit ||= {}; // persistent round-robin credit so audiobooks/podcasts aren't starved
  const batch = await selectBatch([...news, ...serial, ...music], profile, context, n, opening, session.credit);
  for (const it of batch) {
    if (it.type === "news") { session.served.add(it.id); profile.seenNews[it.id] = now; }      // never again
    else if (it.type === "music") { session.served.add(it.id); profile.playedMusic[it.id] = now; } // not again today
  }
  pruneHistory(profile);
  // Drop served news from the pool; keep music + serials so they come back around.
  session.pool = pool.filter((it) => !(it.type === "news" && session.served.has(it.id)));
  return batch;
}

// Bound the persisted history so it can't grow forever: keep the most recent ~5000
// seen-news ids (a track only has ~16-N music ids, no pruning needed there).
function pruneHistory(profile) {
  const ids = Object.keys(profile.seenNews);
  if (ids.length > 6000) {
    const keep = ids.sort((a, b) => profile.seenNews[b] - profile.seenNews[a]).slice(0, 4000);
    const next = {};
    for (const id of keep) next[id] = profile.seenNews[id];
    profile.seenNews = next;
  }
}

// INITIAL station: build the pool and serve the first short batch.
export async function orchestrate(profile = {}, context = {}, session = {}, n = 4, done = new Set()) {
  const { candidates, sources } = await fetchCandidates(profile, context);
  session.served = new Set();
  session.pool = candidates;
  session.sources = sources;
  const queue = await produce(await pickBatch(session, profile, context, n, true, done), profile, context, true);
  return { mode: context.mode || "idle", explanation: explain(context.mode), queue, sources };
}

// CONTINUATION: serve the next batch, replenishing the pool from the agents when the
// fresh ONE-SHOT (news) supply runs low so the radio never dries up. Serials recur
// on their own, so they don't drive refills.
export async function nextBatch(profile = {}, context = {}, session = {}, n = 3, done = new Set()) {
  session.served ||= new Set();
  session.pool ||= [];
  const seen = profile.seenNews || {};
  // Count only UNSEEN, unserved news — once a story's been shown it never repeats, so
  // refill the moment fresh stories run low (this also keeps the all-day feed flowing).
  const freshNews = session.pool.filter((it) => it.type === "news" && !session.served.has(it.id) && !seen[it.id]).length;
  if (freshNews < n) {
    const { candidates } = await fetchCandidates(profile, context);
    const have = new Set(session.pool.map((it) => it.id));
    for (const c of candidates) if (!have.has(c.id) && !(c.type === "news" && seen[c.id])) session.pool.push(c);
  }
  const queue = await produce(await pickBatch(session, profile, context, n, false, done), profile, context, false);
  return { mode: context.mode || "idle", explanation: explain(context.mode), queue };
}
