// MyRadio web client.
// Onboarding interview (free text + dictation) -> orchestrated station -> player.
// Playback per item: music = full audio (Spotify Premium if connected, else royalty-free);
// news/podcast/audiobook = AI summary (condensed, spoken) or full (read aloud / full episode).
const API = "http://localhost:8787";
const USER = "demo";
const speechOK = "speechSynthesis" in window;
const CPS = 15; // approx chars/sec of speech, for spoken progress + seeking

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), onboarding: $("onboarding"), player: $("player"),
  mode: $("mode"), explanation: $("explanation"), queue: $("queue"),
  gear: $("gear"), settings: $("settings"), spotify: $("spotify"), spStatus: $("sp-status"),
  npBadge: $("np-badge"), npTitle: $("np-title"), npSub: $("np-sub"), npNote: $("np-note"),
  npProgress: $("np-progress"), npBar: $("np-bar"), npCur: $("np-cur"), npRem: $("np-rem"),
  prev: $("prev"), back10: $("back10"), toggle: $("toggle"), fwd10: $("fwd10"), next: $("next"),
  like: $("like"), save: $("save"), dislike: $("dislike"), audio: $("audio"),
};

let live = false;
let profile = {};
let queue = [], index = 0;
const history = [];
let mode = "audio";          // 'audio' | 'speak' | 'spotify' | 'text'
let current = null;          // resolved playback descriptor
let loadToken = 0;
const summaryPrefs = { news: "summary", podcast: "full", audiobook: "summary" };
const LENGTHS = { news: 45, podcast: 300, audiobook: 120 };

// Spotify
let spotifyCtx = null, spotifyMusic = [], lastSpPos = 0;
const spotifyReady = () => window.MyRadioSpotify && MyRadioSpotify.isConnected() && MyRadioSpotify.isPremium() && MyRadioSpotify.isReady();

// timers
let speakTimer = null, spPoll = null;
let speakText = "", speakPos = 0;

// ---------- connectivity ----------
async function checkHealth() {
  try { live = (await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { live = false; }
  els.status.textContent = live ? "backend live" : "local mode";
  els.status.className = "status " + (live ? "live" : "local");
}
function signals() {
  const now = new Date(), day = now.getDay();
  return { localHour: now.getHours(), dayOfWeek: day === 0 ? 7 : day, activity: activityFromContexts() };
}
function activityFromContexts() {
  const c = profile.contexts || [];
  if (c.includes("workout")) return "workout";
  if (c.includes("focus")) return "focus";
  if (c.includes("walking")) return "walking";
  return undefined;
}

// ---------- interview parsing (free text -> structured taste) ----------
const TOPIC_WORDS = {
  world: ["world", "ukraine", "gaza", "global", "war", "international"],
  technology: ["ai", "tech", "technology", "software", "startup", "openai", "apple", "google", "gadget", "coding", "crypto"],
  business: ["business", "finance", "economy", "market", "stock", "money", "trade"],
  science: ["science", "space", "nasa", "physics", "climate", "biology", "research", "health"],
  sport: ["sport", "sports", "football", "soccer", "arsenal", "nba", "tennis", "f1", "cricket"],
  culture: ["culture", "film", "movie", "art", "book", "music", "fashion", "celebrity"],
  politics: ["politics", "election", "government", "policy", "trump", "congress"],
};
const VIBE_WORDS = { upbeat: ["upbeat", "energetic", "gym", "workout", "party", "hype", "fast", "dance"], focus: ["focus", "study", "work", "concentrate", "coding", "lofi", "lo-fi", "instrumental"], chill: ["chill", "calm", "relax", "evening", "sleep", "ambient", "mellow", "slow"] };
const GENRE_WORDS = { electronic: ["electronic", "edm", "techno", "house", "dance"], pop: ["pop"], rock: ["rock", "indie", "metal", "punk", "alternative"], classical: ["classical", "orchestra", "piano"], jazz: ["jazz", "blues", "soul"], lofi: ["lofi", "lo-fi", "chillhop"], ambient: ["ambient", "atmospheric"] };
const STOP = new Set("the a an and or of to in on for with about i my me you we like love want hear listen stuff things anything something also really very some more most when where how is are be that this it at as".split(" "));

function matchCats(text, dict) {
  const t = (text || "").toLowerCase();
  return Object.keys(dict).filter((k) => dict[k].some((w) => t.includes(w)));
}
function keywordsFrom(text) {
  return [...new Set((text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)))].slice(0, 12);
}
function contextsFrom(text) {
  const t = (text || "").toLowerCase(), out = [];
  if (/commut|train|drive|car/.test(t)) out.push("commute");
  if (/gym|workout|run|exercise/.test(t)) out.push("workout");
  if (/work|study|focus|coding|office/.test(t)) out.push("focus");
  if (/walk/.test(t)) out.push("walking");
  if (/evening|night|bed|sleep|wind/.test(t)) out.push("evening");
  return out;
}

// ---------- dictation ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
document.querySelectorAll(".mic").forEach((btn) => {
  if (!SR) { btn.style.display = "none"; return; }
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = "en-US"; rec.interimResults = false; rec.continuous = true;
    const ta = $(btn.dataset.target);
    btn.classList.add("rec");
    rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) ta.value += (ta.value ? " " : "") + e.results[i][0].transcript.trim(); };
    rec.onend = () => { btn.classList.remove("rec"); rec = null; };
    rec.start();
  };
});

