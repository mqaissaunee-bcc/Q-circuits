/**
 * Application wiring.
 *
 * Everything that mutates the schematic goes through the store, and every
 * panel redraws from `refresh()`. That keeps the netlist, the parts table and
 * the validation messages from ever disagreeing with what is on the sheet.
 */

import { PARTS, PALETTE, pinsOf, netlistNameOf } from "./parts.js";
import { buildNodes, buildNetlist, nodesFor, validate, formatEng } from "./netlist.js";
import { Store, DEFAULT_ANALYSIS } from "./store.js";
import { createCanvas } from "./canvas.js";
import { createScope } from "./scope.js";
import { runNetlist, engineReady } from "./engine.js";
import { LABS, labById, runChecks } from "./labs.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const say = (m) => { statusEl.textContent = m; };

const store = new Store();

const canvas = createCanvas({
  host: $("sheetHost"),
  store,
  onStatus: say,
  onSelectionChange: () => { renderInspector(); renderPartsTable(lastNet()); }
});

const scope = createScope({ host: $("scopeHost"), onStatus: say });

let currentLab = null;
let lastResult = null;
let running = false;

/* ------------------------------------------------------------- palette */

const partTools = $("partTools");
PALETTE.forEach((key) => {
  const def = PARTS[key];
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.tool = key;
  b.setAttribute("aria-pressed", "false");
  b.title = def.name;
  b.textContent = shortName(def);
  partTools.appendChild(b);
});

function shortName(def) {
  const map = {
    Resistor: "R", Capacitor: "C", Inductor: "L",
    "Voltage source": "V", "Current source": "I", Diode: "D",
    Switch: "SW", Ammeter: "Ammeter", Ground: "GND",
    "NPN transistor": "NPN", "PNP transistor": "PNP",
    "N-channel MOSFET": "NMOS", "P-channel MOSFET": "PMOS",
    "Op-amp (ideal)": "Op-amp"
  };
  return map[def.name] || def.name;
}

function setTool(tool) {
  canvas.setTool(tool);
  document.querySelectorAll("#modeTools button, #partTools button").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.tool === tool ? "true" : "false");
  });
}

document.querySelectorAll("#modeTools, #partTools").forEach((group) => {
  group.addEventListener("click", (evt) => {
    const b = evt.target.closest("button[data-tool]");
    if (!b) return;
    setTool(b.dataset.tool);
    say(`${b.title || b.textContent} tool active.`);
  });
});

/* --------------------------------------------------------- edit actions */

$("btnUndo").addEventListener("click", () => { if (store.undo()) say("Undone."); });
$("btnRedo").addEventListener("click", () => { if (store.redo()) say("Redone."); });
$("btnDelete").addEventListener("click", () => {
  const n = store.deleteSelection();
  say(n ? `${n} item${n === 1 ? "" : "s"} deleted.` : "Nothing selected.");
});
$("btnRotate").addEventListener("click", () => {
  if (store.selection.size) { store.rotateSelection(); say("Rotated."); }
  else say(`Placement angle is now ${canvas.rotateGhost()} degrees.`);
});
$("btnZoomIn").addEventListener("click", () => canvas.zoomIn());
$("btnZoomOut").addEventListener("click", () => canvas.zoomOut());
$("btnFit").addEventListener("click", () => { canvas.fit(); say("View fitted to the circuit."); });

/* ------------------------------------------------------------- keyboard */

const TOOL_KEYS = {
  s: "select", w: "wire", b: "probe", r: "R", c: "C", l: "L",
  v: "V", i: "I", d: "D", g: "GND", q: "NPN", m: "NMOS", u: "OPAMP",
  a: "AM"
};

