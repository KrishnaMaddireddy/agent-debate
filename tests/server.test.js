// The server over real HTTP, against a temporary config directory — never the real local/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), "ad-test-"));
const SECRET = "sk-test-SECRET1234567890abcdef";
process.env.DEBATE_CONFIG_DIR = CFG;
for (const k of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "SERPEX_API_KEY"]) delete process.env[k];

// A providers.json in the exact shape rev 6–13 wrote — existing config must keep working.
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, "local", "providers.json.example"), "utf8"));
providers.providers.deepseek.enabled = true;
providers.default = { provider: "deepseek", model: "deepseek-chat" };
fs.writeFileSync(path.join(CFG, "providers.json"), JSON.stringify(providers, null, 2));
fs.writeFileSync(path.join(CFG, ".env"), `DEEPSEEK_API_KEY=${SECRET}\n`);
fs.mkdirSync(path.join(CFG, "runs"));
fs.writeFileSync(path.join(CFG, "runs", "panel-2026-09-11-16-56-20.json"), JSON.stringify({ topic: "an old panel run", started: "2026-09-11T16:56:20Z", status: "done", seats: [{ name: "Advocate", provider: "mock", model: "mock-1" }] }));
fs.writeFileSync(path.join(CFG, "runs", "panel-2026-09-11-16-56-20.md"), "# old report\n");

let server, base, port;
const { loadEnv } = await import("../app/server/config.js");
loadEnv();
const { createServer } = await import("../app/server/server.js");

before(async () => {
  server = createServer({});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); fs.rmSync(CFG, { recursive: true, force: true }); });

