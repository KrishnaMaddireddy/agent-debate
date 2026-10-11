#!/usr/bin/env node
// Calls every tool in the catalog once, for real, and reports which work from this machine.
//   npm run tools:check                       → every tool (tools.json + enabled plugins + enabled MCP)
//   npm run tools:check -- wikipedia_search fetch_url
// Free endpoints bar web_search, whose backend is whichever one your .env selects. Exits 1 if any failed.
import { loadEnv, toolCatalog } from "./config.js";
import { runTool } from "./tools.js";

loadEnv();
const SAMPLE = {
  web_search: { query: "nuclear power capacity factor" },
  fetch_url: { url: "https://en.wikipedia.org/wiki/Nuclear_power", query: "capacity factor" },
  calculate: { expression: "(1.03^10 - 1) * 100" },
  wikipedia_search: { query: "nuclear power" },
  wikipedia_summary: { title: "Nuclear power" },
  wikidata: { query: "Marie Curie" },
  country_facts: { country: "France" },
  world_bank: { country: "FR", indicator: "EG.ELC.NUCL.ZS" },
  fx_rates: { from: "USD", to: "EUR" },
  crypto_price: { coin: "bitcoin" },
  geocode: { place: "Paris" },
  weather: { latitude: "48.85", longitude: "2.35" },
  hn_search: { query: "nuclear power" },
  stackoverflow: { query: "node fetch timeout" },
  paper_search: { query: "nuclear power decarbonization" },
  biomed_search: { query: "intermittent fasting weight loss" },
  book_search: { query: "nuclear power" },
  crossref_doi: { doi: "10.1038/nature14539" },
  wayback_snapshot: { url: "example.com", timestamp: "20200101" },
};
const mcpErrors = [];
const tools = await toolCatalog({ mcpErrors });
const only = process.argv.slice(2);
const names = Object.keys(tools).filter((n) => n !== "mock_search" && (!only.length || only.includes(n)));
let failed = 0;
console.log(`checking ${names.length} tools…\n`);
for (const e of mcpErrors) console.log(`✗ MCP ${e.server}: ${e.error}`);
for (const n of names) {
  const t0 = Date.now();
  const r = await runTool(tools, n, SAMPLE[n] || {}, { ctx: {} });
  const ms = `${Date.now() - t0}ms`.padStart(7);
  if (r.error) { failed++; console.log(`✗ ${n.padEnd(20)} ${ms}  ${String(r.error).slice(0, 110)}`); }
  else console.log(`✓ ${n.padEnd(20)} ${ms}  ${tools[n].plugin ? `plugin ${tools[n].plugin} · ` : ""}${r.count != null ? `${r.count} rows · ` : ""}${JSON.stringify(r.items?.[0] ?? r.text ?? r.data).slice(0, 100)}`);
}
console.log(`\n${names.length - failed} ok, ${failed} failed`);
process.exit(failed || mcpErrors.length ? 1 : 0);
