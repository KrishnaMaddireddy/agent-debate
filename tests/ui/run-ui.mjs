#!/usr/bin/env node
// Browser matrix: drives the real console (and the built claude.ai page) in Chromium.
// Needs Playwright, which is NOT a dependency of the app: `npm i --no-save playwright` once, or set
// PLAYWRIGHT_MODULE to its index.mjs. CHROMIUM_PATH picks a browser binary if Playwright's own is absent.
// Writes docs/TEST_MATRIX.md and docs/matrix/*.png.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pw;
try { pw = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"); }
catch { console.log("SKIP: Playwright is not installed (npm i --no-save playwright), or set PLAYWRIGHT_MODULE."); process.exit(0); }
const { chromium } = pw;

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), "ad-ui-"));
fs.copyFileSync(path.join(ROOT, "local", "providers.json.example"), path.join(CFG, "providers.json"));
const PORT = 8900 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(ROOT, "app", "server", "server.js")], { env: { ...process.env, DEBATE_CONFIG_DIR: CFG, PORT: String(PORT) }, stdio: "pipe" });
await new Promise((resolve, reject) => { srv.stdout.on("data", (d) => /→ http/.test(String(d)) && resolve()); srv.on("exit", () => reject(new Error("server exited"))); setTimeout(() => reject(new Error("server did not start")), 8000); });
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, "docs", "matrix");
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
async function check(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 980 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text()); });
  const t0 = Date.now();
  try {
    const note = await fn(page, ctx);
    if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
    results.push({ name, ok: true, ms: Date.now() - t0, note: note || "" });
  } catch (e) {
    await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
    results.push({ name, ok: false, ms: Date.now() - t0, note: e.message.split("\n")[0] });
  }
  await ctx.close();
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
async function fillRun(page, { question, models, rounds = 1, doc, deliverable }) {
  await page.goto(BASE);
  await page.waitForSelector("#analysts .analyst");
  await page.fill("#question", question);
  if (doc) { await page.click("#pasteBtn"); await page.fill("#pasteName", "memo.md"); await page.fill("#pasteText", doc); await page.click("#pasteAdd"); }
  while ((await page.$$("#analysts .analyst")).length < models.length) await page.click("#addAnalyst");
  for (const [i, m] of models.entries()) { await page.selectOption(`#analysts .analyst[data-i="${i}"] [data-prov]`, "mock"); await page.selectOption(`#analysts .analyst[data-i="${i}"] [data-model]`, m); }
  await page.selectOption("#rounds", String(rounds));
  if (deliverable === "files") await page.click('#deliverable button[data-v="files"]');
  // The tool list sits in a collapsed <details>; untick through the same change event a click fires.
  await page.$$eval("#tools [data-tool]:checked", (els) => els.forEach((c) => { c.checked = false; c.dispatchEvent(new Event("change")); }));
}
const DOC = "The pilot budget is 450000 dollars. Each city costs 150000 dollars to launch, so the budget covers three cities. Austin had 1200 waitlist sign-ups and Denver had 800 sign-ups last year.";

await check("A. debate: three analysts, two rounds, every card and panel", async (page) => {
  await fillRun(page, { question: "Which 3 cities should we pilot in first?", models: ["mock-1", "mock-alt", "mock-liar"], rounds: 2, doc: DOC });
  await page.click("#runBtn");
  await page.waitForSelector('[data-key="memo"]', { timeout: 20000 });
  const keys = await page.$$eval("#feed > [data-key]", (els) => els.map((e) => e.dataset.key));
  for (const k of ["cfg", "intent", "art-A", "art-B", "art-C", "diff", "crit-1-A", "reb-1-B", "final", "memo"]) expect(keys.includes(k), `missing card ${k}`);
  const panels = await page.$$eval("#panels .card h3", (els) => els.map((e) => e.firstChild.textContent.trim()));
  for (const p of ["Participation", "Grounding", "Agreement", "Why they disagreed", "Movement"]) expect(panels.includes(p), `missing panel ${p}`);
  expect(await page.$('[data-key="art-C"] .flag'), "the fabricated quote is flagged on C's card");
  expect((await page.textContent("#statusText")) === "done", "status done");
  await page.screenshot({ path: path.join(SHOTS, "A-debate.png") });
  return `${keys.length} cards, ${panels.length} panels`;
});

