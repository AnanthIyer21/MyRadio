// Session planner (MVP stub): build a small cross-format queue for a context.
// Real content adapters replace SEED later. Scoring stays intentionally simple.

const SEED = [
  { id: "news-1", type: "news", title: "Morning briefing", durationSec: 180, energy: 0.4, source: "seed" },
  { id: "pod-1", type: "podcast", title: "Tech in 10", durationSec: 600, energy: 0.5, source: "seed" },
  { id: "book-1", type: "audiobook", title: "Public-domain classic, ch.1", durationSec: 900, energy: 0.3, source: "seed" },
  { id: "music-1", type: "music", title: "Upbeat focus instrumental", durationSec: 210, energy: 0.8, source: "seed" },
  { id: "music-2", type: "music", title: "Calm evening ambient", durationSec: 240, energy: 0.2, source: "seed" },
];

// Preferred energy per mode — a stand-in for context_match.
const MODE_ENERGY = {
  morning_commute: 0.6,
  evening_commute: 0.5,
  focus_block: 0.7,
  workout: 0.9,
  walking: 0.5,
  evening_wind_down: 0.25,
  idle: 0.5,
};

export function planSession({ context, profile = {} } = {}) {
  const targetEnergy = MODE_ENERGY[context?.mode] ?? 0.5;
  const rewards = profile.rewards || {};

  const scored = SEED.map((item) => {
    const contextMatch = 1 - Math.abs(item.energy - targetEnergy);
    const explicitReward = rewards[item.id] || 0;
    const freshness = item.type === "news" ? 0.2 : 0;
    const score = contextMatch + explicitReward + freshness;
    return { ...item, score: Number(score.toFixed(3)) };
  }).sort((a, b) => b.score - a.score);

  return {
    mode: context?.mode || "idle",
    explanation: explain(context?.mode),
    queue: scored.slice(0, 4),
  };
}

function explain(mode) {
  switch (mode) {
    case "morning_commute": return "Morning commute — concise news and upbeat audio.";
    case "workout": return "Workout — high-energy music.";
    case "focus_block": return "Focus block — steady instrumental and longer pieces.";
    case "evening_wind_down": return "Evening wind-down — calm, low-energy audio.";
    default: return "Building a balanced mix across news, podcasts, books, and music.";
  }
}
