// Files as a deliverable: models answer with named code fences; code parses them out, the console
// previews them, the server saves them under runs/<id>/files/<letter>/. Browser-safe.

export const FILES_RULES = `Your deliverable is one or more FILES, not an essay. Output every file as a fenced code block whose opening fence names it, exactly like this:
\`\`\`html file=index.html
<!doctype html> …
\`\`\`
Rules: put CSS and JavaScript inline in the HTML unless the question asks for separate files; use only relative links between your own files; never reference assets you did not produce — if the deliverable needs an image, diagram or chart, produce it as an SVG file (\`\`\`svg file=chart.svg) or inline SVG; make every file complete and self-contained so it renders as-is.`;

const FENCE_RE = /```([a-zA-Z0-9+#.-]*)[ \t]*([^\n]*)\n([\s\S]*?)```/g;
const EXT_BY_LANG = { html: "html", htm: "html", css: "css", js: "js", javascript: "js", jsx: "jsx", ts: "ts", tsx: "tsx", json: "json", md: "md", markdown: "md", py: "py", python: "py", svg: "svg", txt: "txt", text: "txt", xml: "xml", yaml: "yml", yml: "yml", sh: "sh", bash: "sh", sql: "sql", csv: "csv" };
const MIME_BY_EXT = { html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", jsx: "text/plain", ts: "text/plain", tsx: "text/plain", json: "application/json", md: "text/markdown", py: "text/x-python", svg: "image/svg+xml", txt: "text/plain", xml: "application/xml", yml: "text/yaml", sh: "text/plain", sql: "text/plain", csv: "text/csv", png: "image/png", ico: "image/x-icon" };

export function mimeFor(name) {
  return MIME_BY_EXT[String(name).split(".").pop().toLowerCase()] || "text/plain";
}

/**
 * Named files in a reply. ```html file=index.html (also filename=, title=, path=, or a bare
 * "index.html" after the language) names a file; an unnamed html block becomes index.html; other
 * unnamed blocks are illustrations, not deliverables. Names are made safe: at most two segments,
 * no dot-segments or dotfiles, safe characters only. Returns { files, prose }.
 */
export function extractFiles(text) {
  const files = [];
  const seen = new Set();
  let prose = "", last = 0;
  const src = String(text ?? "");
  for (const m of src.matchAll(FENCE_RE)) {
    prose += src.slice(last, m.index); last = m.index + m[0].length;
    const lang = (m[1] || "").toLowerCase();
    const meta = m[2] || "";
    let name = (meta.match(/(?:file(?:name)?|title|path)\s*=\s*["']?([^\s"']+)/i) || [, ""])[1] || (meta.match(/^\s*([\w./-]+\.[a-z0-9]{1,5})\s*$/i) || [, ""])[1];
    if (!name && (lang === "html" || lang === "htm")) name = "index.html";
    if (!name) continue;
    name = name.split(/[\\/]+/).map((seg) => seg.replace(/[^\w.-]/g, "_")).filter((seg) => seg && !/^\.+$/.test(seg) && !seg.startsWith(".")).slice(-2).join("/").slice(0, 80);
    if (!name) continue;
    if (!/\.[a-z0-9]{1,5}$/i.test(name) && EXT_BY_LANG[lang]) name += `.${EXT_BY_LANG[lang]}`;
    if (seen.has(name)) { let i = 2; while (seen.has(name.replace(/(\.[^.]+)$/, `-${i}$1`))) i++; name = name.replace(/(\.[^.]+)$/, `-${i}$1`); }
    seen.add(name);
    const content = m[3].replace(/\s+$/, "") + "\n";
    files.push({ name, lang: lang || EXT_BY_LANG[name.split(".").pop()] || "", bytes: new TextEncoder().encode(content).length, content });
  }
  prose += src.slice(last);
  return { files, prose: prose.replace(/\n{3,}/g, "\n\n").trim() };
}

/**
 * A preview is a sandboxed srcdoc with no origin, so `<img src="chart.svg">` would render broken.
 * Inline each sibling the page names as a data: URL so the preview shows what the download will.
 */
export function inlineSiblings(file, files) {
  if (!/\.html?$/i.test(file.name || "")) return file.content;
  let html = file.content;
  for (const other of files) {
    if (other.name === file.name) continue;
    const base = other.name.split("/").pop();
    let b64;
    try { b64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(other.content))) : null; } catch { b64 = null; }
    if (!b64) continue;
    const url = `data:${mimeFor(other.name)};base64,${b64}`;
    for (const ref of new Set([other.name, base, `./${base}`])) html = html.split(`"${ref}"`).join(`"${url}"`).split(`'${ref}'`).join(`'${url}'`);
  }
  return html;
}

/** A stored (uncompressed) zip, written by hand — every unzipper supports "stored". Returns bytes. */
export function zipStore(entries) {
  const enc = new TextEncoder();
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), data = typeof e.content === "string" ? enc.encode(e.content) : e.content, crc = crc32(data);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
