// MyRadio web client: onboarding -> orchestrated station -> player.
// Playback per item type: music = full audio; news/podcast/audiobook = AI summary
// (spoken by the browser's speech engine) or full audio/text, per Settings.
const API = "http://localhost:8787";
const USER = "demo";
const speechOK = "speechSynthesis" in window;

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), onboarding: $("onboarding"), player: $("player"),
  mode: $("mode"), explanation: $("explanation"), queue: $("queue"),
  gear: $("gear"), settings: $("settings"),
  npBadge: $("np-badge"), npTitle: $("np-title"), npSub: $("np-sub"), npNote: $("np-note"),
  npProgress: $("np-progress"), npBar: $("np-bar"), npCur: $("np-cur"), npRem: $("np-rem"),
  prev: $("prev"), toggle: $("toggle"), next: $("next"),
  like: $("like"), save: $("save"), dislike: $("dislike"),
  audio: $("audio"),
};

let live = false;
let profile = { topics: [], musicVibes: [], genres: [], contexts: [] };
let queue = [];
let index = 0;
const history = [];                 // previously played indices, for "go back"
let mode = "audio";                 // 'audio' | 'speak' | 'text'
const summaryPrefs = { news: "summary", podcast: "full", audiobook: "summary" };

// speech timing
let speakTimer = null, speakElapsed = 0, speakEst = 0;

// ---------- connectivity ----------
async function checkHealth() {
  try { live = (await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { live = false; }
  els.status.textContent = live ? "backend live" : "local mode";
  els.status.className = "status " + (live ? "live" : "local");
}

function signals() {
  const now = new Date();                       // real current time of day
  const day = now.getDay();
  return { localHour: now.getHours(), dayOfWeek: day === 0 ? 7 : day, activity: activityFromContexts() };
}
function activityFromContexts() {
  const c = profile.contexts || [];
  if (c.includes("workout")) return "workout";
  if (c.includes("focus")) return "focus";
  if (c.includes("walking")) return "walking";
  return undefined;
}

// ---------- onboarding ----------
function wireChips(id) {
  const box = $(id), multi = box.dataset.multi === "true";
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    if (!multi) box.querySelectorAll("button").forEach((b) => b !== btn && b.classList.remove("on"));
    btn.classList.toggle("on");
  });
}
const chipValues = (id) => [...$(id).querySelectorAll("button.on")].map((b) => b.dataset.v);
["ob-topics", "ob-vibe", "ob-genres", "ob-contexts"].forEach(wireChips);

$("ob-start").onclick = async () => {
  profile = {
    name: $("ob-name").value.trim(),
    topics: chipValues("ob-topics"),
    musicVibes: chipValues("ob-vibe"),
    genres: chipValues("ob-genres"),
    contexts: chipValues("ob-contexts"),
  };
  startPlayer(await onboard());
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

// ---------- settings ----------
els.gear.onclick = () => { els.settings.hidden = !els.settings.hidden; };
document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    summaryPrefs[seg.dataset.type] = b.dataset.v;
    if (queue[index]?.type === seg.dataset.type) loadCurrent(false); // re-evaluate current
  });
});

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

function stopPlayback() {
  els.audio.pause();
  els.audio.removeAttribute("src");
  if (speechOK) speechSynthesis.cancel();
  if (speakTimer) { clearInterval(speakTimer); speakTimer = null; }
  setToggle(false);
}

function decideMode(item) {
  if (item.type === "music") return "audio";
  const pref = summaryPrefs[item.type] || "summary";
  if (pref === "summary" && item.summary && speechOK) return "speak";
  if (item.audioUrl) return "audio";
  return "text";
}

function loadCurrent(autoplay = false) {
  stopPlayback();                                  // <- always stop prior audio/speech first
  const item = queue[index]; if (!item) return;

  els.npBadge.textContent = item.type;
  els.npBadge.className = "badge " + item.type;
  els.npTitle.textContent = item.title;
  els.npSub.textContent = item.subtitle || item.source || "";
  resetReactions();
  renderQueue();

  els.npBar.style.width = "0%"; els.npCur.textContent = "0:00"; els.npRem.textContent = "";
  mode = decideMode(item);
  els.npProgress.classList.toggle("disabled", mode !== "audio");

  if (mode === "audio") {
    els.npNote.textContent = item.type === "music" ? "" : "▶ Full audio";
    els.audio.src = item.audioUrl;
    if (autoplay) playAudio(); else setToggle(false);
  } else if (mode === "speak") {
    els.npNote.textContent = "🔊 AI summary (spoken)";
    if (autoplay) startSpeak(item); else setToggle(false);
  } else { // text
    els.npNote.innerHTML = (item.summary ? item.summary + " " : "") +
      (item.url ? `<a href="${item.url}" target="_blank" rel="noopener">Open full ↗</a>` : "");
    setToggle(false);
  }
}

