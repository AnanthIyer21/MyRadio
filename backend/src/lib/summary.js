// Summarization seam. Today it trims the source's own abstract (RSS standfirst,
// book subjects) into a short blurb. Swap toSummary() for an OpenAI call to get
// true generated summaries — the rest of the app already expects item.summary.

export function toSummary(text = "", maxSentences = 2) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const out = cleaned.split(/(?<=[.!?])\s+/).slice(0, maxSentences).join(" ");
  return out.length > 320 ? out.slice(0, 317) + "…" : out;
}
