// News agent — pulls licensed RSS from a WIDE set of reputable outlets grouped
// by topic, selects the feeds that match the listener's interests, fetches
// across many sources, dedupes the same story reported by multiple outlets, and
// ranks by the listener's free-text keywords + freshness. Dead/blocked feeds are
// skipped gracefully (Promise.allSettled), so an occasional 404 is harmless.
//
// Topic labels here MUST match the TOPIC_WORDS keys in web/app.js so the
// onboarding interests map onto these feeds.
import { getText } from "../lib/http.js";
import { parseRss, shortHash } from "../lib/rss.js";
import { toSummary } from "../lib/summary.js";

const FEEDS = [
  // ---- world ----
  { topic: "world", source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { topic: "world", source: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
  { topic: "world", source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { topic: "world", source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { topic: "world", source: "CNN", url: "http://rss.cnn.com/rss/edition_world.rss" },
  { topic: "world", source: "DW", url: "https://rss.dw.com/rdf/rss-en-world" },

  // ---- technology ----
  { topic: "technology", source: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { topic: "technology", source: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { topic: "technology", source: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { topic: "technology", source: "Wired", url: "https://www.wired.com/feed/rss" },
  { topic: "technology", source: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { topic: "technology", source: "The Guardian", url: "https://www.theguardian.com/technology/rss" },
  { topic: "technology", source: "Hacker News", url: "https://hnrss.org/frontpage" },

  // ---- ai ----
  { topic: "ai", source: "The Verge AI", url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml" },
  { topic: "ai", source: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { topic: "ai", source: "MIT Tech Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { topic: "ai", source: "Hacker News · AI", url: "https://hnrss.org/newest?q=AI+OR+LLM&points=20" },

  // ---- business / markets ----
  { topic: "business", source: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { topic: "business", source: "The Guardian", url: "https://www.theguardian.com/business/rss" },
  { topic: "business", source: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
  { topic: "business", source: "MarketWatch", url: "http://feeds.marketwatch.com/marketwatch/topstories/" },

  // ---- science ----
  { topic: "science", source: "NPR", url: "https://feeds.npr.org/1007/rss.xml" },
  { topic: "science", source: "The Guardian", url: "https://www.theguardian.com/science/rss" },
  { topic: "science", source: "Scientific American", url: "http://rss.sciam.com/ScientificAmerican-Global" },
  { topic: "science", source: "Phys.org", url: "https://phys.org/rss-feed/" },
  { topic: "science", source: "ScienceDaily", url: "https://www.sciencedaily.com/rss/top/science.xml" },

  // ---- space ----
  { topic: "space", source: "NASA", url: "https://www.nasa.gov/rss/dyn/breaking_news.rss" },
  { topic: "space", source: "Space.com", url: "https://www.space.com/feeds/all" },

  // ---- health ----
  { topic: "health", source: "BBC", url: "https://feeds.bbci.co.uk/news/health/rss.xml" },
  { topic: "health", source: "NPR", url: "https://feeds.npr.org/1128/rss.xml" },
  { topic: "health", source: "ScienceDaily", url: "https://www.sciencedaily.com/rss/health_medicine.xml" },

  // ---- sport ----
  { topic: "sport", source: "BBC", url: "https://feeds.bbci.co.uk/sport/rss.xml" },
  { topic: "sport", source: "ESPN", url: "https://www.espn.com/espn/rss/news" },
  { topic: "sport", source: "Sky Sports", url: "https://www.skysports.com/rss/12040" },
  { topic: "sport", source: "The Guardian", url: "https://www.theguardian.com/sport/rss" },

  // ---- culture ----
  { topic: "culture", source: "The Guardian", url: "https://www.theguardian.com/culture/rss" },
  { topic: "culture", source: "NPR Arts", url: "https://feeds.npr.org/1008/rss.xml" },
  { topic: "culture", source: "Pitchfork", url: "https://pitchfork.com/rss/news/" },

  // ---- entertainment ----
  { topic: "entertainment", source: "Variety", url: "https://variety.com/feed/" },
  { topic: "entertainment", source: "The Hollywood Reporter", url: "https://www.hollywoodreporter.com/feed/" },
  { topic: "entertainment", source: "The Guardian Film", url: "https://www.theguardian.com/film/rss" },

  // ---- gaming ----
  { topic: "gaming", source: "Polygon", url: "https://www.polygon.com/rss/index.xml" },
  { topic: "gaming", source: "IGN", url: "https://feeds.ign.com/ign/all" },
  { topic: "gaming", source: "Eurogamer", url: "https://www.eurogamer.net/feed" },

  // ---- politics ----
  { topic: "politics", source: "The Guardian", url: "https://www.theguardian.com/politics/rss" },
  { topic: "politics", source: "Politico", url: "https://rss.politico.com/politics-news.xml" },
  { topic: "politics", source: "NPR", url: "https://feeds.npr.org/1014/rss.xml" },
  { topic: "politics", source: "The Hill", url: "https://thehill.com/rss/syndicator/19110" },

  // ---- climate / environment ----
  { topic: "climate", source: "The Guardian", url: "https://www.theguardian.com/environment/rss" },
  { topic: "climate", source: "Grist", url: "https://grist.org/feed/" },
  { topic: "climate", source: "Inside Climate News", url: "https://insideclimatenews.org/feed/" },
];

// Spoken news bulletins — NEWS items that already have real audio.
const AUDIO_NEWS = [
  { topic: "world", source: "Guardian · Today in Focus", url: "https://www.theguardian.com/news/series/todayinfocus/podcast.xml" },
  { topic: "science", source: "Guardian · Science Weekly", url: "https://www.theguardian.com/science/series/science/podcast.xml" },
];

const MAX_FEEDS = 10; // breadth cap per build, to bound latency

export async function newsAgent(profile = {}) {
  const topics = (profile.topics || []).map((t) => String(t).toLowerCase());
  const keywords = (profile.keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length > 2);

  // Pick every feed whose topic the listener expressed; if they said little,
  // fall back to a general world + technology mix. Shuffle so the outlet mix
  // varies between builds, then cap for latency.
  let chosen = FEEDS.filter((f) => topics.includes(f.topic));
  if (chosen.length < 3) chosen = chosen.concat(FEEDS.filter((f) => f.topic === "world" || f.topic === "technology"));
  chosen = shuffle(dedupeFeeds(chosen)).slice(0, MAX_FEEDS);

  const audioFeed = AUDIO_NEWS.find((a) => topics.includes(a.topic)) || AUDIO_NEWS[0];

  const settled = await Promise.allSettled([
    ...chosen.map((f) => fetchFeed(f, 4)),
    fetchFeed(audioFeed, 1),
  ]);
  let items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  items = dedupeStories(items);

  // Rank by relevance to the listener's stated interests (free-text keywords)
  // plus a freshness nudge, so the most on-topic, recent stories surface first.
  items = items
    .map((it) => ({ ...it, _rel: relevance(it, keywords) }))
    .sort((a, b) => b._rel - a._rel)
    .map(({ _rel, ...it }) => it);

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
      topic: feed.topic,
      url: it.link,
      summary: toSummary(it.description),
      publishedAt: it.pubDate ? Date.parse(it.pubDate) || 0 : 0,
      durationSec: it.audioUrl ? 1500 : 150,
      energy: 0.4,
      audioUrl: it.audioUrl, // null for text articles; set for spoken bulletins
    }));
}

// Relevance = keyword hits (title weighted 2x over the blurb) + a small recency
// bonus for stories from roughly the last two days.
function relevance(it, keywords) {
  let score = 0;
  if (keywords.length) {
    const title = (it.title || "").toLowerCase();
    const blurb = (it.summary || "").toLowerCase();
    for (const k of keywords) {
      if (title.includes(k)) score += 2;
      if (blurb.includes(k)) score += 1;
    }
  }
  if (it.publishedAt) {
    const ageH = (Date.now() - it.publishedAt) / 3.6e6;
    if (ageH >= 0 && ageH < 48) score += (48 - ageH) / 48; // up to +1 for the freshest
  }
  return score;
}

function dedupeFeeds(feeds) {
  const seen = new Set();
  return feeds.filter((f) => (seen.has(f.url) ? false : seen.add(f.url)));
}

// Collapse the same story reported by multiple outlets (normalised title prefix).
function dedupeStories(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = (it.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 7).join(" ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  return [{ id: "news-seed", type: "news", title: "Your morning briefing", subtitle: "Seed · offline", source: "seed", summary: "Offline demo headline.", durationSec: 150, energy: 0.4, audioUrl: null }];
}
