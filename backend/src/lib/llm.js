// Claude client for generated, spoken-word summaries — the upgrade from the
// extractive toSummary() in summary.js. Zero-dependency on purpose: calls the
// Messages API directly with Node's built-in fetch (same spirit as lib/http.js),
// rather than pulling in @anthropic-ai/sdk and its transitive deps.
//
// Gated on ANTHROPIC_API_KEY: with no key, generateSummaries() returns null and
// the caller keeps the extractive summaries, so the app works unchanged offline.

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
// Haiku 4.5 — cheap + fast, the right tier for high-volume summaries. Override
// with ANTHROPIC_MODEL (e.g. claude-opus-4-8) for higher quality at higher cost.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

export const llmAvailable = () => !!process.env.ANTHROPIC_API_KEY;

// A radio host writing TTS-friendly copy: no markdown, no headers, no emoji —
// just clean sentences calibrated to how long the listener wants to listen.
const SYSTEM =
  "You are the host of a personal AI radio station. For each item, write a warm, " +
  "natural spoken-word summary that will be read aloud by a text-to-speech voice. " +
  "Plain sentences only — no markdown, lists, headings, emoji, or stage directions. " +
  "Lead with what matters, stay factual to the source blurb, and write to roughly the " +
  "target spoken length given for each item. Do not invent facts beyond the blurb.";

// Per-type fallbacks (seconds of speech) when the listener hasn't set a length.
const DEFAULT_SECONDS = { news: 40, podcast: 90, audiobook: 90 };

function targetSeconds(type, lengths = {}) {
  const v = lengths[type];
  if (typeof v !== "number" || v <= 0) return DEFAULT_SECONDS[type] || 45; // 0 = "Full" → cap below
  return Math.min(v, 180); // never ask for more than ~3 min of spoken summary
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summaries"],
  properties: {
    summaries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
      },
    },
  },
};

// Returns a Map<id, summaryText> for the given items, or null if unavailable/failed.
// Items without a title or of type "music" are skipped (music needs no summary).
export async function generateSummaries(items = [], { lengths = {} } = {}, ms = 20000) {
  if (!llmAvailable()) return null;
  const targets = items.filter((it) => it && it.title && it.type !== "music");
  if (!targets.length) return new Map();

  const payload = targets.map((it) => ({
    id: it.id,
    type: it.type,
    title: it.title,
    source: it.source || it.subtitle || "",
    blurb: it.summary || "",
    target_seconds: targetSeconds(it.type, lengths),
  }));

  try {
    const r = await fetch(API, {
      method: "POST",
      signal: AbortSignal.timeout(ms),
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        // Structured output guarantees the first text block is valid JSON.
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [
          {
            role: "user",
            content:
              "Write spoken summaries for these radio items. Return one summary per id.\n\n" +
              JSON.stringify(payload),
          },
        ],
      }),
    });
    if (!r.ok) {
      console.warn(`[llm] summaries ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const text = (data.content || []).find((b) => b.type === "text")?.text || "";
    const parsed = JSON.parse(text);
    const out = new Map();
    for (const s of parsed.summaries || []) if (s && s.id && s.text) out.set(s.id, s.text.trim());
    return out;
  } catch (e) {
    console.warn("[llm] summaries failed:", e?.message || e);
    return null;
  }
}
