// Orchestration agent — fans out to every specialist agent in parallel, then
// scores + diversifies their candidates into one context-aware queue.
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

export async function orchestrate(profile = {}, context = {}, n = 6) {
  const settled = await Promise.allSettled(AGENTS.map(([, fn]) => fn(profile, context)));

  const sources = {};
  const candidates = [];
  settled.forEach((r, i) => {
    const name = AGENTS[i][0];
    if (r.status === "fulfilled") {
      sources[name] = r.value.length;
      candidates.push(...r.value);
    } else {
      sources[name] = 0;
    }
  });

  const queue = scoreAndDiversify(candidates, profile, context, n);

  // Producer pass: one Claude call over the ordered queue writes a spoken segue
  // (DJ intro) per item and upgrades the extractive blurbs to spoken summaries.
  // Only the queue (not every candidate), so it stays cheap. Falls back to the
  // static client-side lead + extractive item.summary if no key or on error.
  try {
    const script = await generateScript(queue, { lengths: profile.lengths, context, profile });
    if (script) for (const it of queue) {
      const s = script.get(it.id);
      if (!s) continue;
      if (s.segue) it.segue = s.segue;
      if (s.summary && it.type !== "music") it.summary = s.summary;
    }
  } catch { /* keep extractive summaries + static lead */ }

  return {
    mode: context.mode || "idle",
    explanation: explain(context.mode),
    queue,
    sources, // how many candidates each agent contributed
  };
}
