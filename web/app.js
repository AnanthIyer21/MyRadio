// MyRadio web client.
// Onboarding interview (free text + dictation) -> orchestrated station -> player.
// Playback per item: music = full audio (Spotify Premium if connected, else royalty-free);
// news/podcast/audiobook = AI summary (condensed, spoken) or full (read aloud / full episode).

// Spotify's PKCE flow stores the one-time code_verifier in localStorage, which is
// partitioned by origin. "localhost" and "127.0.0.1" are DIFFERENT origins, and the
// registered Spotify redirect URI is 127.0.0.1 — so if the page is opened on localhost,
// the verifier saved here is gone after the redirect and the token exchange fails.
// Force the whole app onto the 127.0.0.1 origin so the flow round-trips correctly.
if (location.hostname === "localhost") {
  location.replace(location.href.replace("://localhost", "://127.0.0.1"));
}

// Backend base URL. On localhost we always use the local server on :8787 (so local dev keeps
// working); anywhere else we use MYRADIO_CONFIG.API_BASE (the deployed Render backend).
const LOCALHOST = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const API = (!LOCALHOST && window.MYRADIO_CONFIG && window.MYRADIO_CONFIG.API_BASE)
  || `http://${location.hostname || "127.0.0.1"}:8787`;
// Per-device identity: a stable UUID kept in localStorage, so this browser's profile,
// learning, no-repeat news history and resume positions are its OWN — not shared across
// everyone on a single "demo" account. (Replaced by the real account id once login lands.)
const DEVICE_ID = (() => {
  try {
    let u = localStorage.getItem("myradio_uid");
    if (!u) { u = (crypto?.randomUUID ? crypto.randomUUID() : "u-" + Date.now() + "-" + Math.random().toString(36).slice(2)); localStorage.setItem("myradio_uid", u); }
    return u;
  } catch { return "demo"; }
})();
// The id the app sends as `userId`. Defaults to the per-device id; once the listener logs in
// it becomes their account id (set in initAuth), so their profile + feed follow them across
// devices. authHeaders() attaches the login token so the backend can trust that account id.
let USER = DEVICE_ID;
const auth = window.MyRadioAuth || null;
async function authHeaders(base = {}) {
  if (auth && auth.configured()) { try { const t = await auth.token(); if (t) return { ...base, authorization: "Bearer " + t }; } catch {} }
  return base;
}
const speechOK = "speechSynthesis" in window;
const CPS = 15; // approx chars/sec of speech, for spoken progress + seeking

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), onboarding: $("onboarding"), player: $("player"),
  mode: $("mode"), explanation: $("explanation"), queue: $("queue"),
  gear: $("gear"), settings: $("settings"), spStatus: $("sp-status"),
  obSpotify: $("ob-spotify"), obSpotifyStatus: $("ob-spotify-status"),
  nowcard: $("nowcard"),
  npBadge: $("np-badge"), npTitle: $("np-title"), npSub: $("np-sub"), npNote: $("np-note"),
  npProgress: $("np-progress"), npBar: $("np-bar"), npCur: $("np-cur"), npRem: $("np-rem"),
  prev: $("prev"), back10: $("back10"), toggle: $("toggle"), fwd10: $("fwd10"), next: $("next"),
  like: $("like"), save: $("save"), dislike: $("dislike"), audio: $("audio"), bed: $("bed"),
};

// Gentle ambient bed under spoken news / podcasts / audiobooks.
const BED_URL = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3";
els.bed.src = BED_URL; els.bed.volume = 0.08;
function startBed() { try { els.bed.currentTime = els.bed.currentTime || 0; els.bed.play().catch(() => {}); } catch {} }
function stopBed() { try { els.bed.pause(); } catch {} }

let live = false;
let profile = {};
let queue = [], index = 0;
const history = [];
let mode = "audio";          // 'audio' | 'speak' | 'spotify' | 'text'
let current = null;          // resolved playback descriptor
let loadToken = 0;
// Narration: spoken items are synthesized server-side to MP3 and played through the
// <audio> element (mode "audio") with the ambient bed underneath. `narration` marks
// that audio-mode playback as voice-over-bed so transport also controls the bed.
let narration = false, lastBlobUrl = null;
const summaryPrefs = { news: "summary", podcast: "summary", audiobook: "summary" };
const LENGTHS = { news: 45, podcast: 300, audiobook: 120 };

// Spotify
let spotifyCtx = null, spotifyMusic = [], spotifyPodcasts = [], lastSpPos = 0, lastSpDur = 0;
const spotifyReady = () => window.MyRadioSpotify && MyRadioSpotify.isConnected() && MyRadioSpotify.isPremium() && MyRadioSpotify.isReady();
const shuffled = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

// timers
let speakTimer = null, spPoll = null;
let speakText = "", speakPos = 0;
// Speech reliability state: retain the utterance (so it isn't GC'd mid-speech),
// a keepalive against Chrome's ~15s auto-pause, and a poll loop that tracks actual
// start/end via speechSynthesis.speaking (Chrome's onstart/onend events are unreliable).
let speakUtter = null, speakKeepalive = null, speakPoll = null, speakStarted = false;
let voicesReady = !speechOK || (speechSynthesis.getVoices && speechSynthesis.getVoices().length > 0);
if (speechOK && !voicesReady) { try { speechSynthesis.onvoiceschanged = () => { voicesReady = true; }; } catch {} }
// playback length cap: a non-"Full" length slider stops the item after N seconds.
let playCap = 0, capped = false;

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
// Keys MUST match the FEED topic labels in backend/src/agents/news.js.
const TOPIC_WORDS = {
  world: ["world", "ukraine", "gaza", "israel", "global", "war", "international", "foreign", "geopolitic"],
  technology: ["tech", "technology", "software", "startup", "apple", "google", "microsoft", "gadget", "coding", "developer", "crypto", "web3", "cyber"],
  ai: ["ai", "a.i.", "artificial intelligence", "machine learning", "ml", "llm", "openai", "anthropic", "claude", "chatgpt", "gpt", "neural", "deep learning"],
  business: ["business", "finance", "economy", "economic", "market", "markets", "stock", "stocks", "money", "trade", "startup funding", "vc", "venture"],
  science: ["science", "physics", "chemistry", "biology", "research", "scientist", "study", "discovery", "genetics"],
  space: ["space", "nasa", "spacex", "astronomy", "mars", "moon", "rocket", "satellite", "cosmos", "galaxy"],
  health: ["health", "medicine", "medical", "wellness", "fitness", "mental health", "disease", "nutrition", "covid", "healthcare"],
  sport: ["sport", "sports", "football", "soccer", "arsenal", "premier league", "nba", "nfl", "tennis", "f1", "formula 1", "cricket", "golf", "baseball"],
  culture: ["culture", "art", "book", "books", "literature", "fashion", "design", "theatre", "museum"],
  entertainment: ["entertainment", "film", "movie", "movies", "tv", "television", "netflix", "hollywood", "celebrity", "streaming", "show"],
  gaming: ["gaming", "game", "games", "video game", "xbox", "playstation", "nintendo", "steam", "esports"],
  politics: ["politics", "political", "election", "government", "policy", "trump", "biden", "congress", "senate", "parliament"],
  climate: ["climate", "environment", "environmental", "sustainability", "carbon", "warming", "renewable", "emissions", "green energy"],
};
const VIBE_WORDS = { upbeat: ["upbeat", "energetic", "gym", "workout", "party", "hype", "fast", "dance"], focus: ["focus", "study", "work", "concentrate", "coding", "lofi", "lo-fi", "instrumental"], chill: ["chill", "calm", "relax", "evening", "sleep", "ambient", "mellow", "slow"] };
const GENRE_WORDS = { electronic: ["electronic", "edm", "techno", "house", "dance"], hiphop: ["hip hop", "hip-hop", "hiphop", "rap", "trap", "drill"], rnb: ["r&b", "rnb", "rhythm and blues"], latin: ["latin", "reggaeton", "afrobeats", "amapiano"], pop: ["pop"], rock: ["rock", "indie", "metal", "punk", "alternative"], classical: ["classical", "orchestra", "piano"], jazz: ["jazz", "blues", "soul"], lofi: ["lofi", "lo-fi", "chillhop"], ambient: ["ambient", "atmospheric"] };
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

