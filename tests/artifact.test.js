// The claude.ai page: built from the same files the app runs, and within the artifact page contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ad-art-")), "page.html");
const r = spawnSync(process.execPath, [path.join(ROOT, "build", "artifact.js"), "--out", out], { encoding: "utf8" });
const page = r.status === 0 ? fs.readFileSync(out, "utf8") : "";
const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));

test("the build succeeds and the bundle parses", () => {
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotThrow(() => new Function(script));
});

test("page contract: content only, title first, under 16 MB, theme tokens for all three states", () => {
  const markup = page.slice(0, page.indexOf("<script>"));
  assert.ok(!/<!doctype|<html|<head>|<body>/i.test(markup), "the platform supplies the skeleton");
  assert.ok(page.startsWith("<title>Agent Debate</title>"));
  assert.ok(page.length < 16 * 1024 * 1024);
  assert.match(page, /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\)/);
  assert.match(page, /:root\[data-theme="light"\]/);
  assert.match(page, /:root\[data-theme="dark"\]/);
  assert.ok(!/100vh/.test(page), "height from the frame, not the viewport");
  assert.ok(!/src="https?:/.test(page), "nothing loaded from outside");
});

test("no module syntax survives, and every engine module is inside", () => {
  assert.ok(!/^\s*(import|export)\s/m.test(script));
  for (const m of ["app/core/engine.js", "app/core/audit.js", "app/core/metrics.js", "app/core/record.js", "app/core/prompts.js", "build/host-artifact.js", "app/ui/app.js"]) assert.ok(script.includes(`// ---- ${m}`), m);
});

test("the engine inside the page is the engine on disk, byte for byte", () => {
  for (const f of ["app/core/engine.js", "app/core/audit.js", "app/core/prompts.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const fnBodies = [...src.matchAll(/^export (?:async )?function (\w+)[\s\S]*?^}/gm)].map((m) => m[0].replace(/^export /gm, ""));
    assert.ok(fnBodies.length > 2, f);
    for (const body of fnBodies) assert.ok(script.includes(body), `${f}: a function differs in the bundle`);
  }
});

test("the page talks to Claude through the sample capability, and downloads through the downloads capability", () => {
  assert.match(script, /window\.claude\.use\("sample"\)/);
  assert.match(script, /window\.claude\.use\("downloads"\)/);
  assert.match(script, /modelTier: tier, cache: false/);
});
