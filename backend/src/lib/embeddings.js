// Embeddings seam (workflow #5) — semantic relevance + dedup.
//
// Provider-agnostic and gated: with a key we embed the listener's interests and each
// news candidate and rank by cosine similarity (meaning, not keyword overlap), and
// collapse near-duplicate stories the title-prefix heuristic misses. With no key,
// embed() returns null and callers keep the keyword/freshness heuristic (fallback-safe).
//
// Providers (pick by which key is set):
//   GEMINI_API_KEY  → Google AI Studio embeddings (free tier; rate-limited, not metered)
//   OPENAI_API_KEY  → OpenAI text-embedding-3-small (pay-as-you-go, ~pennies/month)
const OPENAI_ENDPOINT = "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const GEMINI_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

function embProvider() {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}
export const embeddingsAvailable = () => !!embProvider();

async function geminiEmbed(texts, ms) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`;
  const body = { requests: texts.map((t) => ({ model: `models/${GEMINI_MODEL}`, content: { parts: [{ text: String(t).slice(0, 2000) }] } })) };
  const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(ms), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { console.warn(`[embed gemini] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); return null; }
  const j = await r.json();
  const vecs = (j.embeddings || []).map((e) => e.values);
  return vecs.length === texts.length ? vecs : null;
}

async function openaiEmbed(texts, ms) {
  const r = await fetch(OPENAI_ENDPOINT, {
    method: "POST", signal: AbortSignal.timeout(ms),
    headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, input: texts.map((t) => String(t).slice(0, 2000)) }),
  });
  if (!r.ok) { console.warn(`[embed openai] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); return null; }
  const j = await r.json();
  const vecs = (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return vecs.length === texts.length ? vecs : null;
}

// Embed an array of strings → array of vectors (same order), or null on no-key/failure.
export async function embed(texts = [], ms = 15000) {
  const p = embProvider();
  if (!p || !texts.length) return null;
  try { return p === "gemini" ? await geminiEmbed(texts, ms) : await openaiEmbed(texts, ms); }
  catch (e) { console.warn("[embed] failed:", e?.message || e); return null; }
}

export function cosine(a = [], b = []) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
