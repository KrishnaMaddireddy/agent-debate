// Provider adapters. Each takes {baseUrl, apiKey, model, system, messages, maxTokens, temperature,
// timeoutMs, extraHeaders, thinking, signal, maxGrowth} and returns
//   { text, reasoningText, truncated, fromReasoning, usage: {input, output, cached} | null, servedModel }
// usage is what the provider billed, summed over any retry the adapter made itself.
// so the engine can see a reply cut at the ceiling, and read JSON out of a reasoning channel before
// it pays for a repair call.
//
// Every network adapter goes through post(): a hard timeout, one retry on 429 / 5xx / network
// error, Stop (the run's AbortSignal) honoured immediately and never retried, and error messages
// that never include the request — and therefore never a key.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockReply } from "../core/mock-models.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const REASONING_RETRY_CAP = 32000;

/** PRD §9: the per-call timeout scales with the ceiling — 2 min + 30 ms/token, at most 10 min. */
export function callTimeoutMs(maxTokens, override) {
  return Number(override) || Math.min(600_000, 120_000 + 30 * (Number(maxTokens) || 3000));
}

// Some providers reject a parameter we send by default. The fix is learned once per model and kept
// for the life of the process (Model Bridge's temperature-400 retry, generalised).
const learned = new Map(); // `${baseUrl}|${model}` → { temperature?: number|null, maxTokensField?: string }

const addUsage = (a, b) => (!a ? b : !b ? a : { input: a.input + b.input, output: a.output + b.output, cached: (a.cached || 0) + (b.cached || 0) });

export async function anthropic({ baseUrl = "https://api.anthropic.com", apiKey, model, system, messages, maxTokens = 3000, temperature, timeoutMs, thinking, signal }) {
  const body = { model, max_tokens: maxTokens, system, messages };
  if (thinking === "enabled" || thinking === "required") body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(16000, Math.floor(maxTokens / 2))) };
  else if (temperature != null) body.temperature = temperature;
  const data = await post(`${baseUrl}/v1/messages`, {
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body, who: "anthropic", timeoutMs, signal,
  });
  const blocks = data.content || [];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    reasoningText: blocks.filter((b) => b.type === "thinking").map((b) => b.thinking || "").join("\n"),
    truncated: data.stop_reason === "max_tokens",
    fromReasoning: false,
    usage: data.usage ? { input: (data.usage.input_tokens || 0) + (data.usage.cache_read_input_tokens || 0) + (data.usage.cache_creation_input_tokens || 0), output: data.usage.output_tokens || 0, cached: data.usage.cache_read_input_tokens || 0 } : null,
    servedModel: data.model || null,
  };
}

