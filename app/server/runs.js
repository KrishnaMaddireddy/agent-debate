// Runs: started in-process, streamed as events, persisted as
//   runs/<id>.jsonl      every event, appended as it happens (the source of truth; replayed for history)
//   runs/<id>.json       the record — reduceEvents(events), written when the run ends
//   runs/<id>.md         the report — renderReport(record)
//   runs/<id>.meta.json  one history row
//   runs/<id>/files/<letter>/…   files a model produced (files deliverable)
import fs from "node:fs";
import path from "node:path";
import { runDebate } from "../core/engine.js";
import { reduceEvents, renderReport } from "../core/record.js";
import { PATHS } from "./config.js";

export const RUN_ID_RE = /^run-\d{8}-\d{6}-[a-z0-9]{4}$/;
export const LEGACY_ID_RE = /^(panel|compare)-[0-9-]+$/;
const live = new Map(); // id → { events, clients:Set<res>, ctrl, status, started, question }

export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `run-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

const file = (id, ext) => path.join(PATHS.runs, `${id}${ext}`);

export function isLive(id) { return live.has(id); }

/** Start a run. `options` are engine options; `env` supplies call and callTool. Returns {id, done}. */
export function startRun(options, { call, callTool, log = () => {}, onEvent }) {
  fs.mkdirSync(PATHS.runs, { recursive: true });
  const id = newRunId();
  const ctrl = new AbortController();
  const entry = { events: [], clients: new Set(), ctrl, status: "running", started: Date.now(), question: options.question };
  live.set(id, entry);
  // One synchronous append per event: the log survives a crash up to the last event, and a CLI that
  // exits the moment the run ends cannot lose a buffered tail.
  const logFile = file(id, ".jsonl");
  const emit = (ev) => {
    entry.events.push(ev);
    try { fs.appendFileSync(logFile, JSON.stringify(ev) + "\n"); } catch (e) { log(`run ${id}: could not append event — ${e.message}`); }
    try { onEvent?.(ev); } catch { /* a listener's failure is not the run's */ }
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of entry.clients) { try { res.write(line); } catch { /* client went away */ } }
  };
  const done = runDebate(options, { call: (r) => call({ ...r, signal: ctrl.signal }), callTool: (r) => callTool({ ...r, signal: ctrl.signal }), emit, signal: ctrl.signal })
    .catch((e) => { emit({ t: Date.now(), type: "crash", phase: "engine", message: e.message }); emit({ t: Date.now(), type: "done", status: "error" }); return reduceEvents(entry.events); })
    .then((record) => {
      entry.status = record.status;
      try { saveRecord(id, record); } catch (e) { log(`run ${id}: could not save — ${e.message}`); }
      for (const res of entry.clients) { try { res.write("event: end\ndata: {}\n\n"); res.end(); } catch { /* gone */ } }
      entry.clients.clear();
      live.delete(id);
      log(`run ${id} ${record.status} in ${Math.round((record.duration_ms || 0) / 1000)}s`);
      return { id, record };
    });
  return { id, done };
}

export function stopRun(id) {
  const e = live.get(id);
  if (!e) return false;
  e.ctrl.abort();
  return true;
}

const safeSeg = (s) => String(s).replace(/[^\w.-]/g, "_").replace(/^\.+/, "").slice(0, 80) || "_";

export function saveRecord(id, record) {
  // Files a model produced become real files, served at /api/runs/<id>/files/<letter>/<name>.
  for (const [L, art] of Object.entries(record.current || {})) {
    for (const f of art?.files || []) {
      if (typeof f?.name !== "string" || typeof f?.content !== "string") continue;
      const segs = f.name.split("/").map(safeSeg).filter((x) => x && !/^\.+$/.test(x)).slice(-2);
      if (!segs.length) continue;
      const dir = path.join(PATHS.runs, id, "files", L);
      fs.mkdirSync(path.join(dir, ...segs.slice(0, -1)), { recursive: true });
      fs.writeFileSync(path.join(dir, ...segs), f.content);
      f.url = `/api/runs/${id}/files/${L}/${segs.join("/")}`;
    }
  }
  fs.writeFileSync(file(id, ".json"), JSON.stringify({ id, ...record }, null, 1));
  fs.writeFileSync(file(id, ".md"), renderReport(record));
  fs.writeFileSync(file(id, ".meta.json"), JSON.stringify(metaOf(id, record)));
}

export function metaOf(id, r) {
  const c = r.config || {};
  return {
    id, status: r.status, started: r.started, finished: r.finished, duration_ms: r.duration_ms,
    question: c.question, deliverable: c.deliverable, rounds: c.rounds, rounds_run: r.final?.rounds_run ?? 0,
    models: (c.models || []).map((m) => ({ letter: m.letter, label: m.label, color: m.color })),
    absent: Object.keys(r.absent || {}),
    headline: r.final?.compare?.headline || (r.status === "failed" ? "no analyst answered" : null),
    red_flag: Boolean(r.final?.compare?.redFlag),
    memo: Boolean(r.synthesis?.memo),
    cost: r.usage?.total?.calls ? { usd: r.usage.total.usd, unknown: r.usage.total.unknown, calls: r.usage.total.calls, input: r.usage.total.input, output: r.usage.total.output } : null,
    stopped_reason: r.stopped_reason || null,
  };
}

export function listRuns() {
  const rows = [];
  if (fs.existsSync(PATHS.runs)) {
    for (const f of fs.readdirSync(PATHS.runs)) {
      if (f.endsWith(".meta.json")) {
        try { rows.push(JSON.parse(fs.readFileSync(path.join(PATHS.runs, f), "utf8"))); } catch { /* skip */ }
      } else if (/^(panel|compare)-.*\.json$/.test(f)) {
        // Runs from the rev ≤ 13 panel app: listed, readable as their report, not replayable.
        try {
          const r = JSON.parse(fs.readFileSync(path.join(PATHS.runs, f), "utf8"));
          rows.push({ id: f.replace(/\.json$/, ""), legacy: true, status: r.status, started: Date.parse(r.started) || null, question: r.topic || r.prompt, models: (r.seats || r.responders || []).map((s, i) => ({ letter: String.fromCharCode(65 + i), label: `${s.name} · ${s.provider}/${s.model}` })) });
        } catch { /* skip */ }
      }
    }
  }
  for (const [id, e] of live) if (!rows.some((r) => r.id === id)) rows.push({ id, status: "running", started: e.started, question: e.question, live: true, models: e.events[0]?.config?.models?.map((m) => ({ letter: m.letter, label: m.label, color: m.color })) || [] });
  return rows.sort((a, b) => (b.started || 0) - (a.started || 0)).slice(0, 300);
}

/** Every event of a run so far — from memory when live, else from its .jsonl. */
export function runEvents(id) {
  const e = live.get(id);
  if (e) return e.events.slice();
  const f = file(id, ".jsonl");
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Server-sent events: replay everything so far, then stream until the run ends. */
export function streamRun(id, res) {
  const e = live.get(id);
  const events = runEvents(id);
  if (!events) return false;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (!e) { res.write("event: end\ndata: {}\n\n"); res.end(); return true; }
  e.clients.add(res);
  const keep = setInterval(() => { try { res.write(": keepalive\n\n"); } catch { /* gone */ } }, 15000);
  res.on("close", () => { clearInterval(keep); e.clients.delete(res); });
  return true;
}

export function readRecord(id) {
  const f = file(id, ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const events = runEvents(id);
  return events ? { id, ...reduceEvents(events) } : null;
}

/** Every finished run's record (new format), for the scorecard. Unreadable files are skipped. */
export function allRecords() {
  const out = [];
  if (!fs.existsSync(PATHS.runs)) return out;
  for (const f of fs.readdirSync(PATHS.runs)) {
    const m = f.match(/^(run-\d{8}-\d{6}-[a-z0-9]{4})\.json$/);
    if (!m || live.has(m[1])) continue;
    try { out.push({ id: m[1], ...JSON.parse(fs.readFileSync(path.join(PATHS.runs, f), "utf8")) }); } catch { /* skip */ }
  }
  return out;
}

export function deleteRun(id) {
  if (live.has(id)) throw new Error("the run is still going — stop it first");
  let n = 0;
  for (const ext of [".json", ".md", ".jsonl", ".meta.json"]) { const p = file(id, ext); if (fs.existsSync(p)) { fs.rmSync(p); n++; } }
  const dir = path.join(PATHS.runs, id);
  if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); n++; }
  return n;
}

export function runFile(id, letter, rest) {
  const segs = [letter, ...String(rest || "").split("/")].map(safeSeg).filter(Boolean);
  const base = path.join(PATHS.runs, id, "files");
  const f = path.join(base, ...segs);
  if (!f.startsWith(base + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return null;
  return f;
}
