// The shareable page for a saved run, for the server and the CLI. Same function as the console's.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportPage, cssFromIndexHtml } from "../ui/export.js";
import { readRecord, runEvents } from "./runs.js";
import { reduceEvents } from "../core/record.js";

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");
let css = null;

export function reportHtml(id, { prompts = true, documents = true, version = "" } = {}) {
  const events = runEvents(id);
  if (!events) {
    const rec = readRecord(id);
    if (!rec) return null;
    throw new Error("this run has no event log, so it cannot be rendered as a page — use the .md report");
  }
  css ??= cssFromIndexHtml(fs.readFileSync(INDEX, "utf8"));
  return reportPage({ record: reduceEvents(events), events, css, prompts, documents, version });
}
