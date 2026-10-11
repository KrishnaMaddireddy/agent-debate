// Small DOM helpers for the console. Browser-only.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Linkify http(s) URLs in already-escaped text. */
export function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"')]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}

/** A deliberately small markdown renderer for memos: headings, lists, quotes, tables, bold, code, links. Input is escaped first. */
export function mdToHtml(src) {
  const lines = String(src ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  let list = null, para = [], table = null;
  const inline = (t) => linkify(esc(t))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, a, b) => `<a href="${b}" target="_blank" rel="noopener noreferrer">${a}</a>`);
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; }
    if (table) { out.push(`<table>${table.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("")}</table>`); table = null; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push(`<h${Math.min(5, m[1].length + 2)}>${inline(m[2])}</h${Math.min(5, m[1].length + 2)}>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (para.length || table || (list && list.tag !== "ul")) flush(); (list ||= { tag: "ul", items: [] }).items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (para.length || table || (list && list.tag !== "ol")) flush(); (list ||= { tag: "ol", items: [] }).items.push(m[1]); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      if (para.length || list) flush();
      (table ||= []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    if (list || table) flush();
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}

export function fmtTime(t) {
  if (!t) return "";
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDuration(ms) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Save bytes or text as a file (a normal <a download> in a page; the artifact host can override). */
export function saveBlob(data, filename, type = "text/plain") {
  if (window.__AD_SAVE__) return window.__AD_SAVE__(data, filename, type);
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`ad.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ad.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
