// MyRadio web client: onboarding interview -> orchestrated station -> audio player.
const API = "http://localhost:8787";
const USER = "demo";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), onboarding: $("onboarding"), player: $("player"),
  mode: $("mode"), explanation: $("explanation"), queue: $("queue"),
  hour: $("hour"), hourLabel: $("hourLabel"),
  npBadge: $("np-badge"), npTitle: $("np-title"), npSub: $("np-sub"), npNote: $("np-note"), npBar: $("np-bar"),
  prev: $("prev"), toggle: $("toggle"), next: $("next"),
  like: $("like"), save: $("save"), dislike: $("dislike"),
  audio: $("audio"),
};

let live = false;
let profile = { topics: [], musicVibe: null, contexts: [] };
let queue = [];
let index = 0;
const history = []; // previously played indices, for "go back"

// ---------- connectivity ----------
async function checkHealth() {
  try { live = (await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { live = false; }
  els.status.textContent = live ? "backend live" : "local mode";
  els.status.className = "status " + (live ? "live" : "local");
}

function signals() {
  const day = new Date().getDay();
  return { localHour: Number(els.hour.value), dayOfWeek: day === 0 ? 7 : day, activity: activityFromContexts() };
}
function activityFromContexts() {
  const c = profile.contexts || [];
  if (c.includes("workout")) return "workout";
  if (c.includes("focus")) return "focus";
  if (c.includes("walking")) return "walking";
  return undefined;
}

// ---------- onboarding ----------
function wireChips(containerId) {
  const box = $(containerId);
  const multi = box.dataset.multi === "true";
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    if (!multi) box.querySelectorAll("button").forEach((b) => b !== btn && b.classList.remove("on"));
    btn.classList.toggle("on");
  });
}
function chipValues(containerId) {
  return [...$(containerId).querySelectorAll("button.on")].map((b) => b.dataset.v);
}

["ob-topics", "ob-vibe", "ob-contexts"].forEach(wireChips);

$("ob-start").onclick = async () => {
  profile = {
    name: $("ob-name").value.trim(),
    topics: chipValues("ob-topics"),
    musicVibe: chipValues("ob-vibe")[0] || null,
    contexts: chipValues("ob-contexts"),
  };
  const plan = await onboard();
  startPlayer(plan);
};

async function onboard() {
  if (live) {
    try {
      const r = await fetch(`${API}/api/onboarding`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER, ...profile, signals: signals() }),
      });
      if (r.ok) return r.json();
    } catch { /* fall through */ }
  }
  return localPlan();
}

// ---------- player ----------
function startPlayer(plan) {
  els.onboarding.hidden = true;
  els.player.hidden = false;
  applyPlan(plan);
  index = 0; history.length = 0;
  loadCurrent(true);
}

function applyPlan(plan) {
  els.mode.textContent = (plan.mode || "idle").replace(/_/g, " ");
  els.explanation.textContent = plan.explanation || "";
  queue = plan.queue || [];
}

async function getPlan() {
  if (live) {
    try {
      const r = await fetch(`${API}/api/session-plan`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER, signals: signals() }),
      });
      if (r.ok) return r.json();
    } catch { /* fall through */ }
  }
  return localPlan();
}

function loadCurrent(autoplay = false) {
  const item = queue[index];
  if (!item) return;
  els.npBadge.textContent = item.type;
  els.npBadge.className = "badge " + item.type;
  els.npTitle.textContent = item.title;
  els.npSub.textContent = item.subtitle || item.source || "";
  resetReactions();
  renderQueue();

  if (item.audioUrl) {
    els.npNote.textContent = "";
    els.audio.src = item.audioUrl;
    if (autoplay) play();
    else { els.audio.load(); setToggle(false); }
  } else {
    // Text item (news / book): spoken summary via TTS comes later.
    els.audio.removeAttribute("src");
    els.npNote.textContent = "🔊 Spoken summary coming soon — press ⏭ for the next track.";
    setToggle(false);
    els.npBar.style.width = "0%";
  }
}