// --- audio mode ---
function playAudio() { els.audio.play().then(() => setToggle(true)).catch(() => setToggle(false)); event("play"); }
function pauseAudio() { els.audio.pause(); setToggle(false); }
els.audio.ontimeupdate = () => {
  const d = els.audio.duration;
  if (!d) return;
  els.npBar.style.width = (els.audio.currentTime / d * 100) + "%";
  els.npCur.textContent = fmt(els.audio.currentTime);
  els.npRem.textContent = "-" + fmt(d - els.audio.currentTime);
};
els.audio.onended = () => { event("complete"); advance(); };
els.npProgress.onclick = (e) => {              // seek to any point
  if (mode !== "audio" || !els.audio.duration) return;
  const r = els.npProgress.getBoundingClientRect();
  els.audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * els.audio.duration;
};

// --- speak (summary) mode ---
function startSpeak(item) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(item.summary);
  u.rate = 1.03;
  u.onend = () => { stopSpeakTimer(); if (mode === "speak") { event("complete"); advance(); } };
  speakEst = estSeconds(item.summary);
  speakElapsed = 0;
  speechSynthesis.speak(u);
  event("play");
  setToggle(true);
  startSpeakTimer();
}
function startSpeakTimer() {
  stopSpeakTimer();
  speakTimer = setInterval(() => {
    speakElapsed += 0.25;
    const ratio = Math.min(1, speakElapsed / speakEst);
    els.npBar.style.width = ratio * 100 + "%";
    els.npCur.textContent = fmt(speakElapsed);
    els.npRem.textContent = "-" + fmt(Math.max(0, speakEst - speakElapsed));
  }, 250);
}
function stopSpeakTimer() { if (speakTimer) { clearInterval(speakTimer); speakTimer = null; } }
const estSeconds = (t) => Math.max(3, t.split(/\s+/).length / 2.7);

// --- transport ---
els.toggle.onclick = () => {
  const item = queue[index]; if (!item) return;
  if (mode === "audio") {
    if (!els.audio.getAttribute("src")) return;
    els.audio.paused ? playAudio() : pauseAudio();
  } else if (mode === "speak") {
    if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); stopSpeakTimer(); setToggle(false); }
    else if (speechSynthesis.paused) { speechSynthesis.resume(); startSpeakTimer(); setToggle(true); }
    else startSpeak(item);
  }
};
els.next.onclick = () => { event("skip"); advance(); };
els.prev.onclick = () => {
  if (mode === "audio" && els.audio.currentTime > 3) { els.audio.currentTime = 0; return; }
  index = history.length ? history.pop() : 0;
  loadCurrent(true);
};
async function advance() {
  history.push(index);
  index += 1;
  if (index >= queue.length) {
    applyPlan(await getPlan());                  // re-plan with updated rewards
    index = 0; history.length = 0;
  }
  loadCurrent(true);
}
function setToggle(playing) { els.toggle.textContent = playing ? "❚❚" : "▶"; }

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
    const audible = item.type === "music" || item.audioUrl || (item.summary && speechOK);
    li.innerHTML = `
      <span class="badge ${item.type}">${item.type}</span>
      <div class="meta">
        <div class="rt">${item.title}</div>
        <div class="rs">${item.subtitle || item.source || ""}</div>
      </div>
      ${audible ? '<span class="has-audio">▶ audio</span>' : ""}`;
    li.onclick = () => { if (i !== index) { history.push(index); index = i; loadCurrent(true); } };
    els.queue.appendChild(li);
  });
}

const fmt = (sec = 0) => { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; };

// ---------- local fallback (works with no backend) ----------
const LOCAL_MUSIC = [
  { n: 1, title: "Neon Drive", energy: 0.85, g: "electronic" },
  { n: 9, title: "Afterglow", energy: 0.75, g: "pop" },
  { n: 3, title: "Pulse Theory", energy: 0.6, g: "electronic" },
  { n: 2, title: "Glass Horizon", energy: 0.35, g: "ambient" },
].map((t) => ({ id: `mus-sh${t.n}`, type: "music", title: t.title, subtitle: `${t.g} · royalty-free`,
  source: "SoundHelix", energy: t.energy, audioUrl: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${t.n}.mp3` }));

function localPlan() {
  const q = [
    { id: "news-x", type: "news", title: "Your briefing (offline demo)", subtitle: "seed", summary: "This is an offline demo summary, spoken by your browser so you can hear how AI news briefings will sound.", energy: 0.4, audioUrl: null },
    ...LOCAL_MUSIC,
    { id: "book-x", type: "audiobook", title: "A public-domain classic", subtitle: "seed", summary: "A short spoken summary of a public-domain book, demonstrating the audiobook summary mode.", energy: 0.3, audioUrl: null },
  ];
  return { mode: "idle", explanation: "Local demo — start the backend for live, personalized content.", queue: q };
}

// ---------- boot ----------
(async () => { await checkHealth(); })();
