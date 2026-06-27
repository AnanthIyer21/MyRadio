// Orchestration agent — fans out to every specialist agent in parallel, then
// scores + diversifies their candidates into one context-aware queue.
import { newsAgent } from "./news.js";
import { podcastAgent } from "./podcasts.js";
import { audiobookAgent } from "./audiobooks.js";
import { musicAgent } from "./music.js";
import { scoreAndDiversify, explain } from "../planner.js";

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
  return {
    mode: context.mode || "idle",
    explanation: explain(context.mode),
    queue,
    sources, // how many candidates each agent contributed
  };
}
