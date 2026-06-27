// Music agent — royalty-free, directly playable tracks tagged by energy/vibe so
// they can match the listening context. Swap this catalogue for a licensed library
// (or the Spotify SDK for Premium users) later; the interface stays the same.
const CATALOGUE = [
  { n: 1, title: "Neon Drive", vibe: "upbeat", energy: 0.85 },
  { n: 9, title: "Afterglow", vibe: "upbeat", energy: 0.75 },
  { n: 3, title: "Pulse Theory", vibe: "focus", energy: 0.6 },
  { n: 5, title: "Deep Current", vibe: "focus", energy: 0.5 },
  { n: 2, title: "Glass Horizon", vibe: "chill", energy: 0.35 },
  { n: 8, title: "Velvet Hours", vibe: "chill", energy: 0.25 },
].map((t) => ({
  ...t,
  id: `mus-sh${t.n}`,
  type: "music",
  source: "Royalty-free (SoundHelix)",
  durationSec: 300,
  audioUrl: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${t.n}.mp3`,
}));

const MODE_ENERGY = {
  morning_commute: 0.6, evening_commute: 0.5, focus_block: 0.7,
  workout: 0.9, walking: 0.5, evening_wind_down: 0.25, idle: 0.5,
};

export async function musicAgent(profile = {}, context = {}) {
  const target = MODE_ENERGY[context.mode] ?? 0.5;
  const vibe = profile.musicVibe;
  return CATALOGUE
    .map((t) => ({
      id: t.id, type: t.type, title: t.title,
      subtitle: `${cap(t.vibe)} · royalty-free`,
      source: t.source, durationSec: t.durationSec, energy: t.energy, audioUrl: t.audioUrl,
      _fit: -Math.abs(t.energy - target) + (vibe && vibe === t.vibe ? 0.2 : 0),
    }))
    .sort((a, b) => b._fit - a._fit)
    .slice(0, 4)
    .map(({ _fit, ...t }) => t);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
