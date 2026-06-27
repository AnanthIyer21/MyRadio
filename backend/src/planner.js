// Scoring + diversification used by the orchestrator.
// Intentionally simple linear model; upgrade to a contextual bandit later.

const MODE_ENERGY = {
  morning_commute: 0.6, evening_commute: 0.5, focus_block: 0.7,
  workout: 0.9, walking: 0.5, evening_wind_down: 0.25, idle: 0.5,
};

const DEFAULT_MIX = { music: 40, news: 25, podcast: 20, audiobook: 15 };

export function scoreItem(item, profile = {}, context = {}) {
  const target = MODE_ENERGY[context.mode] ?? 0.5;
  const contextMatch = 1 - Math.abs((item.energy ?? 0.5) - target);
  const explicitReward = profile.rewards?.[item.id] || 0;
  const mix = profile.contentMix || DEFAULT_MIX;
  const typePref = (mix[item.type] ?? 0) / 100;
  const freshness = item.type === "news" ? 0.2 : 0;
  return Number((contextMatch + explicitReward + typePref + freshness).toFixed(3));
}

// Round-robin across types (highest mix preference first) so the queue is a
// balanced cross-format mix, with the best-scoring item of each type chosen.
export function scoreAndDiversify(items, profile = {}, context = {}, n = 6) {
  const scored = items
    .map((it) => ({ ...it, score: scoreItem(it, profile, context) }))
    .sort((a, b) => b.score - a.score);

  const byType = {};
  for (const it of scored) (byType[it.type] ||= []).push(it);

  const mix = profile.contentMix || DEFAULT_MIX;
  const order = Object.keys({ ...DEFAULT_MIX, ...mix }).sort((a, b) => (mix[b] ?? 0) - (mix[a] ?? 0));

  const queue = [];
  let progressed = true;
  while (queue.length < n && progressed) {
    progressed = false;
    for (const t of order) {
      const arr = byType[t];
      if (arr && arr.length) {
        queue.push(arr.shift());
        progressed = true;
        if (queue.length >= n) break;
      }
    }
  }
  return queue;
}

export function explain(mode) {
  switch (mode) {
    case "morning_commute": return "Morning commute — concise news and upbeat music to start the day.";
    case "evening_commute": return "Evening commute — a relaxed mix to decompress.";
    case "workout": return "Workout — high-energy music up front.";
    case "focus_block": return "Focus block — steady instrumentals and longer listens.";
    case "walking": return "On a walk — a balanced, easy mix.";
    case "evening_wind_down": return "Evening wind-down — calm, low-energy audio.";
    default: return "A balanced mix across news, podcasts, audiobooks, and music.";
  }
}
