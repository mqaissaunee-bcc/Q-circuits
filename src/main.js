/**
 * Application wiring.
 *
 * Everything that mutates the schematic goes through the store, and every
 * panel redraws from `refresh()`. That keeps the netlist, the parts table and
 * the validation messages from ever disagreeing with what is on the sheet.
 */

import { PARTS, PALETTE, pinsOf, netlistNameOf } from "./parts.js";
import { buildNodes, nodesFor, validate, formatEng, paramValues } from "./netlist.js";
import { Store, DEFAULT_ANALYSIS } from "./store.js";
import { createCanvas } from "./canvas.js";
import { createScope } from "./scope.js";
import { runNetlist, engineReady } from "./engine.js";
import { LABS, LAB_GROUPS, LAB_KINDS, labById, runChecks, corners } from "./labs.js";
import { simulate, probedTraces, previewNetlist } from "./simulate.js";
import { explainEngineError } from "./errors.js";
import { shareUrl, decodeCircuit, clearHash } from "./share.js";
import { exportSvg, exportCanvas } from "./export-png.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const say = (m) => { statusEl.textContent = m; };

const store = new Store();

const canvas = createCanvas({
  host: $("sheetHost"),
  store,
  onStatus: say,
  onSelectionChange: () => { renderInspector(); renderPartsTable(lastNet()); },
  // Parts whose only settings are dropdowns cannot be edited in a text box,
  // so send those to the inspector rather than opening a field that lies.
  onNeedsInspector: (comp) => {
    store.selection = new Set([comp.id]);
    refresh();
    const first = $("inspector").querySelector("select, input");
    if (first) first.focus();
    say(`${comp.label} has no free-text value. Use the Selected part panel.`);
  }
});

const scope = createScope({ host: $("scopeHost"), measureHost: $("measureHost"), onStatus: say });

let currentLab = null;
let lastResult = null;
let running = false;

/**
 * Anything that replaces the whole sheet asks first when there is unsaved work.
 * Opening a lab used to wipe a student's circuit outright.
 */
function confirmReplace(what) {
  if (!store.isDirty()) return true;
  const name = store.state.title || "this circuit";
  return confirm(`${name} has changes you have not saved.\n\n${what} will replace it. Save it under My circuits first if you want to keep it.\n\nReplace anyway?`);
}

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
    "Op-amp": "Op-amp", "LM324 op-amp": "LM324",
    "Net alias": "Net alias", "Power symbol": "Power", Parameter: "Param"
  };
  return map[def.name] || def.name;
}

function setTool(tool) {
  canvas.setTool(tool);
  document.querySelectorAll("#modeTools button, #viewTools button, #partTools button").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.tool === tool ? "true" : "false");
  });
}

