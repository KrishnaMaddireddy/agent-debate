// Dependency-free PDF text-layer extraction.
//
// Why not pdf.js: this project ships with zero runtime dependencies (CLAUDE.md), and the
// declared pdfjs-dist was never actually installed — every PDF attach on the user's machine
// failed with "Cannot find package 'pdfjs-dist'" (found in live browser testing, rev 12).
//
// What this does, in the order the format forces:
//   1. index every object, including the ones packed inside /ObjStm streams;
//   2. walk the page tree so pages come out in reading order;
//   3. for each page, read its /Resources /Font map and each font's /ToUnicode CMap —
//      without that, a Chrome- or Word-produced PDF yields subset codes, not letters;
//   4. run the content stream, tracking the active font at every Tf so each string is
//      decoded through the right CMap.
// Text that still cannot be decoded is reported as such rather than handed to the models
// as noise: a seat quoting garbage is worse than a seat told the document is unreadable.
import zlib from "node:zlib";

// ---------- filters ----------
const ascii85 = (s) => {
  const body = s.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>$/, "");
  const out = []; let tuple = [], i = 0;
  while (i < body.length) {
    const c = body[i++];
    if (c === "z" && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    tuple.push(c.charCodeAt(0) - 33);
    if (tuple.length === 5) { let n = 0; for (const t of tuple) n = n * 85 + t; out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); tuple = []; }
  }
  if (tuple.length) { const k = tuple.length; while (tuple.length < 5) tuple.push(84); let n = 0; for (const t of tuple) n = n * 85 + t; out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, k - 1)); }
  return Buffer.from(out);
};
const asciiHex = (s) => Buffer.from((s.replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "").match(/../g) || []).map((h) => parseInt(h, 16)));
const IMAGE_FILTERS = new Set(["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"]);

function decodeStream(raw, filters) {
  let buf = raw;
  for (const f of filters) {
    if (IMAGE_FILTERS.has(f)) return null;
    if (f === "ASCII85Decode" || f === "A85") buf = ascii85(buf.toString("latin1"));
    else if (f === "ASCIIHexDecode" || f === "AHx") buf = asciiHex(buf.toString("latin1"));
    else if (f === "FlateDecode" || f === "Fl") { try { buf = zlib.inflateSync(buf); } catch { try { buf = zlib.inflateRawSync(buf.subarray(1)); } catch { return null; } } }
    else if (f === "LZWDecode" || f === "RunLengthDecode") return null;
  }
  return buf;
}

// ---------- object index ----------
function filtersOf(dict) {
  const m = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
  return m ? (m[1].match(/\/(\w+)/g) || []).map((f) => f.slice(1)) : [];
}

function indexObjects(s) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const end = s.indexOf("endobj", m.index);
    const body = s.slice(m.index + m[0].length, end < 0 ? s.length : end);
    const sm = /(^|[^A-Za-z])stream\r?\n?/.exec(body);
    let dict = body, stream = null;
    if (sm) {
      dict = body.slice(0, sm.index);
      const start = sm.index + sm[0].length;
      const stop = body.indexOf("endstream", start);
      stream = Buffer.from(body.slice(start, stop < 0 ? body.length : stop), "latin1");
    }
    objs.set(num, { dict, stream });
    if (end > 0) re.lastIndex = end;
  }
  // Objects packed into object streams (any PDF ≥ 1.5 keeps page and font dicts there).
  for (const [, o] of [...objs]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = decodeStream(o.stream, filtersOf(o.dict));
    if (!data) continue;
    const text = data.toString("latin1");
    const n = Number((/\/N\s+(\d+)/.exec(o.dict) || [])[1] || 0);
    const first = Number((/\/First\s+(\d+)/.exec(o.dict) || [])[1] || 0);
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = nums[i * 2], off = nums[i * 2 + 1], nextOff = i + 1 < n ? nums[i * 2 + 3] : text.length - first;
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      if (!objs.has(num)) objs.set(num, { dict: text.slice(first + off, first + nextOff), stream: null });
    }
  }
  return objs;
}

