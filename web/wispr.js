// Wispr Flow dictation — streams mic audio (16kHz PCM) over Wispr's WebSocket and
// returns transcripts. The access token is minted server-side (/api/wispr-token) from
// the org API key. Exposes window.MyRadioWispr. No-op (returns false) when unconfigured,
// so the caller can fall back to the browser's built-in dictation.
(function () {
  const API = "http://localhost:8787";
  let cfg = null;
  async function loadCfg() {
    if (cfg) return cfg;
    try { cfg = await (await fetch(`${API}/api/wispr-token`)).json(); } catch { cfg = { configured: false }; }
    return cfg;
  }

  let ws = null, actx = null, source = null, proc = null, sink = null, stream = null;
  let position = 0, active = false, onTextCb = null;

  // Downsample Float32 @ inRate -> Int16 PCM @ 16kHz (mono).
  function to16kPCM(input, inRate) {
    const ratio = inRate / 16000;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let s = input[Math.floor(i * ratio)] || 0;
      s = Math.max(-1, Math.min(1, s));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  function b64(int16) {
    const bytes = new Uint8Array(int16.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function rms(int16) { let s = 0; for (let i = 0; i < int16.length; i++) { const v = int16[i] / 32768; s += v * v; } return Math.sqrt(s / (int16.length || 1)); }

  async function isConfigured() { const c = await loadCfg(); return !!(c.configured && c.access_token); }

  async function start(textarea, onText) {
    const c = await loadCfg();
    if (!c.configured || !c.access_token) return false;
    onTextCb = onText;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { return false; }
    actx = new (window.AudioContext || window.webkitAudioContext)();
    source = actx.createMediaStreamSource(stream);
    proc = actx.createScriptProcessor(4096, 1, 1);
    sink = actx.createGain(); sink.gain.value = 0; // keep node processing without echoing mic
    position = 0; active = true;

    ws = new WebSocket(c.ws);
    ws.onopen = () => ws.send(JSON.stringify({
      type: "auth", access_token: c.access_token,
      context: {
        app: { name: "MyRadio", type: "web" }, dictionary_context: [],
        user_identifier: "demo", user_first_name: "", user_last_name: "",
        textbox_contents: { before_text: textarea.value || "", selected_text: "", after_text: "" },
        screenshot: null, content_text: null, content_html: null, conversation: null,
      },
      language: ["en"],
    }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.status === "text" && m.body && m.body.text && onTextCb) onTextCb(m.body.text);
    };
    ws.onerror = () => {};

    proc.onaudioprocess = (e) => {
      if (!active || !ws || ws.readyState !== 1) return;
      const pcm = to16kPCM(e.inputBuffer.getChannelData(0), actx.sampleRate);
      ws.send(JSON.stringify({
        type: "append", position: position++,
        audio_packets: { packets: [b64(pcm)], volumes: [rms(pcm)], packet_duration: pcm.length / 16000, audio_encoding: "wav", byte_encoding: "base64" },
      }));
    };
    source.connect(proc); proc.connect(sink); sink.connect(actx.destination);
    return true;
  }

  function stop() {
    active = false;
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "commit", total_packets: position })); } catch {}
    try { proc && proc.disconnect(); source && source.disconnect(); sink && sink.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { actx && actx.close(); } catch {}
    setTimeout(() => { try { ws && ws.close(); } catch {} ws = null; }, 500);
  }

  window.MyRadioWispr = { isConfigured, start, stop, isActive: () => active };
})();
