// Pull readable body text out of an article page (paragraph text), and clean
// Project Gutenberg plain-text. Used so "Full article / Full text" can be read aloud.
import { decodeEntities } from "./entities.js";

export function extractArticle(html, maxChars = 14000) {
  // 1) Paragraph extraction — scope to <article> when present, else the whole page.
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  const scope = art ? art[0] : html;
  const paras = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => clean(m[1]))
    .filter((t) => t.length > 40 && !/^(advertisement|sign up|subscribe|cookie|photograph|this article|read more)/i.test(t));
  let text = paras.join(" ");

  // 2) Fallback: many sites (ESPN, agencies, JS-rendered pages) ship the full text
  //    in a JSON-LD "articleBody" field even when the <p> markup is sparse. Use the
  //    longest one found if it beats the paragraph extraction.
  if (text.length < 600) {
    const jsonld = jsonLdArticleBody(html);
    if (jsonld.length > text.length) text = jsonld;
  }
  // 3) Last resort: the page's meta description (a sentence or two) so a stubborn
  //    page still yields something to speak rather than nothing.
  if (text.length < 120) {
    const meta = metaDescription(html);
    if (meta.length > text.length) text = meta;
  }

  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// Pull "articleBody" out of JSON-LD blocks. The value is a JSON string, so unescape
// the common sequences. Returns the longest body found (the main article).
function jsonLdArticleBody(html) {
  let best = "";
  for (const m of html.matchAll(/"articleBody"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    const body = clean(m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\t/g, " "));
    if (body.length > best.length) best = body;
  }
  return best;
}

function metaDescription(html) {
  const m = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i);
  return m ? clean(m[1]) : "";
}

export function cleanBookText(raw, maxChars = 24000) {
  let t = String(raw).replace(/\r\n/g, "\n");
  // 1) Cut the footer first (license/credits tail) so it can't leak into the body.
  //    The END marker may wrap lines and use 0+ spaces after ***.
  const em = t.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG|END OF (?:THE|THIS) PROJECT GUTENBERG|START: FULL LICENSE/i);
  if (em >= 0) t = t.slice(0, em);
  // 2) Drop leading Gutenberg boilerplate by PARAGRAPH (blank-line delimited), which
  //    survives the multi-line wrapping that breaks line-by-line matching. Handles
  //    both the legal preamble + metadata header AND the post-START transcriber notes
  //    ("E-text prepared by … Project Gutenberg … Online Distributed Proofreading").
  const BOILER = /^(title|author|editor|translator|illustrator|release date|posting date|first posted|last updated|language|character set|credits?|produced by|e-?text prepared)\b|project gutenberg|proofreading|pgdp\.net|gutenberg\.org|this ebook is for the use|\d+-h\.(htm|zip)/i;
  const paras = t.split(/\n\s*\n/);
  let j = 0;
  while (j < paras.length && (BOILER.test(paras[j].trim()) || paras[j].trim().length < 2)) j++;
  if (j < paras.length) t = paras.slice(j).join("\n\n");
  t = decodeEntities(t).replace(/\s+/g, " ").trim();
  return t.slice(0, maxChars);
}

function clean(s) {
  return decodeEntities(
    String(s)
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}
