// Settings (server host only): providers, tools, MCP servers & plugins, local models.
// Every change goes to the server, which validates it and writes local/*.json or .env. Key values
// are sent once, written to .env, and never come back.
import { esc, $ } from "./dom.js";

export function openSettings({ host, openModal, onChanged }) {
  let tab = "providers";
  const api = host.api;
  const body = () => $("#modalBody");
  const status = (msg, bad = false) => { const el = $("#setMsg"); if (el) { el.textContent = msg; el.className = bad ? "bad" : "ok"; } };

  async function render() {
    const tabs = [["providers", "Providers"], ["tools", "Tools"], ["mcp", "MCP & plugins"], ["local", "Local models"]];
    openModal("Settings", `<div class="tabs-top" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join("")}</div><div id="setMsg" style="min-height:18px;margin:6px 0"></div><div id="setBody">Loading…</div>`);
    body().querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
    try {
      if (tab === "providers") await providers();
      else if (tab === "tools") await tools();
      else if (tab === "mcp") await mcp();
      else await local();
    } catch (e) { $("#setBody").innerHTML = `<div class="flag">${esc(e.message)}</div>`; }
  }

  // ------------------------------------------------------------ providers
  async function providers() {
    const s = await api("/api/settings");
    const el = $("#setBody");
    el.innerHTML = `<div class="note" style="margin-top:0">Providers are off until you switch them on. The server refuses any call to a provider that is off, and only models listed here can be called — nothing is billed by accident. Keys are written to <code>${esc(s.envFile)}</code> and never shown again.</div>
      <div class="prov row" style="gap:8px"><b>Default spending cap</b><span>$</span><input type="number" id="defCap" min="0" max="1000" step="0.05" value="${s.defaultBudgetUsd ?? ""}" placeholder="none" style="width:90px"><button id="defCapSave">Save</button>
        <span class="faint" style="font-size:11.5px">Used by the CLI and the API when a run names no cap. The console's cap field starts here too (or at $1).</span></div>
      ${s.providers.map((p) => `<div class="prov ${p.enabled ? "on" : ""}" data-p="${esc(p.id)}">
        <div class="row"><label class="row" style="gap:6px"><input type="checkbox" data-en ${p.enabled ? "checked" : ""} ${p.type === "mock" ? "disabled" : ""}> <b>${esc(p.label)}</b></label>
          <span class="faint">${esc(p.type)}${p.baseUrl ? ` · ${esc(p.baseUrl)}` : ""}</span><span style="flex:1"></span>
          ${s.default?.provider === p.id ? `<span class="pill">default</span>` : p.enabled ? `<button class="link" data-def>make default</button>` : ""}
          <span class="${p.hasKey ? "ok" : "warn"}">${p.type === "mock" ? "no key needed" : p.type === "cli" ? (p.hasKey ? "Claude Code found" : "claude CLI not found") : !p.keyEnv ? "no key needed" : p.hasKey ? "key set" : `${esc(p.keyEnv)} not set`}</span></div>
        ${p.keyEnv ? `<div class="row" style="margin-top:6px"><input type="password" data-key placeholder="${esc(p.keyEnv)}${p.hasKey ? " — set; paste to replace" : ""}" style="flex:1" autocomplete="off"><button data-savekey>Save key</button></div>` : ""}
        <div style="margin-top:6px" class="row">${(p.models || []).map((m) => `<span class="chip">${esc(m)} <span class="x" data-rm="${esc(m)}" title="remove">×</span></span>`).join("") || `<span class="faint">no models listed</span>`}</div>
        <div class="row" style="margin-top:6px"><input type="text" data-newmodel placeholder="add a model id" style="flex:1"><button data-addmodel>Add</button><button data-live>Refresh from provider</button></div>
        <div data-livelist></div>
        ${p.type !== "mock" && p.type !== "cli" && (p.models || []).length ? `<details style="margin-top:6px"><summary>prices <span class="faint">— USD per 1M tokens${(p.models || []).some((m) => !p.prices?.[m]) ? ` · <span class="warn">${(p.models || []).filter((m) => !p.prices?.[m]).length} unknown</span>` : ""}</span></summary>
          <table class="mx" style="margin-top:6px;width:100%"><tr><th style="text-align:left">model</th><th>in</th><th>cached in</th><th>out</th><th style="text-align:left">source</th></tr>
          ${(p.models || []).map((m) => { const pr = p.prices?.[m]; const mine = pr?.source === "your price"; return `<tr data-pm="${esc(m)}"><td style="text-align:left">${esc(m)}</td><td><input type="number" min="0" step="0.01" data-pin value="${mine ? pr.in : ""}" placeholder="${pr ? pr.in : "?"}" style="width:70px"></td><td><input type="number" min="0" step="0.001" data-pcin value="${mine && pr.cachedIn != null ? pr.cachedIn : ""}" placeholder="${pr?.cachedIn ?? "—"}" style="width:70px"></td><td><input type="number" min="0" step="0.01" data-pout value="${mine ? pr.out : ""}" placeholder="${pr ? pr.out : "?"}" style="width:70px"></td><td style="text-align:left" class="faint">${pr ? esc(pr.source) : "unknown"}</td></tr>`; }).join("")}</table>
          <div class="row" style="margin-top:6px"><button data-saveprices>Save prices</button><span class="faint" style="font-size:11.5px">Blank keeps the list price shown in grey. Your price wins over it.</span></div></details>` : ""}
        <details style="margin-top:6px"><summary>advanced</summary><div class="grid2" style="margin-top:6px">
          <label>token floor<br><input type="number" data-f="tokenFloor" value="${p.tokenFloor ?? ""}" placeholder="—"></label>
          <label>temperature<br><input type="number" step="0.1" data-f="temperature" value="${p.temperature ?? ""}" placeholder="provider default"></label>
          <label>timeout ms<br><input type="number" data-f="timeoutMs" value="${p.timeoutMs ?? ""}" placeholder="scaled"></label>
          <label>thinking<br><select data-f="thinking"><option value="">provider default</option><option value="enabled" ${p.thinking === "enabled" ? "selected" : ""}>enabled</option><option value="disabled" ${p.thinking === "disabled" ? "selected" : ""}>disabled</option></select></label>
          </div><div class="row" style="margin-top:6px"><button data-saveadv>Save</button>${p.type !== "mock" && s.default?.provider !== p.id ? `<button class="link" data-remove>remove provider</button>` : ""}</div></details>
      </div>`).join("")}
      <details class="prov"><summary><b>Add a provider</b> <span class="faint">— any OpenAI-compatible API, Anthropic or Gemini</span></summary>
        <div class="grid2" style="margin-top:8px">
          <label>id<br><input type="text" id="np-id" placeholder="groq"></label><label>label<br><input type="text" id="np-label" placeholder="Groq"></label>
          <label>type<br><select id="np-type"><option value="openai">openai-compatible</option><option value="anthropic">anthropic</option><option value="gemini">gemini</option></select></label>
          <label>base URL<br><input type="text" id="np-base" placeholder="https://api.groq.com/openai/v1"></label>
          <label>key variable<br><input type="text" id="np-key" placeholder="GROQ_API_KEY"></label>
        </div><div style="margin-top:8px"><button id="np-add">Add provider</button></div></details>`;
    const save = async (patch, msg) => {
      try { await api("/api/settings/providers", { method: "PUT", body: patch }); status(msg); onChanged(); await providers(); }
      catch (e) { status(e.message, true); }
    };
    el.querySelectorAll(".prov[data-p]").forEach((card) => {
      const id = card.dataset.p;
      const p = s.providers.find((x) => x.id === id);
      card.querySelector("[data-en]")?.addEventListener("change", (e) => save({ providers: { [id]: { enabled: e.target.checked } } }, `${p.label} ${e.target.checked ? "enabled" : "disabled"}`));
      card.querySelector("[data-def]")?.addEventListener("click", () => save({ default: { provider: id, model: p.models[0] || "" } }, `${p.label} is the default`));
      card.querySelector("[data-savekey]")?.addEventListener("click", async () => {
        const v = card.querySelector("[data-key]").value.trim();
        try { await api("/api/settings/keys", { method: "POST", body: { name: p.keyEnv, value: v } }); status(v ? `${p.keyEnv} saved` : `${p.keyEnv} cleared`); onChanged(); await providers(); } catch (e) { status(e.message, true); }
      });
      card.querySelectorAll("[data-rm]").forEach((x) => (x.onclick = () => save({ providers: { [id]: { models: p.models.filter((m) => m !== x.dataset.rm) } } }, `removed ${x.dataset.rm}`)));
      card.querySelector("[data-addmodel]").onclick = () => { const v = card.querySelector("[data-newmodel]").value.trim(); if (v) save({ providers: { [id]: { models: [...p.models, v] } } }, `added ${v}`); };
      card.querySelector("[data-live]").onclick = async () => {
        const box = card.querySelector("[data-livelist]");
        box.innerHTML = `<div class="faint">asking ${esc(p.label)}…</div>`;
        try {
          const r = await api(`/api/models/${encodeURIComponent(id)}?refresh=1`);
          if (r.error) { box.innerHTML = `<div class="flag">${esc(r.error)}</div>`; return; }
          const fresh = r.live.filter((m) => !p.models.includes(m));
          box.innerHTML = `<div class="faint" style="margin-top:5px">${r.live.length} models offered; click to add:</div><div class="row" style="max-height:150px;overflow:auto">${fresh.map((m) => `<span class="chip" data-take="${esc(m)}">+ ${esc(m)}</span>`).join("") || `<span class="faint">all listed already</span>`}</div>`;
          box.querySelectorAll("[data-take]").forEach((c) => (c.onclick = () => save({ providers: { [id]: { models: [...p.models, c.dataset.take] } } }, `added ${c.dataset.take}`)));
        } catch (e) { box.innerHTML = `<div class="flag">${esc(e.message)}</div>`; }
      };
      card.querySelector("[data-saveadv]").onclick = () => {
        const patch = {};
        card.querySelectorAll("[data-f]").forEach((f) => (patch[f.dataset.f] = f.value === "" ? null : f.value));
        save({ providers: { [id]: patch } }, `${p.label} saved`);
      };
      card.querySelector("[data-saveprices]")?.addEventListener("click", () => {
        const prices = {};
        card.querySelectorAll("[data-pm]").forEach((row) => {
          const pin = row.querySelector("[data-pin]").value, pout = row.querySelector("[data-pout]").value, pcin = row.querySelector("[data-pcin]").value;
          const mine = p.prices?.[row.dataset.pm]?.source === "your price";
          if (pin === "" && pout === "") { if (mine) prices[row.dataset.pm] = null; return; }
          prices[row.dataset.pm] = { in: pin, out: pout, ...(pcin !== "" ? { cachedIn: pcin } : {}) };
        });
        save({ providers: { [id]: { prices } } }, `${p.label} prices saved`);
      });
      card.querySelector("[data-remove]")?.addEventListener("click", () => save({ providers: { [id]: { remove: true } } }, `${p.label} removed`));
    });
    $("#defCapSave").onclick = () => save({ defaultBudgetUsd: $("#defCap").value === "" ? null : $("#defCap").value }, $("#defCap").value === "" ? "no default cap" : `default cap $${$("#defCap").value}`);
    $("#np-add").onclick = () => {
      const id = $("#np-id").value.trim();
      save({ providers: { [id]: { type: $("#np-type").value, label: $("#np-label").value.trim() || id, baseUrl: $("#np-base").value.trim(), keyEnv: $("#np-key").value.trim() || null, models: [] } } }, `${id} added — add a model, then switch it on`);
    };
  }

  // ------------------------------------------------------------ tools
  async function tools() {
    const s = await api("/api/settings");
    const el = $("#setBody");
    const groups = {};
    for (const t of s.tools) (groups[t.mcp ? `MCP · ${t.mcp.server}` : t.plugin ? `plugin · ${t.plugin}` : t.category || "general"] ||= []).push(t);
    el.innerHTML = `<div class="faint">Tools are chosen per run on the left; every analyst gets the same list and the same budget. Keys for search backends go to .env.</div>
      ${Object.entries(groups).map(([g, list]) => `<div class="sec" style="margin-top:12px">${esc(g)}</div>${list.map((t) => `<div class="prov" data-t="${esc(t.name)}">
        <div class="row"><b>${esc(t.name)}</b><span class="${t.available ? "ok" : "warn"}">${t.available ? "ready" : `needs ${esc((t.missingEnv || []).join(", "))}`}</span>${t.providerLabel ? `<span class="faint">via ${esc(t.providerLabel)}</span>` : ""}<span style="flex:1"></span>
          ${!t.mcp && !t.plugin ? `<label>calls per phase <input type="number" min="1" max="10" data-budget value="${t.budget_per_turn}" style="width:56px"></label>` : ""}
          ${t.candidates?.length ? `<label>backend <select data-use><option value="">first with a key</option>${t.candidates.map((c) => `<option ${t.use === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : ""}</div>
        <div class="faint" style="font-size:11.5px">${esc(t.description)}</div></div>`).join("")}`).join("")}
      <div class="sec" style="margin-top:12px">search backend keys</div>
      ${s.backends.map((b) => `<div class="row" style="margin:4px 0"><span style="width:160px">${esc(b.label)}</span><span class="${b.ready ? "ok" : "faint"}">${b.ready ? "key set" : "no key"}</span>${b.vars.map((v) => `<input type="password" data-var="${esc(v)}" placeholder="${esc(v)}" style="flex:1" autocomplete="off"><button data-savevar="${esc(v)}">Save</button>`).join("")}</div>`).join("")}`;
    el.querySelectorAll("[data-t]").forEach((row) => {
      const name = row.dataset.t;
      row.querySelector("[data-budget]")?.addEventListener("change", async (e) => { try { await api("/api/settings/tools", { method: "PUT", body: { tools: { [name]: { budget_per_turn: Number(e.target.value) } } } }); status(`${name}: ${e.target.value} per phase`); onChanged(); } catch (x) { status(x.message, true); } });
      row.querySelector("[data-use]")?.addEventListener("change", async (e) => { try { await api("/api/settings/tools", { method: "PUT", body: { tools: { [name]: { use: e.target.value } } } }); status(`${name} backend saved`); onChanged(); await tools(); } catch (x) { status(x.message, true); } });
    });
    el.querySelectorAll("[data-savevar]").forEach((b) => (b.onclick = async () => {
      const v = el.querySelector(`[data-var="${b.dataset.savevar}"]`).value.trim();
      try { await api("/api/settings/keys", { method: "POST", body: { name: b.dataset.savevar, value: v } }); status(`${b.dataset.savevar} saved`); onChanged(); await tools(); } catch (e) { status(e.message, true); }
    }));
  }

  // ------------------------------------------------------------ MCP servers and plugins
  async function mcp() {
    const [m, p] = await Promise.all([api("/api/mcp"), api("/api/plugins")]);
    const el = $("#setBody");
    el.innerHTML = `<div class="sec">remote MCP servers</div><div class="faint">https only (http on localhost). Header values use <code>\${VAR}</code> from .env — a literal key is refused. Off until you switch it on.</div>
      ${m.servers.map((s) => `<div class="prov ${s.enabled ? "on" : ""}" data-s="${esc(s.id)}">
        <div class="row"><label class="row" style="gap:6px"><input type="checkbox" data-en ${s.enabled ? "checked" : ""}> <b>${esc(s.label)}</b></label><span class="faint">${esc(s.url)}</span><span style="flex:1"></span>
          ${s.error ? `<span class="bad">${esc(s.error)}</span>` : s.enabled ? `<span class="ok">${s.tools.length} tools</span>` : ""}<button data-test>Test</button><button class="link" data-rm>remove</button></div>
        ${s.missingEnv.length ? s.missingEnv.map((v) => `<div class="row" style="margin-top:5px"><input type="password" data-var="${esc(v)}" placeholder="${esc(v)} (not set)" style="flex:1" autocomplete="off"><button data-savevar="${esc(v)}">Save</button></div>`).join("") : ""}
        <div data-out class="faint" style="font-size:11.5px"></div></div>`).join("") || `<div class="faint" style="margin:6px 0">none yet</div>`}
      <details class="prov"><summary><b>Add a server</b></summary><div class="grid2" style="margin-top:8px">
        <label>id<br><input type="text" id="nm-id" placeholder="my_server"></label><label>label<br><input type="text" id="nm-label"></label>
        <label style="grid-column:1/-1">url<br><input type="text" id="nm-url" placeholder="https://example.com/mcp" style="width:100%"></label>
        <label style="grid-column:1/-1">headers (JSON)<br><input type="text" id="nm-headers" placeholder='{"Authorization":"Bearer \${MY_TOKEN}"}' style="width:100%"></label></div>
        <div style="margin-top:8px"><button id="nm-add">Add server</button></div></details>
      <div class="sec" style="margin-top:14px">plugins <span class="faint" style="text-transform:none;letter-spacing:0">— folders in ${esc(p.dir)}/ bundling skills, tools and MCP servers</span></div>
      ${p.plugins.map((x) => `<div class="prov ${x.enabled ? "on" : ""}"><label class="row" style="gap:6px"><input type="checkbox" data-plugin="${esc(x.id)}" ${x.enabled ? "checked" : ""}> <b>${esc(x.label || x.id)}</b> <span class="faint">${esc(x.description || "")}</span></label>
        <div class="faint" style="font-size:11.5px">${x.skills?.length ? `skills: ${esc(x.skills.join(", "))}` : ""} ${x.tools?.length ? `· tools: ${esc(x.tools.join(", "))}` : ""}</div></div>`).join("") || `<div class="faint">none found</div>`}`;
    el.querySelectorAll("[data-s]").forEach((card) => {
      const id = card.dataset.s;
      card.querySelector("[data-en]").onchange = async (e) => { try { await api(`/api/mcp/${id}`, { method: "PUT", body: { enabled: e.target.checked } }); status(`${id} ${e.target.checked ? "enabled" : "disabled"}`); onChanged(); await mcp(); } catch (x) { status(x.message, true); } };
      card.querySelector("[data-test]").onclick = async () => { const out = card.querySelector("[data-out]"); out.textContent = "testing…"; try { const r = await api(`/api/mcp/${id}/test`, { method: "POST" }); out.textContent = `${r.count} tools: ${r.tools.map((t) => t.name).join(", ")}`; } catch (x) { out.innerHTML = `<span class="bad">${esc(x.message)}</span>`; } };
      card.querySelector("[data-rm]").onclick = async () => { try { await api(`/api/mcp/${id}`, { method: "PUT", body: { remove: true } }); status(`${id} removed`); onChanged(); await mcp(); } catch (x) { status(x.message, true); } };
      card.querySelectorAll("[data-savevar]").forEach((b) => (b.onclick = async () => { const v = card.querySelector(`[data-var="${b.dataset.savevar}"]`).value.trim(); try { await api("/api/settings/keys", { method: "POST", body: { name: b.dataset.savevar, value: v } }); status(`${b.dataset.savevar} saved`); onChanged(); await mcp(); } catch (x) { status(x.message, true); } }));
    });
    $("#nm-add").onclick = async () => {
      let headers = {};
      try { headers = $("#nm-headers").value.trim() ? JSON.parse($("#nm-headers").value) : {}; } catch { return status("headers must be JSON", true); }
      try { await api(`/api/mcp/${encodeURIComponent($("#nm-id").value.trim())}`, { method: "PUT", body: { label: $("#nm-label").value.trim(), url: $("#nm-url").value.trim(), headers } }); status("server added — switch it on to use it"); await mcp(); } catch (x) { status(x.message, true); }
    };
    el.querySelectorAll("[data-plugin]").forEach((c) => (c.onchange = async () => { try { await api(`/api/plugins/${c.dataset.plugin}/enable`, { method: "POST", body: { enabled: c.checked } }); status(`${c.dataset.plugin} ${c.checked ? "enabled" : "disabled"}`); onChanged(); await mcp(); } catch (x) { status(x.message, true); } }));
  }

  // ------------------------------------------------------------ local runtimes
  async function local() {
    const el = $("#setBody");
    el.innerHTML = `<div class="faint">Looking for Ollama, LM Studio and vLLM on this machine…</div>`;
    const r = await api("/api/local-runtimes");
    el.innerHTML = `<div class="faint">Local models cost nothing per call. Start one, then enable it here.</div>${r.runtimes.map((rt) => `<div class="prov ${rt.enabled ? "on" : ""}"><div class="row"><b>${esc(rt.label)}</b><span class="faint">${esc(rt.baseUrl)}</span><span style="flex:1"></span>
      ${rt.running ? `<span class="ok">running · ${rt.models.length} models</span>${rt.enabled ? `<span class="pill">enabled</span>` : `<button data-rt="${esc(rt.id)}">Enable</button>`}` : `<span class="faint">not running — ${esc(rt.hint)}</span>`}</div></div>`).join("")}`;
    el.querySelectorAll("[data-rt]").forEach((b) => (b.onclick = async () => { try { await api(`/api/local-runtimes/${b.dataset.rt}/enable`, { method: "POST" }); status(`${b.dataset.rt} enabled`); onChanged(); await local(); } catch (x) { status(x.message, true); } }));
  }

  render();
}
