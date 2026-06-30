import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContext } from "../src/context.js";
import { scoreAndDiversify, scoreItem } from "../src/planner.js";
import { musicAgent } from "../src/agents/music.js";
import { targetWords, targetSeconds } from "../src/lib/llm.js";
import { fetchItemContent } from "../src/lib/content.js";

test("context agent detects morning commute on a weekday", () => {
  assert.equal(detectContext({ localHour: 8, dayOfWeek: 2 }).mode, "morning_commute");
});

test("workout activity overrides time-based mode", () => {
  assert.equal(detectContext({ localHour: 8, dayOfWeek: 2, activity: "workout" }).mode, "workout");
});

test("music agent returns playable royalty-free tracks", async () => {
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2, activity: "workout" });
  const tracks = await musicAgent({}, ctx);
  assert.ok(tracks.length > 0);
  assert.ok(tracks.every((t) => t.audioUrl?.startsWith("https://")));
  // Workout context should favour higher-energy tracks first.
  assert.ok(tracks[0].energy >= 0.6);
});

test("explicit rewards lift an item's score", () => {
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2 });
  const item = { id: "x1", type: "music", energy: 0.5 };
  const base = scoreItem(item, { rewards: {} }, ctx);
  const boosted = scoreItem(item, { rewards: { x1: 5 } }, ctx);
  assert.ok(boosted > base);
});

test("summary length scales with the listener's listening length", () => {
  // A longer listening length must ask for proportionally more words.
  const short = targetWords("news", { news: 45 });
  const long = targetWords("podcast", { podcast: 300 });
  assert.ok(long > short * 3, "5-min podcast budget should dwarf a 45s news budget");
  // "Full" (0) and unset fall back to the per-type default, never zero.
  assert.equal(targetSeconds("news", { news: 0 }), targetSeconds("news", {}));
  assert.ok(targetWords("audiobook", {}) >= 20);
  // Honour the longest slider (5 min) without the old 3-min clip.
  assert.equal(targetSeconds("podcast", { podcast: 300 }), 300);
});

test("summary agent cleans podcast show-notes without a network fetch", async () => {
  const text = await fetchItemContent({
    type: "podcast",
    content: "<p>Hosts debate <b>AI policy</b>.</p><![CDATA[ extra ]]>&nbsp;and more.",
  });
  assert.ok(!/[<>]/.test(text), "HTML tags stripped");
  assert.match(text, /AI policy/);
});

test("summary agent yields no content (falls back to blurb) when none is fetchable", async () => {
  assert.equal(await fetchItemContent({ type: "news" }), "");        // no url
  assert.equal(await fetchItemContent({ type: "audiobook" }), "");   // no textUrl
  assert.equal(await fetchItemContent({ type: "music" }), "");       // music never summarised
});

test("diversify returns a balanced cross-format queue", () => {
  const items = [
    { id: "n1", type: "news", energy: 0.4 }, { id: "n2", type: "news", energy: 0.4 },
    { id: "m1", type: "music", energy: 0.8 }, { id: "m2", type: "music", energy: 0.5 },
    { id: "p1", type: "podcast", energy: 0.5 }, { id: "b1", type: "audiobook", energy: 0.3 },
  ];
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2 });
  const q = scoreAndDiversify(items, {}, ctx, 4);
  assert.equal(q.length, 4);
  assert.ok(new Set(q.map((i) => i.type)).size >= 3, "queue should span multiple formats");
});