document.addEventListener("keydown", (evt) => {
  const tag = (evt.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select";
  const mod = evt.ctrlKey || evt.metaKey;

  if (typing && !mod) {
    if (evt.key === "Escape") evt.target.blur();
    return;
  }

  if (mod) {
    const k = evt.key.toLowerCase();
    if (k === "z" && !evt.shiftKey) { evt.preventDefault(); if (store.undo()) say("Undone."); return; }
    if ((k === "z" && evt.shiftKey) || k === "y") { evt.preventDefault(); if (store.redo()) say("Redone."); return; }
    if (typing) return;
    if (k === "c") { evt.preventDefault(); const n = store.copySelection(); say(n ? `${n} item${n === 1 ? "" : "s"} copied.` : "Nothing to copy."); return; }
    if (k === "x") { evt.preventDefault(); const n = store.cutSelection(); say(n ? `${n} item${n === 1 ? "" : "s"} cut.` : "Nothing to cut."); return; }
    if (k === "v") { evt.preventDefault(); const n = store.paste(); say(n ? `${n} item${n === 1 ? "" : "s"} pasted.` : "Clipboard is empty."); return; }
    if (k === "a") {
      evt.preventDefault();
      store.selection = new Set([...store.state.comps.map((c) => c.id), ...store.state.wires.map((w) => w.id)]);
      refresh(); say(`${store.selection.size} items selected.`);
      return;
    }
    return;
  }

  if (typing) return;
  const key = evt.key.toLowerCase();

  if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); say(`${key.toUpperCase()} tool active.`); return; }
  if (key === "o") { $("btnRotate").click(); return; }
  if (evt.key === "Escape") { canvas.cancel(); store.selection.clear(); setTool("select"); refresh(); say("Back to select."); return; }
  if (evt.key === "Delete" || evt.key === "Backspace") { evt.preventDefault(); $("btnDelete").click(); return; }
  if (evt.key.startsWith("Arrow") && store.selection.size) {
    evt.preventDefault();
    const d = 20;
    const map = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
    const [dx, dy] = map[evt.key];
    store.moveSelection(dx, dy);
    say("Selection moved.");
  }
});

/* ------------------------------------------------------------ inspector */

function renderInspector() {
  const host = $("inspector");
  host.replaceChildren();
  const comps = store.selectedComps();

  if (!comps.length) {
    host.appendChild(muted("Nothing selected. Click a part on the sheet, or pick one from the parts table."));
    return;
  }
  if (comps.length > 1) {
    host.appendChild(muted(`${comps.length} parts selected. Rotate, move, copy and delete apply to all of them.`));
    return;
  }

  const c = comps[0];
  const def = PARTS[c.type];

  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = def.name;
  host.appendChild(heading);

  if (!def.noLabel) {
    host.appendChild(field("Reference designator", "text", c.label, (v) => {
      store.edit(() => { c.label = v; }, "label");
    }));
  }

  def.fields.forEach((f) => {
    if (f.options) {
      host.appendChild(select(f.label, f.options, c[f.k], f.labels, (v) => {
        store.edit(() => { c[f.k] = v; }, "field");
      }, f.hint));
    } else {
      host.appendChild(field(f.label, "text", c[f.k] ?? "", (v) => {
        store.edit(() => { c[f.k] = v; }, "field");
      }, f.hint));
    }
  });

  const pins = pinsOf(c);
  const net = lastNet();
  if (net) {
    const nodes = nodesFor(c, net);
    const p = document.createElement("p");
    p.className = "field-hint";
    p.textContent = def.pinNames.map((n, i) => `${n} → node ${nodes[i] ?? "?"}`).join(" · ");
    host.appendChild(p);
  }
  void pins;
}

function muted(text) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  return p;
}