await check("B. prompt viewer shows exactly what was sent", async (page) => {
  await page.goto(BASE);
  await page.waitForSelector("#hist [data-open]");
  await page.click("#hist [data-open]");
  await page.waitForSelector('[data-key="memo"]');
  await page.click('[data-key="art-A"] [data-prompt]');
  await page.waitForSelector("#modal:not([hidden])");
  const body = await page.textContent("#modalBody");
  expect(/PHASE 1 — INDEPENDENT ANSWER/.test(body) && /QUESTION \(verbatim\)/.test(body), "system and user prompt shown");
  await page.keyboard.press("Escape");
  expect(await page.$eval("#modal", (m) => m.hidden), "Escape closes the modal");
});

await check("C. replay from history reproduces the live run", async (page) => {
  await page.goto(BASE);
  await page.waitForSelector("#hist [data-open]");
  await page.click("#hist [data-open]");
  await page.waitForSelector('[data-key="memo"]');
  const n = await page.$$eval("#feed > [data-key]", (els) => els.length);
  expect(n > 25, `replay rendered ${n} cards`);
  return `${n} cards replayed`;
});

await check("D. absent analysts are shown as absent and excluded", async (page) => {
  await fillRun(page, { question: "Is a four-day week good for a 20-person startup?", models: ["mock-1", "mock-empty", "mock-template"], rounds: 1 });
  await page.click("#runBtn");
  await page.waitForSelector('[data-key="memo"]', { timeout: 20000 });
  expect(await page.$('[data-key="abs-B"]') && await page.$('[data-key="abs-C"]'), "absent cards");
  expect(/no one to debate/.test(await page.textContent('[data-key="gate"]')), "gate note");
});

await check("E. Stop cancels a running debate and keeps what finished", async (page) => {
  await fillRun(page, { question: "Slow question?", models: ["mock-1", "mock-slow"], rounds: 1 });
  await page.click("#runBtn");
  await page.waitForSelector("#stopBtn:not([hidden])");
  await page.waitForTimeout(600);
  await page.click("#stopBtn");
  await page.waitForSelector('[data-key="stopped"]', { timeout: 6000 });
  expect((await page.textContent("#statusText")) === "stopped", "status stopped");
});

await check("F. files deliverable: previews, tabs, zip download", async (page) => {
  await fillRun(page, { question: "A one-page site for the city pilot", models: ["mock-svg", "mock-2"], rounds: 1, deliverable: "files" });
  await page.click("#runBtn");
  await page.waitForSelector('[data-key="memo"]', { timeout: 20000 });
  expect(await page.$('[data-key="art-A"] iframe'), "HTML preview frame");
  await page.click('[data-key="art-A"] [data-file="A|chart.svg"]');
  expect(await page.$('[data-key="art-A"] iframe[title="chart.svg preview"]'), "SVG preview after switching tab");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dlZip")]);
  expect(/files\.zip$/.test(dl.suggestedFilename()), "zip download");
  expect(/revised files/.test(await page.textContent('[data-key="reb-1-B"]')), "B revised its files");
  await page.screenshot({ path: path.join(SHOTS, "F-files.png") });
});

await check("G. downloads: report and record", async (page) => {
  await page.goto(BASE);
  await page.waitForSelector("#hist [data-open]");
  await page.click("#hist [data-open]");
  await page.waitForSelector("#dlMd");
  const [md] = await Promise.all([page.waitForEvent("download"), page.click("#dlMd")]);
  const text = fs.readFileSync(await md.path(), "utf8");
  expect(text.includes("## Run configuration"), "report content");
  const [js] = await Promise.all([page.waitForEvent("download"), page.click("#dlJson")]);
  expect(JSON.parse(fs.readFileSync(await js.path(), "utf8")).config, "record content");
});

await check("H. settings: providers are opt-in and a key is never shown", async (page) => {
  await page.goto(BASE);
  await page.click("#settingsBtn");
  await page.waitForSelector('.prov[data-p="deepseek"]');
  await page.check('.prov[data-p="deepseek"] [data-en]');
  await page.waitForSelector("#setMsg.ok");
  const saved = JSON.parse(fs.readFileSync(path.join(CFG, "providers.json"), "utf8"));
  expect(saved.providers.deepseek.enabled === true, "enabled in providers.json");
  await page.fill('.prov[data-p="deepseek"] [data-key]', "sk-ui-test-0123456789");
  await page.click('.prov[data-p="deepseek"] [data-savekey]');
  await page.waitForSelector('.prov[data-p="deepseek"] .ok');
  expect(!(await page.content()).includes("sk-ui-test-0123456789"), "the key is not echoed");
  await page.click('[data-tab="mcp"]');
  await page.waitForSelector("text=plugins");
  await page.click('[data-tab="tools"]');
  await page.waitForSelector("[data-t]");
  await page.screenshot({ path: path.join(SHOTS, "H-settings.png") });
  await page.keyboard.press("Escape");
  await page.selectOption('#analysts .analyst[data-i="0"] [data-prov]', "deepseek");
});

