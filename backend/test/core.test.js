import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContext } from "../src/context.js";
import { scoreAndDiversify, scoreItem } from "../src/planner.js";
import { musicAgent } from "../src/agents/music.js";

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
