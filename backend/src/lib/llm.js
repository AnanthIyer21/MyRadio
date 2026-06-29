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

// A radio host/producer writing TTS-friendly copy: no markdown, no headers, no
// emoji — just clean sentences calibrated to how long the listener wants to listen.
const SYSTEM =
  "You are the host and producer of a personal AI radio station. You receive the " +
  "ordered run of items (news, podcasts, audiobooks, music) for one listening session, " +
  "the listener's name, and the listening context (e.g. morning_commute, workout, " +
  "evening_wind_down). For EACH item write two things:\n" +
  "1. `segue`: one short spoken line introducing the item, like a real DJ — aware of " +
  "where it sits in the run (greet the listener by name on the first item; use natural " +
  "transitions like 'up next' or 'let's slow things down' afterward) and of the context " +
  "(energy and tone should fit the mode). One sentence, conversational.\n" +
  "2. `summary`: for news/podcasts/audiobooks, a warm spoken summary read to roughly the " +
  "given target_seconds; lead with what matters and stay factual to the source blurb. For " +
  "music items, return an empty string for summary.\n" +
  "Plain sentences only — no markdown, lists, headings, emoji, or stage directions. " +
  "Never invent facts beyond each item's blurb.";

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
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "segue", "summary"],
        properties: {
          id: { type: "string" },
          segue: { type: "string" }, // one-line spoken intro for this item
          summary: { type: "string" }, // spoken body; "" for music
        },
      },
    },
  },
};

// Produces a Map<id, {segue, summary}> for the ordered queue, or null if
// unavailable/failed. The whole run goes in one request so the host can write
// segues aware of flow and context. Music items get a segue but an empty summary.
export async function generateScript(queue = [], { lengths = {}, context = {}, profile = {} } = {}, ms = 20000) {
  if (!llmAvailable()) return null;
  const items = queue.filter((it) => it && it.title);
  if (!items.length) return new Map();

  const payload = items.map((it, i) => ({
    id: it.id,
    position: i + 1,
    type: it.type,
    title: it.title,
    source: it.source || it.subtitle || "",
    blurb: it.type === "music" ? "" : it.summary || "",
    target_seconds: it.type === "music" ? 0 : targetSeconds(it.type, lengths),
  }));
  const brief = {
    listener: profile.name || "there",
    context: context.mode || "idle",
    time_of_day: context.timeOfDay || "",
    run: payload,
  };

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
        max_tokens: 3072,
        system: SYSTEM,
        // Structured output guarantees the first text block is valid JSON.
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [
          {
            role: "user",
            content:
              "Here is the run for this session. Write a segue and (where applicable) a " +
              "summary for each item, in order. Return one entry per id.\n\n" +
              JSON.stringify(brief),
          },
        ],
      }),
    });
    if (!r.ok) {
      console.warn(`[llm] script ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const text = (data.content || []).find((b) => b.type === "text")?.text || "";
    const parsed = JSON.parse(text);
    const out = new Map();
    for (const s of parsed.items || []) {
      if (!s || !s.id) continue;
      out.set(s.id, { segue: (s.segue || "").trim(), summary: (s.summary || "").trim() });
    }
    return out;
  } catch (e) {
    console.warn("[llm] script failed:", e?.message || e);
    return null;
  }
}
