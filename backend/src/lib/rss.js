// Minimal dependency-free RSS parser — good enough for well-formed feeds.

export function parseRss(xml, limit = 10) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1, limit + 1);
  for (const b of blocks) {
    const enclosure = b.match(/<enclosure[^>]*url="([^"]+)"/i);
    items.push({
      title: tag(b, "title"),
      link: tag(b, "link"),
      pubDate: tag(b, "pubDate"),
      description: tag(b, "description"),
      audioUrl: enclosure ? enclosure[1] : null,
    });
  }
  return items;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Stable short id from a string (no crypto dependency).
export function shortHash(s = "") {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}
