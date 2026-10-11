#!/usr/bin/env node
// Run before every push: `npm run check:secrets`.
// Looks at exactly what git would publish (tracked files + untracked files not ignored) and fails if
//   - any real value from your .env / local/.env appears in them (values are never printed),
//   - a user-config file would be published (.env, providers.json, tools.json, mcp.json, plugins.json, seats.json, runs),
//   - a key-shaped string appears outside the tests' obviously fake keys.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const files = [...new Set([...git("ls-files"), ...git("ls-files", "--others", "--exclude-standard")])].filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

const secrets = [];
for (const envFile of [".env", "local/.env"]) {
  const p = path.join(ROOT, envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n#]+?)"?\s*$/);
    if (m && m[2].length >= 12) secrets.push({ name: m[1], value: m[2] });
  }
}

const CONFIG = /(^|\/)(\.env(\..*)?|providers\.json|tools\.json|mcp\.json|plugins\.json|seats\.json)$|(^|\/)runs\//;
const SHAPED = /(sk-[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[bp]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,})/g;
const FAKE = /test|fake|example|SECRET|should|0123456789|abcdef/i;

const problems = [];
for (const f of files) {
  if (CONFIG.test(f) && !f.endsWith(".example") && !/^(app\/server\/search-providers\.json|plugins\/[^/]+\/(tools|mcp)\.json)$/.test(f)) problems.push(`${f}: user config would be published`);
  const text = fs.readFileSync(path.join(ROOT, f)).toString("latin1");
  for (const s of secrets) if (text.includes(s.value)) problems.push(`${f}: contains the value of ${s.name} from .env`);
  for (const m of text.matchAll(SHAPED)) if (!FAKE.test(m[0])) problems.push(`${f}: key-shaped string ${m[0].slice(0, 8)}…`);
}

console.log(`checked ${files.length} files that git would publish against ${secrets.length} values from .env`);
if (problems.length) { console.log(problems.map((p) => `  ✗ ${p}`).join("\n")); process.exit(1); }
console.log("  ✓ no keys, no user config");
