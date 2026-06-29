// MyRadio health monitor — zero-dependency, runnable by hand, by a local /loop,
// or by the scheduled cloud agent. It boots the backend in a sandbox, exercises
// the real listening loop, and confirms the content it returns is actually playable.
//
//   node monitor/check.mjs            # human-readable report, exits non-zero on failure
//   node monitor/check.mjs --json     # machine-readable report on stdout (for the agent)
//
// Optional env:
//   MYRADIO_HEALTH_URL   also probe a deployed /health (once MyRadio is deployed)
//   CHECK_PORT           port to boot the test backend on (default 8799)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = process.env.CHECK_PORT || 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_OUT = process.argv.includes("--json");

const results = [];
// severity "critical" => a failure means MyRadio is broken; "warn" => degraded.
async function step(name, severity, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, severity, ok: true, detail: detail || "ok", ms: Date.now() - started });
  } catch (err) {
    results.push({ name, severity, ok: false, detail: String(err?.message || err), ms: Date.now() - started });
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

async function fetchJson(url, init, timeoutMs = 15000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

// ---- the checks ---------------------------------------------------------

await step("unit tests (node --test)", "critical", async () => {
  const { code, out } = await run("node", ["--test"], { cwd: BACKEND });
  if (code !== 0) {
    const tail = out.split("\n").filter((l) => /not ok|Error|fail/i.test(l)).slice(-8).join(" | ");
    throw new Error(`test suite exited ${code}: ${tail || out.slice(-300)}`);
  }
  const passed = (out.match(/(?:#|ℹ) pass (\d+)/) || [])[1];
  return `${passed || "?"} tests passed`;
});

await step("web static syntax (node --check)", "critical", async () => {
  const files = ["app.js", "spotify.js", "wispr.js", "config.js"];
  for (const f of files) {
    const { code, out } = await run("node", ["--check", path.join(ROOT, "web", f)]);
    if (code !== 0) throw new Error(`web/${f}: ${out.trim().split("\n")[0]}`);
  }
  return `${files.length} web modules parse clean`;
});

let server;
await step("backend boots + /health", "critical", async () => {
  server = spawn("node", ["src/server.js"], { cwd: BACKEND, env: { ...process.env, PORT }, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  server.stdout.on("data", (d) => (bootLog += d));
  server.stderr.on("data", (d) => (bootLog += d));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const { status, body } = await fetchJson(`${BASE}/health`, {}, 1500);
      if (status === 200 && body.ok) return `healthy (v${body.version})`;
    } catch { /* not up yet */ }
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}: ${bootLog.slice(-200)}`);
  }
  throw new Error(`/health never became ready: ${bootLog.slice(-200)}`);
});

if (server && server.exitCode == null) {
  let queue = [];

  await step("core flow: onboarding → first station", "critical", async () => {
    const { status, body } = await fetchJson(`${BASE}/api/onboarding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "monitor", name: "Monitor", topics: ["technology", "world news"],
        musicVibes: ["upbeat"], contexts: ["morning_commute"],
        signals: { localHour: 8, dayOfWeek: 2 },
      }),
    });
    if (status !== 200) throw new Error(`status ${status}`);
    if (!body.queue?.length) throw new Error("onboarding returned an empty station");
    return `station with ${body.queue.length} items`;
  });

  await step("core flow: session-plan returns a balanced queue", "critical", async () => {
    const { status, body } = await fetchJson(`${BASE}/api/session-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "monitor", signals: { localHour: 8, dayOfWeek: 2 } }),
    });
    if (status !== 200) throw new Error(`status ${status}`);
    queue = body.queue || [];
    if (queue.length < 3) throw new Error(`queue too short (${queue.length})`);
    const types = new Set(queue.map((i) => i.type));
    if (types.size < 2) throw new Error(`queue not diversified, only types: ${[...types].join(",")}`);
    return `${queue.length} items across ${types.size} formats (${[...types].join(", ")})`;
  });

  await step("content is actually playable (audio URLs resolve)", "warn", async () => {
    const withAudio = queue.filter((i) => /^https:\/\//.test(i.audioUrl || ""));
    if (!withAudio.length) throw new Error("no items in the queue had a playable https audioUrl");
    const sample = withAudio.slice(0, 3);
    const checked = [];
    for (const item of sample) {
      try {
        const r = await fetch(item.audioUrl, { method: "GET", headers: { range: "bytes=0-1" }, signal: AbortSignal.timeout(10000) });
        const ct = r.headers.get("content-type") || "";
        const ok = (r.status === 200 || r.status === 206);
        checked.push(`${item.type}:${ok ? ct.split(";")[0] || r.status : "DEAD(" + r.status + ")"}`);
        if (!ok) throw new Error(`${item.type} audio ${item.audioUrl} -> ${r.status}`);
      } catch (e) {
        throw new Error(`${item.type} audio unreachable: ${String(e?.message || e)}`);
      }
    }
    return `${checked.length}/${withAudio.length} sampled OK (${checked.join(", ")})`;
  });

  await step("feedback loop updates the taste profile", "critical", async () => {
    const item = queue[0];
    const ev = await fetchJson(`${BASE}/api/events`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "monitor", itemId: item.id, type: "like" }),
    });
    if (ev.status !== 200 || !ev.body.ok) throw new Error(`events rejected: ${JSON.stringify(ev.body)}`);
    const prof = await fetchJson(`${BASE}/api/profile/monitor`, {}, 5000);
    if (!(prof.body.rewards?.[item.id] > 0)) throw new Error("like did not raise the item's reward");
    return `reward for ${item.id} -> ${ev.body.reward}`;
  });
}

// Optional: probe a real deployment when one exists.
if (process.env.MYRADIO_HEALTH_URL) {
  await step("deployed /health reachable", "critical", async () => {
    const { status, body } = await fetchJson(process.env.MYRADIO_HEALTH_URL, {}, 8000);
    if (status !== 200 || !body.ok) throw new Error(`deployed health -> ${status}`);
    return `deployed OK (v${body.version})`;
  });
}

// ---- teardown + report --------------------------------------------------

if (server && server.exitCode == null) { server.kill("SIGTERM"); await sleep(200); }

const failed = results.filter((r) => !r.ok);
const criticalFailed = failed.filter((r) => r.severity === "critical");
const status = criticalFailed.length ? "BROKEN" : failed.length ? "DEGRADED" : "HEALTHY";

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ status, checkedAt: new Date().toISOString(), results }, null, 2) + "\n");
} else {
  const icon = (r) => (r.ok ? "✅" : r.severity === "critical" ? "❌" : "⚠️ ");
  console.log(`\nMyRadio monitor — ${status}\n${"─".repeat(40)}`);
  for (const r of results) console.log(`${icon(r)} ${r.name} — ${r.detail} (${r.ms}ms)`);
  console.log(`${"─".repeat(40)}\n${results.filter(r=>r.ok).length}/${results.length} checks passed → ${status}\n`);
}

process.exit(criticalFailed.length ? 1 : 0);
