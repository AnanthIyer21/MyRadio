// Robust article-text extraction with a keyless reader fallback.
//
// The fast path is our own paragraph/JSON-LD extractor (extract.js). Many JS-heavy or
// paywalled sites (ESPN, Reuters, agencies) render almost no server-side <p>, so that
// path returns little. For those we fall back to the keyless Jina Reader proxy
// (r.jina.ai), which renders the page and returns clean article markdown — no API key.
import { getText } from "./http.js";
import { extractArticle } from "./extract.js";

const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const MIN_OK = 400; // chars below which we consider extraction "too thin" and try the reader

// Turn Jina Reader markdown into plain prose: drop its header, unwrap links, strip
// markdown marks, and keep only real sentence-bearing paragraphs (not nav/boilerplate).
export function cleanReaderMarkdown(md, maxChars = 14000) {
  let t = String(md || "");
  const i = t.indexOf("Markdown Content:");
  if (i >= 0) t = t.slice(i + "Markdown Content:".length);
  t = t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")     // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")  // links → their text
    .replace(/^#{1,6}\s*/gm, "")               // heading marks
    .replace(/[*_`>|]/g, "");                  // emphasis/quote/code/table marks
  const paras = t.split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 80 && /[.!?]/.test(p) &&
      !/^(skip to|top |menu|share|advertisement|sign up|subscribe|follow|read more|copyright|all rights)/i.test(p));
  const out = paras.join(" ");
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

export async function fetchReadable(url, maxChars = 14000, ms = 15000) {
  try {
    const r = await fetch("https://r.jina.ai/" + url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return "";
    return cleanReaderMarkdown(await r.text(), maxChars);
  } catch { return ""; }
}

// Best article body for a URL: our fast extractor, then the reader fallback if thin.
export async function articleText(url, maxChars = 14000) {
  if (!url) return "";
  try {
    const t = extractArticle(await getText(url, 9000), maxChars);
    if (t && t.length >= MIN_OK) return t;
  } catch { /* fall through to reader */ }
  return fetchReadable(url, maxChars);
}