const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, headers: r.headers, text: await r.text() }; };
const json = async (p, method = "GET", body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  assert.ok(!text.includes("SECRET1234"), `${method} ${p} leaked a key`);
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
async function events(id) {
  const r = await fetch(`${base}/api/runs/${id}/events`);
  const text = await r.text();
  return text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
}
const DOC = "The pilot budget is 450000 dollars. Each city costs 150000 dollars to launch, so the budget covers three cities.";

test("config: existing providers.json loads; only enabled providers are offered; no key ever returned", async () => {
  const { status, data } = await json("/api/config");
  assert.equal(status, 200);
  assert.deepEqual(data.providers.map((p) => p.id).sort(), ["deepseek", "mock"]);
  assert.ok(data.personas.length >= 3);
  assert.ok(data.skills.some((s) => s.name === "evaluate-evidence"));
  assert.ok(!data.tools.some((t) => t.name === "read_skill" || t.name === "read_context"), "house tools are gone from the analyst catalog");
  const s = await json("/api/settings");
  assert.equal(s.status, 200);
  assert.equal(s.data.providers.find((p) => p.id === "deepseek").hasKey, true);
});

test("opt-in: a disabled provider and an unlisted model are refused before any call", async () => {
  const off = await json("/api/runs", "POST", { question: "q", models: [{ provider: "openrouter", model: "openai/gpt-5-mini" }] });
  assert.equal(off.status, 400);
  assert.match(off.data.error, /not enabled/);
  const unlisted = await json("/api/runs", "POST", { question: "q", models: [{ provider: "deepseek", model: "deepseek-secret-model" }] });
  assert.equal(unlisted.status, 400);
  assert.match(unlisted.data.error, /configured list/);
});

test("security: foreign Origin and foreign Host are refused; static paths cannot escape", async () => {
  assert.equal((await json("/api/runs", "POST", { question: "q", models: [] }, { origin: "https://evil.example" })).status, 403);
  const http = await import("node:http");
  const status = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: "/api/config", headers: { host: "attacker.test" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  assert.equal(status, 403, "DNS-rebinding guard");
  assert.equal((await get("/core/../server/config.js")).status, 404);
  assert.equal((await get("/core/%2e%2e/server/config.js")).status, 404);
  assert.equal((await json("/api/runs", "POST", { question: "q", models: [{ provider: "mock", model: "mock-1" }] }, { origin: `http://127.0.0.1:${port}` })).status, 200, "same origin is allowed");
});

test("the console and the engine modules are served", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Agent Debate<\/title>/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const eng = await get("/core/engine.js");
  assert.match(eng.headers.get("content-type"), /javascript/);
  assert.match((await get("/ui/app.js")).text, /reduceEvents/);
});

let doneId;
test("a run: SSE stream from start to end, then saved as jsonl, json, md and meta", async () => {
  const { status, data } = await json("/api/runs", "POST", { question: "Which 3 cities should we pilot in first?", models: [{ provider: "mock", model: "mock-1" }, { provider: "mock", model: "mock-alt" }], rounds: 1, docs: [{ name: "memo.md", text: DOC }], persona: "cautious-cfo", skills: "auto" });
  assert.equal(status, 200);
  doneId = data.id;
  const evs = await events(data.id);
  assert.equal(evs[0].type, "run_started");
  assert.equal(evs.at(-1).type, "done");
  assert.equal(evs.at(-1).status, "done");
  assert.equal(evs[0].config.persona.name, "Cautious CFO");
  for (const ext of [".jsonl", ".json", ".md", ".meta.json"]) assert.ok(fs.existsSync(path.join(CFG, "runs", `${data.id}${ext}`)), ext);
  const rec = await json(`/api/runs/${data.id}`);
  assert.equal(rec.data.status, "done");
  assert.match((await get(`/api/runs/${data.id}/report.md`)).text, /## Intent, as read/);
  const again = await events(data.id);
  assert.equal(again.length, evs.length, "a finished run replays every event from disk");
});

test("history: new runs with a headline, and rev ≤13 panel runs listed as legacy", async () => {
  const { data } = await json("/api/runs");
  const row = data.runs.find((r) => r.id === doneId);
  assert.ok(row.headline);
  assert.deepEqual(row.models.map((m) => m.letter), ["A", "B"]);
  const legacy = data.runs.find((r) => r.legacy);
  assert.equal(legacy.question, "an old panel run");
  assert.match((await get(`/api/runs/${legacy.id}/report.md`)).text, /old report/);
});

test("Stop aborts a running run", async () => {
  const { data } = await json("/api/runs", "POST", { question: "q?", models: [{ provider: "mock", model: "mock-slow" }, { provider: "mock", model: "mock-1" }], rounds: 1, expand: false });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  assert.equal((await json(`/api/runs/${data.id}/stop`, "POST")).data.ok, true);
  const evs = await events(data.id);
  assert.equal(evs.at(-1).status, "stopped");
  assert.ok(Date.now() - t0 < 2000);
});

test("files deliverable: files saved and served with a CSP; traversal refused", async () => {
  const { data } = await json("/api/run", "POST", { question: "A one-page site for the pilot", models: [{ provider: "mock", model: "mock-svg" }, { provider: "mock", model: "mock-2" }], rounds: 0, deliverable: "files" });
  assert.equal(data.ok, true);
  assert.equal(data.record.prompts, undefined, "the sync API leaves out prompts unless asked");
  const f = await get(`/api/runs/${data.id}/files/A/chart.svg`);
  assert.equal(f.status, 200);
  assert.match(f.headers.get("content-type"), /svg/);
  assert.match(f.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal((await get(`/api/runs/${data.id}/files/A/..%2F..%2F..%2Fproviders.json`)).status, 404);
});

test("delete removes every trace of a run", async () => {
  assert.equal((await json(`/api/runs/${doneId}`, "DELETE")).status, 200);
  for (const ext of [".jsonl", ".json", ".md", ".meta.json"]) assert.ok(!fs.existsSync(path.join(CFG, "runs", `${doneId}${ext}`)));
  assert.equal((await json(`/api/runs/${doneId}`)).status, 404);
});

test("settings: enable a provider, save a key to .env, never read it back", async () => {
  const on = await json("/api/settings/providers", "PUT", { providers: { openrouter: { enabled: true } } });
  assert.equal(on.status, 200);
  assert.equal(on.data.providers.find((p) => p.id === "openrouter").enabled, true);
  const k = await json("/api/settings/keys", "POST", { name: "OPENROUTER_API_KEY", value: "sk-or-SECRET1234567890" });
  assert.equal(k.status, 200);
  assert.equal(k.data.set, true);
  assert.match(fs.readFileSync(path.join(CFG, ".env"), "utf8"), /OPENROUTER_API_KEY=sk-or-SECRET/);
  assert.equal((await json("/api/settings/keys", "POST", { name: "PATH", value: "x" })).status, 400, "only variables some provider or tool uses");
  const saved = JSON.parse(fs.readFileSync(path.join(CFG, "providers.json"), "utf8"));
  assert.equal(saved.providers.openrouter.enabled, true);
  assert.equal(saved.providers.openrouter.hasKey, undefined, "derived fields are not written back");
  await json("/api/settings/providers", "PUT", { providers: { openrouter: { enabled: false } } });
});

test("settings: thinking mode and floors are validated", async () => {
  assert.equal((await json("/api/settings/providers", "PUT", { providers: { deepseek: { thinking: "maybe" } } })).status, 400);
  const ok = await json("/api/settings/providers", "PUT", { providers: { deepseek: { thinking: "disabled", tokenFloor: 6000 } } });
  assert.equal(ok.data.providers.find((p) => p.id === "deepseek").thinking, "disabled");
});

test("extract: PDF text via the dependency-free reader; images refused with a reason", async () => {
  const pdf = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "sample.pdf")).toString("base64");
  const r = await json("/api/extract", "POST", { name: "sample.pdf", data: pdf });
  assert.equal(r.status, 200);
  assert.ok(r.data.words > 5);
  const img = await json("/api/extract", "POST", { name: "photo.png", data: Buffer.from("x").toString("base64") });
  assert.equal(img.status, 400);
  assert.match(img.data.error, /images/);
});

test("the CLI runs the same engine and writes the same run files", async () => {
  const { spawnSync } = await import("node:child_process");
  const doc = path.join(CFG, "memo.md");
  fs.writeFileSync(doc, DOC);
  const r = spawnSync(process.execPath, [path.join(ROOT, "app", "cli.js"), "--question", "Which 3 cities?", "--model", "mock/mock-1", "--model", "mock/mock-alt", "--rounds", "1", "--context", doc, "--json"], { env: { ...process.env, DEBATE_CONFIG_DIR: CFG }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "done");
  assert.ok(fs.existsSync(path.join(CFG, "runs", `${out.id}.jsonl`)));
});

// ---------------------------------------------------------------- rev 15: prices, the cap, the scorecard, the page

test("prices: the console sees a price per model and where it came from; free providers are free", async () => {
  const { data } = await json("/api/config");
  const ds = data.providers.find((p) => p.id === "deepseek");
  assert.equal(ds.prices["deepseek-chat"].out, 1.2);
  assert.match(ds.prices["deepseek-chat"].source, /deepseek\.com.*checked/);
  const mock = data.providers.find((p) => p.id === "mock");
  assert.deepEqual([mock.prices["mock-1"].in, mock.prices["mock-1"].out], [0, 0]);
});

test("cap: a run with a cap and an unpriced model is refused before any call; your price fixes it", async () => {
  await json("/api/settings/providers", "PUT", { providers: { deepseek: { models: ["deepseek-chat", "deepseek-flash", "deepseek-experimental"] } } });
  const r = await json("/api/runs", "POST", { question: "q", models: [{ provider: "deepseek", model: "deepseek-experimental" }, { provider: "mock", model: "mock-1" }], budgetUsd: 0.5 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no price for deepseek · deepseek-experimental/);
  assert.equal((await json("/api/settings/providers", "PUT", { providers: { deepseek: { prices: { "deepseek-experimental": { in: -1, out: 2 } } } } })).status, 400, "negative prices are refused");
  const ok = await json("/api/settings/providers", "PUT", { providers: { deepseek: { prices: { "deepseek-experimental": { in: 0.5, out: 2, cachedIn: 0.05 } } } } });
  assert.deepEqual(ok.data.providers.find((p) => p.id === "deepseek").prices["deepseek-experimental"], { in: 0.5, out: 2, cachedIn: 0.05, source: "your price", floor: 6000 });
  const saved = JSON.parse(fs.readFileSync(path.join(CFG, "providers.json"), "utf8"));
  assert.deepEqual(saved.providers.deepseek.prices["deepseek-experimental"], { in: 0.5, out: 2, cachedIn: 0.05 });
});

test("cap: the default cap is saved, used when a run names none, and recorded on the run", async () => {
  assert.equal((await json("/api/settings/providers", "PUT", { defaultBudgetUsd: 0.25 })).data.defaultBudgetUsd, 0.25);
  const { data } = await json("/api/run", "POST", { question: "Which 3 cities?", models: [{ provider: "mock", model: "mock-1" }, { provider: "mock", model: "mock-alt" }], rounds: 0 });
  assert.equal(data.record.config.spend_cap, 0.25);
  assert.equal(data.record.status, "done", "mock calls cost $0, so the cap never bites");
  const none = await json("/api/run", "POST", { question: "Which 3 cities?", models: [{ provider: "mock", model: "mock-1" }], rounds: 0, budgetUsd: 0 });
  assert.equal(none.data.record.config.spend_cap, null, "0 means no cap");
  await json("/api/settings/providers", "PUT", { defaultBudgetUsd: null });
});

test("scorecard: computed from the saved runs; mock models only when asked", async () => {
  assert.deepEqual((await json("/api/scorecard")).data.rows, []);
  const { data } = await json("/api/scorecard?mock=1");
  assert.ok(data.runs >= 2);
  assert.ok(data.rows.some((r) => r.model === "mock-alt" && r.seats >= 1));
});

test("page: a finished run as one HTML page, served with a no-script policy", async () => {
  const { data } = await json("/api/run", "POST", { question: "Which 3 cities should we pilot in first?", models: [{ provider: "mock", model: "mock-1" }, { provider: "mock", model: "mock-alt" }], rounds: 1, docs: [{ name: "memo.md", text: DOC }] });
  const page = await get(`/api/runs/${data.id}/report.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'none'/);
  assert.ok(!/<script/i.test(page.text));
  assert.match(page.text, /Run configuration[\s\S]*Every prompt as sent/);
  const lean = await get(`/api/runs/${data.id}/report.html?prompts=0&documents=0`);
  assert.ok(!lean.text.includes("Every prompt as sent") && !lean.text.includes("so the budget covers three cities. Austin"));
  assert.equal((await get(`/api/runs/${data.id}/report.html?download=1`)).headers.get("content-disposition"), `attachment; filename="agent-debate-${data.id}.html"`);
  assert.equal((await get("/api/runs/run-20990101-000000-zzzz/report.html")).status, 404);
});

test("prices: OpenRouter's published per-token prices become per-1M prices for its models", async () => {
  const { liveModels, modelCache, priceFor } = await import("../app/server/config.js");
  const p = { id: "or-test", type: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: null, hasKey: true, enabled: true, models: ["openai/gpt-5-mini"] };
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ id: "openai/gpt-5-mini", pricing: { prompt: "0.00000025", completion: "0.000002", input_cache_read: "0.000000025" } }, { id: "x/free:free", pricing: { prompt: "0", completion: "0" } }] }) });
  await liveModels(p, { fetchImpl, force: true });
  assert.deepEqual(priceFor(p, "openai/gpt-5-mini"), { in: 0.25, out: 2, cachedIn: 0.025, source: "OpenRouter list price (live)" });
  assert.deepEqual([priceFor(p, "x/free:free").in, priceFor(p, "x/free:free").out], [0, 0]);
  assert.equal(priceFor(p, "not/listed"), null);
  modelCache.delete("or-test");
});
