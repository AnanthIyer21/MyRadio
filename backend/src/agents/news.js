// News agent — pulls licensed RSS from multiple outlets, matched to the listener's
// onboarding topics. Audio bulletins (e.g. Guardian's daily news show) are NEWS with
// audio, not podcasts. Each item carries a `summary` for the AI-summary playback mode.
import { getText } from "../lib/http.js";
import { parseRss, shortHash } from "../lib/rss.js";
import { toSummary } from "../lib/summary.js";

// Text news sources by topic (multiple outlets per topic).
const FEEDS = [
  { topic: "world", source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { topic: "world", source: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
  { topic: "world", source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { topic: "technology", source: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { topic: "technology", source: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { topic: "technology", source: "The Guardian", url: "https://www.theguardian.com/technology/rss" },
  { topic: "business", source: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { topic: "business", source: "The Guardian", url: "https://www.theguardian.com/business/rss" },
  { topic: "science", source: "NPR", url: "https://feeds.npr.org/1007/rss.xml" },
  { topic: "science", source: "The Guardian", url: "https://www.theguardian.com/science/rss" },
  { topic: "sport", source: "BBC", url: "https://feeds.bbci.co.uk/sport/rss.xml" },
  { topic: "culture", source: "The Guardian", url: "https://www.theguardian.com/culture/rss" },
  { topic: "politics", source: "The Guardian", url: "https://www.theguardian.com/politics/rss" },
];

// Spoken news bulletins — NEWS items that already have real audio.
const AUDIO_NEWS = [
  { topic: "world", source: "Guardian · Today in Focus", url: "https://www.theguardian.com/news/series/todayinfocus/podcast.xml" },
  { topic: "science", source: "Guardian · Science Weekly", url: "https://www.theguardian.com/science/series/science/podcast.xml" },
];

export async function newsAgent(profile = {}) {
  const topics = (profile.topics || []).map((t) => String(t).toLowerCase());

  let chosen = FEEDS.filter((f) => topics.includes(f.topic));
  if (chosen.length < 2) chosen = chosen.concat(FEEDS.filter((f) => f.topic === "world"));
  chosen = dedupe(chosen).slice(0, 3);

  const audioFeed = AUDIO_NEWS.find((a) => topics.includes(a.topic)) || AUDIO_NEWS[0];

  const tasks = [
    ...chosen.map((f) => fetchFeed(f, 3)),
    fetchFeed(audioFeed, 1),
  ];
  const settled = await Promise.allSettled(tasks);
  const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return items.length ? items : seed();
}

async function fetchFeed(feed, n) {
  const xml = await getText(feed.url);
  return parseRss(xml, n)
    .filter((it) => it.title)
    .map((it) => ({
      id: "news-" + shortHash(it.link || it.title),
      type: "news",
      title: it.title,
      subtitle: feed.source,
      source: feed.source,
      url: it.link,
      summary: toSummary(it.description),
      durationSec: it.audioUrl ? 1500 : 150,
      energy: 0.4,
      audioUrl: it.audioUrl, // null for text articles; set for spoken bulletins
    }));
}

function dedupe(feeds) {
  const seen = new Set();
  return feeds.filter((f) => (seen.has(f.url) ? false : seen.add(f.url)));
}

function seed() {
  return [{ id: "news-seed", type: "news", title: "Your morning briefing", subtitle: "Seed · offline", source: "seed", summary: "Offline demo headline.", durationSec: 150, energy: 0.4, audioUrl: null }];
}
