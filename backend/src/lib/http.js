// Tiny fetch helpers with a timeout and a UA. Node's fetch follows redirects.
const UA = { "user-agent": "MyRadioAI/0.1 (+demo)" };

export async function getText(url, ms = 7000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: UA });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

export async function getJson(url, ms = 7000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { ...UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}