function play() { els.audio.play().then(() => setToggle(true)).catch(() => setToggle(false)); event("play"); }
function pause() { els.audio.pause(); setToggle(false); }
function setToggle(playing) { els.toggle.textContent = playing ? "❚❚" : "▶"; }

els.toggle.onclick = () => {
  const item = queue[index];
  if (!item?.audioUrl) return; // nothing to play for text items
  els.audio.paused ? play() : pause();
};

els.next.onclick = () => { event("skip"); advance(); };

els.prev.onclick = () => {
  if (els.audio.currentTime > 3) { els.audio.currentTime = 0; return; } // restart if mid-track
  if (history.length) { index = history.pop(); loadCurrent(true); }
  else { index = 0; loadCurrent(true); }
};

async function advance() {
  history.push(index);
  index += 1;
  if (index >= queue.length) {
    const plan = await getPlan();           // re-plan with updated rewards
    applyPlan(plan);
    index = 0; history.length = 0;
  }
  loadCurrent(true);
}

els.audio.onended = () => { event("complete"); advance(); };
els.audio.ontimeupdate = () => {
  if (els.audio.duration) els.npBar.style.width = (els.audio.currentTime / els.audio.duration * 100) + "%";
};

// ---------- reactions ----------
function resetReactions() { [els.like, els.save, els.dislike].forEach((b) => b.classList.remove("on")); }
els.like.onclick = () => { els.like.classList.toggle("on"); event("like"); };
els.save.onclick = () => { els.save.classList.toggle("on"); event("save"); };
els.dislike.onclick = () => { els.dislike.classList.add("on"); event("dislike"); setTimeout(() => { event("skip"); advance(); }, 250); };

async function event(type) {
  const item = queue[index]; if (!item || !live) return;
  try {
    await fetch(`${API}/api/events`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: USER, itemId: item.id, type }),
    });
  } catch { /* ignore in demo */ }
}

function renderQueue() {
  els.queue.innerHTML = "";
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "row" + (i === index ? " playing" : "");
    li.innerHTML = `
      <span class="badge ${item.type}">${item.type}</span>
      <div class="meta">
        <div class="rt">${item.title}</div>
        <div class="rs">${item.subtitle || item.source || ""}</div>
      </div>
      ${item.audioUrl ? '<span class="has-audio">▶ audio</span>' : ""}`;
    li.onclick = () => { if (i !== index) { history.push(index); index = i; loadCurrent(true); } };
    els.queue.appendChild(li);
  });
}

// ---------- local fallback (works with no backend) ----------
const LOCAL_MUSIC = [
  { n: 1, title: "Neon Drive", energy: 0.85, vibe: "upbeat" },
  { n: 9, title: "Afterglow", energy: 0.75, vibe: "upbeat" },
  { n: 3, title: "Pulse Theory", energy: 0.6, vibe: "focus" },
  { n: 2, title: "Glass Horizon", energy: 0.35, vibe: "chill" },
].map((t) => ({ id: `mus-sh${t.n}`, type: "music", title: t.title, subtitle: `${t.vibe} · royalty-free`,
  source: "SoundHelix", energy: t.energy, audioUrl: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${t.n}.mp3` }));

function localPlan() {
  const q = [
    { id: "news-x", type: "news", title: "Your briefing (offline demo)", subtitle: "seed", energy: 0.4, audioUrl: null },
    ...LOCAL_MUSIC,
    { id: "book-x", type: "audiobook", title: "Public-domain classic, ch.1", subtitle: "seed", energy: 0.3, audioUrl: null },
  ];
  return { mode: "idle", explanation: "Local demo — start the backend for live, personalized content.", queue: q };
}

// ---------- boot ----------
els.hour.oninput = () => { els.hourLabel.textContent = String(els.hour.value).padStart(2, "0"); };
(async () => { await checkHealth(); })();