await check("I. delete a run with the inline confirmation", async (page) => {
  await page.goto(BASE);
  await page.waitForSelector("#hist [data-del]");
  const before = (await page.$$("#hist [data-del]")).length;
  await page.click("#hist [data-del]");
  await page.click("#hist [data-del]");
  await page.waitForFunction((n) => document.querySelectorAll("#hist [data-del]").length === n - 1, before);
});

await check("J. light theme and phone width: no horizontal scroll", async (page) => {
  await page.goto(BASE);
  await page.waitForSelector("#hist [data-open]");
  await page.click("#themeBtn");
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "light theme");
  await page.click('#hist [data-open]:has-text("Which 3 cities")'); // a finished run, not the stopped one
  await page.waitForSelector('[data-key="memo"]');
  await page.setViewportSize({ width: 400, height: 860 });
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over <= 0, `page scrolls sideways by ${over}px`);
  await page.screenshot({ path: path.join(SHOTS, "J-phone-light.png") });
});

await check("K. the claude.ai page runs the debate through the sample capability", async (page) => {
  const built = path.join(CFG, "artifact.html");
  const b = spawnSync(process.execPath, [path.join(ROOT, "build", "artifact.js"), "--out", built]);
  expect(b.status === 0, String(b.stderr));
  const { mockReply } = await import(pathToFileURL(path.join(ROOT, "app", "core", "mock-models.js")).href);
  const wrap = path.join(CFG, "artifact-wrapped.html");
  fs.writeFileSync(wrap, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style></head><body>${fs.readFileSync(built, "utf8")}</body></html>`);
  const tiers = [];
  await page.exposeFunction("pw_mock", async (input, tier) => { tiers.push(tier); const [system, user] = String(input).split("\n\n==========\n\n"); return (await mockReply({ model: { default: "mock-1", complex: "mock-alt", quick: "mock-3" }[tier], system, user })).text; });
  await page.addInitScript(() => { window.claude = { use: async (n) => (n === "sample" ? async (input, o) => ({ text: await window.pw_mock(input, o.modelTier), truncated: false, modelTierApplied: o.modelTier }) : n === "downloads" ? { save: async (r) => { window.__saved = r.filename; return { status: "saved" }; } } : null) }; });
  await page.goto(pathToFileURL(wrap).href);
  await page.waitForSelector("#analysts .analyst");
  expect(await page.$eval("#settingsBtn", (e) => e.hidden), "no Settings on claude.ai");
  await page.fill("#question", "Should a 20-person startup adopt a four-day week?");
  await page.click("#runBtn");
  await page.waitForSelector('[data-key="memo"]', { timeout: 20000 });
  await page.click("#dlMd");
  await page.waitForFunction(() => window.__saved);
  expect(new Set(tiers).size >= 2, "two Claude tiers debated");
  expect(await page.$eval(".field:has(#cap)", (e) => e.hidden), "no spending cap on claude.ai: Claude runs on the viewer's plan");
  await page.click("#dlHtml");
  await page.click("#exSave");
  await page.waitForFunction(() => /\.html$/.test(window.__saved || ""));
  await page.click("#scoreBtn");
  await page.check("#scMock");
  await page.waitForSelector("#modalBody table.mx td");
  expect(/Claude · default|Claude · complex/.test(await page.textContent("#modalBody")), "the scorecard counts the Claude tiers");
  await page.screenshot({ path: path.join(SHOTS, "K-claude-ai.png") });
  return `${tiers.length} sample() calls`;
});

await check("L. cost: pre-flight estimate, live meter, Cost panel, and the cap stopping a run", async (page) => {
  const put = (body) => fetch(`${BASE}/api/settings/providers`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await put({ providers: { mock: { prices: { "mock-1": { in: 40, out: 40 }, "mock-alt": { in: 40, out: 40 } } } } });
  try {
    await fillRun(page, { question: "Should we pilot in three cities at once?", models: ["mock-1", "mock-alt"], rounds: 2, doc: DOC });
    await page.fill("#cap", "0.35");
    await page.waitForFunction(() => /worst case \$/.test(document.querySelector("#preflight").textContent));
    expect(/above the \$0\.350 cap/.test(await page.textContent("#qWarn")), "the console warns when the worst case is above the cap");
    await page.click("#runBtn");
    await page.waitForSelector('[data-key="budgetstop"]', { timeout: 20000 });
    await page.waitForFunction(() => /spending cap/.test(document.querySelector("#statusText").textContent));
    const panel = await page.textContent("#panels");
    expect(/Cost/.test(panel) && /spending cap/.test(panel), "Cost panel with the cap");
    expect(/\$0\.\d+/.test(await page.textContent("#elapsed")), "the header shows what was spent");
    await page.waitForSelector("#hist .meta .warn");
    await page.screenshot({ path: path.join(SHOTS, "L-cap-stop.png") });
    return (await page.textContent('[data-key="budgetstop"]')).replace(/\s+/g, " ").slice(0, 120);
  } finally {
    await put({ providers: { mock: { prices: { "mock-1": null, "mock-alt": null } } } });
  }
});

await check("M. scorecard: counted across the saved runs, sortable, mock models on request", async (page) => {
  await page.goto(BASE);
  await page.click("#scoreBtn");
  await page.waitForSelector("#scMock");
  expect(/No runs to count yet/.test(await page.textContent("#modalBody")), "mock models are left out by default");
  await page.check("#scMock");
  await page.waitForSelector("#modalBody table.mx td");
  const text = await page.textContent("#modalBody");
  expect(/mock-alt/.test(text) && /mock-1/.test(text), "rows for the models that ran");
  await page.click('[data-sort="4"]');
  await page.waitForFunction(() => /audit findings ▾/.test(document.querySelector("#modalBody").textContent));
  await page.screenshot({ path: path.join(SHOTS, "M-scorecard.png") });
  return `${(await page.$$("#modalBody table.mx tr")).length - 1} models`;
});

await check("N. shareable page: saved from the console, no script, documents left out on request, fits a phone", async (page, ctx) => {
  await page.goto(BASE);
  await page.waitForSelector("#hist [data-open]");
  await page.click('#hist [data-open]:has-text("Which 3 cities")');
  await page.waitForSelector("#dlHtml");
  await page.click("#dlHtml");
  await page.waitForSelector("#exSave");
  await page.uncheck("#exDocs");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exSave")]);
  const file = await dl.path();
  const html = fs.readFileSync(file, "utf8");
  expect(!/<script/i.test(html), "no script in the page");
  expect(/Run configuration/.test(html) && /Joint memo/.test(html) && /Every prompt as sent/.test(html), "cards, memo and prompts");
  expect(!html.includes("Austin had 1200 waitlist sign-ups and Denver had 800 sign-ups last year."), "the document text is left out when asked");
  const copy = path.join(CFG, "shared.html");
  fs.copyFileSync(file, copy);
  const view = await ctx.newPage();
  await view.setViewportSize({ width: 400, height: 860 });
  await view.emulateMedia({ colorScheme: "light" });
  await view.goto(pathToFileURL(copy).href);
  const over = await view.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over <= 0, `the page scrolls sideways by ${over}px at phone width`);
  const bg = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg === "rgb(245, 247, 249)", `light theme follows the system (${bg})`);
  await view.screenshot({ path: path.join(SHOTS, "N-page-phone-light.png") });
  await view.setViewportSize({ width: 1400, height: 900 });
  await view.emulateMedia({ colorScheme: "dark" });
  await view.screenshot({ path: path.join(SHOTS, "N-page-desktop-dark.png") });
  return `${Math.round(html.length / 1024)} KB`;
});

await browser.close();
srv.kill();
fs.rmSync(CFG, { recursive: true, force: true });

const pass = results.filter((r) => r.ok).length;
const md = [`# Browser matrix — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, "", `${pass} / ${results.length} passed. Screenshots in \`docs/matrix/\`.`, "", "| check | result | time | note |", "|---|---|---|---|",
  ...results.map((r) => `| ${r.name} | ${r.ok ? "pass" : "**FAIL**"} | ${(r.ms / 1000).toFixed(1)} s | ${r.note.replace(/\|/g, "/")} |`)].join("\n");
fs.writeFileSync(path.join(ROOT, "docs", "TEST_MATRIX.md"), md + "\n");
console.log(md);
process.exit(pass === results.length ? 0 : 1);
