// Web-wide news search via Google News RSS.
//
// Given a free-text query, Google News aggregates recent matching coverage from
// thousands of publishers across the whole web — so the LISTENER'S stated interests
// drive the headlines, not a fixed list of feeds. No API key, and it returns
// standard RSS we already know how to parse.
//
// Recency is controlled with Google News' `when:` operator (when:1d = last 24h,
// when:7d = last week), so we fetch "today, up to this week" and the news agent
// ranks the freshest first.
import { getText } from "./http.js";
import { parseRss, shortHash } from "./rss.js";

const ENDPOINT = "https://news.google.com/rss/search";
const LOCALE = "hl=en-US&gl=US&ceid=US:en";

// Build the search URL for a phrase + recency window (days).
function searchUrl(query, days) {
  return `${ENDPOINT}?q=${encodeURIComponent(`${query} when:${days}d`)}&${LOCALE}`;
}

// Google News titles read "Headline - Publisher"; the <source> tag holds the
// publisher cleanly, so strip a trailing " - Publisher" for a clean spoken headline.
function cleanTitle(title, source) {
  let t = String(title || "").trim();
  const suffix = source ? ` - ${source}` : "";
  if (suffix && t.toLowerCase().endsWith(suffix.toLowerCase())) {
    return t.slice(0, t.length - suffix.length).trim();
  }
  // Fall back to dropping a trailing " - segment" (the publisher) if one is present.
  const i = t.lastIndexOf(" - ");
  return i > 20 ? t.slice(0, i).trim() : t;
}

// parseRss doesn't extract <source>, so pull the publisher name from the raw block.
function sourceOf(block = "") {
  const m = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
}

// Search the web for recent news matching `query`. Returns normalized news items
// (same shape fetchFeed() produces in news.js, plus `query`/`scraped` markers).
export async function searchNews(query, { topic = "", days = 7, limit = 6 } = {}) {
  const xml = await getText(searchUrl(query, days), 8000);
  // Re-split for the per-item <source> the parser omits; indexes align with parseRss.
  const blocks = xml.split(/<item[\s>]/i).slice(1, limit + 1);
  return parseRss(xml, limit)
    .map((it, i) => {
      const source = sourceOf(blocks[i]);
      const title = cleanTitle(it.title, source);
      if (!title) return null;
      return {
        id: "news-" + shortHash(it.link || title),
        type: "news",
        title,
        subtitle: source || "Google News",
        source: source || "Google News",
        topic,
        query,                       // which interest produced this (relevance + debug)
        // Google News blurbs are link-lists, not prose — the headline carries the
        // story, and the LLM producer enriches it into spoken copy when available.
        summary: "",
        url: it.link,
        publishedAt: it.pubDate ? Date.parse(it.pubDate) || 0 : 0,
        durationSec: 150,
        energy: 0.4,
        audioUrl: null,
        scraped: true,
      };
    })
    .filter(Boolean);
}