const refOf = (s) => { const m = /^\s*(\d+)\s+\d+\s+R/.exec(s || ""); return m ? Number(m[1]) : null; };
const streamOf = (objs, num) => { const o = objs.get(num); if (!o || !o.stream) return null; return decodeStream(o.stream, filtersOf(o.dict)); };

// ---------- ToUnicode CMaps ----------
function parseCMap(text) {
  const map = new Map();
  const hex = (h) => String.fromCodePoint(...(h.match(/..../g) || [h]).map((x) => parseInt(x, 16)).filter((c) => c > 0));
  for (const blk of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || [])
    for (const m of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hex(m[2]));
  for (const blk of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const m of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[4]) { const base = parseInt(m[4], 16); for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCodePoint(base + (c - lo))); }
      else { const list = [...(m[5] || "").matchAll(/<([0-9a-fA-F]+)>/g)]; list.forEach((h, i) => map.set(lo + i, hex(h[1]))); }
    }
  }
  const widths = [...(text.match(/begincodespacerange([\s\S]*?)endcodespacerange/) || [])[1]?.matchAll(/<([0-9a-fA-F]+)>/g) || []];
  const bytes = widths.length ? widths[0][1].length / 2 : ([...map.keys()][0] > 255 ? 2 : 2);
  return { map, bytes: Math.max(1, Math.min(2, Math.round(bytes))) };
}

function fontsOf(objs, pageDict) {
  // /Resources may be inline or a reference; /Font maps names to font objects.
  let res = pageDict;
  const rm = /\/Resources\s*(\d+\s+\d+\s+R|<<)/.exec(pageDict);
  if (rm && !rm[1].startsWith("<<")) res = objs.get(refOf(rm[1]))?.dict || "";
  const fm = /\/Font\s*(\d+\s+\d+\s+R|<<[\s\S]*?>>)/.exec(res);
  if (!fm) return new Map();
  const fontDict = fm[1].startsWith("<<") ? fm[1] : (objs.get(refOf(fm[1]))?.dict || "");
  const out = new Map();
  for (const m of fontDict.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const f = objs.get(Number(m[2]));
    if (!f) continue;
    const tu = refOf((/\/ToUnicode\s*(\d+\s+\d+\s+R)/.exec(f.dict) || [])[1]);
    const data = tu != null ? streamOf(objs, tu) : null;
    if (data) out.set(m[1], parseCMap(data.toString("latin1")));
  }
  return out;
}

// ---------- content stream → text ----------
function textOf(content, fonts) {
  const s = content.toString("latin1");
  let out = "", i = 0, font = null;
  const push = (codes, isHex) => {
    if (font) {
      const w = font.bytes;
      if (isHex && w === 2) { for (let k = 0; k + 1 < codes.length; k += 2) out += font.map.get((codes[k] << 8) | codes[k + 1]) ?? ""; return; }
      for (const c of codes) out += font.map.get(c) ?? String.fromCharCode(c);
      return;
    }
    for (const c of codes) out += String.fromCharCode(c);
  };
  // Inside a [ (a) -20 (b) ] TJ array the numbers are kerning, in thousandths of an em.
  // A small adjustment is letter spacing inside a word; a large one is a real space.
  const gapAfter = (j) => {
    const m = /^\s*(-?[\d.]+)/.exec(s.slice(j, j + 20));
    if (m) return Math.abs(Number(m[1])) >= 200 ? " " : "";
    return /^\s*[(<]/.test(s.slice(j, j + 8)) ? "" : " ";
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "(") {                                   // literal string
      const codes = []; let depth = 1; i++;
      while (i < s.length && depth) {
        const ch = s[i];
        if (ch === "\\") {
          const n = s[i + 1];
          if (n >= "0" && n <= "7") { const m = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0]; codes.push(parseInt(m, 8)); i += 1 + m.length; continue; }
          const map = { n: 10, r: 10, t: 9, b: 8, f: 12 };
          codes.push(map[n] !== undefined ? map[n] : n.charCodeAt(0)); i += 2; continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") { depth--; if (!depth) { i++; break; } }
        codes.push(ch.charCodeAt(0)); i++;
      }
      push(codes, false); out += gapAfter(i); continue;
    }
    if (c === "<" && s[i + 1] !== "<") {                // hex string
      const end = s.indexOf(">", i);
      if (end > i) {
        const hex = s.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, "");
        push((hex.match(/../g) || []).map((h) => parseInt(h, 16)), true);
        i = end + 1; out += gapAfter(i); continue;
      }
    }
    if (c === "/") {                                   // /F1 12 Tf — switch font
      const m = /^\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf/.exec(s.slice(i));
      if (m) { font = fonts.get(m[1]) || null; i += m[0].length; continue; }
    }
    if (c === "T" && (s[i + 1] === "*" || s[i + 1] === "d" || s[i + 1] === "D")) {
      // Td/TD move the text cursor; only a vertical move is a new line. Without this a
      // paragraph laid out word-by-word (Chrome's PDF writer does that) breaks every word.
      const before = /(-?[\d.]+)\s+(-?[\d.]+)\s*$/.exec(s.slice(Math.max(0, i - 40), i));
      const vertical = s[i + 1] === "*" || !before || Math.abs(Number(before[2])) > 0.01;
      // A horizontal move of less than a couple of points is glyph positioning inside a
      // word (Chrome's writer does this), not a space between words.
      out += vertical ? "\n" : (before && Math.abs(Number(before[1])) < 2 ? "" : " ");
      i += 2; continue;
    }
    i++;
  }
  return out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- page order ----------
