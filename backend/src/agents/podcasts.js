// Podcast agent — discovers REAL podcasts via the iTunes Search API (free, no key),
// then pulls the latest episode audio from each show's RSS feed. Searches a
// randomized spread of the listener's interests so the pool stays varied and a
// replenish on a continuous-radio session surfaces fresh shows each time.
import { getText, getJson } from "../lib/http.js";
import { parseRss, shortHash } from "../lib/rss.js";
import { toSummary } from "../lib/summary.js";

export async function podcastAgent(profile = {}) {
  // Build a term pool from topics + free-text keywords; sample a few each call.
  const pool = [...(profile.topics || []), ...(profile.keywords || [])]
    .map((t) => String(t).trim()).filter((t) => t.length > 2);
  const terms = pickN(pool.length ? pool : ["news", "technology"], 3);

  // Find candidate shows across the chosen terms.
  const found = await Promise.allSettled(
    terms.map((term) => getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=5`))
  );
  const shows = [];
  const seenFeeds = new Set();
  for (const r of found) {
    if (r.status !== "fulfilled") continue;
    for (const s of (r.value.results || [])) {
      if (s.feedUrl && !seenFeeds.has(s.feedUrl)) { seenFeeds.add(s.feedUrl); shows.push(s); }
    }
  }
  if (!shows.length) return seed();

  // Pull the latest episode from up to 4 distinct shows.
  const settled = await Promise.allSettled(shuffle(shows).slice(0, 4).map((s) => latestEpisode(s)));
  const seen = new Set();
  const items = settled
    .flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []))
    .filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
  return items.length ? items : seed();
}

async function latestEpisode(show) {
  const xml = await getText(show.feedUrl);
  const ep = parseRss(xml, 4).find((e) => e.audioUrl);
  if (!ep) return null;
  return {
    id: "pod-" + shortHash(ep.audioUrl),
    type: "podcast",
    title: ep.title || show.collectionName,
    subtitle: `${show.collectionName} · podcast`,
    source: show.collectionName,
    url: ep.link,
    summary: toSummary(ep.description),
    durationSec: 1800,
    energy: 0.5,
    audioUrl: ep.audioUrl,
  };
}

function pickN(arr, n) {
  return shuffle([...new Set(arr)]).slice(0, n);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function seed() {
  return [{ id: "pod-seed", type: "podcast", title: "Tech in 10", subtitle: "Seed · offline", source: "seed", summary: "Offline demo episode.", durationSec: 600, energy: 0.5, audioUrl: null }];
}
