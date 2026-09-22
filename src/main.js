/**
 * Application wiring.
 *
 * Everything that mutates the schematic goes through the store, and every
 * panel redraws from `refresh()`. That keeps the netlist, the parts table and
 * the validation messages from ever disagreeing with what is on the sheet.
 */

import { PARTS, PALETTE, PALETTE_TABS, PART_ICONS, LAB_PARTS, pinsOf, netlistNameOf, isDigital, shapeOf, filledIndices } from "./parts.js";
import { buildNodes, nodesFor, validate, formatEng, paramValues, parseValue } from "./netlist.js";
import { Store, DEFAULT_ANALYSIS, DEFAULT_PLOT, DEFAULT_TITLE_BLOCK } from "./store.js";
import { createCanvas } from "./canvas.js";
import { createScope } from "./scope.js";
import { runNetlist, engineReady } from "./engine.js";
import { LABS, LAB_GROUPS, LAB_KINDS, labById, runChecks, corners, diagramFor,
  variantFor, labTasks, labCircuit, labQuestions, encodeOutcome, decodeOutcome, scoreOf } from "./labs.js";
import { simulate, probedTraces, previewNetlist } from "./simulate.js";
import { explainEngineError } from "./errors.js";
import { shareUrl, decodeCircuit, clearHash } from "./share.js";
import { exportSvg, exportCanvas } from "./export-png.js";
import { createDiagramWindow } from "./diagram.js";
import { buildSubmissionSheet } from "./submission.js";
import { labDiagramSource } from "./authoring.js";

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

const diagram = createDiagramWindow({
  onStatus: (m) => say(m),
  onToggle: (open) => {
    const b = $("btnDiagram");
    b.setAttribute("aria-pressed", open ? "true" : "false");
    b.textContent = open ? "Hide diagram" : "Reference diagram";
  }
});
$("btnDiagram").addEventListener("click", () => diagram.toggle());

const scope = createScope({ host: $("scopeHost"), measureHost: $("measureHost"), onStatus: say });

let currentLab = null;
// Which view is on: the labs' parts and settings, or everything.
const VIEW_KEY = "q-circuits-view-v1";
const LAB_PART_SET = new Set(LAB_PARTS);
let fullView = false;
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
const tabRow = document.createElement("span");
tabRow.className = "seg palette-tabs";
tabRow.setAttribute("role", "group");
tabRow.setAttribute("aria-label", "Part set");
partTools.appendChild(tabRow);
Object.keys(PALETTE_TABS).forEach((tab) => {
  const t = document.createElement("button");
  t.type = "button";
  t.dataset.tab = tab;
  t.textContent = tab === "analog" ? "Analog" : "Digital";
  t.setAttribute("aria-pressed", "false");
  tabRow.appendChild(t);
  PALETTE_TABS[tab].forEach((key) => {
    const def = PARTS[key];
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.tool = key;
    b.dataset.tabPart = tab;
    b.setAttribute("aria-pressed", "false");
    b.title = def.name;
    b.append(partIcon(key), partLabel(def));
    partTools.appendChild(b);
  });
});

let currentTab = "analog";

/** Show one part set. Keyboard shortcuts reach every part either way. */
function setPaletteTab(tab) {
  currentTab = tab;
  partTools.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === tab ? "true" : "false"));
  applyViewMode();
}
tabRow.addEventListener("click", (evt) => {
  const b = evt.target.closest("[data-tab]");
  if (!b) return;
  setPaletteTab(b.dataset.tab);
  say(`${b.textContent} parts shown.`);
});
setPaletteTab("analog");
void PALETTE;

try {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved) fullView = saved === "full";
} catch { /* storage blocked */ }

/**
 * A palette button draws the part's own symbol, taken from the same shape
 * data the sheet draws, so the picture on the button is always the picture
 * the student is about to place.
 */
