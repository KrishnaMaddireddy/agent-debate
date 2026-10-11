#!/usr/bin/env node
// Builds dist/agent-debate.html — the console and the engine as ONE page for claude.ai, where the
// models are Claude via the `sample` capability. Zero dependencies: each ES module is wrapped in its
// own function scope and wired to the others through a module table, so the page runs exactly the
// source files the local app runs. Nothing is copied by hand; nothing can drift.
//
//   node build/artifact.js            → dist/agent-debate.html
//   node build/artifact.js --out x    → x
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const out = process.argv.includes("--out") ? path.resolve(process.argv[process.argv.indexOf("--out") + 1]) : path.join(ROOT, "dist", "agent-debate.html");

// ---- data the artifact needs from disk: personas, house skills, version
function readSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "SKILL.md"))).map((d) => {
    const raw = fs.readFileSync(path.join(dir, d.name, "SKILL.md"), "utf8");
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const fm = {}; if (m) for (const line of m[1].split("\n")) { const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2].trim(); }
    return { name: fm.name || d.name, description: fm.description || "", topics: (fm.topics || "").replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), body: (m ? m[2] : raw).trim() };
  });
}
const personas = fs.readdirSync(path.join(ROOT, "personas")).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => ({ id: f.replace(/\.json$/, ""), ...JSON.parse(fs.readFileSync(path.join(ROOT, "personas", f), "utf8")) }));
const version = (() => { try { return fs.readFileSync(path.join(ROOT, "VERSION.txt"), "utf8").split("\n")[0].trim(); } catch { return "dev"; } })();
const VIRTUAL = { "build/artifact-data.js": `export const ARTIFACT_DATA = ${JSON.stringify({ version: `${version} · claude.ai`, personas, skills: readSkills(path.join(ROOT, "skills")) })};` };

// ---- a tiny module linker
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\};?[ \t]*$/gm;

function load(id, seen = new Map(), order = []) {
  if (seen.has(id)) return order;
  const src = VIRTUAL[id] ?? fs.readFileSync(path.join(ROOT, id), "utf8");
  if (/^\s*import\s+[^{]/m.test(src) || /\bimport\s*\(/.test(src.replace(/\/\/.*$/gm, ""))) throw new Error(`${id}: only named static imports are supported by the artifact build`);
  if (/\bimport\.meta\b/.test(src)) throw new Error(`${id}: import.meta is not available in the artifact`);
  const imports = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(id), m[2]));
    imports.push({ dep, names: m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a.trim()}: ${b.trim()}` : a.trim(); }) });
  }
  seen.set(id, true);
  for (const im of imports) load(im.dep, seen, order);
  const exports = [...src.matchAll(EXPORT_DECL_RE)].map((m) => m[2]);
  for (const m of src.matchAll(EXPORT_LIST_RE)) exports.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${b.trim()}: ${a.trim()}` : a.trim(); }));
  const body = src.replace(IMPORT_RE, "").replace(EXPORT_LIST_RE, "").replace(/^export\s+(?=(async\s+function|function|const|let|class)\s)/gm, "");
  order.push({ id, code: `// ---- ${id}\n__m[${JSON.stringify(id)}] = (() => {\n${imports.map((im) => `const { ${im.names.join(", ")} } = __m[${JSON.stringify(im.dep)}];`).join("\n")}\n${body}\nreturn { ${exports.join(", ")} };\n})();` });
  return order;
}

const seen = new Map(), modules = [];
load("build/host-artifact.js", seen, modules); // the host first: app.js reads window.__AD_HOST__ when it starts
load("app/ui/app.js", seen, modules);
const bundle = `(() => {\n"use strict";\nconst __m = Object.create(null);\n${modules.map((m) => m.code).join("\n\n")}\n})();`;

// ---- the page: the console's own markup and styles, the module script replaced by the bundle
const html = fs.readFileSync(path.join(ROOT, "app", "ui", "index.html"), "utf8");
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script type="module" src="\/ui\/app\.js"><\/script>\s*/, "");
if (bundle.includes("</script")) throw new Error("the bundle contains </script — it would end the inline script early");
const page = `${title}\n${style}\n${body.trim()}\n<script>\n${bundle}\n</script>\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`built ${path.relative(ROOT, out)} — ${modules.length} modules, ${(page.length / 1024).toFixed(0)} KB`);
