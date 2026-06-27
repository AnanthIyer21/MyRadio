// Pull readable body text out of an article page (paragraph text), and clean
// Project Gutenberg plain-text. Used so "Full article / Full text" can be read aloud.

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
  let t = raw;
  const start = t.indexOf("*** START");
  if (start >= 0) t = t.slice(t.indexOf("\n", start) + 1);
  const end = t.indexOf("*** END");
  if (end >= 0) t = t.slice(0, end);
  t = t.replace(/\s+/g, " ").trim();
  return t.slice(0, maxChars);
}

function clean(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