document.querySelectorAll("#modeTools, #viewTools, #partTools").forEach((group) => {
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
const VIEW_LOCK_KEY = "q-circuits-viewlock-v1";

function setViewLock(locked, announce = true) {
  canvas.setViewLocked(locked);
  const btn = $("btnLockView");
  btn.setAttribute("aria-pressed", locked ? "true" : "false");
  btn.title = locked
    ? "The sheet ignores pinch-zoom and middle-drag. The zoom buttons still work."
    : "Stop the sheet responding to pinch-zoom and middle-drag";
  try { localStorage.setItem(VIEW_LOCK_KEY, locked ? "1" : "0"); } catch { /* storage blocked */ }
  if (announce) {
    say(locked
      ? "View locked. Pinch and middle-drag are ignored; the zoom buttons still work."
      : "View unlocked.");
  }
}

$("btnLockView").addEventListener("click", () => setViewLock(!canvas.isViewLocked()));

$("btnZoomIn").addEventListener("click", () => canvas.zoomIn());
$("btnZoomOut").addEventListener("click", () => canvas.zoomOut());
$("btnFit").addEventListener("click", () => { canvas.fit(); say("View fitted to the circuit."); });

/* ------------------------------------------------------- shortcuts help */

const helpDialog = $("helpDialog");
function openHelp() {
  if (typeof helpDialog.showModal === "function") helpDialog.showModal();
  else helpDialog.setAttribute("open", "");
  say("Keyboard shortcuts opened.");
}
function closeHelp() {
  if (typeof helpDialog.close === "function") helpDialog.close();
  else helpDialog.removeAttribute("open");
}
$("btnHelp").addEventListener("click", openHelp);
$("btnHelpClose").addEventListener("click", closeHelp);
helpDialog.addEventListener("click", (evt) => { if (evt.target === helpDialog) closeHelp(); });

/* ------------------------------------------------------------- keyboard */

const TOOL_KEYS = {
  s: "select", w: "wire", b: "probe", r: "R", c: "C", n: "L",
  v: "V", i: "I", d: "D", g: "GND", q: "NPN", m: "NMOS", u: "OPAMP",
  a: "AM", h: "pan", z: "zoomrect", t: "text",
  k: "NET", p: "PWR", x: "vdiff"
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

  if (evt.key === "?" || (key === "/" && evt.shiftKey)) { evt.preventDefault(); openHelp(); return; }
  if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); say(`${key.toUpperCase()} tool active.`); return; }
  if (key === "o") { $("btnRotate").click(); return; }
  if (key === "l" && !evt.shiftKey) { $("btnLockView").click(); return; }
  if (evt.key === "Escape") {
    canvas.clearCaret();
    canvas.cancel();
    store.selection.clear();
    setTool("select");
    refresh();
    say("Back to select.");
    return;
  }

  // A placing tool owns Enter and the arrow keys, so a part can be positioned
  // and dropped without touching the mouse.
  if (canvas.isPlacing()) {
    if (evt.key === "Enter") {
      evt.preventDefault();
      canvas.commitCaret();
      return;
    }
    if (evt.key.startsWith("Arrow")) {
      evt.preventDefault();
      const step = evt.shiftKey ? 100 : 20;
      const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const [dx, dy] = deltas[evt.key];
      const at = canvas.moveCaret(dx, dy);
      say(`Placement cursor at ${at.x}, ${at.y}. Press Enter to place.`);
      return;
    }
  }
  if (evt.key === "Delete" || evt.key === "Backspace") { evt.preventDefault(); $("btnDelete").click(); return; }
  if (evt.key.startsWith("Arrow") && store.selection.size) {
    evt.preventDefault();
    const d = evt.shiftKey ? 100 : 20;
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

const ANA_FIELDS = ["dcSrc", "dcStart", "dcStop", "dcStep", "trStep", "trStop", "acPts", "acStart", "acStop",
  "paramName", "paramStart", "paramStop", "paramStep", "paramList"];

function syncAnalysisInputs() {
  const a = store.state.analysis;
  $("anaType").value = a.type;
  ANA_FIELDS.forEach((k) => { $(k).value = a[k] ?? ""; });
  $("trUic").checked = !!a.trUic;
  $("fieldsDC").hidden = a.type !== "dc";
  $("fieldsTran").hidden = a.type !== "tran";
  $("fieldsAC").hidden = a.type !== "ac";
  $("paramOn").checked = !!a.paramOn;
  $("paramMode").value = a.paramMode || "lin";
  $("fieldsParam").hidden = !a.paramOn;
  $("paramLin").hidden = a.paramMode === "list";
  $("paramListWrap").hidden = a.paramMode !== "list";
}

$("paramOn").addEventListener("change", () => {
  store.edit((s) => { s.analysis.paramOn = $("paramOn").checked; }, "analysis");
  syncAnalysisInputs();
});
$("paramMode").addEventListener("change", () => {
  store.edit((s) => { s.analysis.paramMode = $("paramMode").value; }, "analysis");
  syncAnalysisInputs();
});

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
    const result = await simulate(store.state, progress);
    lastResult = result;
    applyResult(result);
    const runs = result.steps ? ` · ${result.steps.length} parametric runs` : "";
    note.textContent = `${result.numPoints} point${result.numPoints === 1 ? "" : "s"} · ${result.traces.length} vector${result.traces.length === 1 ? "" : "s"}${runs}.`;
    say(`Simulation finished with ${result.numPoints} points.`);
  } catch (e) {
    showRunError(e.message || String(e), $("netOut").value);
    note.textContent = engineReady() ? "Engine loaded." : "The engine did not load.";
    say("The simulation did not finish. There is an explanation under the Run button.");
  } finally {
    running = false;
    btn.disabled = false;
  }
}

