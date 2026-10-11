// The console talks to a "host". This one is the local server: fetch for config and runs, SSE for
// the event stream. The claude.ai artifact build supplies a different host with the same shape.

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data?.error || `${method} ${path} → HTTP ${res.status}`);
  return data;
}

export const serverHost = {
  kind: "server",
  api,
  config: () => api("/api/config"),
  suggestSkills: async (question) => (await api(`/api/skills?question=${encodeURIComponent(question)}`)).suggested || [],
  async extract(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return api("/api/extract", { method: "POST", body: { name: file.name, data: btoa(bin) } });
  },
  startRun: (body) => api("/api/runs", { method: "POST", body }),
  subscribe(id, onEvent, onEnd) {
    const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    let ended = false;
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore a malformed line */ } };
    es.addEventListener("end", () => { ended = true; es.close(); onEnd?.(); });
    es.onerror = () => { if (!ended && es.readyState === EventSource.CLOSED) onEnd?.(); };
    return () => { ended = true; es.close(); };
  },
  stop: (id) => api(`/api/runs/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  listRuns: async () => (await api("/api/runs")).runs || [],
  deleteRun: (id) => api(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reportUrl: (id) => `/api/runs/${encodeURIComponent(id)}/report.md`,
  scorecard: (includeMock) => api(`/api/scorecard${includeMock ? "?mock=1" : ""}`),
  canSettings: true,
};
