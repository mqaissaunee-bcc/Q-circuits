/**
 * The floating Reference diagram.
 *
 * It is the same renderer as the sheet, pointed at a store of its own that
 * never saves, and set read-only: drag pans, pinch or ⌘-scroll zooms, and
 * nothing can be edited. Drawing it this way rather than from images keeps it
 * crisp at any size, lets it follow dark mode, and uses exactly the symbols a
 * student places.
 *
 * The window is non-modal so students keep drawing beside it. It remembers
 * where it was put and whether it was open.
 */

import { Store } from "./store.js";
import { createCanvas } from "./canvas.js";
import { PARTS, netlistNameOf } from "./parts.js";
import { buildNodes, nodesFor, nodeAtPoint } from "./netlist.js";
import { diagramFor, DIAGRAM_CAPTIONS } from "./labs.js";

const PREFS_KEY = "q-circuits-diagram-v1";
const STEP = 20;

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function writePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

export function createDiagramWindow({ onStatus, onToggle }) {
  const $ = (id) => document.getElementById(id);
  const win = $("diagramWin");
  const head = $("diagramHead");
  const host = $("diagramHost");
  const say = (m) => onStatus?.(m);

  const store = new Store({ persist: false });
  const canvas = createCanvas({
    host, store, readOnly: true,
    label: "Reference diagram. The circuit in words, below it, is the text equivalent."
  });
  store.subscribe(() => canvas.render());

  const docked = () => window.matchMedia("(max-width: 760px)").matches;

  let lab = null;
  // Open by default beside the sheet; on a phone it would cover half the
  // screen, so there it waits to be asked for.
  let prefs = { open: !docked(), ...readPrefs() };

  /* ------------------------------------------------------------ place */

  function applyPlacement() {
    if (docked()) return;
    const r = prefs.rect;
    if (!r) return;
    const w = Math.min(r.w, window.innerWidth - 16);
    const h = Math.min(r.h, window.innerHeight - 16);
    win.style.width = `${w}px`;
    win.style.height = `${h}px`;
    win.style.left = `${clamp(r.x, 8, window.innerWidth - w - 8)}px`;
    win.style.top = `${clamp(r.y, 8, window.innerHeight - 48)}px`;
    win.style.right = "auto";
    win.style.bottom = "auto";
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function remember() {
    if (docked()) return;
    const b = win.getBoundingClientRect();
    prefs.rect = { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    writePrefs(prefs);
  }

  function moveBy(dx, dy) {
    const b = win.getBoundingClientRect();
    win.style.left = `${clamp(b.left + dx, 8, window.innerWidth - b.width - 8)}px`;
    win.style.top = `${clamp(b.top + dy, 8, window.innerHeight - 48)}px`;
    win.style.right = "auto";
    win.style.bottom = "auto";
    remember();
  }

  let drag = null;
  head.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0 || evt.target.closest("button") || docked()) return;
    const b = win.getBoundingClientRect();
    drag = { dx: evt.clientX - b.left, dy: evt.clientY - b.top };
    head.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  });
  head.addEventListener("pointermove", (evt) => {
    if (!drag) return;
    const b = win.getBoundingClientRect();
    win.style.left = `${clamp(evt.clientX - drag.dx, 8, window.innerWidth - b.width - 8)}px`;
    win.style.top = `${clamp(evt.clientY - drag.dy, 8, window.innerHeight - 48)}px`;
    win.style.right = "auto";
    win.style.bottom = "auto";
  });
  head.addEventListener("pointerup", (evt) => {
    if (!drag) return;
    drag = null;
    try { head.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
    remember();
  });

  head.addEventListener("keydown", (evt) => {
    const step = evt.shiftKey ? STEP * 4 : STEP;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[evt.key] && !docked()) {
      evt.preventDefault();
      evt.stopPropagation();
      moveBy(...moves[evt.key]);
    }
  });

  // Keys inside the window belong to it, not to the sheet's shortcuts.
  win.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") { evt.preventDefault(); close(); $("btnDiagram")?.focus(); }
    evt.stopPropagation();
  });

  // Refit when the student resizes it with the corner grip.
  let fitTimer = null;
  new ResizeObserver(() => {
    if (win.hidden) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { canvas.fit(); remember(); }, 120);
  }).observe(win);

  window.addEventListener("resize", () => { if (!win.hidden) applyPlacement(); });

  $("btnDiagramFit").addEventListener("click", () => { canvas.fit(); say("Diagram fitted."); });
  $("btnDiagramClose").addEventListener("click", () => close());

  /* ----------------------------------------------------------- content */

  function describe() {
    const list = $("diagramWords");
    list.replaceChildren();
    const { comps, wires, probes } = store.state;
    const net = buildNodes(comps, wires);
    const name = (n) => (n === 0 ? "ground" : typeof n === "string" ? n : `node ${n}`);
    const add = (text) => {
      const li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    };

    comps.forEach((c) => {
      const def = PARTS[c.type];
      if (c.type === "PARAM") { add(`PARAMETERS: ${c.name} = ${c.value}`); return; }
      if (def.virtual || c.type === "GND") return;
      const nodes = nodesFor(c, net);
      const setting = def.fields
        .filter((f) => String(c[f.k] ?? "").trim() && !["gbw", "headroom", "gain"].includes(f.k))
        .map((f) => (f.k === "ac" ? `AC ${c[f.k]}` : c[f.k]))
        .join(", ");
      // Polarity means nothing on a resistor, so say what it sits between.
      const ends = ["R", "C", "L", "SW"].includes(c.type)
        ? `between ${name(nodes[0])} and ${name(nodes[1])}`
        : def.pinNames.map((p, i) => `${p} ${name(nodes[i])}`).join(", ");
      add(`${c.label}${setting ? ` (${setting})` : ""}: ${ends}`);
    });
    probes.forEach((p) => {
      if (p.kind === "v") add(`Voltage probe on ${name(nodeAtPoint(net, wires, p.x, p.y))}`);
      else if (p.kind === "vd") add(`Differential probe: + on ${name(nodeAtPoint(net, wires, p.x, p.y))}, − on ${name(nodeAtPoint(net, wires, p.x2, p.y2))}`);
      else {
        const c = comps.find((k) => netlistNameOf(k) === p.ref);
        add(`Current probe on ${c ? c.label : p.ref}`);
      }
    });
  }

  function load() {
    if (!lab) return;
    const circuit = diagramFor(lab);
    store.loadCircuit({ ...circuit, title: lab.title, notes: [] });
    $("diagramTitle").textContent = `Reference: ${lab.title}`;
    $("diagramCaption").textContent = DIAGRAM_CAPTIONS[lab.kind] || "";
    describe();
    canvas.fit();
  }

  /* -------------------------------------------------------------- show */

  function open() {
    if (!lab) return;
    win.hidden = false;
    applyPlacement();
    load();
    prefs.open = true;
    writePrefs(prefs);
    onToggle?.(true);
    say("Reference diagram open. Drag its title bar to move it.");
  }

  function close() {
    win.hidden = true;
    prefs.open = false;
    writePrefs(prefs);
    onToggle?.(false);
    say("Reference diagram closed.");
  }

  return {
    /** Point the window at a lab, or at nothing. Opens it if it was left open. */
    setLab(next) {
      lab = next;
      if (!lab) { win.hidden = true; onToggle?.(false); return; }
      if (prefs.open) {
        win.hidden = false;
        applyPlacement();
        load();
        onToggle?.(true);
      } else {
        onToggle?.(false);
      }
    },
    open, close,
    toggle() { if (win.hidden) open(); else close(); },
    isOpen: () => !win.hidden,
    store, canvas
  };
}
