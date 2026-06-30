// Content seam for the summary agent. The specialist agents ship each item with a
// thin blurb (RSS standfirst, book metadata, truncated episode notes) — enough to
// rank on, but too shallow to summarise from. Before the producer writes the spoken
// summary, we enrich the batch with the REAL content to condense:
//   news      → the article body (extractArticle)
//   audiobook → the opening of the public-domain text (cleanBookText)
//   podcast   → the full episode show-notes the agent already carried (no extra fetch)
// so generateScript() summarises the actual piece, sized to the listener's length,
// instead of re-wording a one-line teaser.
//
// Every fetch is bounded and resilient: a slow/blocked source leaves item.content
// unset and the caller falls back to the existing blurb, so the radio never stalls.
import { getText } from "./http.js";
import { extractArticle, cleanBookText } from "./extract.js";
import { fetchArticleByHeadline } from "./findarticle.js";
import { articleText } from "./readability.js";

const NEWS_CHARS = 9000;  // article body cap fed to the summariser
const BOOK_CHARS = 12000; // opening of the book — enough to summarise the setup/themes
const POD_CHARS = 4000;   // episode show-notes cap

// Strip HTML/CDATA from a podcast description into plain prose for the summariser.
function stripHtml(s = "") {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Best available full text for one item, or "" if none can be fetched. Never throws.
export async function fetchItemContent(item = {}, ms = 7000) {
  try {
    if (item.type === "news") {
      // Scraped (Google News) links are encrypted redirects with no readable body —
      // search the headline for the real publisher article and read THAT instead.
      if (item.scraped) {
        const { url, text } = await fetchArticleByHeadline(item.title, item.source, NEWS_CHARS, ms);
        if (url) item.url = url;              // point full mode / "Open ↗" at the real article
        // If the resolved publisher page extracted thin, retry via the reader fallback.
        return text && text.length >= 400 ? text : (url ? await articleText(url, NEWS_CHARS) : text);
      }
      if (item.url) return articleText(item.url, NEWS_CHARS);  // fast extractor + reader fallback
    }
    // Audiobooks are now real narrated audio (LibriVox chapter MP3s) — nothing to fetch.
    if (item.type === "audiobook") return "";
    if (item.type === "podcast") {
      // Show-notes already travel with the item — no network needed.
      return stripHtml(item.content || item.summary || "").slice(0, POD_CHARS);
    }
  } catch { /* fall through to "" — caller keeps the blurb */ }
  return "";
}

// Attach item.content (the text to summarise) to each non-music item in a batch,
// in parallel. Items keep whatever blurb they had if enrichment yields nothing.
export async function enrichBatch(batch = [], ms = 7000) {
  await Promise.all(
    batch
      .filter((it) => it && it.type !== "music")
      .map(async (it) => {
        const text = await fetchItemContent(it, ms);
        // Replace with the fetched/cleaned body; on failure (""), keep the blurb.
        if (text) it.content = text;
      })
  );
  return batch;
}
