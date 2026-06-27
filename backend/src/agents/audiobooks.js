// Audiobook agent — public-domain catalogue via Gutendex (Project Gutenberg).
// Text metadata now; narrated audio (LibriVox / TTS) is a later step.
import { getJson } from "../lib/http.js";

export async function audiobookAgent(profile = {}) {
  const topic = (profile.topics && profile.topics[0]) || "adventure";
  try {
    const data = await getJson(`https://gutendex.com/books?search=${encodeURIComponent(topic)}&languages=en`);
    const items = (data.results || []).slice(0, 3).map((b) => ({
      id: "book-" + b.id,
      type: "audiobook",
      title: b.title,
      subtitle: `${b.authors?.[0]?.name || "Unknown"} · Project Gutenberg`,
      source: "Project Gutenberg",
      url: b.formats?.["text/html"] || b.formats?.["application/epub+zip"] || "",
      durationSec: 1200,
      energy: 0.3,
      audioUrl: null,
    }));
    return items.length ? items : seed();
  } catch {
    return seed();
  }
}

function seed() {
  return [{ id: "book-seed", type: "audiobook", title: "Public-domain classic, ch.1", subtitle: "Seed · offline", source: "seed", durationSec: 900, energy: 0.3, audioUrl: null }];
}
