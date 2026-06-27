// MyRadio web demo: talks to the backend, falls back to a local plan if it's down.
const API = "http://localhost:8787";

const els = {
  status: document.getElementById("status"),
  mode: document.getElementById("mode"),
  explanation: document.getElementById("explanation"),
  queue: document.getElementById("queue"),
  play: document.getElementById("play"),
  hour: document.getElementById("hour"),
  hourLabel: document.getElementById("hourLabel"),
  activity: document.getElementById("activity"),
};

const USER = "demo";
let live = false;

async function checkHealth() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
    live = r.ok;
  } catch { live = false; }
  els.status.textContent = live ? "backend live" : "local mode";
  els.status.className = "status " + (live ? "live" : "local");
}

function signals() {
  const localHour = Number(els.hour.value);
  const day = new Date().getDay(); // 0 Sun .. 6 Sat
  return { localHour, dayOfWeek: day === 0 ? 7 : day, activity: els.activity.value || undefined };
}

async function getPlan() {
  if (live) {
    try {
      const r = await fetch(`${API}/api/session-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER, signals: signals() }),
      });
      if (r.ok) return r.json();
    } catch { /* fall through */ }
  }
  return localPlan(signals());
}

async function sendEvent(itemId, type) {
  if (!live) return;
  try {
    await fetch(`${API}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: USER, itemId, type }),
    });
  } catch { /* ignore in demo */ }
}

function render(plan) {
  els.mode.textContent = (plan.mode || "idle").replace(/_/g, " ");
  els.explanation.textContent = plan.explanation || "";
  els.queue.innerHTML = "";

  plan.queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "card" + (i === 0 ? " playing" : "");
    li.innerHTML = `
      <span class="badge ${item.type}">${item.type}</span>
      <div class="meta">
        <div class="title">${item.title}</div>
        <div class="sub">${fmt(item.durationSec)} · <span class="score">score ${item.score ?? "—"}</span></div>
      </div>
      <div class="actions">
        <button class="like" title="Like">♥</button>
        <button class="save" title="Save">⤓</button>
        <button class="skip" title="Skip">⏭</button>
        <button class="dislike" title="Less like this">✕</button>
      </div>`;
    const [like, save, skip, dislike] = li.querySelectorAll("button");
    like.onclick = () => react(item.id, "like");
    save.onclick = () => react(item.id, "save");
    skip.onclick = () => react(item.id, "skip");
    dislike.onclick = () => react(item.id, "dislike");
    els.queue.appendChild(li);
  });
}

async function react(itemId, type) {
  await sendEvent(itemId, type);
  // Re-plan so the user can see personalization shift the queue.
  render(await getPlan());
}

function fmt(sec = 0) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- Local fallback so the demo works with no backend ---
const SEED = [
  { id: "news-1", type: "news", title: "Morning briefing", durationSec: 180, energy: 0.4 },
  { id: "pod-1", type: "podcast", title: "Tech in 10", durationSec: 600, energy: 0.5 },
  { id: "book-1", type: "audiobook", title: "Public-domain classic, ch.1", durationSec: 900, energy: 0.3 },
  { id: "music-1", type: "music", title: "Upbeat focus instrumental", durationSec: 210, energy: 0.8 },
  { id: "music-2", type: "music", title: "Calm evening ambient", durationSec: 240, energy: 0.2 },
];
const MODE_ENERGY = { morning_commute: 0.6, evening_commute: 0.5, focus_block: 0.7, workout: 0.9, walking: 0.5, evening_wind_down: 0.25, idle: 0.5 };

function localMode({ localHour, dayOfWeek, activity }) {
  const weekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  if (activity === "workout") return "workout";
  if (activity === "walking") return "walking";
  if (activity === "focus") return "focus_block";
  if (weekday && localHour >= 6 && localHour <= 9) return "morning_commute";
  if (weekday && localHour >= 16 && localHour <= 19) return "evening_commute";
  if (localHour >= 20 || localHour < 6) return "evening_wind_down";
  return "idle";
}

function localPlan(sig) {
  const mode = localMode(sig);
  const target = MODE_ENERGY[mode] ?? 0.5;
  const queue = SEED
    .map((it) => ({ ...it, score: Number((1 - Math.abs(it.energy - target) + (it.type === "news" ? 0.2 : 0)).toFixed(3)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  return { mode, explanation: "Local demo mode — start the backend for live personalization.", queue };
}

els.hour.oninput = () => { els.hourLabel.textContent = String(els.hour.value).padStart(2, "0") + ":00"; };
els.play.onclick = async () => render(await getPlan());

(async () => { await checkHealth(); render(await getPlan()); })();
