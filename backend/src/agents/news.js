// News agent — fetches licensed RSS feeds matched to what we know about THIS person
// (their onboarding topics). We deliberately use attributed RSS rather than broad
// web-scraping, per the product's source-attribution constraint.
import { getText } from "../lib/http.js";
import { parseRss, shortHash } from "../lib/rss.js";

const FEEDS = {
  world: "https://www.theguardian.com/world/rss",
  technology: "https://www.theguardian.com/technology/rss",
  business: "https://www.theguardian.com/business/rss",
  science: "https://www.theguardian.com/science/rss",
  sport: "https://www.theguardian.com/sport/rss",
  culture: "https://www.theguardian.com/culture/rss",
  politics: "https://www.theguardian.com/politics/rss",
};

export async function newsAgent(profile = {}) {
  const topics = (profile.topics || []).map((t) => String(t).toLowerCase());
  const picked = Object.keys(FEEDS).filter((k) => topics.includes(k));
  const feeds = (picked.length ? picked : ["world", "technology"]).slice(0, 2);

  const items = [];
  for (const f of feeds) {
    try {
      const xml = await getText(FEEDS[f]);
      for (const it of parseRss(xml, 4)) {
        if (!it.title) continue;
        items.push({
          id: "news-" + shortHash(it.link || it.title),
          type: "news",
          title: it.title,
          subtitle: `${cap(f)} · The Guardian`,
          source: "The Guardian",
          url: it.link,
          summary: it.description?.slice(0, 240),
          durationSec: 150,
          energy: 0.4,
          audioUrl: null, // spoken summary comes from the Voice Producer (ElevenLabs) later
        });
      }
    } catch {
      /* skip an unreachable feed */
    }
  }
  return items.length ? items : seed();
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function seed() {
  return [{ id: "news-seed", type: "news", title: "Your morning briefing", subtitle: "Seed · offline", source: "seed", durationSec: 150, energy: 0.4, audioUrl: null }];
}
