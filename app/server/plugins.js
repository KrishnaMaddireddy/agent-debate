// Plugins — a folder that bundles skills, tools and MCP servers so a set of capabilities can be
// dropped in, switched on, and shared as one unit.
//
//   plugins/<name>/
//     plugin.json    { "label": "…", "description": "…" }
//     skills/<skill>/SKILL.md      (same shape as the top-level skills/)
//     tools.json                   (same shape as local/tools.json)
//     mcp.json                     ({ "servers": { … } }, same shape as local/mcp.json)
//
// What is on is the operator's choice, not the plugin's: local/plugins.json holds the enabled
// set, so pulling a plugin from GitHub never turns itself on, and never spends a key by itself.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGINS_DIR = path.join(here, "..", "..", "plugins");
export const PLUGINS_STATE = path.join(here, "..", "..", "local", "plugins.json");

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

export function loadPluginState(file = PLUGINS_STATE) { return readJson(file) || {}; }
export function savePluginState(state, file = PLUGINS_STATE) { fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n"); return file; }

/** Every plugin folder found, with what it carries and whether it is on. */
export function listPlugins(dir = PLUGINS_DIR, stateFile = PLUGINS_STATE) {
  if (!fs.existsSync(dir)) return [];
  const state = loadPluginState(stateFile);
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => {
    const root = path.join(dir, d.name);
    const meta = readJson(path.join(root, "plugin.json")) || {};
    const skillsDir = path.join(root, "skills");
    const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((s) => fs.existsSync(path.join(skillsDir, s, "SKILL.md"))) : [];
    const toolsFile = path.join(root, "tools.json");
    const mcpFile = path.join(root, "mcp.json");
    const tools = fs.existsSync(toolsFile) ? Object.keys(readJson(toolsFile) || {}).filter((k) => !k.startsWith("_")) : [];
    const servers = fs.existsSync(mcpFile) ? Object.keys((readJson(mcpFile) || {}).servers || {}) : [];
    return {
      id: d.name, label: meta.label || d.name, description: meta.description || "",
      dir: root, skillsDir: skills.length ? skillsDir : null,
      toolsFile: tools.length ? toolsFile : null, mcpFile: servers.length ? mcpFile : null,
      skills, tools, servers, enabled: state[d.name]?.enabled === true,
    };
  });
}

export function setPluginEnabled(id, enabled, { dir = PLUGINS_DIR, stateFile = PLUGINS_STATE } = {}) {
  const p = listPlugins(dir, stateFile).find((x) => x.id === id);
  if (!p) throw new Error(`unknown plugin "${id}"`);
  const state = loadPluginState(stateFile);
  if (enabled) state[id] = { enabled: true }; else delete state[id];
  savePluginState(state, stateFile);
  return { ...p, enabled: Boolean(enabled) };
}

/** Files the enabled plugins contribute, for the tool/skill/MCP loaders to merge. */
export function enabledContributions(dir = PLUGINS_DIR, stateFile = PLUGINS_STATE) {
  const on = listPlugins(dir, stateFile).filter((p) => p.enabled);
  return {
    plugins: on,
    toolFiles: on.filter((p) => p.toolsFile).map((p) => ({ id: p.id, file: p.toolsFile })),
    mcpFiles: on.filter((p) => p.mcpFile).map((p) => ({ id: p.id, file: p.mcpFile })),
    skillDirs: on.filter((p) => p.skillsDir).map((p) => ({ id: p.id, dir: p.skillsDir })),
  };
}
