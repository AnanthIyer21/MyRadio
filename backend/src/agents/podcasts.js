// Podcast agent — discovers REAL podcasts via the iTunes Search API (free, no key),
// then pulls the latest episode audio from each show's RSS feed. AI summaries of an
// episode are opt-in (client decides); we always provide the original audio + a blurb.
import { getText, getJson } from "../lib/http.js";
import { parseRss, shortHash } from "../lib/rss.js";
import { toSummary } from "../lib/summary.js";

export async function podcastAgent(profile = {}) {
  const term = (profile.topics && profile.topics[0]) || (profile.genres && profile.genres[0]) || "news";

  let shows = [];
  try {
    const d = await getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=5`);
    shows = (d.results || []).filter((r) => r.feedUrl).slice(0, 3);
  } catch {
    return seed();
  }

  const settled = await Promise.allSettled(shows.slice(0, 2).map((s) => latestEpisode(s)));
  const items = settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
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

function seed() {
  return [{ id: "pod-seed", type: "podcast", title: "Tech in 10", subtitle: "Seed · offline", source: "seed", summary: "Offline demo episode.", durationSec: 600, energy: 0.5, audioUrl: null }];
}
