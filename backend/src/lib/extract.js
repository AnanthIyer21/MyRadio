// Pull readable body text out of an article page (paragraph text), and clean
// Project Gutenberg plain-text. Used so "Full article / Full text" can be read aloud.
import { decodeEntities } from "./entities.js";

export function extractArticle(html, maxChars = 14000) {
  let scope = html;
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  if (art) scope = art[0];
  const paras = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => clean(m[1]))
    .filter((t) => t.length > 40 && !/^(advertisement|sign up|subscribe|cookie|photograph|this article|read more)/i.test(t));
  let text = paras.join(" ");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
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
