// Audiobook agent — public-domain catalogue via Gutendex (Project Gutenberg),
// searched across the listener's topics. Text now; narrated audio (LibriVox / TTS) later.
import { getJson } from "../lib/http.js";
import { toSummary } from "../lib/summary.js";

export async function audiobookAgent(profile = {}) {
  const queries = (profile.topics && profile.topics.length ? profile.topics : ["adventure", "classic"]).slice(0, 2);

  const settled = await Promise.allSettled(
    queries.map((q) => getJson(`https://gutendex.com/books?search=${encodeURIComponent(q)}&languages=en`))
  );

  const books = [];
  for (const r of settled) {
    if (r.status === "fulfilled") books.push(...(r.value.results || []).slice(0, 3));
  }

  const seen = new Set();
  const items = books
    .filter((b) => (seen.has(b.id) ? false : seen.add(b.id)))
    .slice(0, 5)
    .map((b) => ({
      id: "book-" + b.id,
      type: "audiobook",
      title: b.title,
      subtitle: `${b.authors?.[0]?.name || "Unknown"} · Project Gutenberg`,
      source: "Project Gutenberg",
      url: b.formats?.["text/html"] || b.formats?.["application/epub+zip"] || "",
      textUrl: b.formats?.["text/plain; charset=us-ascii"] || b.formats?.["text/plain; charset=utf-8"] || b.formats?.["text/plain"] || "",
      summary: bookSummary(b),
      durationSec: 1500,
      energy: 0.3,
      audioUrl: null,
    }));

  return items.length ? items : seed();
}

function bookSummary(b) {
  const author = b.authors?.[0]?.name || "an unknown author";
  const subjects = (b.subjects || []).slice(0, 3).join("; ");
  return toSummary(`${b.title} by ${author}.${subjects ? " Themes: " + subjects + "." : ""}`);
}

function seed() {
  return [{ id: "book-seed", type: "audiobook", title: "Public-domain classic, ch.1", subtitle: "Seed · offline", source: "seed", summary: "Offline demo book.", durationSec: 900, energy: 0.3, audioUrl: null }];
}