// ---------- dictation (Wispr Flow if configured, else browser speech) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const append = (ta, text) => { ta.value += (ta.value ? " " : "") + String(text).trim(); };
document.querySelectorAll(".mic").forEach((btn) => {
  const ta = $(btn.dataset.target);
  let wispr = false, rec = null;
  btn.onclick = async () => {
    // Stop whatever is running
    if (wispr) { MyRadioWispr.stop(); wispr = false; btn.classList.remove("rec"); return; }
    if (rec) { rec.stop(); return; }
    // Prefer Wispr Flow
    if (window.MyRadioWispr && await MyRadioWispr.isConfigured()) {
      btn.classList.add("rec"); wispr = true;
      const ok = await MyRadioWispr.start(ta, (text) => append(ta, text));
      if (!ok) { wispr = false; btn.classList.remove("rec"); }
      return;
    }
    // Fallback: browser dictation
    if (!SR) { btn.title = "Dictation needs Wispr Flow (add API key) or a supported browser"; return; }
    rec = new SR(); rec.lang = "en-US"; rec.interimResults = false; rec.continuous = true;
    btn.classList.add("rec");
    rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) append(ta, e.results[i][0].transcript); };
    rec.onend = () => { btn.classList.remove("rec"); rec = null; };
    rec.start();
  };
});

// length sliders (onboarding). News in seconds; podcasts/audiobooks in minutes,
// with the top of the track meaning "Full" (0 = no condensing).
const lenLabel = (type, v) => type === "news" ? `${v}s` : (v >= 16 ? "Full" : `${v} min`);
const lenSeconds = (type, v) => type === "news" ? v : (v >= 16 ? 0 : v * 60);
["news", "podcast", "audiobook"].forEach((type) => {
  const input = $("len-" + type), val = $("len-" + type + "-val");
  if (!input) return;
  const update = () => { const v = Number(input.value); val.textContent = lenLabel(type, v); LENGTHS[type] = lenSeconds(type, v); };
  input.addEventListener("input", update);
  update(); // seed defaults
});

// Auto-save the interview continuously so nothing is lost across the Spotify redirect.
els.onboarding.addEventListener("input", () => saveDraft());

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
    interestsText: interests, musicText: music, whenText: when, // raw answers for the LLM onboarding agent
  };
  persist();
  try { localStorage.removeItem("myradio_draft"); } catch {}
  await Promise.all([refreshSpotifyPodcasts(), refreshSpotifyMusic()]); // Premium: vibe-matched pools before the first batch
  startPlayer(await onboard());
};

// Premium only: grow the Spotify podcast pool from saved shows to a catalogue SEARCH
// over the listener's interests, so connected Premium users get a far bigger, matched
// selection. No-op when not Premium/ready — non-Premium keeps the iTunes/RSS podcasts.
async function refreshSpotifyPodcasts() {
  if (!spotifyReady() || !profile) return;
  try {
    const terms = [...(profile.topics || []), ...(profile.keywords || [])];
    const found = await MyRadioSpotify.searchPodcasts(terms);
    const seen = new Set(spotifyPodcasts.map((e) => e.uri));
    spotifyPodcasts = spotifyPodcasts.concat(found.filter((e) => e?.uri && !seen.has(e.uri)));
  } catch { /* keep saved-show pool (or none) — withSpotify falls back to RSS */ }
}

// Premium only: build a music pool that HONOURS the listener's stated vibe/genre via catalogue
// search (e.g. "upbeat electronic", "chill lofi"), each query tagged with the energy its vibe
// implies. This becomes the primary pool so the station plays what they asked for — not just
// their top tracks — while their library stays as an energy-neutral fallback. (Spotify's
// audio-features API is deprecated for new apps, so we infer energy from the vibe, not the track.)
// Search by GENRE terms (which return real songs) rather than bare vibe words like "upbeat"
// (which surface SEO "study/workout music" filler). Each carries the genre's characteristic
// energy so context matching still works. Vibes with no genre map to representative genres.
const GENRE_Q = {
  electronic: [{ q: "electronic", e: 0.78 }, { q: "electro house", e: 0.85 }, { q: "house music", e: 0.80 }],
  hiphop: [{ q: "hip hop", e: 0.70 }, { q: "rap hits", e: 0.72 }, { q: "trap", e: 0.75 }],
  rnb: [{ q: "r&b hits", e: 0.55 }, { q: "rnb", e: 0.55 }],
  latin: [{ q: "reggaeton", e: 0.80 }, { q: "latin hits", e: 0.78 }],
  pop:        [{ q: "pop hits", e: 0.70 }, { q: "dance pop", e: 0.78 }],
  rock:       [{ q: "rock anthems", e: 0.80 }, { q: "indie rock", e: 0.65 }],
  classical:  [{ q: "classical", e: 0.38 }, { q: "piano", e: 0.35 }],
  jazz:       [{ q: "jazz", e: 0.42 }, { q: "smooth jazz", e: 0.35 }],
  lofi:       [{ q: "lofi hip hop", e: 0.30 }, { q: "chillhop", e: 0.32 }],
  ambient:    [{ q: "ambient", e: 0.30 }, { q: "chillout", e: 0.32 }],
};
const VIBE_Q = {
  upbeat: [{ q: "dance hits", e: 0.85 }, { q: "electro house", e: 0.85 }],
  focus:  [{ q: "lofi hip hop", e: 0.45 }, { q: "instrumental", e: 0.50 }],
  chill:  [{ q: "chillout", e: 0.32 }, { q: "ambient", e: 0.30 }],
};
async function refreshSpotifyMusic() {
  if (!spotifyReady() || !profile) return;
  const vibes = (profile.musicVibes || []).map(String);
  const genres = (profile.genres || []).map(String);
  const queries = []; const seenQ = new Set();
  const push = (q, energy) => { q = (q || "").trim().toLowerCase(); if (q && !seenQ.has(q)) { seenQ.add(q); queries.push({ q, energy }); } };
  for (const g of genres) for (const x of (GENRE_Q[g] || [])) push(x.q, x.e);
  // Fall back to vibe→genre searches only when a vibe was named but no concrete genre.
  if (!genres.length) for (const v of vibes) for (const x of (VIBE_Q[v] || [])) push(x.q, x.e);
  if (!queries.length) return; // no stated taste → keep the library pool as-is
  // Cache the vibe-search results by taste signature so rebuilding the same station doesn't
  // re-fire ~12 search calls (another 429 source).
  const sig = queries.map((q) => q.q).sort().join("|");
  let vibeTracks = vibeCacheRead(sig);
  if (!vibeTracks) {
    try { vibeTracks = await MyRadioSpotify.searchTracks(queries.slice(0, 6), 20); } catch { vibeTracks = []; }
    if (vibeTracks.length >= 10) vibeCacheWrite(sig, vibeTracks); // don't cache a thin (rate-limited) result
  }
  if (!vibeTracks.length) return;                              // search failed → keep library pool
  const lib = spotifyCtx?.topTracks || [];                     // energy-untagged → fallback only
  // Spotify blocks genre/audio-features for this app, so we can't classify the listener's OWN
  // tracks by vibe. Next best thing: flag vibe-search hits whose artist is already in their
  // library, so the picker leans toward artists they actually listen to.
  const libArtists = new Set(lib.map((t) => (t.artist || "").toLowerCase().trim()).filter(Boolean));
  vibeTracks.forEach((t) => { t.familiar = libArtists.has((t.artist || "").toLowerCase().trim()); });
  const seen = new Set(vibeTracks.map((t) => t.uri));
  spotifyMusic = vibeTracks.concat(lib.filter((t) => !seen.has(t.uri)));
}
const VIBE_CACHE_KEY = "myradio_vibepool", VIBE_TTL = 12 * 3600 * 1000;
function vibeCacheRead(sig) { try { const j = JSON.parse(localStorage.getItem(VIBE_CACHE_KEY) || "null"); if (j && j.sig === sig && Array.isArray(j.v) && j.v.length && (Date.now() - j.t) < VIBE_TTL) return j.v; } catch {} return null; }
function vibeCacheWrite(sig, v) { try { localStorage.setItem(VIBE_CACHE_KEY, JSON.stringify({ t: Date.now(), sig, v })); } catch {} }

