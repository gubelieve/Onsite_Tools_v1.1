/* Onsite Tools v2 - single page frontend (no build step). */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...children) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.detail) || `${r.status} ${r.statusText}`);
    return data;
  }
  const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  // ---------------------------------------------------------------- state
  const state = { meta: null, tools: [], tool: null, jobId: null, pollTimer: null, seenMsg: {}, lastVersion: -1, fieldEls: {} };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  // ---------------------------------------------------------------- toasts
  function toast(text, level) {
    const t = el("div", { class: `toast ${level || "info"}` }, text);
    $("#toasts").append(t);
    setTimeout(() => t.remove(), level === "error" ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- modals
  function showModal(title, body) {
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    $("#modal").hidden = false;
  }
  $("#modal-close").onclick = () => ($("#modal").hidden = true);
  $("#modal-copy").onclick = () => navigator.clipboard.writeText($("#modal-body").textContent).then(() => toast("Copied to clipboard", "success"));
  $("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) $("#modal").hidden = true; });

  function confirmDialog(title, text, danger) {
    return new Promise((resolve) => {
      $("#confirm-title").textContent = title;
      $("#confirm-body").textContent = text;
      const yes = $("#confirm-yes"), no = $("#confirm-no");
      yes.className = "btn " + (danger ? "btn-danger" : "btn-primary");
      yes.textContent = danger ? "Confirm" : "OK";
      no.hidden = danger === null;
      const done = (v) => { $("#confirm").hidden = true; yes.onclick = no.onclick = null; resolve(v); };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
      $("#confirm").hidden = false;
    });
  }

  // ---------------------------------------------------------------- theme
  function applyTheme() {
    const dark = store.get("theme", "light") === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("#theme-toggle").textContent = dark ? "Light mode" : "Dark mode";
  }
  $("#theme-toggle").onclick = () => { store.set("theme", store.get("theme", "light") === "dark" ? "light" : "dark"); applyTheme(); };
  applyTheme();

  $("#remember-creds").checked = !!store.get("rememberCreds", false);
  $("#remember-creds").onchange = (e) => { store.set("rememberCreds", e.target.checked); if (!e.target.checked) store.set("creds", {}); };

  // ---------------------------------------------------------------- sidebar
  function renderSidebar(filter) {
    const nav = $("#tool-list");
    nav.innerHTML = "";
    const f = (filter || "").toLowerCase();
    const cats = {};
    for (const t of state.tools) {
      if (f && !(t.name + " " + t.description + " " + t.category).toLowerCase().includes(f)) continue;
      (cats[t.category] = cats[t.category] || []).push(t);
    }
    for (const [cat, tools] of Object.entries(cats)) {
      nav.append(el("div", { class: "cat" }, cat));
      for (const t of tools) {
        nav.append(el("a", { class: "tool-item" + (state.tool && state.tool.id === t.id ? " active" : ""), href: "#" + t.id },
          t.name, el("span", { class: "desc" }, t.description.length > 70 ? t.description.slice(0, 70) + "…" : t.description)));
      }
    }
  }
  $("#tool-filter").oninput = (e) => renderSidebar(e.target.value);

  $("#templates-link").onclick = async (e) => {
    e.preventDefault();
    const list = await api("/api/templates");
    showModal("CSV templates (click a name in the form's 'Template' link to download)", list.map((t) => `${t.name}  (${t.size} bytes)`).join("\n"));
  };

  // ---------------------------------------------------------------- forms
  function optionList(opts) {
    if (opts === "device_types") return state.meta.device_types.map((v) => ({ value: v, label: v }));
    return (opts || []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  }

  function fieldValue(f) {
    const w = state.fieldEls[f.name];
    if (!w) return undefined;
    return w.get();
  }

  function savedForm(toolId) { return store.get("form:" + toolId, {}); }
  function persistForm() {
    if (!state.tool) return;
    const remember = $("#remember-creds").checked;
    const data = {}, creds = store.get("creds", {});
    for (const f of state.tool.fields) {
      if (["file", "files"].includes(f.type)) continue;
      const v = fieldValue(f);
      if (f.type === "password" || f.remember) {
        if (remember) creds[f.name] = v;
        continue;
      }
      data[f.name] = v;
    }
    store.set("form:" + state.tool.id, data);
    if (remember) store.set("creds", creds);
  }

  function initialValue(f) {
    const saved = savedForm(state.tool.id);
    const creds = $("#remember-creds").checked ? store.get("creds", {}) : {};
    if (f.type === "password" || f.remember) return creds[f.name] ?? f.default ?? "";
    if (saved[f.name] !== undefined && f.type !== "checklist") return saved[f.name];
    return f.default ?? (f.type === "checkbox" ? false : "");
  }

  function makeField(f) {
    const wrap = el("div", { class: "field" + (f.width === "half" ? "" : " full") });
    const label = el("label", null, f.label || f.name, f.required ? el("span", { class: "req" }, " *") : null);
    if (f.template) label.append(" ", el("a", { class: "btn-link", href: "/api/templates/" + f.template, download: f.template, style: "font-size:12px;font-weight:400" }, "⬇ Template"));
    wrap.append(label);
    let api_ = { get: () => "", set: () => {}, refresh: () => {} };
    const val = initialValue(f);
    const onchange = () => { persistForm(); updateVisibility(); };

    if (["text", "password", "number"].includes(f.type)) {
      const inp = el("input", { type: f.type, value: val ?? "", placeholder: f.placeholder || "", min: f.min, max: f.max, autocomplete: f.type === "password" ? "current-password" : "off" });
      inp.addEventListener("change", onchange);
      wrap.append(inp);
      api_ = { get: () => (f.type === "number" ? Number(inp.value) : inp.value), set: (v) => (inp.value = v) };
      if (f.default_action && !val) {
        postJson(`/api/tools/${state.tool.id}/action/${f.default_action}`).then((r) => { if (!inp.value) inp.value = r.value || ""; }).catch(() => {});
      }
    } else if (f.type === "textarea") {
      const ta = el("textarea", { rows: f.rows || 4, placeholder: f.placeholder || "" });
      ta.value = val || "";
      ta.addEventListener("change", onchange);
      wrap.append(ta);
      api_ = { get: () => ta.value, set: (v) => (ta.value = v) };
    } else if (f.type === "checkbox") {
      const inp = el("input", { type: "checkbox" });
      inp.checked = !!val;
      inp.addEventListener("change", onchange);
      wrap.innerHTML = "";
      wrap.append(el("label", { class: "chk", style: "margin-top:22px" }, inp, " ", f.label));
      api_ = { get: () => inp.checked, set: (v) => (inp.checked = !!v) };
    } else if (f.type === "select") {
      const sel = el("select");
      const fill = (opts) => {
        const cur = sel.value || val;
        sel.innerHTML = "";
        for (const o of opts) sel.append(el("option", { value: o.value }, o.label));
        if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
      };
      if (f.source && f.source.type === "csv_column") {
        fill([{ value: f.source.all_label || "All", label: f.source.all_label || "All" }]);
      } else fill(optionList(f.options));
      sel.addEventListener("change", onchange);
      wrap.append(sel);
      api_ = {
        get: () => sel.value, set: (v) => (sel.value = v),
        refresh: async () => {
          if (!f.source || f.source.type !== "csv_column") return;
          const src = state.fieldEls[f.source.field];
          const path = src && src.get();
          const all = f.source.all_label || "All";
          if (!path) return fill([{ value: all, label: all }]);
          try {
            const vals = await api(`/api/csv/values?path=${encodeURIComponent(path)}&column=${encodeURIComponent(f.source.column)}`);
            fill([{ value: all, label: all }, ...vals.map((v) => ({ value: v, label: v }))]);
          } catch (e) { toast("Could not read sites: " + e.message, "warning"); }
        },
      };
    } else if (f.type === "file" || f.type === "files") {
      const multiple = f.type === "files";
      let value = multiple ? [] : "";
      const info = el("div", { class: "file-info" }, "No file selected");
      const inp = el("input", { type: "file", accept: f.accept || "", multiple: multiple });
      inp.addEventListener("change", async () => {
        if (!inp.files.length) return;
        const fd = new FormData();
        for (const file of inp.files) fd.append("files", file);
        info.textContent = "Uploading…";
        try {
          const res = await api("/api/upload", { method: "POST", body: fd });
          if (multiple) { value = res; info.innerHTML = `<b>${res.length}</b> file(s) uploaded`; }
          else {
            value = res[0].path;
            let extra = "";
            try { const ci = await api(`/api/csv/info?path=${encodeURIComponent(value)}`); extra = ` — ${ci.row_count} rows, columns: ${ci.columns.join(", ")}`; } catch (e) { extra = " — " + e.message; }
            info.innerHTML = `<b>${esc(res[0].name)}</b>${esc(extra)}`;
          }
          for (const other of state.tool.fields) if (other.source && other.source.field === f.name) state.fieldEls[other.name].refresh();
        } catch (e) { info.textContent = "Upload failed: " + e.message; toast("Upload failed: " + e.message, "error"); }
      });
      wrap.append(inp, info);
      api_ = { get: () => value, set: () => {} };
    } else if (f.type === "path") {
      const inp = el("input", { type: "text", value: val || "", placeholder: f.placeholder || (f.kind === "folder" ? "C:\\path\\to\\folder" : "C:\\path\\to\\file") });
      inp.addEventListener("change", onchange);
      const btn = el("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        btn.disabled = true;
        try {
          const r = await postJson("/api/browse", { kind: f.kind || "file", title: "Select " + (f.label || ""), filetypes: f.filetypes, initial: inp.value || undefined });
          if (r.path) { inp.value = r.path; onchange(); }
        } catch (e) { toast(e.message, "warning"); } finally { btn.disabled = false; }
      } }, "Browse…");
      wrap.append(el("div", { class: "inline" }, inp, btn));
      api_ = { get: () => inp.value, set: (v) => (inp.value = v) };
    } else if (f.type === "checklist") {
      const box = el("div", { class: "checklist" }, el("span", { class: "muted" }, "Loading…"));
      const savedSel = savedForm(state.tool.id)[f.name] || [];
      const load = async () => {
        let opts = [];
        try { opts = await postJson(`/api/tools/${state.tool.id}/action/${f.source.action}`); } catch (e) { box.textContent = e.message; return; }
        box.innerHTML = "";
        if (!opts.length) box.append(el("span", { class: "muted" }, "No saved commands yet – add one below."));
        for (const o of opts) {
          const cb = el("input", { type: "checkbox", value: o.value });
          cb.checked = savedSel.includes(o.value);
          cb.addEventListener("change", onchange);
          const lab = el("label", null, cb, o.label);
          if (f.remove) lab.append(el("span", { class: "rm", title: "Remove from list", onclick: async (e) => {
            e.preventDefault();
            if (!(await confirmDialog("Remove command", `Remove "${o.value}" from the command list?`, true))) return;
            await postJson(`/api/tools/${state.tool.id}/action/${f.remove.action}`, { value: o.value });
            load();
          } }, "✕"));
          box.append(lab);
        }
      };
      load();
      wrap.append(box);
      const tools = el("div", { class: "inline", style: "margin-top:4px" },
        el("button", { type: "button", class: "btn btn-sm", onclick: () => box.querySelectorAll("input").forEach((c) => (c.checked = true)) }, "Select all"),
        el("button", { type: "button", class: "btn btn-sm", onclick: () => box.querySelectorAll("input").forEach((c) => (c.checked = false)) }, "Clear"));
      wrap.append(tools);
      if (f.add) {
        const form = el("div", { class: "addform" });
        const inputs = {};
        for (const af of f.add.fields) {
          let inp;
          if (af.type === "select") { inp = el("select"); for (const o of optionList(af.options)) inp.append(el("option", { value: o.value }, o.label)); inp.value = af.default || ""; }
          else inp = el("input", { type: "text", placeholder: af.label });
          inputs[af.name] = inp;
          form.append(inp);
        }
        form.append(el("button", { type: "button", class: "btn btn-sm btn-primary", onclick: async () => {
          const body = {}; for (const [k, i] of Object.entries(inputs)) body[k] = i.value;
          try { const r = await postJson(`/api/tools/${state.tool.id}/action/${f.add.action}`, body); toast(r.message || "Saved", "success"); Object.values(inputs).forEach((i) => { if (i.tagName === "INPUT") i.value = ""; }); load(); }
          catch (e) { toast(e.message, "error"); }
        } }, f.add.label || "Add"));
        wrap.append(form);
      }
      api_ = { get: () => [...box.querySelectorAll("input:checked")].map((c) => c.value), set: () => {} };
    }
    if (f.help) wrap.append(el("div", { class: "help" }, f.help));
    wrap.dataset.field = f.name;
    state.fieldEls[f.name] = api_;
    return wrap;
  }

  function updateVisibility() {
    if (!state.tool) return;
    for (const f of state.tool.fields) {
      if (!f.show_if) continue;
      const show = Object.entries(f.show_if).every(([k, v]) => String(fieldValue({ name: k }) ?? "") === String(v));
      const w = $(`[data-field="${f.name}"]`);
      if (w) w.hidden = !show;
    }
  }

  function collectParams() {
    const p = {};
    for (const f of state.tool.fields) {
      if (f.show_if && !Object.entries(f.show_if).every(([k, v]) => String(fieldValue({ name: k }) ?? "") === String(v))) continue;
      p[f.name] = fieldValue(f);
    }
    return p;
  }

  // ---------------------------------------------------------------- tool panel
  function renderTool(tool) {
    stopPolling();
    state.tool = tool; state.jobId = null; state.fieldEls = {}; state.lastVersion = -1;
    renderSidebar($("#tool-filter").value);
    $("#welcome").hidden = true;
    const panel = $("#tool-panel");
    panel.hidden = false;
    panel.innerHTML = "";
    panel.append(el("h2", null, tool.name), el("p", { class: "tool-desc" }, tool.description));

    if (tool.client === "calculator") { panel.append(renderCalculator()); return; }

    const grid = el("div", { class: "form-grid" });
    for (const f of tool.fields) grid.append(makeField(f));
    panel.append(grid);
    updateVisibility();

    const actions = el("div", { class: "actions" });
    for (const r of tool.runs) {
      actions.append(el("button", { class: "btn " + (r.danger ? "btn-danger" : "btn-primary"), "data-run": r.id, onclick: () => startRun(r) }, r.label));
    }
    actions.append(el("span", { class: "spacer" }));
    const hist = el("select", { style: "width:auto", title: "Previous runs of this tool" }, el("option", { value: "" }, "Previous runs…"));
    hist.addEventListener("change", () => { if (hist.value) { state.jobId = hist.value; state.lastVersion = -1; startPolling(); } });
    hist.addEventListener("focus", async () => {
      const jobs = await api("/api/jobs?tool=" + tool.id);
      hist.innerHTML = "";
      hist.append(el("option", { value: "" }, "Previous runs…"));
      for (const j of jobs) hist.append(el("option", { value: j.id }, `${j.created}  ${j.run_label}  [${j.status}] ${j.rows} rows`));
      if (state.jobId) hist.value = state.jobId;
    });
    actions.append(hist);
    panel.append(actions);

    panel.append(el("div", { id: "job-area" }));
  }

  async function startRun(runDef) {
    if (runDef.notice) await confirmDialog(runDef.label, runDef.notice, null);
    if (runDef.confirm && !(await confirmDialog(runDef.label, runDef.confirm, true))) return;
    persistForm();
    const params = collectParams();
    try {
      const r = await postJson(`/api/tools/${state.tool.id}/run`, { params, run_id: runDef.id });
      state.jobId = r.job_id; state.lastVersion = -1; state.seenMsg[r.job_id] = 0;
      startPolling();
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------------------------------------------------------------- job polling
  function stopPolling() { if (state.pollTimer) clearTimeout(state.pollTimer); state.pollTimer = null; }
  function startPolling() { stopPolling(); poll(); }

  async function poll() {
    if (!state.jobId) return;
    let job;
    try { job = await api("/api/jobs/" + state.jobId); } catch (e) { toast("Lost job: " + e.message, "error"); return; }
    if (job.version !== state.lastVersion) { renderJob(job); state.lastVersion = job.version; }
    const running = ["queued", "running"].includes(job.status);
    setRunButtons(!running);
    if (running) state.pollTimer = setTimeout(poll, 1000);
  }

  function setRunButtons(enabled) {
    document.querySelectorAll("[data-run]").forEach((b) => (b.disabled = !enabled));
  }

  const OK_RE = /^(success|pass|completed|connected|connected \(arp\)|done|ok)$/i;
  const BAD_RE = /^(fail|failed|error|authentication failed\.?|connection error|connection timeout|stopped by user|disconnected|auth failed|timeout|request error|response error|skipped|http [45]\d\d)/i;
  const RUN_RE = /^(running|pending|pending\.\.\.|connecting|connecting\.\.\.|collecting\.\.\.|running commands\.\.\.|processing|warning|partial|info)/i;

  function cellHtml(col, v) {
    const s = v === null || v === undefined ? "" : String(v);
    const long = s.length > 80 || s.includes("\n");
    let cls = "";
    const statusCol = /status|stage/i.test(col);
    if (statusCol || OK_RE.test(s) || BAD_RE.test(s)) {
      if (OK_RE.test(s)) cls = "cell-ok";
      else if (BAD_RE.test(s) || (statusCol && /^n\/a$/i.test(s))) cls = "cell-bad";
      else if (RUN_RE.test(s)) cls = "cell-run";
    }
    const shown = long ? s.replace(/\s+/g, " ").slice(0, 80) + "…" : s;
    const inner = cls ? `<span class="${cls}">${esc(shown)}</span>` : esc(shown);
    return long ? `${inner}<button class="btn btn-sm view-btn" data-view="1">View</button>` : inner;
  }

  function renderJob(job) {
    const area = $("#job-area");
    if (!area) return;
    // messages -> toasts
    const seen = state.seenMsg[job.id] || 0;
    for (const m of job.messages) if (m.seq > seen) { toast(m.text, m.level === "warning" ? "warning" : m.level === "error" ? "error" : "success"); state.seenMsg[job.id] = m.seq; }

    let bar = $("#jobbar");
    if (!bar) {
      area.innerHTML = "";
      bar = el("div", { class: "jobbar", id: "jobbar" });
      area.append(bar,
        el("div", { class: "artifacts", id: "artifacts" }),
        el("div", { class: "table-tools", id: "table-tools" }),
        el("div", { class: "table-wrap", id: "table-wrap" }),
        el("details", { id: "log-details" }, el("summary", null, "Log"), el("div", { class: "log", id: "log" })));
      $("#table-wrap").addEventListener("click", (e) => {
        const b = e.target.closest("[data-view]");
        if (!b) return;
        const td = b.closest("td"), tr = td.closest("tr");
        const col = td.dataset.col, key = tr.dataset.key;
        const row = (state.lastJob.rows || []).find((r) => r._key === key);
        showModal(`${col} — ${row ? (row["IP Address"] || row["Host"] || row["Hostname"] || row["IP Management"] || row["Checked On (IP)"] || row["Device Switch"] || "") : ""}`, row ? String(row[col] ?? "") : "");
      });
    }
    state.lastJob = job;
    const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : (job.status === "done" ? 100 : 0);
    bar.innerHTML = "";
    bar.append(
      el("span", { class: "badge " + job.status }, job.status.toUpperCase()),
      el("span", { class: "muted" }, `${job.run_label} · ${job.created}`),
      el("div", { class: "progress" }, el("div", { style: `width:${pct}%` })),
      el("span", { class: "muted" }, job.progress.total ? `${job.progress.done}/${job.progress.total} (${pct}%)` : ""),
      el("span", { class: "summary" }, job.summary || ""),
    );
    if (["queued", "running"].includes(job.status)) bar.append(el("button", { class: "btn btn-danger btn-sm", onclick: () => postJson(`/api/jobs/${job.id}/stop`).then(() => toast("Stop requested – running devices finish their current command.", "warning")) }, "Stop"));
    if (job.rows.length) bar.append(el("a", { class: "btn btn-success btn-sm", href: `/api/jobs/${job.id}/export.csv` }, "Export CSV"));
    for (const ja of state.tool.job_actions || []) {
      bar.append(el("button", { class: "btn btn-sm", title: ja.help || "", disabled: ["queued", "running"].includes(job.status), onclick: async (ev) => {
        ev.target.disabled = true;
        try { const r = await postJson(`/api/tools/${state.tool.id}/job-action/${ja.id}`, { job_id: job.id }); toast(r.message || "Done", "success"); if (r.url) window.open(r.url, "_blank"); state.lastVersion = -1; poll(); }
        catch (e) { toast(e.message, "error"); } finally { ev.target.disabled = false; }
      } }, ja.label));
    }
    if (job.run_dir) bar.append(el("span", { class: "muted", title: job.run_dir }, "📁 " + job.run_dir.split(/[\\/]/).slice(-3).join("/")));
    if (job.error) bar.append(el("span", { class: "cell-bad" }, job.error));

    const arts = $("#artifacts");
    arts.innerHTML = "";
    for (const a of job.artifacts) arts.append(el("a", { class: "btn btn-sm", href: `/api/jobs/${job.id}/artifact/${a.index}`, target: "_blank", title: a.path }, "⬇ " + a.name));

    renderTable(job);

    const log = $("#log");
    log.innerHTML = job.logs.map((l) => `<div class="${l.level}">${l.ts} ${l.level} ${esc(l.text)}</div>`).join("");
    log.scrollTop = log.scrollHeight;
  }

  function renderTable(job) {
    const tools = $("#table-tools");
    if (!tools.childElementCount) {
      const filt = el("input", { type: "search", placeholder: "Filter rows…" });
      filt.addEventListener("input", () => applyFilter(filt.value));
      tools.append(filt, el("span", { class: "muted", id: "row-count" }));
    }
    $("#row-count").textContent = `${job.rows.length} row(s)`;
    const wrap = $("#table-wrap");
    const cols = job.columns.length ? job.columns : Object.keys(job.rows[0] || {}).filter((k) => k !== "_key");
    if (!cols.length) { wrap.innerHTML = `<div class="muted" style="padding:10px">No results yet.</div>`; return; }
    let html = "<table><thead><tr>" + cols.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr></thead><tbody>";
    for (const r of job.rows) {
      html += `<tr data-key="${esc(r._key)}">` + cols.map((c) => `<td data-col="${esc(c)}" title="${esc(String(r[c] ?? "").slice(0, 300))}">${cellHtml(c, r[c])}</td>`).join("") + "</tr>";
    }
    wrap.innerHTML = html + "</tbody></table>";
    applyFilter($("#table-tools input").value);
  }

  function applyFilter(text) {
    const f = (text || "").toLowerCase();
    document.querySelectorAll("#table-wrap tbody tr").forEach((tr) => { tr.hidden = f && !tr.textContent.toLowerCase().includes(f); });
  }

  // ---------------------------------------------------------------- calculator
  function renderCalculator() {
    const box = el("div", { class: "calc" });
    const disp = el("input", { type: "text", class: "display", readonly: true, value: "" });
    const keys = el("div", { class: "keys" });
    const add = (t) => { if (disp.value === "Error") disp.value = ""; disp.value += t; };
    for (const t of ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "=", "+"]) {
      keys.append(el("button", { class: "btn", onclick: async () => {
        if (t === "=") { try { const r = await postJson("/api/tools/calculator/action/calculate", { expression: disp.value }); disp.value = r.result; } catch (e) { disp.value = "Error"; } }
        else add(t);
      } }, t));
    }
    keys.append(el("button", { class: "btn", onclick: () => (disp.value = disp.value.slice(0, -1)) }, "⌫"),
      el("button", { class: "btn", onclick: () => add("(") }, "("), el("button", { class: "btn", onclick: () => add(")") }, ")"),
      el("button", { class: "btn btn-danger", onclick: () => (disp.value = "") }, "C"));
    box.append(disp, keys);
    return box;
  }

  // ---------------------------------------------------------------- routing / boot
  function route() {
    const id = location.hash.replace(/^#/, "");
    const t = state.tools.find((x) => x.id === id);
    if (t) renderTool(t);
    else { stopPolling(); state.tool = null; $("#tool-panel").hidden = true; $("#welcome").hidden = false; renderSidebar($("#tool-filter").value); }
  }
  window.addEventListener("hashchange", route);

  async function boot() {
    try {
      state.meta = await api("/api/meta");
      state.tools = await api("/api/tools");
    } catch (e) { toast("Cannot reach the server: " + e.message, "error"); return; }
    $("#version").textContent = "v" + state.meta.version;
    $("#hostname").textContent = state.meta.hostname;
    $("#logs-dir").textContent = state.meta.settings.logs_dir;
    $("#exports-dir").textContent = state.meta.settings.exports_dir;
    const errs = Object.entries(state.meta.load_errors || {});
    if (errs.length) $("#load-errors").innerHTML = `<p class="cell-bad">Some tools failed to load:</p><pre class="log">${errs.map(([k, v]) => esc(k + ": " + v.split("\n")[0])).join("\n")}</pre>`;
    renderSidebar();
    route();
  }
  boot();
})();