function applyResult(result) {
  const filtered = probedTraces(result, store.state);
  scope.setResult(filtered);
  $("btnCsv").disabled = false;
  $("btnPngPlot").disabled = false;

  const modes = $("acModes");
  modes.hidden = filtered.kind !== "complex";
  if (!modes.hidden) setAcMode(scope.getMode());

  renderOpResults(result);
  updateBias(result);
}

/** Hand operating-point voltages to the sheet, for Show DC voltages. */
function updateBias(result) {
  if (!result || result.sweep) { canvas.setBias(null); syncBiasButton(); return; }
  const values = new Map();
  result.traces.forEach((t) => {
    if (result.steps && t.step !== 0) return;
    const m = String(t.name).split(" \u00B7 ")[0].match(/^v\(([^,()]+)\)$/i);
    if (m) values.set(m[1].toLowerCase(), t.values[t.values.length - 1]);
  });
  canvas.setBias(values);
  syncBiasButton();
}

function syncBiasButton() {
  const on = !!store.state.showBias;
  const b = $("btnBias");
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.textContent = on ? "Hide DC voltages" : "Show DC voltages";
}

$("btnBias").addEventListener("click", () => {
  const on = !store.state.showBias;
  store.edit((s) => { s.showBias = on; }, "bias");
  syncBiasButton();
  if (on && !canvas.hasBias()) {
    say(store.state.analysis.type === "op"
      ? "Voltages will appear once you run the operating point."
      : "Node voltages come from an operating-point run. Set the analysis to Operating point and run it.");
  } else {
    say(on ? "Node voltages shown on the sheet." : "Node voltages hidden.");
  }
});

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

