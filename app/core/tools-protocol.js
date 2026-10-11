// The tool protocol every model gets — prompt-level, not native function calling, so an
// OpenAI-shape model, Anthropic, Gemini, the Claude Code CLI and the mock all receive the same
// tools, the same budget and the same result format (symmetry is the product). Browser-safe.
//
// Each result gets a ledger id per model (T1, T2, …). A claim that rests on a result cites it
// ("basis":"tool","evidence":"T3") and the audit checks the citation against the ledger.

export const DEFAULT_BUDGET = 3;
export const MAX_TURN_CALLS = 12;
// Calls that read house material do not spend the research budget.
export const FREE_TOOLS = new Set(["read_skill"]);
export const RESULT_CHARS = 6000;

export function turnBudget(tools) {
  const paid = (tools || []).filter((t) => !FREE_TOOLS.has(t.name));
  if (!paid.length) return 0;
  return Math.min(MAX_TURN_CALLS, paid.reduce((n, t) => n + (Number(t.budget_per_turn) || DEFAULT_BUDGET), 0));
}

export function toolsBlock(tools, budget) {
  if (!tools?.length) return "";
  const lines = tools.map((t) => `- ${t.name}(${Object.entries(t.args || {}).map(([k, v]) => `${k}: ${v}`).join(", ")}) — ${t.description}${FREE_TOOLS.has(t.name) ? " [free]" : ` [at most ${Number(t.budget_per_turn) || DEFAULT_BUDGET} per phase]`}`);
  return `=== TOOLS (identical for every analyst) ===
${lines.join("\n")}
To call tools, reply with ONLY JSON lines and nothing else, one call per line: {"tool":"<tool name>","args":{<arguments>}}
Several lines at once run together. You have ${budget} call${budget === 1 ? "" : "s"} in this phase. Each result comes back with an id (T1, T2, …) that is yours to cite: a claim resting on a result says "basis":"tool","evidence":"<that id>". Research is iterative — let one result decide the next call. When you have what you need, write your final JSON answer instead of another call.`;
}

export function toolResultsBlock(exchanges) {
  if (!exchanges?.length) return "";
  return `\n\n=== YOUR TOOL RESULTS SO FAR (cite them by id) ===\n${exchanges.map((x) => x.text).join("\n\n")}\n\nCall more tools (JSON lines only) or write your final answer now.`;
}

// Said to a model whose budget is spent. Without it, a model that answers with one more call
// has its turn thrown away and is recorded absent (rev 13: 104 s of work, nothing written down).
export const BUDGET_SPENT = "\n\nYour tool budget for this phase is spent. Do NOT reply with another tool call — it will be discarded. Write your final JSON answer now from what you already have, and say plainly where the evidence is thin.";

// With no tools offered, some models still emit tool-call markup as plain text (DeepSeek's DSML).
export const TOOL_SYNTAX_NOTE = "\n\nThat reply was tool-call syntax, but no tools are available in this phase. Answer now, in the required JSON, from what you already know and have.";

export function toolUsed(exchanges, name) {
  return (exchanges || []).filter((x) => x.call.tool === name).length;
}
export function overBudget(tools, exchanges, name) {
  const t = (tools || []).find((x) => x.name === name);
  return !FREE_TOOLS.has(name) && toolUsed(exchanges, name) >= (Number(t?.budget_per_turn) || DEFAULT_BUDGET);
}
export function paidCalls(exchanges) {
  return (exchanges || []).filter((x) => !FREE_TOOLS.has(x.call.tool)).length;
}

/**
 * Tool calls in a reply: every non-empty line must be a {"tool":…} object — or the reply uses a
 * provider's own dialect (DeepSeek DSML invoke blocks, <tool_call> JSON from Qwen/Kimi/vLLM,
 * Anthropic-style <invoke name=…><parameter name=…>). Live, a model answering in its own dialect
 * lost whole turns until these were read (rev 13).
 */
export function parseToolCalls(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const native = parseNativeToolCalls(raw);
  if (native.length) return native;
  const body = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (!body.startsWith("{")) return [];
  const calls = [];
  for (const line of body.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    if (!line.startsWith("{") || !line.endsWith("}")) return [];
    try {
      const c = asToolCall(JSON.parse(line));
      if (!c) return [];
      calls.push(c);
    } catch { return []; }
  }
  return calls;
}

export function asToolCall(o) {
  if (!o || typeof o !== "object") return null;
  const tool = [o.tool, o.name, o.tool_name, o.function?.name].find((x) => typeof x === "string" && x);
  if (!tool || "position" in o || "claims" in o) return null;
  let args = o.args ?? o.arguments ?? o.parameters ?? o.input ?? o.function?.arguments ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { query: args }; } }
  return { tool, args: args && typeof args === "object" ? args : {} };
}

export function parseNativeToolCalls(text) {
  const calls = [];
  for (const m of text.matchAll(/<(?:tool_call|function_call|tool_use)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call|tool_use)>/g)) {
    try { const c = asToolCall(JSON.parse(m[1])); if (c) calls.push(c); } catch { /* not JSON */ }
  }
  for (const m of text.matchAll(/invoke[\s=]+name[\s=]+"([\w.-]+)"([\s\S]*?)(?=<\/[^>]*invoke>|<[^>]*invoke[\s=]+name|$)/g)) {
    const args = {};
    for (const p of m[2].matchAll(/parameter[\s=]+name[\s=]+"([\w.-]+)"[^>]*>([\s\S]*?)<\//g)) args[p[1]] = p[2].trim();
    calls.push({ tool: m[1], args });
  }
  return calls;
}

/** The text a model sees for one result, and the text the audit searches. */
export function formatToolResult(ref, call, result) {
  const head = `[${ref}] ${call.tool}(${JSON.stringify(call.args)})`;
  if (!result || result.error) return `${head}: ERROR — ${result?.error || "no result"}`;
  let body;
  if (Array.isArray(result.items)) {
    body = result.items.length ? result.items.map((it, i) => `${i + 1}. ${Object.values(it).filter((v) => v != null && v !== "").map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" — ")}`).join("\n") : "no results";
  } else if (typeof result.text === "string") body = result.text;
  else body = JSON.stringify(result.data ?? result);
  if (body.length > RESULT_CHARS) body = `${body.slice(0, RESULT_CHARS)}\n[truncated at ${RESULT_CHARS} characters — do not describe this as complete]`;
  return `${head}:\n${body}`;
}