function persist() { try { localStorage.setItem("myradio_profile", JSON.stringify({ profile, LENGTHS, summaryPrefs })); } catch {} }

async function onboard() {
  if (live) {
    try {
      const r = await fetch(`${API}/api/onboarding`, {
        method: "POST", headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ userId: USER, migrateFrom: DEVICE_ID, ...profile, lengths: LENGTHS, spotify: spotifyCtx ? { genres: spotifyCtx.genres, topArtists: spotifyCtx.topArtists } : undefined, signals: signals(), done: doneIds() }),
      });
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
// Settings length sliders — re-tune lengths mid-session.
["news", "podcast", "audiobook"].forEach((type) => {
  const input = $("s-" + type), val = $("s-" + type + "-val"); if (!input) return;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = lenLabel(type, v); LENGTHS[type] = lenSeconds(type, v); persist();
    if (queue[index]?.type === type) loadCurrent(false);
  });
});
function initSettingsSliders() {
  ["news", "podcast", "audiobook"].forEach((type) => {
    const input = $("s-" + type), val = $("s-" + type + "-val"); if (!input) return;
    const sec = LENGTHS[type];
    input.value = type === "news" ? sec : (sec === 0 ? 16 : Math.round(sec / 60));
    val.textContent = lenLabel(type, Number(input.value));
  });
}

// ---------- player ----------
function startPlayer(plan) {
  els.onboarding.hidden = true; els.player.hidden = false;
  initSettingsSliders();
  startWatchdog();                                  // self-healing playback monitor
  applyPlan(plan); index = 0; history.length = 0; loadCurrent(true);
}
function applyPlan(plan) {
  els.mode.textContent = (plan.mode || "idle").replace(/_/g, " ");
  els.explanation.textContent = plan.explanation || "";
  queue = withSpotify(plan.queue || []);
}
// Same-day play history for Spotify tracks (their identity is client-side, so the
// "don't repeat a song the same day" rule for Spotify lives here, in localStorage).
const SP_PLAYED_KEY = "myradio_spotify_played";
function todayKey() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function playedSpotifyToday() {
  try { const j = JSON.parse(localStorage.getItem(SP_PLAYED_KEY) || "{}"); return j.day === todayKey() ? new Set(j.uris || []) : new Set(); }
  catch { return new Set(); }
}
function markSpotifyPlayed(uri) {
  if (!uri) return;
  const s = playedSpotifyToday(); s.add(uri);
  try { localStorage.setItem(SP_PLAYED_KEY, JSON.stringify({ day: todayKey(), uris: [...s] })); } catch {}
}

// Premium: swap music + podcast items for the listener's own Spotify content.
// Used for both the initial plan and every refill batch.
function withSpotify(items) {
  let out = items;
  // Tracks/episodes already committed to the queue (played or queued ahead) are excluded
  // so a refill never re-assigns one still waiting to play; the `used` set also grows as
  // we assign, preventing duplicates within a single batch.
  if (spotifyReady() && spotifyMusic.length) {
    // Pick order: (1) not played today AND not in the recent queue window, (2) just not in
    // the recent window (so once the small pool cycles, songs come back spread out — never
    // within RECENT of each other), (3) anything not assigned in this batch. `assigned`
    // guarantees no duplicate within a batch; the recent-window guarantees no near-repeat
    // (fixes "same song 3× in a row" once the ~28-track pool is exhausted).
    const RECENT = 18;
    const played = playedSpotifyToday();
    const recent = new Set(queue.slice(-RECENT).filter((it) => it.spotifyUri).map((it) => it.spotifyUri));
    const pool = shuffled(spotifyMusic);
    const assigned = new Set();
    let fb = 0; // rotates among the closest candidates for variety
    // BLEND: play mostly the listener's own library, with ~1 in 3 slots a vibe-matched
    // catalogue track for the mood they stated (energy-matched to the slot). Library tracks
    // carry no energy/genre (Spotify blocks that for this app), so they just rotate with the
    // no-repeat tiers; vibe tracks (energy-tagged) get matched to the slot's intended energy.
    const vibePool = pool.filter((x) => typeof x.energy === "number");
    const libPool  = pool.filter((x) => typeof x.energy !== "number");
    const pickFrom = (sub, target) => {
      if (!sub.length) return null;
      const tgt = (typeof target === "number") ? target : 0.5;
      const score = (x) => ((typeof x.energy === "number") ? Math.abs(x.energy - tgt) : 0.5) - (x.familiar ? 0.06 : 0);
      let cands = sub.filter((x) => !played.has(x.uri) && !recent.has(x.uri) && !assigned.has(x.uri));
      if (!cands.length) cands = sub.filter((x) => !recent.has(x.uri) && !assigned.has(x.uri));
      if (!cands.length) cands = sub.filter((x) => !assigned.has(x.uri));
      if (!cands.length) cands = sub;
      cands = cands.slice().sort((a, b) => score(a) - score(b));
      return cands[(fb++) % Math.min(5, cands.length)];
    };
    let musicCount = 0;
    const pick = (target) => {
      const wantVibe = vibePool.length && (musicCount % 3 === 2); // ~1 of every 3 → vibe discovery
      musicCount++;
      return pickFrom(wantVibe ? vibePool : libPool, target)
        || pickFrom(wantVibe ? libPool : vibePool, target)        // other pool if first is dry
        || pickFrom(pool, target);
    };
    out = out.map((it) => {
      if (it.type !== "music") return it;
      const t = pick(it.energy); if (!t) return it; assigned.add(t.uri);
      return { ...it, spotifyUri: t.uri, title: t.title, subtitle: `${t.artist} · Spotify`, source: "Spotify" };
    });
  }
  // Premium: swap podcasts to the listener's own Spotify shows. STABLE id from the episode
  // uri so resume + never-repeat track the real episode; skip finished or already-queued ones.
  if (spotifyReady() && spotifyPodcasts.length) {
    const used = new Set(queue.filter((it) => it.spotifyUri).map((it) => it.spotifyUri));
    const shuffledPool = shuffled(spotifyPodcasts);
    const pick = () => shuffledPool.find((e) => !used.has(e.uri) && !getProg(spEpisodeId(e.uri)).done)
      || shuffledPool.find((e) => !used.has(e.uri)) || shuffledPool[0];
    out = out.map((it) => {
      if (it.type !== "podcast") return it;
      const e = pick(); used.add(e.uri);
      return { ...it, id: spEpisodeId(e.uri), spotifyUri: e.uri, title: e.title, subtitle: `${e.show} · Spotify`, source: "Spotify", rssAudioUrl: it.audioUrl };
    });
  }
  return out;
}
// Stable client id for a Spotify episode (so progress/no-repeat key on the real episode).
const spEpisodeId = (uri) => "sp-" + String(uri).replace(/[^a-z0-9]/gi, "").slice(-24);

