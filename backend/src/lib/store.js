// Durable profile store — the persistence prerequisite for the learning loop.
// Taste profiles (rewards, type/topic affinity, interests) must survive a restart so
// the radio keeps learning across sessions, instead of resetting every time the
// process bounces. Sessions (the ephemeral candidate pool) stay in memory by design.
//
// Zero-dependency: a single JSON file, loaded on boot and written (debounced) on change.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const FILE = fileURLToPath(new URL("../../data/profiles.json", import.meta.url));

export function loadProfiles() {
  try {
    if (existsSync(FILE)) return new Map(Object.entries(JSON.parse(readFileSync(FILE, "utf8"))));
  } catch { /* corrupt/missing → start fresh */ }
  return new Map();
}

let timer = null;
export function saveProfiles(map) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(Object.fromEntries(map)));
    } catch { /* best-effort; never crash the request path on a write error */ }
  }, 500);
}