function pageNumbers(objs) {
  const pages = [];
  const kidsOf = (num, seen = new Set()) => {
    if (seen.has(num)) return; seen.add(num);
    const o = objs.get(num); if (!o) return;
    if (/\/Type\s*\/Page[^s]/.test(o.dict + " ")) { pages.push(num); return; }
    const km = /\/Kids\s*\[([\s\S]*?)\]/.exec(o.dict);
    if (!km) return;
    for (const m of km[1].matchAll(/(\d+)\s+\d+\s+R/g)) kidsOf(Number(m[1]), seen);
  };
  for (const [num, o] of objs) if (/\/Type\s*\/Catalog/.test(o.dict)) { const r = refOf((/\/Pages\s*(\d+\s+\d+\s+R)/.exec(o.dict) || [])[1]); if (r != null) kidsOf(r); }
  if (!pages.length) for (const [num, o] of objs) if (/\/Type\s*\/Page[^s]/.test(o.dict + " ")) pages.push(num);
  return pages;
}

const junkRatio = (t) => { if (!t.length) return 1; let bad = 0; for (const ch of t) { const c = ch.codePointAt(0); if (c < 9 || (c > 13 && c < 32) || (c >= 127 && c < 160) || c === 0xfffd) bad++; } return bad / t.length; };

/** Extract the text layer of a PDF. Returns { pages: string[], numPages, note }. */
export function pdfText(buf) {
  const s = buf.toString("latin1");
  const objs = indexObjects(s);
  const nums = pageNumbers(objs);
  const pages = [];
  for (const num of nums) {
    const o = objs.get(num); if (!o) continue;
    const fonts = fontsOf(objs, o.dict);
    const cm = /\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(o.dict);
    const refs = cm ? [...cm[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : [];
    const parts = refs.map((r) => streamOf(objs, r)).filter(Boolean);
    if (!parts.length) { pages.push(""); continue; }
    pages.push(textOf(Buffer.concat(parts), fonts));
  }
  const numPages = nums.length || 1;
  const note = `${numPages} page${numPages === 1 ? "" : "s"}`;
  const all = pages.join("\n");
  if (!all.trim()) return { pages: [], numPages, note: `${note} — no text layer (a scanned image?); nothing extracted` };
  if (junkRatio(all) > 0.15) return { pages: [], numPages, note: `${note} — the text layer could not be decoded (embedded subset fonts with no ToUnicode map); export the document as text or HTML and attach that instead` };
  return { pages, numPages, note };
}
