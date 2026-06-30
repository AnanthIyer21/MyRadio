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

// Provider-agnostic LLM layer. The summaries/onboarding/producer work with any chat
// model; pick by which key is set. Groq (free, hosted, OpenAI-compatible) and Anthropic
// are supported; with neither, llmAvailable() is false and every caller falls back to
// its deterministic path. (User chose a free/open provider — this is the non-Claude
// implementation they asked for; Claude remains available via ANTHROPIC_API_KEY.)
function provider() {
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}
export const llmAvailable = () => !!provider();

// One JSON-returning chat call across providers. Returns the parsed object (expected to
// match `schema`) or null on no-key / HTTP / parse failure — callers validate the shape.
async function chatJSON({ system, user, schema, maxTokens = 1024, ms = 15000 }) {
  const p = provider();
  if (!p) return null;
  try {
    if (p === "groq") {
      // OpenAI-compatible Chat Completions with JSON mode. The schema goes in the prompt
      // (Groq guarantees valid JSON, not schema adherence — callers clean/validate).
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(ms),
        headers: { authorization: "Bearer " + process.env.GROQ_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system + "\n\nReturn ONLY a JSON object matching this schema (no markdown, no prose):\n" + JSON.stringify(schema) },
            { role: "user", content: user },
          ],
        }),
      });
      if (!r.ok) { console.warn(`[llm groq] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`); return null; }
      const j = await r.json();
      return JSON.parse(j.choices?.[0]?.message?.content || "null");
    }
    // anthropic
    const r = await fetch(API, {
      method: "POST", signal: AbortSignal.timeout(ms),
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": VERSION },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, output_config: { format: { type: "json_schema", schema } }, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) { console.warn(`[llm anthropic] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`); return null; }
    const j = await r.json();
    return JSON.parse((j.content || []).find((b) => b.type === "text")?.text || "null");
  } catch (e) { console.warn("[llm] chatJSON failed:", e?.message || e); return null; }
}

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
  "2. `summary`: for news/podcasts/audiobooks, a warm spoken summary of the item's `content` " +
  "(its full text/show-notes), sized to the listener's listening length. Each item gives a " +
  "`target_words` budget — write CLOSE to that many words (within ~15%): a short budget means " +
  "a tight headline-style digest, a long one means a fuller walk-through. Lead with what matters " +
  "most and cover the rest in proportion to the budget. Stay factual to the provided content. For " +
  "music items, return an empty string for summary.\n" +
  "Plain sentences only — no markdown, lists, headings, emoji, or stage directions. " +
  "Never invent facts beyond each item's content/blurb.";

// Per-type fallbacks (seconds of speech) when the listener hasn't set a length.
const DEFAULT_SECONDS = { news: 40, podcast: 90, audiobook: 90 };

// Spoken-word pace for sizing summaries: ~150 wpm = 2.5 words/sec, a natural radio read.
const WORDS_PER_SEC = 2.5;

export function targetSeconds(type, lengths = {}) {
  const v = lengths[type];
  if (typeof v !== "number" || v <= 0) return DEFAULT_SECONDS[type] || 45; // 0 = "Full" → cap below
  return Math.min(v, 300); // honour up to ~5 min of spoken summary (the longest slider)
}