let fieldSeq = 0;
function field(label, type, value, onInput, hint) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const id = `f${++fieldSeq}`;
  const l = document.createElement("label");
  l.htmlFor = id; l.textContent = label;
  const input = document.createElement("input");
  input.type = type; input.id = id; input.value = value ?? "";
  input.autocomplete = "off"; input.spellcheck = false;
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => onInput(input.value), 180);
  });
  wrap.append(l, input);
  if (hint) {
    const h = document.createElement("p");
    h.className = "field-hint"; h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function select(label, options, value, labels, onChange, hint) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const id = `f${++fieldSeq}`;
  const l = document.createElement("label");
  l.htmlFor = id; l.textContent = label;
  const sel = document.createElement("select");
  sel.id = id;
  options.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = labels?.[o] || o;
    if (String(value) === o) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.append(l, sel);
  if (hint) {
    const h = document.createElement("p");
    h.className = "field-hint"; h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

/* ---------------------------------------------------------- parts table */

function renderPartsTable(net) {
  const body = $("partsBody");
  body.replaceChildren();
  const parts = store.state.comps.filter((c) => c.type !== "GND");

  if (!parts.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5; td.textContent = "Nothing on the sheet yet.";
    tr.appendChild(td); body.appendChild(tr);
    return;
  }

  parts.forEach((c) => {
    const def = PARTS[c.type];
    const tr = document.createElement("tr");
    if (store.selection.has(c.id)) tr.className = "is-selected";

    const th = document.createElement("th");
    th.scope = "row"; th.textContent = c.label;
    tr.appendChild(th);

    tr.appendChild(cell(def.name));

    const nodes = net ? nodesFor(c, net) : [];
    tr.appendChild(cell(def.pinNames.map((n, i) => `${n}:${nodes[i] ?? "?"}`).join("  "), "nodes"));

    const settings = def.fields
      .map((f) => (String(c[f.k] ?? "").trim() ? `${f.label.replace(/ \(.*\)$/, "")}: ${f.labels?.[c[f.k]] || c[f.k]}` : null))
      .filter(Boolean).join(", ");
    tr.appendChild(cell(settings || "—"));

    const td = document.createElement("td");
    const b = document.createElement("button");
    b.type = "button"; b.textContent = "Select";
    b.setAttribute("aria-label", `Select ${c.label}`);
    b.addEventListener("click", () => {
      store.selection = new Set([c.id]);
      setTool("select");
      refresh();
      say(`${c.label} selected.`);
    });
    td.appendChild(b);
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

function cell(text, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

/* ------------------------------------------------------------- analysis */

const ANA_FIELDS = ["dcSrc", "dcStart", "dcStop", "dcStep", "trStep", "trStop", "acPts", "acStart", "acStop"];

function syncAnalysisInputs() {
  const a = store.state.analysis;
  $("anaType").value = a.type;
  ANA_FIELDS.forEach((k) => { $(k).value = a[k] ?? ""; });
  $("trUic").checked = !!a.trUic;
  $("fieldsDC").hidden = a.type !== "dc";
  $("fieldsTran").hidden = a.type !== "tran";
  $("fieldsAC").hidden = a.type !== "ac";
}

$("anaType").addEventListener("change", () => {
  store.edit((s) => { s.analysis.type = $("anaType").value; }, "analysis");
  syncAnalysisInputs();
});
ANA_FIELDS.forEach((k) => {
  $(k).addEventListener("input", () => {
    store.state.analysis[k] = $(k).value;
    store.save();
    refresh();
  });
});
$("trUic").addEventListener("change", () => {
  store.state.analysis.trUic = $("trUic").checked;
  store.save();
  refresh();
});

/* ------------------------------------------------------------------ run */

async function run() {
  if (running) return;
  running = true;
  const btn = $("btnRun");
  btn.disabled = true;
  $("runError").replaceChildren();
  const note = $("engineNote");

  const progress = (m) => { note.textContent = m; say(m); };

  try {
    const { text } = buildNetlist(store.state.comps, store.state.wires, store.state.analysis, store.state.title);
    const result = await runNetlist(text, progress);
    lastResult = result;
    applyResult(result);
    note.textContent = `${result.numPoints} point${result.numPoints === 1 ? "" : "s"} · ${result.traces.length} vector${result.traces.length === 1 ? "" : "s"}.`;
    say(`Simulation finished with ${result.numPoints} points.`);
  } catch (e) {
    showRunError(e.message || String(e));
    note.textContent = engineReady() ? "Engine loaded." : "The engine did not load.";
    say("The simulation failed. See the message under the Run button.");
  } finally {
    running = false;
    btn.disabled = false;
  }
}

function applyResult(result) {
  const filtered = filterToProbes(result);
  scope.setResult(filtered);
  $("btnCsv").disabled = false;

  const modes = $("acModes");
  modes.hidden = filtered.kind !== "complex";
  if (!modes.hidden) setAcMode(scope.getMode());

  renderOpResults(result);
}

/** When probes are placed, show only what was probed. */
function filterToProbes(result) {
  const probes = store.state.probes;
  if (!probes.length) return result;
  const net = buildNodes(store.state.comps, store.state.wires);
  const wanted = new Set();
  probes.forEach((p) => {
    if (p.kind === "v") {
      const nd = net.coordNode.get(`${p.x},${p.y}`);
      if (nd !== undefined) wanted.add(`v(${nd})`);
    } else {
      wanted.add(`i(${p.ref.toLowerCase()})`);
    }
  });
  const traces = result.traces.filter((t) => wanted.has(t.name.toLowerCase()));
  return traces.length ? { ...result, traces } : result;
}

function renderOpResults(result) {
  const host = $("opResults");
  host.replaceChildren();
  if (result.sweep) return;

  const table = document.createElement("table");
  table.className = "result-table";
  const head = document.createElement("thead");
  head.innerHTML = "";
  const hr = document.createElement("tr");
  ["Vector", "Value"].forEach((t) => {
    const th = document.createElement("th");
    th.scope = "col"; th.textContent = t;
    hr.appendChild(th);
  });
  head.appendChild(hr);
  table.appendChild(head);

  const body = document.createElement("tbody");
  result.traces.forEach((t) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row"; th.textContent = t.name;
    const td = document.createElement("td");
    const v = t.values[t.values.length - 1];
    td.textContent = `${formatEng(v, 5)} ${t.type === "current" ? "A" : "V"}`;
    tr.append(th, td);
    body.appendChild(tr);
  });
  table.appendChild(body);
  host.appendChild(table);
}

function showRunError(message) {
  const host = $("runError");
  host.replaceChildren();
  const ul = document.createElement("ul");
  ul.className = "msg-list";
  const li = document.createElement("li");
  li.className = "error";
  li.textContent = message;
  ul.appendChild(li);
  host.appendChild(ul);
}

$("btnRun").addEventListener("click", run);

/* ---------------------------------------------------------- scope modes */

function setAcMode(mode) {
  document.querySelectorAll("#acModes button").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.mode === mode ? "true" : "false");
  });
}
$("acModes").addEventListener("click", (evt) => {
  const b = evt.target.closest("button[data-mode]");
  if (!b) return;
  scope.setMode(b.dataset.mode);
  setAcMode(b.dataset.mode);
  say(`Plot showing ${b.textContent}.`);
});

$("btnCsv").addEventListener("click", () => {
  const csv = scope.toCSV();
  if (!csv) { say("Nothing to export yet."); return; }
  download(`${slug(store.state.title)}.csv`, csv, "text/csv");
  say("Waveform data exported as CSV.");
});

/* ----------------------------------------------------------------- labs */

const labSelect = $("labSelect");
LABS.forEach((l) => {
  const o = document.createElement("option");
  o.value = l.id; o.textContent = l.title;
  labSelect.appendChild(o);
});

labSelect.addEventListener("change", () => {
  const lab = labById(labSelect.value);
  currentLab = lab;
  $("checkResults").replaceChildren();

  if (!lab) {
    $("labSummary").textContent = "";
    $("labTasks").replaceChildren();
    $("btnCheck").disabled = true;
    say("Free build mode.");
    return;
  }

  store.loadCircuit(lab.circuit);
  syncAnalysisInputs();
  canvas.fit();
  $("labSummary").textContent = lab.summary;
  const ol = $("labTasks");
  ol.replaceChildren();
  lab.tasks.forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    ol.appendChild(li);
  });
  $("btnCheck").disabled = false;
  say(`${lab.title} loaded.`);
});