// Continuous radio: when the queue nears its end, pull the next batch from the
// backend and append it — so the station keeps producing as you skip / listen on.
// Keep at least QWINDOW items queued ahead (refill the moment fewer remain) so the
// "Up next" group always fills to its 5, and request a batch big enough to restock
// the whole window in one fetch.
const REFILL_AHEAD = 6;          // fetch while this many (≥ QWINDOW) items remain ahead
const REFILL_BATCH = 6;          // items to pull per refill — tops the window back up
let fetchingMore = false, refillPromise = null;
// Returns the in-flight refill promise so callers (advance) can await the append
// before deciding the queue is exhausted — otherwise a fetch racing in the
// background looks like an empty queue and triggers an unnecessary replan.
function ensureAhead() {
  if (!live) return Promise.resolve();
  if (fetchingMore) return refillPromise || Promise.resolve();
  if (index < queue.length - REFILL_AHEAD) return Promise.resolve(); // still plenty queued
  fetchingMore = true;
  refillPromise = (async () => {
    try {
      const r = await fetch(`${API}/api/next`, {
        method: "POST", headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ userId: USER, n: REFILL_BATCH, signals: signals(), done: doneIds() }),
      });
      if (r.ok) {
        const data = await r.json();
        const more = withSpotify(data.queue || []);
        if (more.length) { queue = queue.concat(more); renderQueue(); prewarmAhead(); }
      }
    } catch {} finally { fetchingMore = false; }
  })();
  return refillPromise;
}

// ---- content resolution (may fetch full text) ----
const bodyCache = new Map();
async function fetchText(endpoint, url) {
  if (!url || !live) return "";
  if (bodyCache.has(url)) return bodyCache.get(url);
  try { const d = await (await fetch(`${API}/${endpoint}?url=${encodeURIComponent(url)}`)).json(); bodyCache.set(url, d.text || ""); return d.text || ""; }
  catch { return ""; }
}
// Prefer the producer's context-aware spoken segue; fall back to a static intro.
const lead = (it) => (it.segue ? it.segue.trim() + " " : it.type === "news" ? `Here's the latest from ${it.source}. ` : it.type === "podcast" ? `From ${it.source}. ` : it.type === "audiobook" ? `From ${it.title}. ` : "");

// Measured speaking rate of the AI voice (Google TTS ≈ 2.28 words/sec across
// realistic multi-chunk prose), used to trim source text to roughly the listener's
// chosen number of seconds.
const WPS = 2.28;
function condense(text, seconds) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!seconds || !clean) return clean;                 // 0 = "full"
  const target = Math.max(20, Math.round(seconds * WPS));
  const out = []; let w = 0;
  for (const s of clean.split(/(?<=[.!?])\s+/)) { out.push(s); w += s.split(/\s+/).length; if (w >= target) break; }
  return out.join(" ");
}

// ---------- serial playback (podcasts + audiobooks) ----------
// Podcasts and audiobooks aren't summarised — the REAL content plays in segments of
// the chosen length, and we resume from where we stopped next time the same one comes
// up ("finish one then next"). Position is remembered per item in localStorage:
//   podcast   → seconds into the episode audio
//   audiobook → { chapter, pos } : which chapter MP3 + seconds into it
const PROGRESS_KEY = "myradio_progress";
let progress = {};
try { progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}") || {}; } catch {}
const getProg = (id) => progress[id] || {};
function setProg(id, fields) {
  progress[id] = { ...(progress[id] || {}), ...fields };
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch {}
}
// Ids of serial items the listener has finished — sent to the backend so it stops
// serving them and moves on to the next episode/book.
const doneIds = () => Object.keys(progress).filter((id) => progress[id] && progress[id].done);

// The segment currently playing (so transport/advance can save the resume position).
let segState = null;
// Set when the listener explicitly SKIPS the current item (Skip/Less buttons). A skipped
// podcast/audiobook is abandoned — marked done so its remainder never returns and the next
// episode/book takes over. A segment that simply reaches its length cap is NOT a skip.
let skipCurrent = false;

// Persist the resume position for the serial segment that's ending/being left. Both
// podcasts and audiobooks are real audio; the difference is audiobooks span multiple
// chapter MP3s, so finishing a chapter advances to the next one.
function saveSegmentProgress() {
  const s = segState; if (!s) return;
  // Explicit skip of a serial → abandon it: mark done so it's never resumed or re-served.
  if (skipCurrent && (s.type === "podcast" || s.type === "audiobook")) { setProg(s.id, { done: true }); return; }
  // Spotify podcast: position/duration come from the SDK poll (ms), not the <audio> element.
  if (s.spotify) {
    const cur = lastSpPos / 1000, dur = lastSpDur / 1000;
    if (cur - (s.startSec || 0) < 1) return;          // never really played — keep prior spot
    setProg(s.id, { pos: cur, done: dur > 0 && cur >= dur - 3 }); // done when the episode ends
    return;
  }
  const a = els.audio, dur = a.duration || 0, cur = a.currentTime || 0;
  if (!dur || cur - (s.startSec || 0) < 1) return;   // never really played — keep prior spot
  if (s.type === "podcast") {
    setProg(s.id, { pos: cur, done: cur >= dur - 1.5 });        // done when the episode ends
  } else if (s.type === "audiobook") {
    if (cur >= dur - 1.5) {                                     // this chapter finished
      const last = s.chapter >= s.chapters - 1;
      setProg(s.id, last ? { done: true } : { chapter: s.chapter + 1, pos: 0, done: false });
    } else {
      setProg(s.id, { chapter: s.chapter, pos: cur, done: false });
    }
  }
}

// Build the spoken AI-summary text at roughly the chosen length. If the backend
// already summarised this item to length (LLM producer set `summarized`), speak
// that verbatim; otherwise fetch the fullest source available (whole article /
// whole book text) and trim it to the target — so summaries actually fill the time
// instead of playing a one-line blurb. `srcFetcher` is null when no fuller source
// exists (e.g. scraped Google-News headlines, podcast blurbs).
async function summaryText(item, srcFetcher) {
  if (item.summarized && item.summary) return item.summary;   // backend LLM summary, already at length
  let src = item.content || "";                               // backend-enriched full body (article/book/notes)
  if (!src && srcFetcher) src = await srcFetcher();            // fall back to fetching it ourselves
  if (!src) src = item.summary || item.title;                 // last resort: blurb / headline
  return condense(src, LENGTHS[item.type]);
}

async function resolveContent(item) {
  if (item.type === "music") {
    // Music: full Spotify track when Premium, else royalty-free audio.
    if (item.spotifyUri && spotifyReady()) return { kind: "spotify", uri: item.spotifyUri, isFull: true };
    return { kind: "audio", audioUrl: item.audioUrl, isFull: false };
  }
  const pref = summaryPrefs[item.type] || "summary";

  if (item.type === "podcast") {
    // SERIAL: real episode in length-segments, resuming where we left off. Premium →
    // play the Spotify episode via the SDK; otherwise the RSS episode audio.
    const p = getProg(item.id);
    if (item.spotifyUri && spotifyReady())
      return { kind: "spotify", serial: "podcast", id: item.id, uri: item.spotifyUri, startSec: p.pos || 0, segLen: LENGTHS.podcast };
    return { kind: "audio", serial: "podcast", id: item.id, audioUrl: item.audioUrl, startSec: p.pos || 0, segLen: LENGTHS.podcast };
  }
  if (item.type === "news") {
    // Scraped (Google News) links are redirect URLs that don't yield article text,
    // so there's no fuller source to fetch for those — summary stays headline-length.
    const fetchArticle = item.scraped ? null : () => fetchText("api/article", item.url);
    if (pref === "full" && fetchArticle) {
      const body = await fetchArticle();
      if (body) return { kind: "speak", text: lead(item) + body, isFull: true };
    }
    return { kind: "speak", text: lead(item) + await summaryText(item, fetchArticle), isFull: false };
  }
  if (item.type === "audiobook") {
    // SERIAL: real human narration (LibriVox chapter MP3s) played in length-segments,
    // resuming by chapter + position. Each chapter is one audio file.
    const sections = item.sections || [];
    if (!sections.length) return { kind: "text" };
    const p = getProg(item.id);
    const chapter = Math.min(p.chapter || 0, sections.length - 1);
    return { kind: "audio", serial: "audiobook", id: item.id, audioUrl: sections[chapter].url, startSec: p.pos || 0, segLen: LENGTHS.audiobook, chapter, chapters: sections.length };
  }
  return { kind: "text" };
}