// Words to aim for at the listener's pace — the concrete budget the model writes to.
export function targetWords(type, lengths = {}) {
  return Math.max(20, Math.round(targetSeconds(type, lengths) * WORDS_PER_SEC));
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
export async function generateScript(queue = [], { lengths = {}, context = {}, profile = {}, opening = true } = {}, ms = 20000) {
  if (!llmAvailable()) return null;
  const items = queue.filter((it) => it && it.title);
  if (!items.length) return new Map();

  const payload = items.map((it, i) => ({
    id: it.id,
    position: i + 1,
    type: it.type,
    title: it.title,
    source: it.source || it.subtitle || "",
    // The real text to summarise (article body / book opening / episode notes),
    // falling back to the short blurb when content enrichment found nothing.
    content: it.type === "music" ? "" : it.content || it.summary || "",
    target_seconds: it.type === "music" ? 0 : targetSeconds(it.type, lengths),
    target_words: it.type === "music" ? 0 : targetWords(it.type, lengths),
  }));
  // Size the output budget to the run: ~1.4 tokens/word, doubled for headroom, plus
  // room for segues + JSON, so long summaries aren't truncated mid-sentence.
  const totalWords = payload.reduce((n, p) => n + (p.target_words || 0), 0);
  const maxTokens = Math.min(8192, Math.max(2048, Math.round(totalWords * 2.8) + 512));
  const brief = {
    listener: profile.name || "there",
    context: context.mode || "idle",
    time_of_day: context.timeOfDay || "",
    // opening = the very start of the session (greet by name on item 1);
    // false = a continuation batch mid-listen (no greeting, just flow on).
    opening: !!opening,
    run: payload,
  };

  const parsed = await chatJSON({
    system: SYSTEM,
    user:
      "Here is the run for this session. For each item write a segue and (where " +
      "applicable) a summary of its `content`, in order, one entry per id. Size each " +
      "summary to that item's `target_words` (within ~15%) — that is the listener's " +
      "chosen listening length. " +
      "If opening is true, greet the listener by name on the first item; if false, " +
      "this is a continuation mid-session, so do NOT greet — just flow on naturally.\n\n" +
      JSON.stringify(brief),
    schema: SCHEMA,
    maxTokens,
    ms,
  });
  if (!parsed) return null;
  const out = new Map();
  for (const s of parsed.items || []) {
    if (!s || !s.id) continue;
    out.set(s.id, { segue: (s.segue || "").trim(), summary: (s.summary || "").trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The LLM "producer" — the structural half of the DJ agent. Where generateScript
// writes the narration, these two calls make the *decisions* a human producer
// would: which sources to pull for the moment, and how to sequence the show.
// Both are gated on ANTHROPIC_API_KEY and return null on no-key/failure, so the
// orchestrator falls back to its deterministic fan-out + scoring unchanged.

// Small shared caller for a structured-output producer decision. Returns the
// parsed object (per `schema`) or null on any failure. Provider-agnostic via chatJSON.
async function decide(system, user, schema, maxTokens, ms = 12000) {
  return chatJSON({ system, user, schema, maxTokens, ms });
}

const ALL_TYPES = ["news", "podcast", "audiobook", "music"];

const SOURCES_SYSTEM =
  "You are the producer of a personal AI radio station deciding WHICH content sources to pull " +
  "for this listener right now, like choosing which desks to call before building a show. " +
  "You are given the listener's profile (interests, content-mix preference, usual contexts) and " +
  "the current listening context (mode + time of day). Choose the subset of these source types to " +
  "fetch: news, podcast, audiobook, music. Fit the moment — e.g. skip long-form audiobooks during a " +
  "workout or commute, favour news in the morning, lean calm/long-form in an evening wind-down. " +
  "Always include music, and always return at least two types. Return only the chosen type names.";

const SOURCES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["types"],
  properties: {
    types: { type: "array", items: { type: "string", enum: ALL_TYPES } },
  },
};

// Decide which specialist agents to fan out to for this context. Returns a
// de-duplicated subset of ALL_TYPES (always non-empty, music-inclusive), or null
// to let the caller fetch everything.
export async function planSources(profile = {}, context = {}) {
  const brief = {
    context: context.mode || "idle",
    time_of_day: context.timeOfDay || "",
    weekday: context.weekday ?? null,
    topics: profile.topics || [],
    content_mix: profile.contentMix || null,
    usual_contexts: profile.contexts || [],
  };
  const out = await decide(
    SOURCES_SYSTEM,
    "Choose the source types to fetch for this listener and moment.\n\n" + JSON.stringify(brief),
    SOURCES_SCHEMA,
    256
  );
  if (!out || !Array.isArray(out.types)) return null;
  const types = [...new Set(out.types.filter((t) => ALL_TYPES.includes(t)))];
  if (!types.includes("music")) types.push("music"); // music is always available
  return types.length >= 2 ? types : null; // too thin → fall back to all sources
}

const ARRANGE_SYSTEM =
  "You are the producer of a personal AI radio station sequencing the next stretch of the show. " +
  "You receive a MENU of candidate items (already the strongest matches) and must choose and ORDER " +
  "the ones that make the best radio arc for this listener and context. Think like a DJ building a " +
  "set: open with energy that fits the mode (punchy for a commute/workout, calm for a wind-down), " +
  "interleave formats so it never feels like a block of one thing, place longer listens (audiobooks, " +
  "long podcasts) where they fit the moment and DROP them when they don't, and keep variety across " +
  "topics. Pick exactly the requested number of items when possible, fewer only if the menu is too " +
  "thin. Return their ids in play order — every id must come from the menu, no repeats.";

const ARRANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["run"],
  properties: {
    run: { type: "array", items: { type: "string" } },
  },
};

// Given a menu of scored candidates, let the producer select + order `n` of them
// into a show arc. Returns an ordered array of ids (subset of the menu), or null
// so the caller falls back to deterministic scoring + round-robin.
export async function arrangeShow(menu = [], { n = 4, context = {}, profile = {}, opening = true } = {}) {
  const items = (menu || []).filter((it) => it && it.id && it.title);
  if (items.length <= 1) return null; // nothing to arrange
  const brief = {
    listener: profile.name || "there",
    context: context.mode || "idle",
    time_of_day: context.timeOfDay || "",
    opening: !!opening, // true = very start of the session; false = a continuation batch
    want: Math.min(n, items.length),
    menu: items.map((it) => ({
      id: it.id,
      type: it.type,
      title: it.title,
      topic: it.topic || "",
      source: it.source || it.subtitle || "",
      energy: typeof it.energy === "number" ? it.energy : 0.5,
      duration_sec: it.durationSec || 0,
    })),
  };
  const out = await decide(
    ARRANGE_SYSTEM,
    "Sequence the next " + brief.want + " items into a show. Return their ids in play order.\n\n" +
      JSON.stringify(brief),
    ARRANGE_SCHEMA,
    512
  );
  if (!out || !Array.isArray(out.run)) return null;
  const valid = new Set(items.map((it) => it.id));
  const seen = new Set();
  const ids = out.run.filter((id) => valid.has(id) && !seen.has(id) && seen.add(id));
  return ids.length ? ids : null;
}

// ---------- onboarding interview agent (workflow #3) ----------
// Turn the listener's free-text answers into a structured taste profile via Claude,
// instead of the client's keyword/substring matching. Returns null with no key, so the
// caller keeps the keyword-derived profile (fallback) — the agentic path never blocks.
// Enums are constrained to the labels the rest of the system understands (news FEED
// topics, music vibes/genres, listening contexts).
const TOPIC_ENUM = ["world", "technology", "ai", "business", "science", "space", "health", "sport", "culture", "entertainment", "gaming", "politics", "climate"];
const VIBE_ENUM = ["upbeat", "focus", "chill"];
const GENRE_ENUM = ["electronic", "pop", "rock", "classical", "jazz", "lofi", "ambient"];
const CONTEXT_ENUM = ["commute", "workout", "focus", "walking", "evening"];

const INTERVIEW_SYSTEM =
  "You are the onboarding agent for a personal AI radio station. You read the listener's " +
  "free-text answers (what they want to hear about; what music/shows they love; when/where they " +
  "listen) and extract a structured taste profile. Map their interests to the allowed topic labels, " +
  "their music taste to the allowed vibes and genres, and their habits to the allowed listening " +
  "contexts. Also pull a handful of specific free-text keywords (teams, people, subjects they named) " +
  "for fine-grained matching. Only use the allowed enum values; include a label only when the text " +
  "genuinely supports it. Keep keywords lowercase and specific.";

const INTERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics", "keywords", "musicVibes", "genres", "contexts"],
  properties: {
    topics: { type: "array", items: { type: "string", enum: TOPIC_ENUM } },
    keywords: { type: "array", items: { type: "string" } },
    musicVibes: { type: "array", items: { type: "string", enum: VIBE_ENUM } },
    genres: { type: "array", items: { type: "string", enum: GENRE_ENUM } },
    contexts: { type: "array", items: { type: "string", enum: CONTEXT_ENUM } },
  },
};

export async function parseInterview({ name = "", interestsText = "", musicText = "", whenText = "" } = {}) {
  if (!interestsText && !musicText) return null;
  const out = await decide(
    INTERVIEW_SYSTEM,
    "Extract the listener's profile from these interview answers:\n" +
      JSON.stringify({ name, interests: interestsText, music: musicText, when: whenText }),
    INTERVIEW_SCHEMA,
    512
  );
  if (!out) return null;
  const clean = (arr, enumv) => [...new Set((arr || []).filter((x) => !enumv || enumv.includes(x)))];
  return {
    topics: clean(out.topics, TOPIC_ENUM),
    keywords: clean((out.keywords || []).map((k) => String(k).toLowerCase().trim()).filter((k) => k.length > 2)).slice(0, 12),
    musicVibes: clean(out.musicVibes, VIBE_ENUM),
    genres: clean(out.genres, GENRE_ENUM),
    contexts: clean(out.contexts, CONTEXT_ENUM),
  };
}