$("btnCheck").addEventListener("click", async () => {
  if (!currentLab || running) return;
  running = true;
  const btn = $("btnCheck");
  btn.disabled = true;
  const host = $("checkResults");
  host.replaceChildren();

  const note = $("engineNote");
  const outcome = await runChecks(currentLab, store, (m) => { note.textContent = m; say(m); });

  running = false;
  btn.disabled = false;

  if (outcome.error) {
    const ul = document.createElement("ul");
    ul.className = "msg-list";
    const li = document.createElement("li");
    li.className = "error";
    li.textContent = outcome.error;
    ul.appendChild(li);
    host.appendChild(ul);
    say("The check could not run because the simulation failed.");
    return;
  }

  if (outcome.result) {
    lastResult = outcome.result;
    applyResult(outcome.result);
  }

  const ul = document.createElement("ul");
  ul.className = "check-list";
  outcome.results.forEach((r) => {
    const li = document.createElement("li");
    li.className = r.pass ? "pass" : "fail";
    const mark = document.createElement("span");
    mark.className = "check-mark";
    mark.textContent = r.pass ? "✓" : "✗";
    const text = document.createElement("span");
    text.textContent = r.label;
    if (r.detail) {
      const d = document.createElement("span");
      d.className = "check-detail";
      d.textContent = r.detail;
      text.appendChild(d);
    }
    li.append(mark, text);
    ul.appendChild(li);
  });
  host.appendChild(ul);

  const passed = outcome.results.filter((r) => r.pass).length;
  say(`${passed} of ${outcome.results.length} checks passed.`);
});

