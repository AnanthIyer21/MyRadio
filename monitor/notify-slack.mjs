// Posts a MyRadio monitor failure summary to a Slack Incoming Webhook.
// Usage: node monitor/notify-slack.mjs <webhook-url>
// Reads monitor-report.json from the cwd; degrades gracefully if it's missing.

import { readFileSync } from "node:fs";

const webhook = process.argv[2];
if (!webhook) { console.error("no webhook url"); process.exit(0); }

let report;
try { report = JSON.parse(readFileSync("monitor-report.json", "utf8")); } catch { report = null; }

const sha = (process.env.GITHUB_SHA || "").slice(0, 7) || "local";
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";

const failed = report?.results?.filter((r) => !r.ok) || [];
const lines = failed.length
  ? failed.map((r) => `• *${r.name}* — ${r.detail}`).join("\n")
  : "Monitor crashed before producing a report — see the run logs.";

const text = [
  `🔴 *MyRadio monitor failed* on \`${sha}\` (${report?.status || "ERROR"})`,
  lines,
  runUrl ? `<${runUrl}|View the failing run>` : "",
].filter(Boolean).join("\n");

const res = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
if (!res.ok) { console.error(`Slack webhook returned ${res.status}`); process.exit(0); }
console.log("Slack alert sent.");
