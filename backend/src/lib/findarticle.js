// Resolve a real article URL from a headline.
//
// Web-scraped news comes from Google News, whose links are encrypted redirect URLs
// that don't yield article text. But we have the headline + publisher — so we look the
// story up on Bing News' RSS feed (keyless, no bot-challenge, unlike scraping a search
// page) and read the DIRECT publisher URL it embeds in each result link. That turns a
// headline-only item into a full article the summariser can condense to length.
import { extractArticle } from "./extract.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Aggregators / video that aren't the original article — prefer the real publisher.
const SKIP_HOST = /(^|\.)(youtube|youtu\.be|facebook|twitter|x|reddit|instagram|tiktok|linkedin)\.com$/i;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

// Bing News result links wrap the real article as ...&url=<encoded publisher url>...
function realUrl(link) {
  const m = link.replace(/&amp;/g, "&").match(/[?&]url=([^&]+)/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return ""; }
}

// Search Bing News RSS for a headline → ordered, de-duplicated direct article URLs.
async function searchNewsUrls(query, ms) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`bing ${res.status}`);
  const xml = await res.text();
  const urls = xml.split(/<item>/i).slice(1)
    .map((block) => realUrl((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || ""))
    .filter(Boolean);
  return [...new Set(urls)];
}

// Find the best real article URL for a headline. Prefers a result on the named
// publisher's own domain; otherwise the first non-aggregator result. "" if none.
export async function findArticleUrl(title, source = "", ms = 7000) {
  if (!title) return "";
  const results = await searchNewsUrls(`${title} ${source}`.trim(), ms);
  if (!results.length) return "";
  const token = norm(source);
  const onPublisher = token.length >= 4 && results.find((u) => norm(hostOf(u)).includes(token.slice(0, 10)));
  if (onPublisher) return onPublisher;
  return results.find((u) => !SKIP_HOST.test(hostOf(u))) || results[0];
}

// Resolve a headline to its article and return { url, text } (text "" on failure).
export async function fetchArticleByHeadline(title, source, maxChars, ms = 7000) {
  const url = await findArticleUrl(title, source, ms).catch(() => "");
  if (!url) return { url: "", text: "" };
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return { url, text: "" };
    return { url, text: extractArticle(await res.text(), maxChars) };
  } catch { return { url, text: "" }; }
}