// length selectors (onboarding)
document.querySelectorAll(".seg[data-len]").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  LENGTHS[seg.dataset.len] = Number(b.dataset.v);
}));

// ---------- onboarding ----------
$("ob-start").onclick = async () => {
  const interests = $("ob-interests").value, music = $("ob-music").value, when = $("ob-when").value;
  profile = {
    name: $("ob-name").value.trim(),
    topics: matchCats(interests, TOPIC_WORDS),
    keywords: keywordsFrom(interests),
    musicVibes: matchCats(music, VIBE_WORDS),
    genres: matchCats(music, GENRE_WORDS),
    contexts: contextsFrom(when || interests),
    interestsText: interests, musicText: music,
  };
  persist();
  startPlayer(await onboard());
};

function persist() { try { localStorage.setItem("myradio_profile", JSON.stringify({ profile, LENGTHS, summaryPrefs })); } catch {} }
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem("myradio_profile") || "null");
    if (!s) return false;
    profile = s.profile || {}; Object.assign(LENGTHS, s.LENGTHS || {}); Object.assign(summaryPrefs, s.summaryPrefs || {});
    return !!profile.topics;
  } catch { return false; }
}

async function onboard() {
  if (live) {
    try {
      const r = await fetch(`${API}/api/onboarding`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER, ...profile, lengths: LENGTHS, spotify: spotifyCtx ? { genres: spotifyCtx.genres, topArtists: spotifyCtx.topArtists } : undefined, signals: signals() }),
      });
      if (r.ok) return r.json();
    } catch {}
  }
  return localPlan();
}
async function getPlan() {
  if (live) {
    try {
      const r = await fetch(`${API}/api/session-plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: USER, signals: signals() }) });
      if (r.ok) return r.json();
    } catch {}
  }
  return localPlan();
}

// ---------- settings ----------
els.gear.onclick = () => { els.settings.hidden = !els.settings.hidden; };
document.querySelectorAll(".settings .seg[data-type]").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  summaryPrefs[seg.dataset.type] = b.dataset.v; persist();
  if (queue[index]?.type === seg.dataset.type) loadCurrent(false);
}));

// ---------- player ----------
function startPlayer(plan) {
  els.onboarding.hidden = true; els.player.hidden = false;
  applyPlan(plan); index = 0; history.length = 0; loadCurrent(true);
}
function applyPlan(plan) {
  els.mode.textContent = (plan.mode || "idle").replace(/_/g, " ");
  els.explanation.textContent = plan.explanation || "";
  queue = plan.queue || [];
  // Premium: play music from the listener's Spotify instead of royalty-free.
  if (spotifyReady() && spotifyMusic.length) {
    let si = 0;
    queue = queue.map((it) => {
      if (it.type !== "music") return it;
      const t = spotifyMusic[si++ % spotifyMusic.length];
      return { ...it, spotifyUri: t.uri, title: t.title, subtitle: `${t.artist} · Spotify`, source: "Spotify" };
    });
  }
}

// ---- content resolution (may fetch full text) ----
const bodyCache = new Map();
async function fetchText(endpoint, url) {
  if (!url || !live) return "";
  if (bodyCache.has(url)) return bodyCache.get(url);
  try { const d = await (await fetch(`${API}/${endpoint}?url=${encodeURIComponent(url)}`)).json(); bodyCache.set(url, d.text || ""); return d.text || ""; }
  catch { return ""; }
}
const lead = (it) => it.type === "news" ? `Here's the latest from ${it.source}. ` : it.type === "podcast" ? `From ${it.source}. ` : it.type === "audiobook" ? `From ${it.title}. ` : "";
function condense(text, seconds) {
  if (!seconds) return text;                              // 0 = "full"
  const target = Math.round(seconds * 2.6), out = []; let w = 0;
  for (const s of String(text).split(/(?<=[.!?])\s+/)) { out.push(s); w += s.split(/\s+/).length; if (w >= target) break; }
  return out.join(" ");
}

async function resolveContent(item) {
  if (item.type === "music") {
    if (item.spotifyUri && spotifyReady()) return { kind: "spotify", uri: item.spotifyUri, isFull: true };
    return { kind: "audio", audioUrl: item.audioUrl, isFull: false };
  }
  const pref = summaryPrefs[item.type] || "summary";
  if (item.type === "podcast") {
    if (pref === "full" && item.audioUrl) return { kind: "audio", audioUrl: item.audioUrl, isFull: true };
    return { kind: "speak", text: lead(item) + condense(item.summary || item.title, LENGTHS.podcast), isFull: false };
  }
  if (item.type === "news") {
    let body = await fetchText("api/article", item.url); if (!body) body = item.summary || item.title;
    return { kind: "speak", text: lead(item) + (pref === "full" ? body : condense(body, LENGTHS.news)), isFull: pref === "full" };
  }
  if (item.type === "audiobook") {
    let t = await fetchText("api/booktext", item.textUrl); if (!t) t = item.summary || item.title;
    return { kind: "speak", text: lead(item) + (pref === "full" ? t : condense(t, LENGTHS.audiobook)), isFull: pref === "full" };
  }
  return { kind: "text" };
}

async function loadCurrent(autoplay = false) {
  const my = ++loadToken;
  stopPlayback();
  const item = queue[index]; if (!item) return;

  els.npBadge.textContent = item.type; els.npBadge.className = "badge " + item.type;
  els.npTitle.textContent = item.title;
  els.npSub.textContent = item.subtitle || item.source || "";
  resetReactions(); renderQueue();
  els.npBar.style.width = "0%"; els.npCur.textContent = "0:00"; els.npRem.textContent = "";

  const d = await resolveContent(item);
  if (my !== loadToken) return;                 // user already moved on
  current = d; mode = d.kind;

  const seekable = d.kind === "audio" || d.kind === "spotify";
  els.npProgress.classList.toggle("disabled", !(seekable || d.kind === "speak"));
  const showSkip = d.isFull || d.kind === "spotify" || item.type === "music";
  els.back10.hidden = els.fwd10.hidden = !showSkip;

  if (d.kind === "text") { els.npNote.innerHTML = (item.summary || "") + (item.url ? ` <a href="${item.url}" target="_blank" rel="noopener">Open ↗</a>` : ""); setToggle(false); return; }
  els.npNote.textContent = noteFor(item, d);

  if (autoplay) { chime(); await sleep(360); if (my === loadToken) startPlayback(d); }
  else setToggle(false);
}
function noteFor(item, d) {
  if (item.type === "music") return d.kind === "spotify" ? "▶ Spotify" : "";
  return d.isFull ? (d.kind === "audio" ? "▶ Full episode" : "📖 Reading the full text") : "🔊 AI summary (spoken)";
}

function startPlayback(d) {
  if (d.kind === "audio") { els.audio.src = d.audioUrl; playAudio(); }
  else if (d.kind === "speak") { startSpeakFrom(d.text, 0); }
  else if (d.kind === "spotify") { startSpotify(d.uri); }
  event("play");
}
function stopPlayback() {
  els.audio.pause(); els.audio.removeAttribute("src");
  if (speechOK) speechSynthesis.cancel();
  clearInterval(speakTimer); speakTimer = null;
  clearInterval(spPoll); spPoll = null;
  if (window.MyRadioSpotify && MyRadioSpotify.isReady()) MyRadioSpotify.pause();
  setToggle(false);
}

// ---- audio mode ----
function playAudio() { els.audio.play().then(() => setToggle(true)).catch(() => setToggle(false)); }
els.audio.ontimeupdate = () => {
  const dur = els.audio.duration; if (!dur) return;
  els.npBar.style.width = (els.audio.currentTime / dur * 100) + "%";
  els.npCur.textContent = fmt(els.audio.currentTime); els.npRem.textContent = "-" + fmt(dur - els.audio.currentTime);
};
els.audio.onended = () => { event("complete"); advance(); };

// ---- speak (summary / full read-aloud) with char-based seek ----
function startSpeakFrom(text, posChars) {
  speechSynthesis.cancel();
  speakText = text; speakPos = Math.max(0, Math.min(posChars, text.length));
  const u = new SpeechSynthesisUtterance(text.slice(speakPos)); u.rate = 1.03;
  u.onend = () => { if (mode === "speak") { stopSpeakTimer(); event("complete"); advance(); } };
  speechSynthesis.speak(u); setToggle(true); startSpeakTimer();
}
function startSpeakTimer() {
  stopSpeakTimer();
  speakTimer = setInterval(() => {
    speakPos = Math.min(speakText.length, speakPos + CPS * 0.25);
    els.npBar.style.width = (speakPos / speakText.length * 100) + "%";
    els.npCur.textContent = fmt(speakPos / CPS);
    els.npRem.textContent = "-" + fmt(Math.max(0, (speakText.length - speakPos) / CPS));
  }, 250);
}
function stopSpeakTimer() { clearInterval(speakTimer); speakTimer = null; }
function speakSeek(deltaSec) { startSpeakFrom(speakText, Math.floor(speakPos + deltaSec * CPS)); }

// ---- spotify mode ----
async function startSpotify(uri) {
  const ok = await MyRadioSpotify.play(uri); setToggle(ok);
  clearInterval(spPoll);
  spPoll = setInterval(async () => {
    const s = await MyRadioSpotify.getState(); if (!s) return;
    els.npBar.style.width = (s.position / s.duration * 100) + "%";
    els.npCur.textContent = fmt(s.position / 1000); els.npRem.textContent = "-" + fmt((s.duration - s.position) / 1000);
    setToggle(!s.paused);
    if (s.paused && s.position === 0 && lastSpPos > 1500) { lastSpPos = 0; advance(); }
    else lastSpPos = s.position;
  }, 500);
}

// ---- transport ----
els.toggle.onclick = () => {
  if (mode === "audio") { els.audio.getAttribute("src") && (els.audio.paused ? playAudio() : (els.audio.pause(), setToggle(false))); }
  else if (mode === "speak") {
    if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); stopSpeakTimer(); setToggle(false); }
    else if (speechSynthesis.paused) { speechSynthesis.resume(); startSpeakTimer(); setToggle(true); }
    else startSpeakFrom(speakText, speakPos);
  } else if (mode === "spotify") { MyRadioSpotify.togglePlay(); }
};
els.back10.onclick = () => skipBy(-10);
els.fwd10.onclick = () => skipBy(10);
function skipBy(delta) {
  if (mode === "audio") els.audio.currentTime = Math.max(0, Math.min((els.audio.duration || 0), els.audio.currentTime + delta));
  else if (mode === "speak") speakSeek(delta);
  else if (mode === "spotify") MyRadioSpotify.seek(lastSpPos + delta * 1000);
}
els.next.onclick = () => { event("skip"); advance(); };
els.prev.onclick = () => {
  if (mode === "audio" && els.audio.currentTime > 3) { els.audio.currentTime = 0; return; }
  if (mode === "speak" && speakPos > 3 * CPS && history.length === 0) { startSpeakFrom(speakText, 0); return; }
  index = history.length ? history.pop() : 0; loadCurrent(true);
};
els.npProgress.onclick = (e) => {
  const r = els.npProgress.getBoundingClientRect(), ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (mode === "audio" && els.audio.duration) els.audio.currentTime = ratio * els.audio.duration;
  else if (mode === "speak") startSpeakFrom(speakText, Math.floor(ratio * speakText.length));
  else if (mode === "spotify") MyRadioSpotify.seek(ratio * (lastSpPos || 0));
};
async function advance() {
  history.push(index); index += 1;
  if (index >= queue.length) { applyPlan(await getPlan()); index = 0; history.length = 0; }
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
  try { await fetch(`${API}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: USER, itemId: item.id, type }) }); } catch {}
}

function renderQueue() {
  els.queue.innerHTML = "";
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "row" + (i === index ? " playing" : "");
    li.innerHTML = `<span class="badge ${item.type}">${item.type}</span>
      <div class="meta"><div class="rt">${item.title}</div><div class="rs">${item.subtitle || item.source || ""}</div></div>
      <span class="has-audio">▶ audio</span>`;
    li.onclick = () => { if (i !== index) { history.push(index); index = i; loadCurrent(true); } };
    els.queue.appendChild(li);
  });
}

// ---------- separators: a short two-tone chime between items ----------
let actx = null;
function chime() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      const t = t0 + i * 0.13;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.start(t); o.stop(t + 0.22);
    });
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (s = 0) => { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// ---------- Spotify wiring ----------
els.spotify.onclick = () => MyRadioSpotify.connect();
function updateSpotifyUI() {
  if (!spotifyCtx) return;
  els.spotify.classList.add("connected");
  els.spotify.textContent = spotifyCtx.premium ? `Spotify ✓ ${spotifyCtx.displayName || ""}`.trim() : "Spotify (no Premium)";
  els.spStatus.textContent = spotifyCtx.premium
    ? `🎵 Connected to Spotify Premium — your top tracks & ${spotifyCtx.genres.slice(0, 4).join(", ")} are in the mix.`
    : "🎵 Connected, but Premium is required for full-track playback — using royalty-free music meanwhile.";
}

// ---------- local fallback ----------
const LOCAL_MUSIC = [
  { n: 1, t: "Neon Drive", e: 0.85 }, { n: 9, t: "Afterglow", e: 0.75 }, { n: 3, t: "Pulse Theory", e: 0.6 }, { n: 2, t: "Glass Horizon", e: 0.35 },
].map((x) => ({ id: `mus-sh${x.n}`, type: "music", title: x.t, subtitle: "royalty-free", source: "SoundHelix", energy: x.e, audioUrl: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${x.n}.mp3` }));
function localPlan() {
  return {
    mode: "idle", explanation: "Local demo — start the backend for live, personalized content.",
    queue: [
      { id: "news-x", type: "news", title: "Your briefing (offline demo)", subtitle: "seed", summary: "This is an offline demo summary, spoken by your browser so you can hear how AI news briefings sound. Start the backend to get real, condensed news at the length you chose.", energy: 0.4 },
      ...LOCAL_MUSIC,
      { id: "book-x", type: "audiobook", title: "A public-domain classic", subtitle: "seed", summary: "A short spoken summary of a public-domain book, demonstrating audiobook summary mode.", energy: 0.3 },
    ],
  };
}

// ---------- boot ----------
(async () => {
  await checkHealth();
  if (window.MyRadioSpotify) {
    const fresh = await MyRadioSpotify.handleRedirect();
    if (MyRadioSpotify.isConnected()) {
      try {
        spotifyCtx = await MyRadioSpotify.loadContext();
        if (spotifyCtx.premium) { await MyRadioSpotify.initPlayer(); spotifyMusic = spotifyCtx.topTracks || []; }
        updateSpotifyUI();
      } catch {}
    }
    if (fresh && restore()) { startPlayer(await onboard()); return; } // resumed after Spotify login
  }
  if (restore()) startPlayer(await onboard()); // returning user
})();
