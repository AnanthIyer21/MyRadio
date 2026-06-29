// Music agent — royalty-free, directly playable tracks tagged by vibe + genre + energy
// so they can match both the listener's taste (multi-select vibes/genres) and the
// current context. Swap this catalogue for a licensed library (or Spotify SDK) later.
const CATALOGUE = [
  { n: 1, title: "Neon Drive", vibe: "upbeat", genre: "electronic", energy: 0.85 },
  { n: 9, title: "Afterglow", vibe: "upbeat", genre: "pop", energy: 0.75 },
  { n: 4, title: "Skyline Run", vibe: "upbeat", genre: "rock", energy: 0.8 },
  { n: 3, title: "Pulse Theory", vibe: "focus", genre: "electronic", energy: 0.6 },
  { n: 7, title: "Inner Orbit", vibe: "focus", genre: "classical", energy: 0.45 },
  { n: 5, title: "Deep Current", vibe: "focus", genre: "ambient", energy: 0.5 },
  { n: 2, title: "Glass Horizon", vibe: "chill", genre: "ambient", energy: 0.35 },
  { n: 6, title: "Slow Tide", vibe: "chill", genre: "lofi", energy: 0.3 },
  { n: 8, title: "Velvet Hours", vibe: "chill", genre: "jazz", energy: 0.25 },
  { n: 11, title: "Solar Flare", vibe: "upbeat", genre: "electronic", energy: 0.82 },
  { n: 13, title: "Iron Pulse", vibe: "upbeat", genre: "rock", energy: 0.88 },
  { n: 16, title: "Circuit Dawn", vibe: "upbeat", genre: "pop", energy: 0.78 },
  { n: 10, title: "Midnight Loop", vibe: "focus", genre: "electronic", energy: 0.55 },
  { n: 14, title: "Drift Theory", vibe: "focus", genre: "ambient", energy: 0.5 },
  { n: 12, title: "Quiet Static", vibe: "chill", genre: "ambient", energy: 0.3 },
  { n: 15, title: "Paper Moon", vibe: "chill", genre: "jazz", energy: 0.28 },
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
  const vibes = (profile.musicVibes || []).map(String);
  const genres = (profile.genres || []).map(String);

  return CATALOGUE
    .map((t) => ({
      id: t.id, type: t.type, title: t.title,
      subtitle: `${cap(t.genre)} · ${t.vibe}`,
      source: t.source, durationSec: t.durationSec, energy: t.energy, audioUrl: t.audioUrl,
      _fit: -Math.abs(t.energy - target) + (vibes.includes(t.vibe) ? 0.2 : 0) + (genres.includes(t.genre) ? 0.25 : 0),
    }))
    .sort((a, b) => b._fit - a._fit)
    .slice(0, 12) // deep enough that the session cycles through many tracks before repeating
    .map(({ _fit, ...t }) => t);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
