// Server-side text-to-speech via Google Translate's TTS endpoint (free, no API key,
// same spirit as the Google News scraper). The browser Web Speech API is unreliable
// — it stalls silently when the tab isn't focused and has long-standing Chrome bugs —
// so narration is synthesized here and played through the client's <audio> element,
// exactly like music and podcasts. That makes spoken news/audiobooks reliably audible.
//
// The endpoint caps each request at ~200 chars, so long text is chunked on sentence
// then word boundaries and the resulting MP3s are concatenated (MP3 frames play back
// fine when joined).

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ENDPOINT = "https://translate.google.com/translate_tts";
const MAX_CHARS = 200;     // Google TTS per-request limit
const MAX_CHUNKS = 60;     // bound total work/latency (~ several minutes of speech)

// Split text into <=MAX_CHARS pieces, preferring sentence boundaries, then words.
export function chunkText(text, max = MAX_CHARS) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };

  for (const sentence of clean.match(/[^.!?]+[.!?]*\s*/g) || [clean]) {
    if (sentence.length <= max) {
      if ((cur + sentence).length > max) flush();
      cur += sentence;
      continue;
    }
    // Sentence itself exceeds the limit — break it on word boundaries.
    flush();
    for (const word of sentence.split(" ")) {
      if ((cur + " " + word).trim().length > max) flush();
      cur = (cur ? cur + " " : "") + word;
    }
  }
  flush();
  return chunks;
}

async function fetchChunk(text, lang) {
  const url = `${ENDPOINT}?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Split text into <=`max`-char pieces on sentence boundaries (for premium providers
// that accept long input but still have a per-request cap).
function splitByChars(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const out = []; let cur = "";
  for (const s of clean.split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + s).length > max && cur) { out.push(cur.trim()); cur = ""; }
    cur += (cur ? " " : "") + s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// --- premium "host persona" voices (workflow #6), used when their key is set ---
async function elevenLabsTTS(text) {
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel" default
  const parts = [];
  for (const c of splitByChars(text, 2500)) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: c, model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5" }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`elevenlabs ${r.status}`);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts);
}
async function openaiTTS(text) {
  const parts = [];
  for (const c of splitByChars(text, 4000)) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "tts-1", voice: process.env.OPENAI_TTS_VOICE || "alloy", input: c }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`openai tts ${r.status}`);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

// Synthesize `text` to a single MP3 Buffer. Uses a premium host voice when its key is
// set (ElevenLabs > OpenAI), otherwise the keyless Google TTS; any premium failure
// degrades to Google so narration never breaks.
export async function synthesize(text, { lang = "en" } = {}) {
  try {
    if (process.env.ELEVENLABS_API_KEY) return await elevenLabsTTS(text);
    if (process.env.OPENAI_API_KEY) return await openaiTTS(text);
  } catch (e) { console.warn("[tts] premium voice failed, using Google:", e?.message || e); }

  // Fetch chunks in PARALLEL (bounded concurrency) instead of one-at-a-time — a 45s news
  // summary is 6-8 chunks, and sequential round-trips to Google were the bulk of the
  // "preparing audio" wait. Order is preserved; a failed chunk is dropped (null) so one
  // bad fetch doesn't break narration.
  const chunks = chunkText(text).slice(0, MAX_CHUNKS);
  const CONCURRENCY = 6;
  const parts = [];
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const bufs = await Promise.all(chunks.slice(i, i + CONCURRENCY).map((c) => fetchChunk(c, lang).catch(() => null)));
    for (const b of bufs) if (b) parts.push(b);
  }
  return Buffer.concat(parts);
}
