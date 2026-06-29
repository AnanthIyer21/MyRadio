// Scoring + diversification used by the orchestrator.
// Linear scoring + a smooth weighted interleave whose per-type frequency adapts
// to what the listener likes/skips (affinity), so the radio genuinely steers
// itself over a session. Upgrade to a contextual bandit later.

const MODE_ENERGY = {
  morning_commute: 0.6, evening_commute: 0.5, focus_block: 0.7,
  workout: 0.9, walking: 0.5, evening_wind_down: 0.25, idle: 0.5,
};

const DEFAULT_MIX = { music: 40, news: 25, podcast: 20, audiobook: 15 };

// Squash an accumulated reward total into a bounded nudge in [-1, 1] so a long
// like/skip streak steers without ever zeroing a type out entirely.
const squash = (x) => Math.tanh((x || 0) / 2);

export function scoreItem(item, profile = {}, context = {}) {
  const target = MODE_ENERGY[context.mode] ?? 0.5;
  const contextMatch = 1 - Math.abs((item.energy ?? 0.5) - target);
  const explicitReward = profile.rewards?.[item.id] || 0;
  const mix = profile.contentMix || DEFAULT_MIX;
  const typePref = (mix[item.type] ?? 0) / 100;
  const freshness = item.type === "news" ? 0.2 : 0;
  // Learned affinity: how much this listener has liked/skipped this type + topic.
  const typeAff = squash(profile.affinity?.type?.[item.type]);
  const topicAff = item.topic ? squash(profile.affinity?.topic?.[item.topic]) : 0;
  return Number((contextMatch + explicitReward + typePref + freshness + 0.5 * typeAff + 0.4 * topicAff).toFixed(3));
}

// Per-type weight = content-mix preference blended with learned affinity, so a
// type the listener keeps skipping shows up less often (never zero — min 0.05).
function typeWeight(type, profile) {
  const mix = profile.contentMix || DEFAULT_MIX;
  return Math.max(0.05, (mix[type] ?? 10) / 100 + 0.5 * squash(profile.affinity?.type?.[type]));
}

// Smooth weighted round-robin (Nginx-style) across types: each round every type
// gains its weight in "credit", the highest-credit type with items available is
// played and pays 1 credit. Frequency converges to the weight distribution while
// staying interleaved, and within each type the best-scoring item goes first.
export function scoreAndDiversify(items, profile = {}, context = {}, n = 6) {
  const scored = items
    .map((it) => ({ ...it, score: scoreItem(it, profile, context) }))
    .sort((a, b) => b.score - a.score);

  const byType = {};
  for (const it of scored) (byType[it.type] ||= []).push(it);

  const types = Object.keys(byType);
  if (!types.length) return [];
  const weight = {}, credit = {};
  for (const t of types) { weight[t] = typeWeight(t, profile); credit[t] = 0; }

  const queue = [];
  while (queue.length < n) {
    let best = null;
    for (const t of types) {
      if (!byType[t].length) continue;
      credit[t] += weight[t];
      if (best === null || credit[t] > credit[best]) best = t;
    }
    if (best === null) break; // every type exhausted
    queue.push(byType[best].shift());
    credit[best] -= 1;
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
