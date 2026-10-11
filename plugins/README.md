# Plugins

A plugin is a folder that bundles capabilities so they can be dropped in, switched on in
Settings, and shared as one unit:

```
plugins/<name>/
  plugin.json    { "label": "Fact check", "description": "Tools and skills for checking sources" }
  skills/<skill>/SKILL.md      same shape as the top-level skills/
  tools.json                   same shape as local/tools.json
  mcp.json                     { "servers": { … } }, same shape as local/mcp.json
```

Nothing in a plugin runs until you enable it (Settings › Plugins). Enabled state lives in
`local/plugins.json`, not in the plugin, so pulling a plugin from GitHub never switches itself
on. Keys still live in `.env`: a plugin's `tools.json` or `mcp.json` may only reference
`${VAR_NAME}`, and a literal-looking key is refused at load.

Names collide in the operator's favour: your own `local/tools.json` wins over a plugin's tool of
the same name, and the first plugin to declare a name keeps it.

`plugins/example-fact-check` is a worked example: one skill and two keyless tools.