async function loadCurrent(autoplay = false) {
  const my = ++loadToken;
  stopPlayback();
  const item = queue[index]; if (!item) return;

  els.npBadge.textContent = item.type; els.npBadge.className = "badge " + item.type;
  if (els.nowcard) els.nowcard.className = "nowcard " + item.type;   // hero card tints to the content type
  els.npTitle.textContent = item.title;
  els.npSub.textContent = item.subtitle || item.source || "";
  resetReactions(); renderQueue();
  ensureAhead();                                  // prefetch more when near the end
  els.npBar.style.width = "0%"; els.npCur.textContent = "0:00"; els.npRem.textContent = "";

  const d = await resolveContent(item);
  if (my !== loadToken) return;                 // user already moved on
  current = d; mode = d.kind;
  prewarmAhead();                               // synthesize upcoming news TTS in the background

  // Serials manage their own segment length (segState); summaries are pre-trimmed and
  // end naturally — so the old blunt "stop after N seconds" cap is no longer needed.
  playCap = 0;
  capped = false;

  els.npProgress.classList.toggle("disabled", false);
  els.back10.hidden = els.fwd10.hidden = false;  // ±10s available on everything

  if (d.kind === "text") { els.npNote.innerHTML = (item.summary || "") + (item.url ? ` <a href="${item.url}" target="_blank" rel="noopener">Open ↗</a>` : ""); setToggle(false); return; }
  els.npNote.textContent = noteFor(item, d);

  if (autoplay) { chime(); await sleep(360); if (my === loadToken) startPlayback(d); }
  else setToggle(false);
}
function noteFor(item, d) {
  if (item.type === "music") return d.kind === "spotify" ? "▶ Spotify" : "";
  if (d.serial === "podcast") return "Podcast — playing in segments";
  if (d.serial === "audiobook") return "Audiobook — narrated, in segments";
  return d.isFull ? "Reading the full text" : "AI summary (spoken)";
}

// ---- runtime playback watchdog (self-healing "agent") ----
// A background loop that checks playback is actually happening when it should be, and
// recovers without the listener having to notice. Targets the <audio> element path
// (music / narration / podcast / audiobook); Spotify has its own poll. `playIntent` =
// "we want sound right now" (false while paused/stopped/loading), so it never fights
// the user or misfires during a track load.
let playIntent = false, watchTimer = null, stallTicks = 0;
function setPlayIntent(on) { playIntent = on; stallTicks = 0; }
function startWatchdog() {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    if (!playIntent || document.hidden || mode !== "audio") { stallTicks = 0; return; }
    if (!els.audio.getAttribute("src")) { stallTicks = 0; return; } // still loading/preparing
    // It should be playing, but the element is paused → the track stalled or failed.
    if (els.audio.paused) {
      stallTicks++;
      if (stallTicks === 2) { els.audio.play().catch(() => {}); if (narration) startBed(); } // nudge
      else if (stallTicks >= 5) { stallTicks = 0; console.warn("[watchdog] playback stuck — skipping"); autoAdvance(); }
    } else stallTicks = 0;
  }, 2000);
}

function startPlayback(d) {
  setPlayIntent(true);
  if (d.kind === "audio") {
    narration = false; stopBed();
    if (d.serial === "podcast" || d.serial === "audiobook") {
      // Real audio (episode / narrated chapter): resume at the saved second, play one segment.
      segState = { id: d.id, type: d.serial, startSec: d.startSec || 0, segLen: d.segLen, chapter: d.chapter || 0, chapters: d.chapters || 1 };
      const seekThenPlay = () => { try { els.audio.currentTime = Math.min(d.startSec || 0, (els.audio.duration || d.startSec || 0)); } catch {} els.audio.removeEventListener("loadedmetadata", seekThenPlay); };
      els.audio.addEventListener("loadedmetadata", seekThenPlay);
      els.audio.src = d.audioUrl; playAudio();
    } else { els.audio.src = d.audioUrl; playAudio(); }      // music
  } else if (d.kind === "speak") {
    startNarration(d.text, { bed: true });                  // news AI summary, bed underneath
  } else if (d.kind === "spotify") {
    narration = false; stopBed();
    if (d.serial === "podcast") {
      // Spotify podcast, played serially via the SDK (resume + segment cap).
      segState = { id: d.id, type: "podcast", startSec: d.startSec || 0, segLen: d.segLen, chapters: 1, chapter: 0, spotify: true };
      startSpotify(d.uri, d.startSec || 0, d.segLen);
    } else { startSpotify(d.uri); }                         // full music track
  }
  event("play");
}