function partIcon(key) {
  const def = PARTS[key];
  const sample = { type: key, x: 0, y: 0, rot: 0 };
  def.fields.forEach((f) => { sample[f.k] = f.def; });
  const custom = PART_ICONS[key];
  const [x0, y0, x1, y1] = custom ? custom.box : def.boxFor ? def.boxFor(sample) : def.box;
  const pad = custom ? 0 : 6;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`);
  svg.setAttribute("class", "part-icon");
  svg.setAttribute("aria-hidden", "true");
  const fills = custom ? custom.fills || [] : filledIndices(key);
  (custom ? custom.paths : shapeOf(sample)).forEach((d, i) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", fills.includes(i) ? "part-path is-filled" : "part-path");
    svg.appendChild(path);
  });
  return svg;
}

function partLabel(def) {
  const span = document.createElement("span");
  span.textContent = shortName(def);
  return span;
}

function shortName(def) {
  const map = {
    Resistor: "R", Capacitor: "C", Inductor: "L",
    "Voltage source": "V", "Current source": "I", Diode: "D",
    Switch: "SW", Ammeter: "Ammeter", Ground: "GND",
    "NPN transistor": "NPN", "PNP transistor": "PNP",
    "N-channel MOSFET": "NMOS", "P-channel MOSFET": "PMOS",
    "Op-amp": "Op-amp", "LM324 op-amp": "LM324",
    "Net alias": "Net alias", "Power symbol": "Power", Parameter: "Param",
    "Pulse source": "Pulse", Transformer: "Xfmr",
    "2-input gate": "Gate", "3-input gate": "Gate3", Inverter: "NOT", "JK flip-flop": "7473",
    "Digital stimulus": "STIM1", "Digital clock": "DigClock", "Logic 1 ($D_HI)": "$D_HI",
    "N-channel JFET": "NJF", "74151A multiplexer": "74151A", "74154 decoder": "74154",
    "555 timer": "555", "Dependent source": "Dep. src",
    "Bus entry": "Bus entry", Port: "Port"
  };
  return map[def.name] || def.name;
}

function setTool(tool) {
  canvas.setTool(tool);
  document.querySelectorAll("#modeTools button[data-tool], #viewTools button[data-tool], #partTools button[data-tool]").forEach((b) => {
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
["h", "v"].forEach((axis) => {
  $(axis === "h" ? "btnMirrorH" : "btnMirrorV").addEventListener("click", () => {
    if (store.mirrorSelection(axis)) say(axis === "h" ? "Mirrored left to right. Check the wires still meet the pins." : "Mirrored top to bottom. Check the wires still meet the pins.");
    else say("Select a part to mirror.");
  });
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
  k: "NET", p: "PWR", x: "vdiff", y: "bus"
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
  "paramName", "paramStart", "paramStop", "paramStep", "paramList",
  "noiseOut", "noiseSrc", "noisePts", "noiseStart", "noiseStop", "tempList", "fourierFreq"];

function syncAnalysisInputs() {
  const a = store.state.analysis;
  $("anaType").value = a.type;
  ANA_FIELDS.forEach((k) => { $(k).value = a[k] ?? ""; });
  $("trUic").checked = !!a.trUic;
  $("fieldsDC").hidden = a.type !== "dc";
  $("fieldsTran").hidden = a.type !== "tran";
  $("fieldsAC").hidden = a.type !== "ac";
  $("fieldsNoise").hidden = a.type !== "noise";
  $("fourierOn").checked = !!a.fourierOn;
  $("fieldsFourier").hidden = !a.fourierOn;
  $("tempOn").checked = !!a.tempOn;
  $("fieldsTemp").hidden = !a.tempOn;
  $("ffInit").value = a.ffInit || "X";
  $("paramOn").checked = !!a.paramOn;
  $("paramMode").value = a.paramMode || "lin";
  $("fieldsParam").hidden = !a.paramOn;
  $("paramLin").hidden = a.paramMode === "list";
  $("paramListWrap").hidden = a.paramMode !== "list";
}

[["fourierOn", "fourierOn"], ["tempOn", "tempOn"]].forEach(([id, key]) => {
  $(id).addEventListener("change", () => {
    store.edit((s) => { s.analysis[key] = $(id).checked; }, "analysis");
    syncAnalysisInputs();
  });
});

$("ffInit").addEventListener("change", () => {
  store.edit((s) => { s.analysis.ffInit = $("ffInit").value; }, "analysis");
});
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
  scope.setDigital(store.state.comps.some(isDigital) && !filtered.kind?.startsWith?.("complex"));
  scope.setResult(filtered);
  $("btnCsv").disabled = false;
  $("btnPngPlot").disabled = false;

  const modes = $("acModes");
  modes.hidden = filtered.kind !== "complex";
  if (!modes.hidden) {
    const want = plotState().mode;
    if (want && want !== scope.getMode()) scope.setMode(want);
    setAcMode(scope.getMode());
  }
  applyRanges();

  renderOpResults(result);
  renderHarmonics(result);
  updateBias(result);
}

/**
 * Harmonics and THD of each probed trace, when a transient run asked for
 * them. Read as a table because that is how a distortion figure is quoted.
 */
function renderHarmonics(result) {
  const host = $("harmonicsHost");
  host.replaceChildren();
  const f = result?.fourier;
  if (!f || !f.traces.length) return;

  const head = document.createElement("p");
  head.className = "measure-scope";
  head.textContent = `Harmonics of ${formatEng(f.f0, 4)} Hz, over the last ${f.traces[0].cycles} cycle${f.traces[0].cycles === 1 ? "" : "s"} of the run`;
  host.appendChild(head);

  f.traces.forEach((t) => {
    const table = document.createElement("table");
    table.className = "measure-table";
    const caption = document.createElement("caption");
    caption.textContent = `${t.name} — THD ${isFinite(t.thd) ? `${(t.thd * 100).toPrecision(3)} %` : "—"}, DC ${formatEng(t.dc, 3)} ${t.unit}`;
    table.appendChild(caption);
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Harmonic", "Frequency", "Magnitude", "Relative", "Phase"].forEach((label, i) => {
      const th = document.createElement("th");
      th.textContent = label;
      if (i) th.className = "num";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const body = document.createElement("tbody");
    t.harmonics.forEach((h) => {
      const tr = document.createElement("tr");
      const first = document.createElement("th");
      first.scope = "row";
      first.textContent = String(h.harmonic);
      tr.appendChild(first);
      [`${formatEng(h.freq, 4)} Hz`, `${formatEng(h.mag, 4)} ${t.unit}`,
        `${(h.relative * 100).toPrecision(3)} %`, `${h.phase.toFixed(1)}\u00B0`].forEach((text) => {
        const td = document.createElement("td");
        td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    host.appendChild(table);
  });
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

/* ------------------------------------------------------------ view mode */

/**
 * Two views of the same tool. The condensed one shows the parts and settings
 * the labs use; the full one shows everything. It only changes what is on
 * screen: a circuit drawn in one view works in the other, and a part already
 * on the sheet stays in the palette whichever view is on, so nothing a
 * student has drawn can become unreachable.
 */
function applyViewMode() {
  document.body.classList.toggle("view-condensed", !fullView);
  const b = $("btnViewMode");
  b.setAttribute("aria-pressed", fullView ? "true" : "false");
  b.textContent = fullView ? "Lab view" : "Full view";
  b.title = fullView
    ? "Show only the parts and settings the labs use"
    : "Show every part and analysis Q Circuits has";

  const onSheet = new Set(store.state.comps.map((c) => c.type));
  partTools.querySelectorAll("[data-tab-part]").forEach((btn) => {
    const inTab = btn.dataset.tabPart === currentTab;
    const allowed = fullView || LAB_PART_SET.has(btn.dataset.tool) || onSheet.has(btn.dataset.tool);
    btn.hidden = !inTab || !allowed;
  });
  // The noise analysis is not one the labs run.
  const noise = $("anaType").querySelector('option[value="noise"]');
  if (noise) noise.hidden = !fullView && store.state.analysis.type !== "noise";
}

function setViewMode(next, { announce = true } = {}) {
  fullView = next === "full";
  try { localStorage.setItem(VIEW_KEY, next); } catch { /* storage blocked */ }
  applyViewMode();
  if (announce) {
    say(fullView
      ? "Full view: every part and analysis is showing."
      : "Lab view: the parts and settings the labs use. Your circuit is unchanged.");
  }
}

$("btnViewMode").addEventListener("click", () => setViewMode(fullView ? "condensed" : "full"));

/* ---------------------------------------------------------- title block */

const TB_INPUTS = { name: "tbName", course: "tbCourse", org: "tbOrg", date: "tbDate" };

function titleBlockState() {
  if (!store.state.titleBlock) store.state.titleBlock = { ...DEFAULT_TITLE_BLOCK };
  return store.state.titleBlock;
}

/** The date used when the student has not typed one. */
const todayISO = () => new Date().toISOString().slice(0, 10);

function syncTitleBlock() {
  const tb = titleBlockState();
  Object.entries(TB_INPUTS).forEach(([k, id]) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = tb[k] ?? "";
  });
  const b = $("btnTitleBlock");
  b.setAttribute("aria-pressed", tb.show ? "true" : "false");
  b.textContent = tb.show ? "Hide title block" : "Title block";
}

Object.entries(TB_INPUTS).forEach(([k, id]) => {
  $(id).addEventListener("input", () => {
    titleBlockState()[k] = $(id).value;
    store.save();
    if (currentLab) store.saveLabWork(currentLab.id);
    canvas.render();
  });
});

$("btnTitleBlock").addEventListener("click", () => {
  const tb = titleBlockState();
  tb.show = !tb.show;
  if (tb.show && !tb.date) { tb.date = todayISO(); $("tbDate").value = tb.date; }
  store.save();
  if (currentLab) store.saveLabWork(currentLab.id);
  syncTitleBlock();
  canvas.render();
  if (tb.show && !tb.name) {
    $("titleBlockBox").open = true;
    say("Title block added. Fill in your name and course below the sheet.");
  } else {
    say(tb.show ? "Title block added to the sheet." : "Title block removed.");
  }
});

/* ---------------------------------------------------------- axis ranges */

const PLOT_INPUTS = { xMin: "plotXMin", xMax: "plotXMax", yMin: "plotYMin", yMax: "plotYMax", y2Min: "plotY2Min", y2Max: "plotY2Max" };

function plotState() {
  if (!store.state.plot) store.state.plot = { ...DEFAULT_PLOT };
  return store.state.plot;
}

function applyRanges() {
  const p = plotState();
  const r = {};
  Object.keys(PLOT_INPUTS).forEach((k) => { r[k] = String(p[k] ?? "").trim() ? parseValue(p[k]) : NaN; });
  scope.setRanges(r);
  const lanes = scope.isDigital() && scope.paneCount() > 0;
  $("plotY2Row").hidden = lanes || scope.paneCount() < 2;
  $("plotYLabel").closest(".field-grid-2").hidden = lanes;
  $("plotYLabel").textContent = scope.paneCount() > 1 ? "Top plot Y from" : "Y from";
}

function syncPlotInputs() {
  const p = plotState();
  Object.entries(PLOT_INPUTS).forEach(([k, id]) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = p[k] ?? "";
  });
  if (Object.keys(PLOT_INPUTS).some((k) => String(p[k] ?? "").trim())) $("axisBox").open = true;
  applyRanges();
}

Object.entries(PLOT_INPUTS).forEach(([k, id]) => {
  $(id).addEventListener("input", () => {
    plotState()[k] = $(id).value;
    store.save();
    if (currentLab) store.saveLabWork(currentLab.id);
    applyRanges();
  });
});

$("btnAxisAuto").addEventListener("click", () => {
  const p = plotState();
  Object.keys(PLOT_INPUTS).forEach((k) => { p[k] = ""; });
  store.save();
  syncPlotInputs();
  syncTitleBlock();
  applyViewMode();
  say("Both axes are automatic again.");
});

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
  plotState().mode = b.dataset.mode;
  store.save();
  if (currentLab) store.saveLabWork(currentLab.id);
  say(`Plot showing ${b.textContent}.`);
});

/**
 * Printing gives the schematic and the plot on paper, with the panels left
 * out (see the print rules in styles.css). The sheet is framed to the whole
 * circuit for the duration, whatever the student had zoomed in on, and put
 * back afterwards.
 */
let viewBeforePrint = null;
window.addEventListener("beforeprint", () => {
  viewBeforePrint = canvas.getView();
  canvas.fit();
});
window.addEventListener("afterprint", () => {
  if (viewBeforePrint) canvas.setView(viewBeforePrint);
  viewBeforePrint = null;
});

$("btnPrint").addEventListener("click", () => {
  say("Opening the print dialog. The schematic and the plot print; the panels do not.");
  window.print();
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
  store.loadCircuit(labCircuit(lab, variantFor(lab, store.state.titleBlock?.name)));
  say(`${lab.title} loaded.`);
}

function setLab(lab) {
  currentLab = lab;
  store.currentLabId = lab ? lab.id : "";
  // No reference diagram in an exam: the question paper is the only picture.
  $("btnDiagram").hidden = !lab || !!lab.exam;
  diagram.setLab(lab && !lab.exam ? lab : null);
  // A lab opens in the view its parts belong to; free build opens in full.
  setViewMode(lab ? "condensed" : "full", { announce: false });
  if (lab) setPaletteTab(/^e101-1[01]/.test(lab.id) ? "digital" : "analog");
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

/**
 * For whoever marks the exams: a student's sheet carries a code, and this
 * turns it back into the list of checks with the marks each was worth.
 */
$("btnDecode").addEventListener("click", () => {
  const host = $("checkResults");
  host.replaceChildren();
  const decoded = decodeOutcome($("examCode").value);
  if (!decoded) {
    say("That code could not be read. It may have been mistyped, or the sheet edited after it was made.");
    return;
  }
  const lab = labById(decoded.labId);
  if (!lab) {
    say(`The code is for ${decoded.labId}, which is not an exam in this copy of Q Circuits.`);
    return;
  }
  const variant = variantFor(lab, decoded.name);
  const checks = [...(typeof lab.checks === "function" ? lab.checks(variant) : lab.checks),
    ...(typeof lab.questions === "function" ? lab.questions(variant) : lab.questions || [])
      .map((q) => ({ label: `Answer: ${q.prompt}`, points: q.points }))];
  const results = checks.map((_, i) => ({ pass: !!decoded.bits[i] }));
  const { earned, total, percent } = scoreOf(checks, results);

  const head = document.createElement("p");
  head.className = "exam-score";
  head.textContent = `${decoded.name || "unnamed"} — ${lab.title} — ${earned} of ${total} marks (${Math.round(percent)}%) on ${decoded.date}`;
  host.appendChild(head);

  const ul = document.createElement("ul");
  ul.className = "check-list";
  checks.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = results[i].pass ? "pass" : "fail";
    const mark = document.createElement("span");
    mark.className = "check-mark";
    mark.textContent = results[i].pass ? "✓" : "✗";
    const text = document.createElement("span");
    const worth = c.points === undefined ? 1 : c.points;
    text.textContent = `${c.label} (${worth} mark${worth === 1 ? "" : "s"})`;
    li.append(mark, text);
    ul.appendChild(li);
  });
  host.appendChild(ul);
  say(`${decoded.name || "Unnamed"} scored ${earned} of ${total} marks.`);
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
  $("btnSubmit").hidden = true;
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
  kind.textContent = lab.exam ? LAB_KINDS.exam : LAB_KINDS[lab.kind] || "";
  kind.dataset.kind = lab.exam ? "exam" : lab.kind;
  // An exam is marked once and hands back a sheet, not a list of what to fix.
  $("btnCheck").textContent = lab.exam ? "Submit exam answer" : "Check my work";
  $("btnSubmit").hidden = !!lab.exam;

  $("labSummary").textContent = lab.summary;
  const variant = variantFor(lab, store.state.titleBlock?.name);
  const ol = $("labTasks");
  ol.replaceChildren();
  labTasks(lab, variant).forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    ol.appendChild(li);
  });
  renderQuestions(lab);
  $("btnCheck").disabled = false;
  $("btnSubmit").disabled = false;
  $("btnSubmit").hidden = false;
  $("btnLabReset").hidden = false;
}

function renderQuestions(lab) {
  const host = $("labQuestions");
  host.replaceChildren();
  const qs = labQuestions(lab, variantFor(lab, store.state.titleBlock?.name));
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

/**
 * An exam hands back a score and a sheet to hand in. Which checks failed
 * stays in the code on the sheet, for whoever marks it.
 */
async function showExamScore(outcome) {
  const host = $("checkResults");
  host.replaceChildren();
  const { earned, total, percent } = outcome.score;
  const date = titleBlockState().date || todayISO();
  const code = encodeOutcome({
    labId: currentLab.id, name: titleBlockState().name, date, results: outcome.results
  });

  const box = document.createElement("div");
  box.className = "exam-result";
  const score = document.createElement("p");
  score.className = "exam-score";
  score.textContent = `${earned} of ${total} marks (${Math.round(percent)}%)`;
  const note = document.createElement("p");
  note.textContent = outcome.error
    ? "Your circuit did not simulate, so the marks that need a run were lost. The sheet below is still your answer."
    : "Save the sheet and hand it in. It carries your circuit, your readings and this result.";
  box.append(score, note);
  host.appendChild(box);

  store.saveLabWork(currentLab.id);
  try {
    const blob = await buildSubmissionSheet({
      svg: canvas.svg,
      sheetBox: canvas.contentBox(),
      plotCanvas: document.querySelector(".scope-canvas"),
      lab: currentLab,
      state: store.state,
      outcome,
      exam: { code, earned, total, percent }
    });
    const name = `${slug(titleBlockState().name || "answer")}-${slug(currentLab.code || currentLab.id)}-exam.png`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`${earned} of ${total} marks. Your answer sheet was saved as ${name}: hand that in.`);
  } catch (e) {
    say(`${earned} of ${total} marks, but the answer sheet could not be saved: ${e.message}`);
  }
}

/**
 * Mark the current lab: run its checks, show them, record a pass. Returns the
 * outcome so the submission sheet can be built from the same run rather than
 * a second one that might disagree.
 */
async function markLab() {
  if (!currentLab || running) return null;
  running = true;
  $("btnCheck").disabled = true;
  $("btnSubmit").disabled = true;
  const host = $("checkResults");
  host.replaceChildren();
  $("runError").replaceChildren();

  if (currentLab.exam && !titleBlockState().name) {
    $("titleBlockBox").open = true;
    $("tbName").focus();
    say("Type your name under the sheet first: your exam values and your answer sheet depend on it.");
    running = false;
    $("btnCheck").disabled = false;
    $("btnSubmit").disabled = false;
    return null;
  }

  const note = $("engineNote");
  // Answers typed in the last moment may still be in the debounce.
  document.activeElement?.blur?.();
  await new Promise((r) => setTimeout(r, 200));
  const outcome = await runChecks(currentLab, store, (m) => { note.textContent = m; say(m); });

  running = false;
  $("btnCheck").disabled = false;
  $("btnSubmit").disabled = false;

  if (outcome.error) showRunError(outcome.error, $("netOut").value);
  if (outcome.result) {
    lastResult = outcome.result;
    applyResult(outcome.result);
  }

  if (currentLab.exam) {
    showExamScore(outcome);
    running = false;
    $("btnCheck").disabled = false;
    return outcome;
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
  return outcome;
}

$("btnCheck").addEventListener("click", () => markLab());

/**
 * Check the work, then hand back one image holding the whole attempt: the
 * schematic, the plot, the readings and every check. What gets submitted is
 * the run that was just marked, not a fresh one.
 */
$("btnSubmit").addEventListener("click", async () => {
  if (!currentLab || running) return;
  const tb = titleBlockState();
  if (!tb.name) {
    $("titleBlockBox").open = true;
    $("titleBlockBox").scrollIntoView({ block: "nearest" });
    $("tbName").focus();
    say("Add your name under the sheet first: the submission sheet is signed with it.");
    return;
  }
  const outcome = await markLab();
  if (!outcome) return;
  try {
    const blob = await buildSubmissionSheet({
      svg: canvas.svg,
      sheetBox: canvas.contentBox(),
      plotCanvas: document.querySelector(".scope-canvas"),
      lab: currentLab,
      state: store.state,
      outcome
    });
    const name = `${slug(tb.name)}-${slug(currentLab.code || currentLab.id)}-submission.png`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(outcome.ok
      ? `Submission sheet saved as ${name}. It records all ${outcome.results.length} checks passing.`
      : `Submission sheet saved as ${name}. It records ${outcome.results.filter((r) => r.pass).length} of ${outcome.results.length} checks passing.`);
  } catch (e) {
    say(`The submission sheet could not be made: ${e.message}`);
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

/**
 * For whoever writes the labs: draw the circuit, then copy it out as the
 * data a reference diagram is made of.
 */
$("btnLabSource").addEventListener("click", async () => {
  if (!store.state.comps.length && !store.state.wires.length) {
    say("The sheet is empty, so there is nothing to copy.");
    return;
  }
  const text = labDiagramSource(store.state);
  const parts = store.state.comps.length;
  try {
    await navigator.clipboard.writeText(text);
    say(`Copied this sheet as a lab diagram: ${parts} part${parts === 1 ? "" : "s"}. Paste it into DIAGRAMS in src/labs.js.`);
  } catch {
    // Clipboard blocked: put it where it can be selected by hand.
    $("netOut").value = text;
    $("netOut").select();
    say("Copy was blocked. The lab diagram is in the netlist box — press Ctrl or Command C. It reappears as a netlist on the next change.");
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
  syncPlotInputs();
  // Keep the palette in step: a part on the sheet stays reachable.
  applyViewMode();

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
  simulate, diagram, buildSubmissionSheet, labDiagramSource, parts: { shapeOf, PARTS }, titleBlock: titleBlockState, labs: { LABS, runChecks, labById, corners, diagramFor, variantFor, encodeOutcome, decodeOutcome, scoreOf } };