function showRunError(message, netlist) {
  const host = $("runError");
  host.replaceChildren();

  const info = explainEngineError(message, netlist);
  const box = document.createElement("div");
  box.className = "engine-error";
  box.setAttribute("role", "alert");

  const h = document.createElement("h3");
  h.textContent = info.title;
  box.appendChild(h);

  const fix = document.createElement("p");
  fix.textContent = info.fix;
  box.appendChild(fix);

  if (info.line) {
    const p = document.createElement("p");
    p.textContent = `Netlist line ${info.line.number}:`;
    box.appendChild(p);
    const pre = document.createElement("div");
    pre.className = "culprit";
    pre.textContent = info.line.text;
    box.appendChild(pre);
  }

  if (info.raw) {
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Show what ngspice said";
    const pre = document.createElement("pre");
    pre.textContent = info.raw;
    det.append(sum, pre);
    box.appendChild(det);
  }

  host.appendChild(box);
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

$("btnPngSheet").addEventListener("click", async () => {
  try {
    await exportSvg(canvas.svg, `${slug(store.state.title)}-schematic.png`, canvas.contentBox());
    say("Schematic exported as a PNG.");
  } catch (e) {
    say(`The schematic could not be exported: ${e.message}`);
  }
});

$("btnPngPlot").addEventListener("click", async () => {
  const plot = document.querySelector(".scope-canvas");
  if (!plot) { say("There is no plot to export yet."); return; }
  try {
    await exportCanvas(plot, `${slug(store.state.title)}-waveforms.png`);
    say("Waveform plot exported as a PNG.");
  } catch (e) {
    say(`The plot could not be exported: ${e.message}`);
  }
});

$("btnCsv").addEventListener("click", () => {
  const csv = scope.toCSV();
  if (!csv) { say("Nothing to export yet."); return; }
  download(`${slug(store.state.title)}.csv`, csv, "text/csv");
  say("Waveform data exported as CSV.");
});

/* ----------------------------------------------------------------- labs */

const labSelect = $("labSelect");

/** Rebuild the lab list, grouped, ticking the ones already passed. */
function renderLabList() {
  const keep = currentLab ? currentLab.id : "";
  labSelect.replaceChildren();
  const free = document.createElement("option");
  free.value = ""; free.textContent = "Free build";
  labSelect.appendChild(free);

  let passed = 0;
  LAB_GROUPS.forEach((g) => {
    const labs = LABS.filter((l) => l.group === g.id);
    if (!labs.length) return;
    const og = document.createElement("optgroup");
    og.label = g.title;
    labs.forEach((l) => {
      const done = store.labPassed(l.id);
      if (done) passed++;
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = done ? `${l.title}  \u2713` : l.title;
      og.appendChild(o);
    });
    labSelect.appendChild(og);
  });
  labSelect.value = keep;

  const tally = $("labTally");
  tally.textContent = passed ? `${passed} of ${LABS.length} passed` : "";
}
renderLabList();

/**
 * Put a lab on the sheet: the student's own saved attempt if there is one,
 * otherwise the starting circuit, offering to carry an earlier lab forward.
 */
function openLab(lab) {
  if (store.openLabWork(lab.id)) {
    say(`${lab.title}: your work so far is back on the sheet.`);
    return;
  }
  const from = lab.carryFrom && store.labWorkDoc(lab.carryFrom);
  const fromLab = lab.carryFrom && labById(lab.carryFrom);
  if (from && confirm(`Start ${lab.title} from your ${fromLab.title.split(" · ")[0]} circuit?\n\nOK copies that circuit and its analysis settings onto this lab's sheet. Cancel starts blank.`)) {
    store.loadCircuit({
      ...from,
      comps: from.comps.map(({ id, ...rest }) => rest),
      wires: (from.wires || []).map(({ id, ...rest }) => rest),
      notes: [],
      probes: []
    });
    say(`${lab.title}: started from your ${fromLab.title.split(" · ")[0]} circuit. Probes were not copied.`);
    return;
  }
  store.loadCircuit(lab.circuit);
  say(`${lab.title} loaded.`);
}

function setLab(lab) {
  currentLab = lab;
  store.currentLabId = lab ? lab.id : "";
  $("checkResults").replaceChildren();
  if (!lab) { clearLabPanel(); return; }
  renderLabPanel(lab);
}

labSelect.addEventListener("change", () => {
  const lab = labById(labSelect.value);

  // Work in a lab is kept for that lab, so only free-build work needs a warning.
  if (currentLab) store.saveLabWork(currentLab.id);
  else if (lab && !confirmReplace(`Opening the ${lab.title} lab`)) {
    labSelect.value = "";
    return;
  }

  if (!lab) {
    setLab(null);
    say("Free build mode. Your lab work is kept; pick the lab again to return to it.");
    return;
  }

  openLab(lab);
  syncAnalysisInputs();
  syncBiasButton();
  canvas.setBias(null);
  canvas.fit();
  setLab(lab);
});

$("btnLabReset").addEventListener("click", () => {
  if (!currentLab) return;
  if (!confirm(`Start ${currentLab.title} over?\n\nYour work on this lab is replaced by the starting circuit. Your pass mark, if you have one, is kept.`)) return;
  store.forgetLabWork(currentLab.id);
  openLab(currentLab);
  store.saveLabWork(currentLab.id);
  syncAnalysisInputs();
  syncBiasButton();
  canvas.setBias(null);
  canvas.fit();
  renderLabPanel(currentLab);
  $("checkResults").replaceChildren();
});

function clearLabPanel() {
  $("labSummary").textContent = "";
  $("labTasks").replaceChildren();
  $("labQuestions").replaceChildren();
  $("labQuestions").hidden = true;
  $("labProgress").hidden = true;
  $("labKind").hidden = true;
  $("btnCheck").disabled = true;
  $("btnLabReset").hidden = true;
}

/** Fill the lab panel with a lab's brief, tasks and questions. */
function renderLabPanel(lab) {
  const done = store.labPassed(lab.id);
  const banner = $("labProgress");
  banner.hidden = !done;
  if (done) {
    const at = store.readProgress()[lab.id]?.at;
    banner.textContent = at
      ? `\u2713 Passed on ${new Date(at).toLocaleDateString(undefined, { month: "long", day: "numeric" })}`
      : "\u2713 Passed";
  }
  const kind = $("labKind");
  kind.hidden = false;
  kind.textContent = LAB_KINDS[lab.kind] || "";
  kind.dataset.kind = lab.kind;

  $("labSummary").textContent = lab.summary;
  const ol = $("labTasks");
  ol.replaceChildren();
  lab.tasks.forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    ol.appendChild(li);
  });
  renderQuestions(lab);
  $("btnCheck").disabled = false;
  $("btnLabReset").hidden = false;
}

