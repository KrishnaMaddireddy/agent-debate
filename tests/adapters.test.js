// Provider adapters against a fake provider over real HTTP, and the CLI adapter against a fake binary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openaiCompat, anthropic, gemini, cli, thinkBody, callTimeoutMs, CLI_ISOLATION_PREAMBLE } from "../app/server/adapters.js";

let server, base;
const seen = [];
let script = () => ({ status: 200, body: {} });
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url, headers: req.headers, body });
    const out = await script(body, req);
    if (out.hang) return; // never answers
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const msg = (content, extra = {}) => ({ choices: [{ message: { content, ...extra }, finish_reason: extra.finish || "stop" }] });

test("openai: text, truncation flag, bearer key never in the error", async () => {
  script = () => ({ status: 200, body: { choices: [{ message: { content: "hi" }, finish_reason: "length" }] } });
  const r = await openaiCompat({ baseUrl: base, apiKey: "k1", model: "m-trunc", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 100 });
  assert.deepEqual([r.text, r.truncated], ["hi", true]);
  assert.equal(seen.at(-1).headers.authorization, "Bearer k1");
  script = () => ({ status: 401, body: { error: { message: "bad key" } } });
  await assert.rejects(openaiCompat({ baseUrl: base, apiKey: "SECRETKEY", model: "m-401", system: "s", messages: [] }), (e) => !e.message.includes("SECRETKEY") && /401: bad key/.test(e.message));
});

test("openai: the temperature a provider demands is learned and kept", async () => {
  let n = 0;
  script = (b) => { n++; return b.temperature === 1 ? { status: 200, body: msg("ok") } : { status: 400, body: { error: { message: "invalid temperature: only 1 is allowed for this model" } } }; };
  const opts = { baseUrl: base, apiKey: "k", model: "kimi-like", system: "s", messages: [{ role: "user", content: "u" }], temperature: 0.3 };
  assert.equal((await openaiCompat(opts)).text, "ok");
  assert.equal(n, 2);
  assert.equal((await openaiCompat(opts)).text, "ok");
  assert.equal(n, 3, "learned once: the second call goes straight through");
});

test("openai: an unsupported temperature is dropped; max_completion_tokens is adopted when demanded", async () => {
  script = (b) => ("temperature" in b ? { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.3" } } } : "max_tokens" in b ? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } } } : { status: 200, body: msg("fine") });
  const r = await openaiCompat({ baseUrl: base, apiKey: "k", model: "gpt-like", system: "s", messages: [], temperature: 0.3, maxTokens: 500 });
  assert.equal(r.text, "fine");
  assert.equal(seen.at(-1).body.max_completion_tokens, 500);
});

test("openai: a reasoning model cut off before answering gets twice the room once; the channel is returned", async () => {
  const sizes = [];
  script = (b) => { sizes.push(b.max_tokens); return b.max_tokens < 2000 ? { status: 200, body: msg("", { reasoning_content: "thinking…", finish: "length" }) } : { status: 200, body: msg("", { reasoning_content: '{"position":"from reasoning"}' }) }; };
  const r = await openaiCompat({ baseUrl: base, apiKey: "k", model: "r1-like", system: "s", messages: [], maxTokens: 1000 });
  assert.deepEqual(sizes, [1000, 2000]);
  assert.equal(r.text, "");
  assert.match(r.reasoningText, /from reasoning/);
});

test("thinking is a mode, and the dialect follows the base URL", () => {
  assert.deepEqual(thinkBody({ baseUrl: "https://openrouter.ai/api/v1", thinking: "enabled" }), { reasoning: { effort: "high" } });
  assert.deepEqual(thinkBody({ baseUrl: "https://api.deepseek.com", thinking: "disabled" }), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkBody({ baseUrl: "x", thinking: null }), {});
});

test("timeouts scale with the ceiling and Stop aborts at once", async () => {
  assert.equal(callTimeoutMs(1000), 150_000);
  assert.equal(callTimeoutMs(100_000), 600_000);
  assert.equal(callTimeoutMs(1000, 5000), 5000);
  script = () => ({ hang: true });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(openaiCompat({ baseUrl: base, apiKey: "k", model: "slow", system: "s", messages: [], signal: ctrl.signal }), (e) => e.name === "AbortError");
  assert.ok(Date.now() - t0 < 1500);
});

test("anthropic: text blocks, thinking blocks, max_tokens stop", async () => {
  script = () => ({ status: 200, body: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }], stop_reason: "max_tokens" } });
  const r = await anthropic({ baseUrl: base, apiKey: "k", model: "claude-x", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 4000, thinking: "enabled", temperature: 0.3 });
  assert.deepEqual([r.text, r.reasoningText, r.truncated], ["answer", "hmm", true]);
  assert.equal(seen.at(-1).body.thinking.type, "enabled");
  assert.equal(seen.at(-1).body.temperature, undefined, "no temperature with thinking");
});

