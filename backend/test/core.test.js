import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContext } from "../src/context.js";
import { planSession } from "../src/planner.js";

test("context agent detects morning commute on a weekday", () => {
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2 });
  assert.equal(ctx.mode, "morning_commute");
});

test("workout activity overrides time-based mode", () => {
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2, activity: "workout" });
  assert.equal(ctx.mode, "workout");
});

test("planner returns a ranked cross-format queue", () => {
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2 });
  const plan = planSession({ context: ctx, profile: { rewards: {} } });
  assert.ok(plan.queue.length > 0);
  assert.ok(plan.queue[0].score >= plan.queue[plan.queue.length - 1].score);
});

test("explicit rewards lift an item's score", () => {
  const ctx = detectContext({ localHour: 8, dayOfWeek: 2 });
  const base = planSession({ context: ctx, profile: { rewards: {} } });
  const boosted = planSession({ context: ctx, profile: { rewards: { "book-1": 5 } } });
  assert.equal(boosted.queue[0].id, "book-1");
  assert.notEqual(base.queue[0].id, "book-1");
});