function renderQuestions(lab) {
  const host = $("labQuestions");
  host.replaceChildren();
  const qs = lab.questions || [];
  host.hidden = !qs.length;
  if (!qs.length) return;
  const h = document.createElement("h3");
  h.textContent = "Your readings";
  host.appendChild(h);
  const hint = document.createElement("p");
  hint.className = "field-hint";
  hint.textContent = "Numbers only. SPICE suffixes work: 4.2m, 17.9k.";
  host.appendChild(hint);
  qs.forEach((q) => {
    host.appendChild(field(q.prompt, "text", store.state.answers?.[q.id] ?? "", (v) => {
      store.state.answers = { ...(store.state.answers || {}), [q.id]: v };
      store.save();
      if (currentLab) store.saveLabWork(currentLab.id);
    }));
  });
}

$("btnCheck").addEventListener("click", async () => {
  if (!currentLab || running) return;
  running = true;
  const btn = $("btnCheck");
  btn.disabled = true;
  const host = $("checkResults");
  host.replaceChildren();
  $("runError").replaceChildren();

  const note = $("engineNote");
  // Answers typed in the last moment may still be in the debounce.
  document.activeElement?.blur?.();
  await new Promise((r) => setTimeout(r, 200));
  const outcome = await runChecks(currentLab, store, (m) => { note.textContent = m; say(m); });

  running = false;
  btn.disabled = false;

  if (outcome.error) showRunError(outcome.error, $("netOut").value);
  if (outcome.result) {
    lastResult = outcome.result;
    applyResult(outcome.result);
  }

  const ul = document.createElement("ul");
  ul.className = "check-list";
  outcome.results.forEach((r) => {
    const li = document.createElement("li");
    li.className = (r.pass ? "pass" : "fail") + (r.answer ? " is-answer" : "");
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
  store.saveLabWork(currentLab.id);
  if (outcome.ok) {
    store.recordLabPass(currentLab.id);
    renderLabList();
    renderLabPanel(currentLab);
    say(`All ${outcome.results.length} checks passed. ${currentLab.title} is complete.`);
  } else {
    say(`${passed} of ${outcome.results.length} checks passed.${outcome.error ? " The simulation did not run; see the explanation under Run simulation." : ""}`);
  }
});

// Keep each lab's sheet saved as the student works.
let labSaveTimer = null;
store.subscribe((_, reason) => {
  if (!currentLab || reason === "live") return;
  clearTimeout(labSaveTimer);
  labSaveTimer = setTimeout(() => { if (currentLab) store.saveLabWork(currentLab.id); }, 400);
});

/* ------------------------------------------------------- saved circuits */

function renderLibrary() {
  const list = $("libraryList");
  list.replaceChildren();
  const saved = store.listSaved();

  if (!saved.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing saved yet. Name your circuit at the top, then use Save current.";
    list.appendChild(li);
    return;
  }

  saved.forEach((entry) => {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "lib-name";
    name.textContent = entry.name;
    li.appendChild(name);

    if (entry.savedAt) {
      const when = document.createElement("span");
      when.className = "lib-when";
      when.textContent = new Date(entry.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      li.appendChild(when);
    }

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.setAttribute("aria-label", `Open ${entry.name}`);
    open.addEventListener("click", () => {
      if (!currentLab && !confirmReplace(`Opening ${entry.name}`)) return;
      detachLab();
      if (store.openFromLibrary(entry.name)) {
        syncAnalysisInputs();
        canvas.fit();
        say(`${entry.name} opened.`);
      }
    });
    li.appendChild(open);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete ${entry.name}`);
    del.addEventListener("click", () => {
      if (!confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
      store.deleteFromLibrary(entry.name);
      renderLibrary();
      say(`${entry.name} deleted.`);
    });
    li.appendChild(del);

    list.appendChild(li);
  });
}

$("btnStore").addEventListener("click", () => {
  const suggested = store.state.title && store.state.title !== "Untitled circuit"
    ? store.state.title : "";
  const name = prompt("Save this circuit as:", suggested);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { say("A name is needed to save a circuit."); return; }

  const exists = store.listSaved().some((e) => e.name === trimmed);
  if (exists && !confirm(`${trimmed} already exists. Replace it?`)) return;

  if (store.saveToLibrary(trimmed)) {
    $("docTitle").value = trimmed;
    renderLibrary();
    say(`Saved as ${trimmed}.`);
  } else {
    say("The circuit could not be saved. Browser storage may be full or blocked.");
  }
});

/** Step off a lab, since the sheet is no longer that lab's circuit. */
function detachLab() {
  if (currentLab) store.saveLabWork(currentLab.id);
  labSelect.value = "";
  setLab(null);
}

/* ------------------------------------------------------------- file I/O */

function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => (s || "circuit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "circuit";

$("btnLink").addEventListener("click", async () => {
  try {
    const url = await shareUrl(store.state);
    try {
      await navigator.clipboard.writeText(url);
      say(`Link copied — ${url.length} characters. Anyone who opens it gets this exact circuit.`);
    } catch {
      window.prompt("Copy this link:", url);
    }
  } catch (e) {
    say(`The link could not be built: ${e.message}`);
  }
});

$("btnNew").addEventListener("click", () => {
  if (!currentLab && !confirmReplace("Starting a new sheet")) return;
  detachLab();
  store.clear();
  say("New sheet.");
});

$("btnSave").addEventListener("click", () => {
  download(`${slug(store.state.title)}.json`, store.toDocument());
  store.markClean();
  say("Circuit downloaded.");
});

$("btnOpen").addEventListener("click", () => $("fileInput").click());

$("fileInput").addEventListener("change", async (evt) => {
  const file = evt.target.files?.[0];
  if (!file) return;
  if (!currentLab && !confirmReplace(`Opening ${file.name}`)) { evt.target.value = ""; return; }
  try {
    const text = await file.text();
    detachLab();
    store.loadDocument(text);
    syncAnalysisInputs();
    canvas.fit();
    say(`${file.name} opened.`);
  } catch (e) {
    showRunError(e.message, "");
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
  const { text, net } = previewNetlist(store.state);
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

store.subscribe((_, reason) => {
  refresh();
  if (reason === "library") renderLibrary();
});

/* ----------------------------------------------------------------- boot */

async function boot() {
  const restored = store.restore() && store.state.comps.length > 0;

  let shared = null;
  try {
    shared = await decodeCircuit();
  } catch (e) {
    // A truncated link should not stop the app from opening.
    setTimeout(() => say(e.message), 0);
  }

  if (shared) {
    // Someone followed a link on purpose, so it wins — but not silently over
    // work that has not been saved anywhere.
    if (!restored || !store.isDirty() ||
        confirm("This link contains a circuit.\n\nOpening it replaces what is on your sheet, which has unsaved changes.\n\nOpen the linked circuit?")) {
      store.loadCircuit(shared);
      store.state.analysis = { ...DEFAULT_ANALYSIS, ...(shared.analysis || {}) };
      store.state.showBias = !!shared.showBias;
      setLab(null);
      setTimeout(() => say(`Opened "${store.state.title}" from a shared link.`), 0);
    }
    clearHash();
  } else if (!restored) {
    store.state.analysis = { ...DEFAULT_ANALYSIS };
    store.loadCircuit(LABS[0].circuit);
    setLab(LABS[0]);
  } else {
    // Reopen the lab the student was in, if the sheet still belongs to it.
    const lab = labById(store.currentLabId);
    if (lab) setLab(lab);
  }
  labSelect.value = currentLab ? currentLab.id : "";

  syncAnalysisInputs();
  syncBiasButton();
  $("docTitle").value = store.state.title;
  store.markClean();
  renderLibrary();
  try { setViewLock(localStorage.getItem(VIEW_LOCK_KEY) === "1", false); }
  catch { setViewLock(false, false); }
  refresh();
  canvas.fit();
  setTool("select");
}

boot().then(() => { window.__spiceLab.ready = true; });

// exposed for the end-to-end tests
window.__spiceLab = { store, canvas, scope, run, refresh, runNetlist, shareUrl, decodeCircuit,
  explainEngineError, ready: false, getResult: () => lastResult,
  // Leave the current lab and wipe every lab's saved work, so a test can
  // open a lab and get its starting circuit.
  freshLabs() {
    clearTimeout(labSaveTimer);
    setLab(null);
    labSelect.value = "";
    try { localStorage.removeItem("q-circuits-labwork-v1"); } catch { /* storage blocked */ }
  },
  currentLab: () => currentLab,
  simulate, labs: { LABS, runChecks, labById, corners } };