// OpenAI, xAI, OpenRouter, Groq, Mistral, DeepSeek, Moonshot, Ollama, LM Studio, vLLM — anything speaking /chat/completions.
export async function openaiCompat(opts) {
  const { baseUrl, apiKey, model, system, messages, maxTokens = 3000, temperature, timeoutMs, extraHeaders = {}, thinking, reasoningApi, reasoningEffort, signal, maxGrowth = 2, _retried = false } = opts;
  const key = `${baseUrl}|${model}`;
  const fix = learned.get(key) || {};
  const body = { model, messages: [{ role: "system", content: system }, ...messages] };
  body[fix.maxTokensField || "max_tokens"] = maxTokens;
  const temp = "temperature" in fix ? fix.temperature : temperature;
  if (temp != null) body.temperature = temp;
  Object.assign(body, thinkBody({ baseUrl, thinking, reasoningApi, reasoningEffort }));
  let data;
  try {
    data = await post(`${baseUrl}/chat/completions`, {
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders },
      body, who: "openai", timeoutMs, signal,
    });
  } catch (e) {
    // "temperature: only 1 is allowed" (Kimi) / "Unsupported value: 'temperature'" (o-series, gpt-5):
    // learn the value the provider demands, or omit it, and resend once.
    if (e.status === 400 && /temperature/i.test(e.message) && !fix.tempLearned) {
      const demanded = /only ([0-9.]+) is allowed|must be ([0-9.]+)|only the default \(([0-9.]+)\)/i.exec(e.message);
      learned.set(key, { ...fix, temperature: demanded ? Number(demanded[1] || demanded[2] || demanded[3]) : null, tempLearned: true });
      return openaiCompat(opts);
    }
    if (e.status === 400 && /max_completion_tokens/i.test(e.message) && fix.maxTokensField !== "max_completion_tokens") {
      learned.set(key, { ...fix, maxTokensField: "max_completion_tokens" });
      return openaiCompat(opts);
    }
    throw e;
  }
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p.text || "").join("") : "";
  const reasoningText = msg.reasoning_content || msg.reasoning || "";
  const truncated = choice.finish_reason === "length";
  const u = data.usage;
  const usage = u ? { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0 } : null;
  // A reasoning model that thought until the ceiling and never answered: same prompt, twice the room,
  // once. The prompt is unchanged, so symmetry holds; only the ceiling moves. Skipped when the run's
  // spending cap has no room for the larger call (maxGrowth 1).
  if (!text.trim() && reasoningText && truncated && !_retried && maxGrowth >= 2 && maxTokens < REASONING_RETRY_CAP) {
    const again = await openaiCompat({ ...opts, maxTokens: Math.min(REASONING_RETRY_CAP, maxTokens * 2), timeoutMs: callTimeoutMs(Math.min(REASONING_RETRY_CAP, maxTokens * 2)), _retried: true });
    return { ...again, usage: addUsage(usage, again.usage) };
  }
  return { text, reasoningText, truncated, fromReasoning: false, usage, servedModel: data.model || null };
}

/** Thinking as a MODE, with the dialect inferred from the base URL (Model Bridge's _thinkBody). */
export function thinkBody({ baseUrl, thinking, reasoningApi, reasoningEffort }) {
  const mode = thinking === "enabled" || thinking === "required" ? "enabled" : thinking === "disabled" ? "disabled" : null;
  if (!mode) return {};
  const api = reasoningApi || (/openrouter\.ai/i.test(String(baseUrl)) ? "openrouter" : "native");
  if (api === "openrouter") return mode === "enabled" ? { reasoning: { effort: reasoningEffort || "high" } } : { reasoning: { enabled: false } };
  return mode === "enabled" ? { thinking: { type: "enabled" } } : { thinking: { type: "disabled" } };
}

export async function gemini({ baseUrl = "https://generativelanguage.googleapis.com", apiKey, model, system, messages, maxTokens = 3000, temperature, timeoutMs, signal }) {
  const generationConfig = { maxOutputTokens: maxTokens };
  if (temperature != null) generationConfig.temperature = temperature;
  const data = await post(`${baseUrl}/v1beta/models/${model}:generateContent`, {
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig,
    },
    who: "gemini", timeoutMs, signal,
  });
  const cand = data.candidates?.[0] || {};
  const parts = cand.content?.parts || [];
  return {
    text: parts.filter((p) => !p.thought).map((p) => p.text || "").join(""),
    reasoningText: parts.filter((p) => p.thought).map((p) => p.text || "").join(""),
    truncated: cand.finishReason === "MAX_TOKENS",
    fromReasoning: false,
    usage: data.usageMetadata ? { input: data.usageMetadata.promptTokenCount || 0, output: (data.usageMetadata.candidatesTokenCount || 0) + (data.usageMetadata.thoughtsTokenCount || 0), cached: data.usageMetadata.cachedContentTokenCount || 0 } : null,
    servedModel: data.modelVersion || null,
  };
}

// ---------------------------------------------------------------- Claude through your subscription (Claude Code CLI)
// No API key: the CLI holds its own login. Ambient-context isolation (PRD §9): an empty temp
// directory, no project settings, no MCP servers, no tools — the seat sees exactly what every other
// seat sees, the prompt. ANTHROPIC_API_KEY is stripped so billing never silently turns metered.