// Synthesize the spoken text to MP3 on the backend and play it through the <audio>
// element (reliable), with the ambient bed underneath. Falls back to the browser
// voice if the server TTS is unavailable (offline / endpoint down).
async function narrate(text) {
  if (!live) return null;
  try {
    const r = await fetch(`${API}/api/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) return null;
    const blob = await r.blob();
    return blob.size ? URL.createObjectURL(blob) : null;
  } catch { return null; }
}
// TTS prewarm cache: spoken text -> Promise<objUrl|null>. Synthesizing upcoming news in the
// background (see prewarmAhead) while the current item plays means the MP3 is usually ready
// the instant we arrive, so playback starts immediately instead of waiting on a round-trip.
const ttsCache = new Map();
function ttsFor(text) {
  const key = text || "";
  if (!key) return Promise.resolve(null);
  if (ttsCache.has(key)) return ttsCache.get(key);
  const p = narrate(key);
  ttsCache.set(key, p);
  if (ttsCache.size > 12) ttsCache.delete(ttsCache.keys().next().value); // bound the cache
  return p;
}
// Pre-synthesize TTS for the next few spoken (news) items so they're ready before we reach
// them. Fire-and-forget; resolveContent here is the same work play does, just done earlier.
function prewarmAhead() {
  let warmed = 0;
  for (let i = index + 1; i < queue.length && warmed < 3; i++) {
    const it = queue[i];
    if (!it || it.type !== "news") continue;          // only spoken items need TTS
    warmed++;
    resolveContent(it).then((d) => { if (d && d.kind === "speak" && d.text) ttsFor(d.text); }).catch(() => {});
  }
}
async function startNarration(text, { bed = true } = {}) {
  const my = loadToken;
  els.npNote.textContent = "Preparing audio…";
  const objUrl = await ttsFor(text);
  if (my !== loadToken) { if (objUrl) URL.revokeObjectURL(objUrl); return; } // moved on while synthesizing
  if (objUrl) {
    narration = bed; mode = "audio";                   // `narration` = "bed rides with the voice"
    if (lastBlobUrl) { try { URL.revokeObjectURL(lastBlobUrl); } catch {} }
    lastBlobUrl = objUrl;
    els.npNote.textContent = current?.serial === "audiobook" ? "Audiobook — read aloud in segments" : "AI summary (spoken)";
    els.audio.src = objUrl; if (bed) startBed(); playAudio();
  } else {
    narration = false; mode = "speak";                 // last-resort fallback: browser voice
    startSpeakFrom(text, 0);
  }
}
function stopPlayback() {
  setPlayIntent(false);
  saveSegmentProgress(); segState = null; skipCurrent = false;   // persist/abandon, then clear the skip flag
  els.audio.pause(); els.audio.removeAttribute("src");
  if (speechOK) speechSynthesis.cancel();
  clearInterval(speakTimer); speakTimer = null;
  stopKeepalive(); clearInterval(speakPoll); speakPoll = null; speakUtter = null;
  clearInterval(spPoll); spPoll = null;
  if (window.MyRadioSpotify && MyRadioSpotify.isReady()) MyRadioSpotify.pause();
  stopBed();
  setToggle(false);
}

// ---- audio mode ----
function playAudio() { els.audio.play().then(() => setToggle(true)).catch(() => setToggle(false)); }
els.audio.ontimeupdate = () => {
  const dur = els.audio.duration; if (!dur) return;
  // Podcast segment: progress + cap are measured RELATIVE to where this segment began,
  // so a 5-min segment is 5 min of listening wherever in the episode it resumed.
  if (segState && (segState.type === "podcast" || segState.type === "audiobook")) {
    const played = els.audio.currentTime - segState.startSec;
    const total = segState.segLen;
    if (total && played >= total && !capped) { capped = true; els.audio.pause(); event("complete"); autoAdvance(); return; }
    els.npBar.style.width = Math.min(100, played / total * 100) + "%";
    els.npCur.textContent = fmt(Math.max(0, played)); els.npRem.textContent = "-" + fmt(Math.max(0, total - played));
    return;
  }
  els.npBar.style.width = Math.min(100, els.audio.currentTime / dur * 100) + "%";
  els.npCur.textContent = fmt(els.audio.currentTime); els.npRem.textContent = "-" + fmt(Math.max(0, dur - els.audio.currentTime));
};
els.audio.onended = () => { event("complete"); autoAdvance(); };
// If a real-audio item fails to load/play (bad or region-locked chapter URL, network
// error), don't sit silent — move on immediately instead of waiting for the watchdog.
// Guarded so the src-removal during stopPlayback() doesn't count as a real failure.
els.audio.onerror = () => {
  if (!els.audio.getAttribute("src") || !playIntent) return;   // teardown / not the current item
  console.warn("[audio] could not play this item — skipping:", els.audio.error?.code);
  autoAdvance();
};

// ---- speak (summary / full read-aloud) with char-based seek ----
// Chrome's SpeechSynthesis onstart/onend events are unreliable — they often never
// fire even while speech is actually playing (speechSynthesis.speaking === true).
// So we POLL speechSynthesis.speaking as the source of truth: it tells us when the
// voice really starts and when it finishes, and the events just accelerate that.
const isSpeaking = () => { try { return speechSynthesis.speaking; } catch { return false; } };
const isPausedTTS = () => { try { return speechSynthesis.paused; } catch { return false; } };

// The voice actually began: kick off the ambient bed, progress, and keepalive once.
function markSpeakStarted() {
  if (speakStarted) return;
  speakStarted = true;
  startBed(); startSpeakTimer(); startKeepalive(); setToggle(true);
}
// Natural end of the utterance → log completion and move to the next item.
function finishSpeak() {
  stopSpeakTimer(); stopKeepalive();
  event("complete"); autoAdvance();
}
// Genuinely couldn't speak (no voice ever started) — surface it and skip on.
function speakUnavailable() {
  stopSpeakTimer(); stopKeepalive(); stopBed();
  els.npNote.textContent = "🔇 Spoken summary unavailable — skipping.";
  setToggle(false);
  if (mode === "speak") setTimeout(() => autoAdvance(), 700);
}

function startSpeakFrom(text, posChars, isRetry = false) {
  speakText = text; speakPos = Math.max(0, Math.min(posChars, text.length));
  if (!speechOK) { startSpeakTimer(); startBed(); setToggle(true); return; } // no TTS: timer-driven progress
  clearInterval(speakPoll); speakPoll = null;
  stopKeepalive();
  speakUtter = null;          // supersede any prior utterance: its callbacks now no-op
  speechSynthesis.cancel();   // (cancel can fire the old utterance's onend/onerror)
  speakStarted = false;

  const begin = () => {
    const u = new SpeechSynthesisUtterance(speakText.slice(speakPos));
    u.rate = 1.03;
    speakUtter = u; // retain the reference so the utterance isn't GC'd mid-speech
    // Events are opportunistic accelerators; the poll loop below is authoritative.
    // Each handler bails if its utterance is no longer the current one.
    u.onstart = () => { if (speakUtter === u) markSpeakStarted(); };
    u.onend = () => { if (speakUtter === u && speakStarted && mode === "speak") { clearInterval(speakPoll); speakPoll = null; finishSpeak(); } };
    u.onerror = (e) => {
      if (speakUtter !== u) return;
      // cancel()/supersede fire 'interrupted'/'canceled' — those aren't real failures.
      if (e && (e.error === "interrupted" || e.error === "canceled")) return;
      if (!speakStarted && !isRetry) { startSpeakFrom(speakText, speakPos, true); return; } // one retry
      clearInterval(speakPoll); speakPoll = null; speakUnavailable();
    };
    speechSynthesis.speak(u);

    // Authoritative poll: detect real start (speaking flips true even when onstart
    // never fires) and real end (speaking goes quiet after we'd started). If the
    // voice never starts within the grace window, retry once, then give up.
    let waited = 0;
    const STEP = 200, GRACE = 3000;
    clearInterval(speakPoll);
    speakPoll = setInterval(() => {
      if (speakUtter !== u) { clearInterval(speakPoll); speakPoll = null; return; }
      if (!speakStarted) {
        if (isSpeaking()) { markSpeakStarted(); return; }
        waited += STEP;
        if (waited >= GRACE) {
          clearInterval(speakPoll); speakPoll = null;
          if (!isRetry) startSpeakFrom(speakText, speakPos, true);
          else speakUnavailable();
        }
      } else if (!isSpeaking() && !isPausedTTS()) {
        // Started and now silent (and not just paused) → the utterance finished.
        clearInterval(speakPoll); speakPoll = null;
        if (mode === "speak") finishSpeak();
      }
    }, STEP);
  };

  // Defer a tick so cancel() settles before speak() (avoids the 'canceled' race),
  // and on the very first run wait for Chrome to populate voices.
  if (voicesReady) { setTimeout(begin, 0); }
  else {
    let fired = false;
    const go = () => { if (fired) return; fired = true; voicesReady = true; begin(); };
    try { speechSynthesis.onvoiceschanged = go; } catch {}
    setTimeout(go, 400); // fallback if onvoiceschanged never fires
  }
}
function startKeepalive() {
  stopKeepalive();
  // Chrome silently pauses speech after ~15s; a periodic resume() keeps long summaries going.
  speakKeepalive = setInterval(() => { try { if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.resume(); } catch {} }, 10000);
}
function stopKeepalive() { clearInterval(speakKeepalive); speakKeepalive = null; }
function startSpeakTimer() {
  stopSpeakTimer();
  speakTimer = setInterval(() => {
    speakPos = Math.min(speakText.length, speakPos + CPS * 0.25);
    const elapsed = speakPos / CPS;
    if (playCap && elapsed >= playCap && !capped) { capped = true; stopSpeakTimer(); event("complete"); autoAdvance(); return; }
    const total = playCap ? Math.min(speakText.length / CPS, playCap) : speakText.length / CPS;
    els.npBar.style.width = Math.min(100, elapsed / total * 100) + "%";
    els.npCur.textContent = fmt(elapsed);
    els.npRem.textContent = "-" + fmt(Math.max(0, total - elapsed));
  }, 250);
}
function stopSpeakTimer() { clearInterval(speakTimer); speakTimer = null; }
function speakSeek(deltaSec) { startSpeakFrom(speakText, Math.floor(speakPos + deltaSec * CPS)); }

// ---- spotify mode ----
// segStart/segLen (seconds, both 0 for full music tracks): for a serial Spotify PODCAST
// we resume at segStart and stop after segLen of listening, saving the position.
async function startSpotify(uri, segStart = 0, segLen = 0) {
  clearInterval(spPoll); spPoll = null;
  lastSpPos = segStart * 1000; lastSpDur = 0; // reset per-track state — stale values were
                                              // triggering a false "track ended" right after a skip
  const my = loadToken;                       // this poll belongs only to the current track
  let started = false, seeked = segStart <= 0; // don't detect "ended" until it really plays
  markSpotifyPlayed(uri);                      // record for the same-day no-repeat rule
  const ok = await MyRadioSpotify.play(uri); setToggle(ok);
  spPoll = setInterval(async () => {
    if (my !== loadToken) { clearInterval(spPoll); return; }   // a skip/next superseded us → stop
    const s = await MyRadioSpotify.getState(); if (!s) return;
    if (!seeked && !s.paused) { try { await MyRadioSpotify.seek(segStart * 1000); } catch {} seeked = true; lastSpPos = segStart * 1000; return; } // resume position
    if (!s.paused && s.position > 250) started = true;          // freshly-skipped track is now playing
    const prevPos = lastSpPos;
    lastSpPos = s.position;
    // Segment cap (podcast): stop after segLen of listening from where we resumed.
    if (segLen && (s.position / 1000 - segStart) >= segLen) { saveSegmentProgress(); autoAdvance(); return; }
    if (playCap && s.position / 1000 >= playCap && !capped) { capped = true; autoAdvance(); return; }
    const eff = s.duration || 1;
    lastSpDur = eff;
    const played = segLen ? Math.max(0, s.position / 1000 - segStart) : s.position / 1000;
    const total = segLen || eff / 1000;
    els.npBar.style.width = Math.min(100, played / total * 100) + "%";
    els.npCur.textContent = fmt(played); els.npRem.textContent = "-" + fmt(Math.max(0, total - played));
    setToggle(!s.paused);
    // Natural end → next, only once it had actually started (so a just-skipped-to track's
    // load can't be mistaken for "finished"). For a serial podcast, mark it finished so it
    // never repeats (position is 0 at the end, so set done explicitly).
    if (started && s.paused && s.position === 0 && prevPos > 1500) { if (segLen && segState) setProg(segState.id, { done: true }); autoAdvance(); return; }
  }, 500);
}

// ---- transport ----
els.toggle.onclick = () => {
  if (mode === "audio") {
    if (!els.audio.getAttribute("src")) return;
    if (els.audio.paused) { setPlayIntent(true); playAudio(); if (narration) startBed(); }      // narration: bed rides with the voice
    else { setPlayIntent(false); els.audio.pause(); setToggle(false); if (narration) stopBed(); }
  }
  else if (mode === "speak") {
    if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); stopSpeakTimer(); stopKeepalive(); stopBed(); setToggle(false); }
    else if (speechSynthesis.paused) { speechSynthesis.resume(); startSpeakTimer(); startKeepalive(); startBed(); setToggle(true); }
    else { startSpeakFrom(speakText, speakPos); } // bed restarts on onstart
  } else if (mode === "spotify") { MyRadioSpotify.togglePlay(); }
};
els.back10.onclick = () => skipBy(-10);
els.fwd10.onclick = () => skipBy(10);
function skipBy(delta) {
  if (segState && (segState.type === "podcast" || segState.type === "audiobook")) {
    // Keep ±10s inside the current segment [startSec, startSec+segLen) of the episode.
    const lo = segState.startSec, hi = segState.startSec + segState.segLen - 1;
    els.audio.currentTime = Math.max(lo, Math.min(hi, els.audio.currentTime + delta));
  } else if (mode === "audio") els.audio.currentTime = Math.max(0, Math.min((els.audio.duration || 0), els.audio.currentTime + delta));
  else if (mode === "speak") speakSeek(delta);
  else if (mode === "spotify") MyRadioSpotify.seek(lastSpPos + delta * 1000);
}
els.next.onclick = () => { skipCurrent = true; event("skip"); advance(); };
els.prev.onclick = () => {
  if (segState && (segState.type === "podcast" || segState.type === "audiobook") && els.audio.currentTime - segState.startSec > 3) { els.audio.currentTime = segState.startSec; return; }
  if (mode === "audio" && !segState && els.audio.currentTime > 3) { els.audio.currentTime = 0; return; }
  if (mode === "speak" && speakPos > 3 * CPS && history.length === 0) { startSpeakFrom(speakText, 0); return; }
  index = history.length ? history.pop() : 0; loadCurrent(true);
};
els.npProgress.onclick = (e) => {
  const r = els.npProgress.getBoundingClientRect(), ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (segState && (segState.type === "podcast" || segState.type === "audiobook")) {
    // The bar represents this 5-min SEGMENT (not the whole episode), so map the click
    // into the segment window and keep it just inside the cap so seeking doesn't skip.
    const target = segState.startSec + Math.min(ratio * segState.segLen, segState.segLen - 1);
    els.audio.currentTime = Math.min(target, (els.audio.duration || target));
  } else if (mode === "audio" && els.audio.duration) els.audio.currentTime = ratio * els.audio.duration;
  else if (mode === "speak") startSpeakFrom(speakText, Math.floor(ratio * speakText.length));
  else if (mode === "spotify") MyRadioSpotify.seek(ratio * (lastSpDur || 0)); // seek by duration, not position
};
// Automatic advances (track ended, load error, watchdog, segment/playback caps, Spotify
// natural-end) are DEBOUNCED so two triggers firing close together — or a stale trigger
// from a just-torn-down track — can't cascade into a runaway skip. Manual skips (the Next
// button / dislike) call advance() directly and stay instant; they also bump the timestamp
// so a stale automatic trigger can't pile on right after a manual skip. The window is far
// shorter than any real item, so legitimate end-of-item advances are never suppressed.
let lastAdvanceAt = 0;
function autoAdvance() {
  const now = Date.now();
  if (now - lastAdvanceAt < 700) return;   // an advance just happened → ignore the duplicate
  advance();
}
async function advance() {
  lastAdvanceAt = Date.now();
  history.push(index); index += 1;
  // Fast path: the next item is already queued → switch to it INSTANTLY (loadCurrent
  // stops the current audio immediately) and top the queue up in the background. This
  // is what makes skip feel responsive — it no longer waits on a network refill, which
  // was leaving the old track playing for seconds and stacking up under rapid clicks.
  if (index < queue.length) {
    loadCurrent(true);
    ensureAhead();                              // background refill, NOT awaited
    return;
  }
  // Only when we're genuinely at the end of the queue do we wait for more.
  await ensureAhead();
  if (index >= queue.length && live) {
    try {
      const r = await fetch(`${API}/api/next`, {
        method: "POST", headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ userId: USER, n: REFILL_BATCH, signals: signals(), done: doneIds() }),
      });
      if (r.ok) { const more = withSpotify((await r.json()).queue || []); if (more.length) queue = queue.concat(more); }
    } catch {}
  }
  if (index >= queue.length) index = 0;          // truly nothing new (offline / pool dry): loop
  loadCurrent(true);
}
function setToggle(playing) { els.toggle.textContent = playing ? "❚❚" : "▶"; }

// ---------- reactions ----------
function resetReactions() { [els.like, els.save, els.dislike].forEach((b) => b.classList.remove("on")); }
els.like.onclick = () => { els.like.classList.toggle("on"); event("like"); };
els.save.onclick = () => { els.save.classList.toggle("on"); event("save"); };
els.dislike.onclick = () => { els.dislike.classList.add("on"); event("dislike"); setTimeout(() => { skipCurrent = true; event("skip"); advance(); }, 250); };
async function event(type) {
  const item = queue[index]; if (!item || !live) return;
  // Send the item's content-type + topic so the backend can learn affinity, not
  // just a per-item reward — this is what makes skipping/liking steer the radio.
  try { await fetch(`${API}/api/events`, { method: "POST", headers: await authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ userId: USER, itemId: item.id, type, itemType: item.type, itemTopic: item.topic }) }); } catch {}
}

// Show a window around the current item: up to QWINDOW already-played items,
// the one playing now, and up to QWINDOW upcoming — grouped with labels. Played
// items sit before `index` in the queue, upcoming after it, so the array order
// is the listening order. The "Recently played" group only appears once there's history.
const QWINDOW = 5;
function renderQueue() {
  els.queue.innerHTML = "";
  if (!queue.length || !queue[index]) return;
  const start = Math.max(0, index - QWINDOW);
  const end = Math.min(queue.length - 1, index + QWINDOW);

  const addLabel = (text) => {
    const li = document.createElement("li");
    li.className = "qlabel"; li.textContent = text;
    els.queue.appendChild(li);
  };
  const addRow = (item, i) => {
    const li = document.createElement("li");
    const state = i === index ? "playing" : (i < index ? "played" : "");
    li.className = "row" + (state ? " " + state : "");
    const tag = i === index ? "♪ playing" : (i < index ? "played" : "▶ audio");
    li.innerHTML = `<span class="badge ${item.type}">${item.type}</span>
      <div class="meta"><div class="rt">${item.title}</div><div class="rs">${item.subtitle || item.source || ""}</div></div>
      <span class="has-audio">${tag}</span>`;
    li.onclick = () => { if (i !== index) { history.push(index); index = i; loadCurrent(true); } };
    els.queue.appendChild(li);
  };

  if (index > start) addLabel("Recently played");
  for (let i = start; i < index; i++) addRow(queue[i], i);
  addLabel("Now playing");
  addRow(queue[index], index);
  if (end > index) addLabel("Up next");
  for (let i = index + 1; i <= end; i++) addRow(queue[i], i);
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

// ---------- Spotify wiring (connect from onboarding) ----------
els.obSpotify.onclick = () => { saveDraft(); MyRadioSpotify.connect(); };
function updateSpotifyUI() {
  if (!spotifyCtx) return;
  // Prefer the SDK-confirmed Premium (works when /me is rate-limited) over spotifyCtx.premium.
  const premium = (window.MyRadioSpotify && MyRadioSpotify.isPremium()) || spotifyCtx.premium;
  els.obSpotify.classList.add("connected");
  els.obSpotify.textContent = premium ? `Spotify ✓ ${spotifyCtx.displayName || ""}`.trim() : "Spotify connected";
  els.obSpotifyStatus.textContent = premium
    ? `Premium — your top tracks, ${(spotifyCtx.genres || []).slice(0, 3).join(", ")} & Spotify podcasts matched to your interests are in the mix.`
    : "No Premium detected — we'll use royalty-free music + iTunes podcasts.";
  els.spStatus.textContent = premium
    ? "🎵 Spotify Premium connected — full-track music from your library; ambient bed under spoken content."
    : "🎵 Connected, but Premium is needed for full-track playback. Ambient bed plays under spoken content.";
}

// Preserve onboarding answers across the Spotify login redirect.
function saveDraft() {
  try { localStorage.setItem("myradio_draft", JSON.stringify({
    name: $("ob-name").value, interests: $("ob-interests").value, music: $("ob-music").value, when: $("ob-when").value,
    lens: { news: $("len-news").value, podcast: $("len-podcast").value, audiobook: $("len-audiobook").value },
  })); } catch {}
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem("myradio_draft") || "null"); if (!d) return;
    $("ob-name").value = d.name || ""; $("ob-interests").value = d.interests || ""; $("ob-music").value = d.music || ""; $("ob-when").value = d.when || "";
    if (d.lens) ["news", "podcast", "audiobook"].forEach((k) => { const i = $("len-" + k); if (i && d.lens[k] != null) { i.value = d.lens[k]; i.dispatchEvent(new Event("input")); } });
  } catch {}
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

// ---------- accounts (passwordless magic-link login) ----------
const acctEls = {
  account: $("account"), email: $("acct-email"), signin: $("acct-signin"), signout: $("acct-signout"),
  login: $("login"), loginEmail: $("login-email"), loginSend: $("login-send"), loginMsg: $("login-msg"), loginClose: $("login-close"),
};
function updateAccountUI() {
  if (!auth || !auth.configured() || !acctEls.account) { if (acctEls.account) acctEls.account.hidden = true; return; }
  acctEls.account.hidden = false;
  const u = auth.currentUser();
  acctEls.email.textContent = u ? (u.email || "signed in") : "";
  acctEls.signin.hidden = !!u;
  acctEls.signout.hidden = !u;
}
function openLogin() { if (acctEls.login) { acctEls.login.hidden = false; acctEls.loginMsg.textContent = ""; } }
function closeLogin() { if (acctEls.login) acctEls.login.hidden = true; }
if (acctEls.signin) acctEls.signin.onclick = openLogin;
if (acctEls.loginClose) acctEls.loginClose.onclick = closeLogin;
if (acctEls.signout) acctEls.signout.onclick = () => { auth.signOut(); USER = DEVICE_ID; updateAccountUI(); location.reload(); };
if (acctEls.loginSend) acctEls.loginSend.onclick = async () => {
  const email = (acctEls.loginEmail.value || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { acctEls.loginMsg.textContent = "Please enter a valid email."; return; }
  acctEls.loginSend.disabled = true; acctEls.loginMsg.textContent = "Sending…";
  try { await auth.sendLink(email); acctEls.loginMsg.textContent = "✓ Check your inbox for the login link, then open it on this device."; }
  catch (e) { acctEls.loginMsg.textContent = "Couldn't send link: " + (e.message || e); }
  finally { acctEls.loginSend.disabled = false; }
};
// Resolve identity on boot: capture a magic-link return, then use the account id if logged
// in (so the feed follows the user). Migration of the device profile onto a fresh account is
// handled server-side via `migrateFrom` on the next onboarding build.
async function initAuth() {
  if (!auth || !auth.configured()) { updateAccountUI(); return; }
  try { auth.handleRedirect(); } catch {}
  let u = null;
  try { u = await auth.loadUser(); } catch {}
  if (u) USER = u.id;
  updateAccountUI();
}

// ---------- boot ----------
(async () => {
  await checkHealth();
  await initAuth();
  if (window.MyRadioSpotify) {
    await MyRadioSpotify.handleRedirect();
    if (MyRadioSpotify.isConnected()) {
      try { spotifyCtx = await MyRadioSpotify.loadContext(); } catch { spotifyCtx = spotifyCtx || {}; }
      // Confirm Premium via the playback SDK (works even when the Web API /me is rate-limited),
      // then load the pools if Premium. This is why "no Premium" showed on the live site — /me
      // was 429'd; the SDK's `ready` event is the reliable signal.
      try { await MyRadioSpotify.initPlayer(); } catch {}
      if (MyRadioSpotify.isPremium()) {
        spotifyMusic = (spotifyCtx && spotifyCtx.topTracks) || [];
        spotifyPodcasts = (spotifyCtx && spotifyCtx.topShows) || [];
      }
      updateSpotifyUI();
    } else if (MyRadioSpotify.lastError && MyRadioSpotify.lastError()) {
      // Login was attempted but didn't complete — show why instead of failing silently.
      if (els.obSpotifyStatus) els.obSpotifyStatus.textContent = MyRadioSpotify.lastError();
    }
  }
  // Always land on the onboarding interview (a reload should NOT skip to the player).
  // Refill the form if we're returning from the Spotify login redirect.
  loadDraft();
})();
