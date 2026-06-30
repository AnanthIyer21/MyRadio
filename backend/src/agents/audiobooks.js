// Audiobook agent — REAL human-narrated public-domain audiobooks via LibriVox
// (free, no API key). Each book ships as a list of chapter MP3s (hosted on archive.org),
// so audiobooks play in the narrator's own voice — not a TTS "AI voice" — and the client
// plays them serially in length-segments, resuming by chapter + position next time.
import { getJson } from "../lib/http.js";

const API = "https://librivox.org/api/feed/audiobooks";

// "6:18:46" -> seconds
function hmsToSec(t = "") {
  const p = String(t).split(":").map((n) => parseInt(n, 10) || 0);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] || 0;
}

function toItem(book) {
  const sections = (book.sections || [])
    .map((s, i) => ({ url: s.listen_url, dur: parseInt(s.playtime, 10) || 0, title: s.title, n: parseInt(s.section_number, 10) || (i + 1) }))
    .filter((s) => s.url)
    .sort((a, b) => a.n - b.n)            // CRITICAL: chapter order. LibriVox doesn't guarantee
    .map(({ url, dur, title }) => ({ url, dur, title })); // the array is sorted, so without this
  if (!sections.length) return null;     // sections[0] (played first) could be chapter 4, not 1.
  const author = book.authors?.[0] ? `${book.authors[0].first_name || ""} ${book.authors[0].last_name || ""}`.trim() : "Unknown";
  // LibriVox lists long works split into per-chapter/volume entries (e.g. "...(Volume 1,
  // Chapter 05)"). Serving one of those drops the listener into the MIDDLE of a book — the
  // "starts on chapter 4/5" bug. Flag them so the agent prefers complete books instead.
  const fragment = /\bchapters?\s*\d+|\bvol(?:ume)?\.?\s*\d+\s*,\s*chap/i.test(book.title || "");
  return {
    id: "book-lv-" + book.id,
    type: "audiobook",
    title: book.title,
    subtitle: `${author} · LibriVox`,
    source: "LibriVox",
    url: book.url_librivox || "",
    sections,                           // chapter MP3s — the client plays these in order
    durationSec: hmsToSec(book.totaltime),
    energy: 0.3,
    fragment,                           // true = a single chapter/volume of a larger work
    audioUrl: sections[0].url,          // first chapter, for any non-serial fallback
  };
}

export async function audiobookAgent(profile = {}) {
  // Search LibriVox by the listener's interests; sample a few so refills vary.
  const pool = [...(profile.topics || []), ...(profile.keywords || [])]
    .map((t) => String(t).trim()).filter((t) => t.length > 2);
  const queries = sample(pool.length ? pool : ["adventure", "science", "history", "mystery"], 3);

  const settled = await Promise.allSettled(
    queries.map((q) => getJson(`${API}/?title=^${encodeURIComponent(q)}&format=json&extended=1&limit=4`)
      .catch(() => getJson(`${API}/?title=${encodeURIComponent(q)}&format=json&extended=1&limit=4`)))
  );

  const seen = new Set();
  const items = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const b of (r.value.books || [])) {
      const it = toItem(b);
      if (it && !seen.has(it.id)) { seen.add(it.id); items.push(it); }
    }
  }
  // Prefer COMPLETE books over single-chapter/volume fragments, so a listener always starts
  // a book at chapter 1 rather than being dropped mid-work. Fragments sink to the end and are
  // only used if there aren't enough whole books.
  items.sort((a, b) => (a.fragment ? 1 : 0) - (b.fragment ? 1 : 0));
  const whole = items.filter((it) => !it.fragment);
  const chosen = whole.length >= 3 ? whole : items;   // drop fragments entirely when we have enough
  return chosen.length ? chosen.slice(0, 6) : await seed();
}

function sample(arr, n) {
  const a = [...new Set(arr)];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Resilient fallback: a few well-known LibriVox audiobooks by id, so a transient
// search failure still yields real narrated books rather than nothing.
const FALLBACK_IDS = [52, 32, 47, 84]; // Sherlock Holmes, Pride & Prejudice, etc.
async function seed() {
  const settled = await Promise.allSettled(
    FALLBACK_IDS.map((id) => getJson(`${API}/?id=${id}&format=json&extended=1`))
  );
  const items = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const it = toItem((r.value.books || [])[0] || {});
    if (it) items.push(it);
  }
  return items;
}