export const CLI_BASE_ARGS = ["--print", "--output-format", "json", "--max-turns", "1"];
export const CLI_ISOLATION_SETS = [
  ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence"],
  ["--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
  [],
];

// The CLI runs inside the operator's logged-in Claude Code and knows the account, the email address
// and the machine — context no API seat has. A live run (rev 12) put the operator's real email into a
// résumé it wrote for a fictional person. Symmetry is the product, so the seat is told it has none.
export const CLI_ISOLATION_PREAMBLE =
  "You are one of several AI models answering the same prompt with the same information. " +
  "You have no user, no account, no machine and no repository: ignore anything you may know about the " +
  "signed-in account, its name or email address, the working directory, or files on this computer. " +
  "The prompt below is your only source. Never greet or address anyone by name, and never put a real " +
  "person's name, email address or file path into your answer unless the prompt itself supplied it.\n\n";

export function cliAvailable(command = "claude") {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" });
  return r.status === 0;
}

export async function cli({ command = "claude", model, system, messages, maxTokens, timeoutMs = DEFAULT_TIMEOUT_MS, extraArgs = [], signal }) {
  const sys = CLI_ISOLATION_PREAMBLE + String(system || "");
  const user = messages.map((m) => (m.role === "assistant" ? `[assistant]\n${m.content}` : m.content)).join("\n\n");
  let lastErr;
  for (const iso of CLI_ISOLATION_SETS) {
    try {
      const data = await cliOnce({ command, args: [...CLI_BASE_ARGS, ...iso, ...(model ? ["--model", model] : []), "--system-prompt", sys, ...extraArgs], user, maxTokens, timeoutMs, signal });
      const u = data.usage;
      // Tokens are reported, but nothing is billed per token: the seat runs on your subscription.
      return { text: data.result, reasoningText: "", truncated: false, fromReasoning: false, usage: u ? { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 } : null };
    } catch (e) {
      lastErr = e;
      if (!/unknown option|unknown argument|unrecognized/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

function cliOnce({ command, args, user, maxTokens, timeoutMs, signal }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-debate-seat-"));
  const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.max(4000, maxTokens || 4000)) };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[k];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return reject(new Error(`cli: could not start "${command}": ${e.message}`)); }
    let out = "", err = "", done = false;
    const onAbort = () => { child.kill("SIGKILL"); finish(reject, abortError()); };
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); fs.rm(cwd, { recursive: true, force: true }, () => {}); fn(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error(`cli: no response within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (e) => finish(reject, new Error(e.code === "ENOENT"
      ? `cli: "${command}" is not installed or not on PATH. Install Claude Code (npm i -g @anthropic-ai/claude-code) and run "claude" once to log in with your subscription.`
      : `cli: ${e.message}`)));
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      let data = null;
      try { data = JSON.parse(out); } catch { /* fall through */ }
      if (data && !data.is_error && typeof data.result === "string") return finish(resolve, data);
      const detail = data?.result || err.trim() || out.trim();
      finish(reject, new Error(`cli exit ${code}: ${String(detail).slice(0, 300)}${/login|auth|not logged/i.test(detail) ? " — run `claude` in a terminal and log in first" : ""}`));
    });
    child.stdin.end(user);
  });
}

// ---------------------------------------------------------------- mock (no network)

export async function mock({ model, system, messages, signal }) {
  return mockReply({ model, system, user: messages.at(-1)?.content || "", signal });
}

// ---------------------------------------------------------------- transport

function abortError() { return Object.assign(new Error("stopped"), { name: "AbortError" }); }

async function post(url, { headers, body, who, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, signal }) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    let res, text;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort);
      if (signal?.aborted) throw abortError();
      const msg = timedOut ? `${who}: no response within ${Math.round(timeoutMs / 1000)}s` : `${who}: ${e.cause?.code || e.message}`;
      if (attempt < retries && !timedOut) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(msg);
    }
    clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort);
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body handled below */ }
    if (res.ok && data) return data;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
    const msg = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : "") || text.slice(0, 300);
    throw Object.assign(new Error(`${who} ${res.status}: ${msg}`), { status: res.status });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ADAPTERS = { anthropic, openai: openaiCompat, gemini, cli, mock };