/* ------------------------------------------------------------- file I/O */

function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => (s || "circuit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "circuit";

$("btnNew").addEventListener("click", () => {
  if (store.state.comps.length && !confirm("Start a new sheet? The current circuit is cleared.")) return;
  store.clear();
  labSelect.value = "";
  labSelect.dispatchEvent(new Event("change"));
  say("New sheet.");
});

$("btnSave").addEventListener("click", () => {
  download(`${slug(store.state.title)}.json`, store.toDocument());
  say("Circuit saved.");
});

$("btnOpen").addEventListener("click", () => $("fileInput").click());

$("fileInput").addEventListener("change", async (evt) => {
  const file = evt.target.files?.[0];
  if (!file) return;
  try {
    store.loadDocument(await file.text());
    syncAnalysisInputs();
    canvas.fit();
    labSelect.value = "";
    currentLab = null;
    $("labTasks").replaceChildren();
    $("labSummary").textContent = "";
    $("btnCheck").disabled = true;
    say(`${file.name} opened.`);
  } catch (e) {
    showRunError(e.message);
    say("That file could not be opened.");
  }
  evt.target.value = "";
});

$("btnCir").addEventListener("click", () => {
  download(`${slug(store.state.title)}.cir`, $("netOut").value, "text/plain");
  say("Netlist downloaded.");
});

$("btnCopyNet").addEventListener("click", async () => {
  const text = $("netOut").value;
  try {
    await navigator.clipboard.writeText(text);
    say("Netlist copied.");
  } catch {
    $("netOut").select();
    say("Copy was blocked. The netlist is selected — press Ctrl or Command C.");
  }
});

$("docTitle").addEventListener("input", () => {
  store.state.title = $("docTitle").value;
  store.save();
});

/* -------------------------------------------------------------- refresh */

let cachedNet = null;
const lastNet = () => cachedNet;

function refresh() {
  const { text, net } = buildNetlist(store.state.comps, store.state.wires, store.state.analysis, store.state.title);
  cachedNet = net;

  $("netOut").value = text;
  if ($("docTitle").value !== store.state.title) $("docTitle").value = store.state.title;

  canvas.render();
  renderInspector();
  renderPartsTable(net);
  renderChecks(validate(store.state.comps, store.state.wires, net, store.state.analysis));

  $("btnUndo").disabled = !store.canUndo();
  $("btnRedo").disabled = !store.canRedo();
}

function renderChecks(msgs) {
  const host = $("checks");
  host.replaceChildren();
  const ul = document.createElement("ul");
  ul.className = "msg-list";
  msgs.forEach((m) => {
    const li = document.createElement("li");
    li.className = m.level;
    li.textContent = m.text;
    ul.appendChild(li);
  });
  host.appendChild(ul);
}

store.subscribe(() => refresh());

/* ----------------------------------------------------------------- boot */

if (!store.restore() || !store.state.comps.length) {
  store.state.analysis = { ...DEFAULT_ANALYSIS };
  store.loadCircuit(LABS[0].circuit);
  labSelect.value = LABS[0].id;
  labSelect.dispatchEvent(new Event("change"));
}
syncAnalysisInputs();
$("docTitle").value = store.state.title;
refresh();
canvas.fit();
setTool("select");

// exposed for the end-to-end tests
window.__spiceLab = { store, canvas, scope, run, refresh, getResult: () => lastResult };
