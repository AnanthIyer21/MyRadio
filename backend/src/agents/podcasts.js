// Podcast agent — fetches latest episodes from RSS feeds (real, playable audio
// via <enclosure>). Original audio only; AI summaries would be opt-in later.
import { getText } from "../lib/http.js";
import { parseRss, shortHash } from "../lib/rss.js";

// A small, stable starter set. Real product imports the user's subscriptions.
const FEEDS = [
  { topic: "news", title: "Today in Focus", url: "https://www.theguardian.com/news/series/todayinfocus/podcast.xml" },
  { topic: "science", title: "Science Weekly", url: "https://www.theguardian.com/science/series/science/podcast.xml" },
];

export async function podcastAgent(profile = {}) {
  const topics = (profile.topics || []).map((t) => String(t).toLowerCase());
  const ranked = [...FEEDS].sort((a, b) => Number(topics.includes(b.topic)) - Number(topics.includes(a.topic)));

  const items = [];
  for (const feed of ranked.slice(0, 2)) {
    try {
      const xml = await getText(feed.url);
      const eps = parseRss(xml, 2).filter((e) => e.audioUrl);
      for (const e of eps) {
        items.push({
          id: "pod-" + shortHash(e.audioUrl),
          type: "podcast",
          title: e.title || feed.title,
          subtitle: `${feed.title} · podcast`,
          source: feed.title,
          url: e.link,
          durationSec: 1500,
          energy: 0.5,
          audioUrl: e.audioUrl, // original episode audio
        });
      }
    } catch {
      /* skip feed */
    }
  }
  return items.length ? items : seed();
}

function seed() {
  return [{ id: "pod-seed", type: "podcast", title: "Tech in 10", subtitle: "Seed · offline", source: "seed", durationSec: 600, energy: 0.5, audioUrl: null }];
}
