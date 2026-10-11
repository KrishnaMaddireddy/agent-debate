// A run as one self-contained HTML page: the same cards and panels the console shows, rendered once
// from the same reducer, with no script — open it anywhere, send it to anyone. Pure string building,
// so the console, the server and the CLI all produce byte-identical pages. The console's stylesheet
// is passed in (the browser reads it from the page; the server from app/ui/index.html).

import { esc, mdToHtml } from "./dom.js";
import { feedItems } from "./feed.js";
import { renderPanels } from "./panels.js";
import { costLine } from "../core/record.js";

const EXTRA_CSS = `
html, body { height: auto; }
.rp-top { padding: 18px 16px 6px; max-width: 1440px; margin: 0 auto; }
.rp-top h1 { font-size: 17px; margin: 0 0 6px; line-height: 1.4; overflow-wrap: anywhere; text-wrap: balance; }
.rp-top .meta { color: var(--dim); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.rp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 380px); gap: 16px; max-width: 1440px; margin: 0 auto; padding: 10px 16px 30px; }
.rp > * { min-width: 0; }
.rp .ev, .rp .phase { max-width: none; }
.rp-side { position: sticky; top: 10px; align-self: start; max-height: calc(100dvh - 20px); overflow: auto; }
.rp-appx { max-width: 1440px; margin: 0 auto; padding: 0 16px 40px; }
.rp-appx pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 8px; font-size: 11.5px; max-height: 520px; overflow: auto; }
.rp-appx details { margin: 4px 0; }
.rp-foot { color: var(--faint); font-size: 11px; max-width: 1440px; margin: 0 auto; padding: 0 16px 30px; }
@media (max-width: 980px) { .rp { grid-template-columns: minmax(0, 1fr); } .rp-side { position: static; max-height: none; } }
@media print { .rp { grid-template-columns: minmax(0, 1fr); } .rp-side { position: static; max-height: none; } details { break-inside: avoid; } }
`;

const STATIC_UI = { fileTab: {}, fileMode: {}, static: true };

/** Documents appear once, in their own section; inside prompts they are replaced by a pointer. */
function dedupeDocs(text, docs, included) {
  let out = String(text ?? "");
  for (const d of docs || []) if (d.text && (d.text.length > 200 || !included)) out = out.split(d.text).join(included ? `[the full text of ${d.id} is in the Documents section of this page]` : `[the text of ${d.id} is not included in this page]`);
  return out;
}

/**
 * reportPage({ record, events, css, prompts = true, documents = true, version }) → "<!doctype html>…"
 * prompts: include every prompt and raw reply; documents: include the attached documents' text.
 */
export function reportPage({ record: rec, events, css = "", prompts = true, documents = true, version = "" }) {
  const c = rec.config || { models: [], docs: [] };
  const when = rec.started ? new Date(rec.started).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  let feed = feedItems(events, rec, STATIC_UI).map((it) => `<div class="${esc(it.cls)}">${it.html}</div>`).join("\n");
  // Buttons only work in the console: the prompts they open are in the appendix here.
  feed = feed.replace(/<button class="link" data-prompt="[^"]*"[^>]*>prompt<\/button>/g, "");
  const status = rec.status === "done" ? "done" : rec.status === "stopped" ? `stopped${rec.stopped_reason === "spending cap" ? " by the spending cap" : ""}` : rec.status;
  const docsSection = documents && c.docs?.length
    ? `<h2 class="sec" style="margin:18px 0 8px">Documents — every analyst received these exact bytes</h2>${c.docs.map((d) => `<details><summary>${esc(d.id)} ${esc(d.name)} · ${d.words} words</summary><pre>${esc(d.text || "")}</pre></details>`).join("")}`
    : c.docs?.length ? `<div class="note">${c.docs.length} document${c.docs.length === 1 ? " was" : "s were"} attached to this run; ${c.docs.length === 1 ? "its text is" : "their text is"} not included in this page.</div>` : "";
  // Pair each prompt with its reply: the k-th call of a (phase, round, analyst) with its k-th output.
  const seen = {}, outsBy = {};
  for (const o of rec.outputs) (outsBy[`${o.phase}|${o.round ?? 0}|${o.model}`] ||= []).push(o);
  const promptSection = prompts && rec.prompts.length
    ? `<h2 class="sec" style="margin:18px 0 8px">Every prompt as sent, and every reply as received</h2>${rec.prompts.map((p, i) => {
        const key = `${p.phase}|${p.round ?? 0}|${p.model}`;
        const k = (seen[key] = (seen[key] ?? -1) + 1);
        const o = outsBy[key]?.[k];
        const who = /^[A-F]$/.test(String(p.model)) ? `analyst ${p.model}` : p.model;
        return `<details><summary>${i + 1}. ${esc(p.phase)}${p.round ? ` · round ${p.round}` : ""} · ${esc(who)} · max ${p.max_tokens} tokens${o?.usage ? ` · ${o.usage.input.toLocaleString()} in / ${o.usage.output.toLocaleString()} out` : ""}</summary>
          <div class="faint" style="margin:4px 0">system</div><pre>${esc(dedupeDocs(p.system, c.docs, documents))}</pre>
          <div class="faint" style="margin:4px 0">user</div><pre>${esc(dedupeDocs(p.user, c.docs, documents))}</pre>
          ${o ? `<div class="faint" style="margin:4px 0">reply${o.truncated ? " — cut off at the ceiling" : ""}</div><pre>${esc(o.text)}</pre>` : ""}</details>`;
      }).join("")}`
    : "";
  const title = `Agent Debate — ${String(c.question || "run").replace(/\s+/g, " ").slice(0, 90)}${String(c.question || "").length > 90 ? "…" : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="generator" content="Agent Debate ${esc(version)}">
<title>${esc(title)}</title>
<style>${css}${EXTRA_CSS}</style>
</head>
<body>
<header class="rp-top">
  <h1>${esc(c.question || "")}</h1>
  <div class="meta"><span>${esc(when)}</span><span>${esc(status)}</span><span>${c.models.map((m) => esc(`${m.letter} · ${m.label}`)).join(" · ")}</span><span>${esc(costLine(rec))}</span></div>
</header>
<div class="rp">
  <main>${feed}</main>
  <aside class="rp-side">${renderPanels(rec)}</aside>
</div>
<section class="rp-appx">${docsSection}${promptSection}</section>
<footer class="rp-foot">Made with Agent Debate ${esc(version)}. The panels and every number in them are computed by code from the run's events — no model graded another. ${prompts ? "" : "Prompts and raw replies are not included in this page. "}${documents ? "" : "Attached documents are not included in this page. "}</footer>
</body>
</html>
`;
}

/** The console's stylesheet, from the text of app/ui/index.html (server and CLI). */
export function cssFromIndexHtml(html) {
  const m = String(html).match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : "";
}

export { mdToHtml };
