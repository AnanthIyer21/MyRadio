// MyRadio UX probe — exercises the API exactly as the web client does and flags
// issues a *user* would hit: garbled text read aloud, license boilerplate spoken,
// dead/placeholder content, malformed media URLs, missing fields per item type.
//
//   node monitor/ux-probe.mjs            # report + rewrites monitor/HANDOFF.md
//   node monitor/ux-probe.mjs --json
//
// It boots its own backend (port CHECK_PORT or 8801) so it never depends on a
// server already running, and is safe to run from a post-commit hook or CI.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = process.env.CHECK_PORT || 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_OUT = process.argv.includes("--json");

const findings = []; // {severity: high|med|low, area, symptom, evidence, fix}
const add = (f) => findings.push(f);

async function api(pathname, init, timeoutMs = 20000) {
  const r = await fetch(`${BASE}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}
async function apiGet(pathname, timeoutMs = 20000) { return api(pathname, {}, timeoutMs); }

// ---- boot backend -------------------------------------------------------
const server = spawn("node", ["src/server.js"], { cwd: BACKEND, env: { ...process.env, PORT }, stdio: ["ignore", "pipe", "pipe"] });
let booted = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try { const { body } = await apiGet("/health", 1500); if (body?.ok) { booted = true; break; } } catch {}
  if (server.exitCode != null) break;
}
if (!booted) {
  add({ severity: "high", area: "backend", symptom: "Backend never became healthy — the whole app is offline.", evidence: `no /health on ${BASE}`, fix: "Check src/server.js boot errors." });
  finish();
}

// ---- exercise the real flows -------------------------------------------
const topics = ["technology", "world", "science"];
const { body: plan } = await api("/api/onboarding", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: "uxprobe", name: "UX", topics, keywords: ["ai", "space"], musicVibes: ["upbeat"], genres: ["electronic"], contexts: ["focus"], lengths: { news: 45, podcast: 300, audiobook: 120 }, signals: { localHour: 8, dayOfWeek: 2 } }),
});
const queue = plan?.queue || [];
if (!queue.length) add({ severity: "high", area: "onboarding", symptom: "Onboarding returned an empty station — nothing to play.", evidence: JSON.stringify(plan).slice(0, 200), fix: "orchestrator returned no items." });

const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i;
const byType = (t) => queue.filter((i) => i.type === t);

// 1. Per-item required fields (what the web client reads).
for (const it of queue) {
  const need = { news: "url", podcast: "audioUrl", audiobook: "textUrl", music: "audioUrl" }[it.type];
  if (need && !it[need]) add({ severity: "med", area: `${it.type} item`, symptom: `Missing "${need}" — the player can't fully resolve this ${it.type}.`, evidence: `id=${it.id} title="${(it.title || "").slice(0, 50)}"`, fix: `Ensure the ${it.type} agent always sets ${need} (or filters items that lack it).` });
  if (it.source === "seed" || /(^|-)seed/.test(it.id || "")) add({ severity: "med", area: `${it.type} fallback`, symptom: `A "seed"/offline-demo ${it.type} is in a LIVE station — user sees fake demo content.`, evidence: `id=${it.id} source=${it.source}`, fix: `Upstream fetch failed and silently fell back to seed(); either retry, drop the slot, or label it clearly.` });
  if (ENTITY.test(it.title || "") || ENTITY.test(it.summary || "")) add({ severity: "med", area: `${it.type} text`, symptom: `Raw HTML entity in title/summary — shown/spoken literally.`, evidence: `id=${it.id} "${(it.title || it.summary || "").match(ENTITY)}"`, fix: "Decode HTML entities in the agent before returning." });
  if (/&amp;/.test(it.audioUrl || "")) add({ severity: "med", area: `${it.type} media`, symptom: `audioUrl contains un-decoded "&amp;" — query params become malformed (broken tracking/redirects).`, evidence: (it.audioUrl || "").slice(0, 80), fix: "Decode RSS entities (&amp;→&) when parsing enclosure URLs." });
}

// 2. News full-text read-aloud — entities & emptiness.
const news = byType("news").find((i) => i.url);
if (news) {
  const { body } = await apiGet(`/api/article?url=${encodeURIComponent(news.url)}`);
  const txt = body?.text || "";
  if (!txt) add({ severity: "med", area: "news full read", symptom: "Article extraction returned empty — 'Full article' read-aloud falls back to the one-line summary.", evidence: `url=${news.url}`, fix: "Improve extractArticle selectors / handle this source." });
  else if (ENTITY.test(txt)) add({ severity: "high", area: "news full read", symptom: "Extracted article text contains raw HTML entities (e.g. &#x27;) — TTS speaks gibberish / shows garbled punctuation.", evidence: (txt.match(new RegExp(`.{0,15}${ENTITY.source}.{0,15}`, "i")) || [txt.slice(0, 40)])[0], fix: "In extract.js clean(): decode hex (&#xNN;) + named entities to characters instead of stripping; current regex misses &#x.. and deletes &#NN; (drops apostrophes)." });
}

// 3. Audiobook full read-aloud — Gutenberg license boilerplate.
const book = byType("audiobook").find((i) => i.textUrl);
if (book) {
  const { body } = await apiGet(`/api/booktext?url=${encodeURIComponent(book.textUrl)}`);
  const txt = body?.text || "";
  const head = txt.slice(0, 600).toUpperCase();
  if (!txt) add({ severity: "med", area: "audiobook full read", symptom: "Book text extraction returned empty.", evidence: `textUrl=${book.textUrl}`, fix: "Handle this Gutenberg text layout." });
  else if (/PROJECT GUTENBERG|START OF (THE|THIS)|\bLICENSE\b/.test(head)) add({ severity: "high", area: "audiobook full read", symptom: "Book text starts with Project Gutenberg license/boilerplate — the audiobook reads legal text aloud instead of the book.", evidence: txt.slice(0, 90).replace(/\s+/g, " "), fix: "cleanBookText must strip the header up to '*** START OF...' and footer from '*** END OF...'; the fetch window (getText cap in server.js) may also truncate before the START marker — raise it." });
}

// 4. Audiobook relevance (soft): does the book relate to the listener's topics?
const anyBook = byType("audiobook")[0];
if (anyBook && anyBook.source !== "seed") {
  const hay = `${anyBook.title} ${anyBook.subtitle}`.toLowerCase();
  if (!topics.some((t) => hay.includes(t)) && !/tech|world|scien|ai|comput|space/.test(hay))
    add({ severity: "low", area: "audiobook relevance", symptom: "Audiobook looks unrelated to the listener's topics (Gutendex full-text search matches odd catalogs).", evidence: `topics=[${topics}] book="${(anyBook.title || "").slice(0, 60)}"`, fix: "Search Gutendex by subject/topic mapping, or curate a per-topic shortlist." });
}

// 5. Frontend note that the API can't reveal (kept as a standing reminder).
add({ severity: "low", area: "queue UI", symptom: "Every queue row renders a static '▶ audio' label (web/app.js renderQueue), even for spoken summaries / news / audiobooks — misleading.", evidence: "web/app.js ~line 435", fix: "Label rows by what they actually play: 'audio' for music/full episode, 'spoken' for summaries." });

finish();

// ---- report -------------------------------------------------------------
function finish() {
  if (server && server.exitCode == null) server.kill("SIGTERM");
  const order = { high: 0, med: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const stamp = process.env.PROBE_TIME || "(run locally)";

  const md = [
    "# MyRadio — UX findings handoff",
    "",
    "_Auto-generated by `monitor/ux-probe.mjs` — driving the API the way the web client does._",
    `Last run: ${stamp} · ${findings.length} findings (high: ${counts.high || 0}, med: ${counts.med || 0}, low: ${counts.low || 0})`,
    "",
    "Recommendations for the dev session, highest-impact first:",
    "",
    ...findings.map((f, i) => [
      `## ${i + 1}. [${f.severity.toUpperCase()}] ${f.area} — ${f.symptom}`,
      `- **Evidence:** \`${String(f.evidence).replace(/`/g, "'").slice(0, 160)}\``,
      `- **Recommended fix:** ${f.fix}`,
      "",
    ].join("\n")),
    findings.length ? "" : "✅ No UX issues detected this run.",
    "",
  ].join("\n");

  writeFileSync(path.join(ROOT, "monitor", "HANDOFF.md"), md);

  if (JSON_OUT) process.stdout.write(JSON.stringify({ stamp, counts, findings }, null, 2) + "\n");
  else {
    console.log(`\nMyRadio UX probe — ${findings.length} findings (high ${counts.high || 0} / med ${counts.med || 0} / low ${counts.low || 0})\n${"─".repeat(50)}`);
    for (const f of findings) console.log(`[${f.severity.toUpperCase()}] ${f.area}: ${f.symptom}`);
    console.log(`${"─".repeat(50)}\nWrote monitor/HANDOFF.md\n`);
  }
  process.exit(0);
}
