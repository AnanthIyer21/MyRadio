// Audiobook agent — public-domain catalogue via Gutendex (Project Gutenberg),
// searched across the listener's topics. Text now; narrated audio (LibriVox / TTS) later.
import { getJson } from "../lib/http.js";
import { toSummary } from "../lib/summary.js";

export async function audiobookAgent(profile = {}) {
  // Vary the search across topics + free-text interests so replenishes on a long
  // session surface different public-domain titles rather than the same few.
  const pool = [...(profile.topics || []), ...(profile.keywords || [])]
    .map((t) => String(t).trim()).filter((t) => t.length > 2);
  const queries = sample(pool.length ? pool : ["adventure", "classic", "science", "history"], 3);

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
      textUrl: pickBookText(b.formats),
      summary: bookSummary(b),
      durationSec: 1500,
      energy: 0.3,
      audioUrl: null,
    }))
    // Drop books with no usable plain-text source rather than ship a dead/README slot.
    .filter((it) => it.textUrl);

  return items.length ? items : seed();
}

// Choose the actual book plain-text, never a README / file-listing / zip.
// Gutendex sometimes lists a "*-README.txt" under a text/plain key, which would
// otherwise be read aloud as a file-distribution notice instead of the book.
function pickBookText(formats = {}) {
  const urls = Object.entries(formats)
    .filter(([k]) => /^text\/plain/i.test(k))
    .map(([, v]) => v)
    .filter(Boolean);
  const pool = urls.filter((u) => !/readme|\.zip(\?|$)|index|metadata|\/dirs?\//i.test(u));
  // Prefer the /files/NN/NN-0.txt edition (carries the standard *** START *** markers)
  // over the /ebooks/NN.txt.utf-8 cache edition (marker-less front matter).
  return (
    pool.find((u) => /-0\.txt(\?|$)/i.test(u)) ||
    pool.find((u) => /\/files\/\d+\/\d+\.txt(\?|$)/i.test(u)) ||
    pool.find((u) => /\.txt\.utf-8(\?|$)/i.test(u)) ||
    pool.find((u) => /\.txt(\?|$)/i.test(u)) ||
    pool[0] ||
    ""
  );
}

// Distinct random sample of up to n terms.
function sample(arr, n) {
  const a = [...new Set(arr)];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function bookSummary(b) {
  const author = b.authors?.[0]?.name || "an unknown author";
  const subjects = (b.subjects || []).slice(0, 3).join("; ");
  return toSummary(`${b.title} by ${author}.${subjects ? " Themes: " + subjects + "." : ""}`);
}

// Resilient fallback: real public-domain classics with known-good plain-text URLs
// (proper *** START *** markers, handled by cleanBookText), so a transient Gutendex
// failure still yields a genuine readable book — never fake "offline demo" content.
const CLASSICS = [
  { id: 1342, title: "Pride and Prejudice", author: "Jane Austen", subjects: ["England", "love", "social class"] },
  { id: 1661, title: "The Adventures of Sherlock Holmes", author: "Arthur Conan Doyle", subjects: ["detective", "mystery"] },
  { id: 84, title: "Frankenstein", author: "Mary Wollstonecraft Shelley", subjects: ["science", "horror"] },
  { id: 11, title: "Alice's Adventures in Wonderland", author: "Lewis Carroll", subjects: ["fantasy", "children"] },
  { id: 2701, title: "Moby Dick", author: "Herman Melville", subjects: ["adventure", "sea"] },
];

function seed() {
  return CLASSICS.slice(0, 3).map((b) => ({
    id: "book-" + b.id,
    type: "audiobook",
    title: b.title,
    subtitle: `${b.author} · Project Gutenberg`,
    source: "Project Gutenberg",
    url: `https://www.gutenberg.org/ebooks/${b.id}`,
    textUrl: `https://www.gutenberg.org/files/${b.id}/${b.id}-0.txt`,
    summary: toSummary(`${b.title} by ${b.author}. Themes: ${b.subjects.join("; ")}.`),
    durationSec: 1500,
    energy: 0.3,
    audioUrl: null,
  }));
}
