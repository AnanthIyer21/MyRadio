// Minimal dependency-free RSS parser — good enough for well-formed feeds.
import { decodeEntities } from "./entities.js";

export function parseRss(xml, limit = 10) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1, limit + 1);
  for (const b of blocks) {
    items.push({
      title: tag(b, "title"),
      link: tag(b, "link"),
      pubDate: tag(b, "pubDate"),
      description: tag(b, "description") || tag(b, "itunes:summary"),
      duration: tag(b, "itunes:duration"),
      audioUrl: audioEnclosure(b),
    });
  }
  return items;
}

// Only treat an <enclosure> as playable audio if its type is audio/* (news feeds
// often attach images, which must NOT become an audio URL).
function audioEnclosure(block) {
  const enc = block.match(/<enclosure[^>]*>/i);
  if (!enc) return null;
  const url = enc[0].match(/url="([^"]+)"/i);
  const type = enc[0].match(/type="([^"]+)"/i);
  // Decode XML entities so the URL's query params survive (&amp; -> &).
  if (url && (!type || /audio/i.test(type[1]))) return decodeEntities(url[1]);
  return null;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return decodeEntities(
    String(s)
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]+>/g, "")
  ).replace(/\s+/g, " ").trim();
}

// Stable short id from a string (no crypto dependency).
export function shortHash(s = "") {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}