test("gemini: thought parts are the reasoning channel", async () => {
  script = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "why", thought: true }, { text: "what" }] }, finishReason: "STOP" }] } });
  const r = await gemini({ baseUrl: base, apiKey: "k", model: "gemini-x", system: "s", messages: [{ role: "user", content: "u" }] });
  assert.deepEqual([r.text, r.reasoningText, r.truncated], ["what", "why", false]);
});

test("cli: isolation flags, preamble, no metered key, and Stop kills the process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cli-"));
  const bin = path.join(dir, "fake-claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2); let input = ""; process.stdin.on("data", (d) => input += d);
process.stdin.on("end", () => {
  if (input.includes("SLOW")) return setTimeout(() => {}, 60000);
  const sys = args[args.indexOf("--system-prompt") + 1] || "";
  process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify({ tools: args.includes("--tools"), preamble: sys.startsWith("You are one of several"), key: process.env.ANTHROPIC_API_KEY || null, cwd: process.cwd() }) }));
});`);
  fs.chmodSync(bin, 0o755);
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-pass";
  const r = await cli({ command: bin, model: "sonnet", system: "brief", messages: [{ role: "user", content: "hello" }], maxTokens: 1000, timeoutMs: 10000 });
  const o = JSON.parse(r.text);
  assert.equal(o.tools, true, "strongest isolation set first");
  assert.equal(o.preamble, true);
  assert.equal(o.key, null, "the subscription seat never sees a metered key");
  assert.ok(o.cwd.includes("agent-debate-seat-"), "runs in an empty temp directory");
  assert.ok(CLI_ISOLATION_PREAMBLE.includes("no user, no account"));
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 150);
  await assert.rejects(cli({ command: bin, system: "s", messages: [{ role: "user", content: "SLOW" }], timeoutMs: 30000, signal: ctrl.signal }), (e) => e.name === "AbortError");
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(cli({ command: path.join(dir, "missing"), system: "s", messages: [{ role: "user", content: "x" }] }), /not installed or not on PATH/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rev 15: usage for the meter and the cap

test("usage: OpenAI-style tokens and cache hits are returned, with the model that actually served", async () => {
  script = () => ({ status: 200, body: { model: "deepseek-flash", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100 } } });
  const r = await openaiCompat({ baseUrl: base, apiKey: "k", model: "deepseek-chat", system: "s", messages: [] });
  assert.deepEqual(r.usage, { input: 120, output: 30, cached: 100 });
  assert.equal(r.servedModel, "deepseek-flash");
});

test("usage: the reasoning retry's tokens are added to the first attempt's; maxGrowth 1 forbids the retry", async () => {
  let n = 0;
  script = (b) => { n++; return b.max_tokens < 2000 ? { status: 200, body: { ...msg("", { reasoning_content: "thinking", finish: "length" }), usage: { prompt_tokens: 50, completion_tokens: 1000 } } } : { status: 200, body: { ...msg("answer"), usage: { prompt_tokens: 50, completion_tokens: 700 } } }; };
  const r = await openaiCompat({ baseUrl: base, apiKey: "k", model: "r1-usage", system: "s", messages: [], maxTokens: 1000 });
  assert.equal(r.text, "answer");
  assert.deepEqual([r.usage.input, r.usage.output], [100, 1700], "both attempts were billed, so both are counted");
  n = 0;
  const capped = await openaiCompat({ baseUrl: base, apiKey: "k", model: "r1-usage2", system: "s", messages: [], maxTokens: 1000, maxGrowth: 1 });
  assert.equal(n, 1, "no second, larger call when the spending cap has no room for it");
  assert.equal(capped.text, "");
  assert.equal(capped.usage.output, 1000);
});

test("usage: Anthropic counts cache reads and writes as input; Gemini counts thoughts as output", async () => {
  script = () => ({ status: 200, body: { model: "claude-x", content: [{ type: "text", text: "a" }], stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 } } });
  const a = await anthropic({ baseUrl: base, apiKey: "k", model: "claude-x", system: "s", messages: [{ role: "user", content: "u" }] });
  assert.deepEqual(a.usage, { input: 105, output: 7, cached: 90 });
  script = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, thoughtsTokenCount: 30 } } });
  const g = await gemini({ baseUrl: base, apiKey: "k", model: "gemini-x", system: "s", messages: [{ role: "user", content: "u" }] });
  assert.deepEqual(g.usage, { input: 40, output: 38, cached: 0 });
});

test("usage: the subscription CLI reports tokens (billed to the plan, not per token)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cli-u-"));
  const bin = path.join(dir, "fake-claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ is_error: false, result: "hi", usage: { input_tokens: 12, cache_read_input_tokens: 3000, output_tokens: 9 }, total_cost_usd: 0.02 })));`);
  fs.chmodSync(bin, 0o755);
  const r = await cli({ command: bin, system: "s", messages: [{ role: "user", content: "x" }], timeoutMs: 10000 });
  assert.equal(r.text, "hi");
  assert.deepEqual(r.usage, { input: 3012, output: 9, cached: 3000 });
  fs.rmSync(dir, { recursive: true, force: true });
});
