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
  // Held here rather than looked up each time: once the window has moved
  // into a pop-out, it is in that window's document, not this one.
  const el = {
    title: $("diagramTitle"), caption: $("diagramCaption"), words: $("diagramWords"),
    fit: $("btnDiagramFit"), close: $("btnDiagramClose"), pop: $("btnDiagramPop"),
    zoomIn: $("btnDiagramZoomIn"), zoomOut: $("btnDiagramZoomOut")
  };
  const home = { parent: win.parentNode, next: win.nextSibling };
  let popup = null;               // the separate window, while popped out
  const popped = () => !!popup && !popup.closed;
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
    if (docked() || popped()) return;
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
    if (docked() || popped()) return;
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
    if (evt.button !== 0 || evt.target.closest("button") || docked() || popped()) return;
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
    if (moves[evt.key] && !docked() && !popped()) {
      evt.preventDefault();
      evt.stopPropagation();
      moveBy(...moves[evt.key]);
    }
  });

  // Keys inside the window belong to it, not to the sheet's shortcuts.
  win.addEventListener("keydown", (evt) => {
    if (evt.target.closest("input, textarea")) return;
    if (evt.key === "+" || evt.key === "=") { evt.preventDefault(); canvas.zoomIn(); evt.stopPropagation(); return; }
    if (evt.key === "-" || evt.key === "_") { evt.preventDefault(); canvas.zoomOut(); evt.stopPropagation(); return; }
    if (evt.key === "0") { evt.preventDefault(); canvas.fit(); evt.stopPropagation(); return; }
    if (evt.key === "Escape") {
      evt.preventDefault();
      // In its own window Escape brings it home; in the page it closes it.
      if (popped()) { putBack(); return; }
      close();
      $("btnDiagram")?.focus();
    }
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

  el.fit.addEventListener("click", () => { canvas.fit(); say("Diagram fitted."); });
  el.zoomIn.addEventListener("click", () => canvas.zoomIn());
  el.zoomOut.addEventListener("click", () => canvas.zoomOut());
  el.close.addEventListener("click", () => close());
  el.pop.addEventListener("click", () => (popped() ? putBack() : popOut()));

  /**
   * Move the diagram into a window of its own. A floating panel cannot leave
   * the page, but a window can go to another monitor and fill it. The diagram
   * itself moves, not a copy, so it still pans, zooms and follows the student
   * from lab to lab.
   */
  function popOut() {
    // Big by default, since a diagram is for reading; after that, wherever
    // and however large the student last left it.
    const last = prefs.popup || {};
    const width = last.w || Math.round(Math.min(1600, (screen.availWidth || 1280) * 0.85));
    const height = last.h || Math.round(Math.min(1100, (screen.availHeight || 800) * 0.85));
    const place = last.x !== undefined ? `,left=${last.x},top=${last.y}` : "";
    const w = window.open("", "qcircuits-diagram", `popup,width=${width},height=${height}${place}`);
    if (!w) {
      say("The browser blocked the new window. Allow pop-ups for this site, then press Pop out again.");
      return;
    }
    popup = w;
    const doc = w.document;
    // The diagram is drawn with the page's styles, so they go with it.
    doc.head.replaceChildren(...[...document.querySelectorAll('link[rel="stylesheet"], style')]
      .map((n) => n.cloneNode(true)));
    // After the head is replaced, or the title goes with it.
    doc.title = lab ? `Reference: ${lab.title}` : "Q Circuits — reference diagram";
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme || "";
    doc.body.className = "diagram-popup";
    doc.body.replaceChildren(doc.adoptNode(win));
    win.classList.add("is-popped");
    win.hidden = false;
    el.pop.textContent = "Put back";
    el.pop.title = "Return the diagram to the page";
    w.addEventListener("pagehide", () => putBack(), { once: true });
    w.addEventListener("resize", () => { canvas.fit(); rememberPopup(w); });
    // Styles may still be loading into the new window; fit once they settle.
    setTimeout(() => canvas.fit(), 60);
    w.focus();
    onToggle?.(true);
    say("The diagram is in its own window. Drag it to your other monitor.");
  }

  /** Bring the diagram back into the page, and close its window. */
  /** Note where the pop-out is, so the next one opens in the same place. */
  function rememberPopup(w) {
    try {
      if (w && !w.closed && w.outerWidth > 200) {
        prefs.popup = { w: w.outerWidth, h: w.outerHeight, x: w.screenX, y: w.screenY };
        writePrefs(prefs);
      }
    } catch { /* the window has gone */ }
  }

  function putBack() {
    if (!popup) return;
    const w = popup;
    rememberPopup(w);
    popup = null;
    win.classList.remove("is-popped");
    home.parent.insertBefore(document.adoptNode(win), home.next);
    el.pop.textContent = "Pop out";
    el.pop.title = "Open the diagram in its own window, to move to another monitor";
    if (!w.closed) w.close();
    applyPlacement();
    canvas.fit();
    say("The diagram is back on the page.");
  }

  // Closing the page closes the diagram's window with it.
  window.addEventListener("pagehide", () => { if (popped()) popup.close(); });

  /* ----------------------------------------------------------- content */

  function describe() {
    const list = el.words;
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
    el.title.textContent = `Reference: ${lab.title}`;
    if (popup && !popup.closed) popup.document.title = `Reference: ${lab.title}`;
    el.caption.textContent = DIAGRAM_CAPTIONS[lab.kind] || "";
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
    if (popped()) putBack();
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
      if (!lab) {
        if (popped()) putBack();
        win.hidden = true;
        onToggle?.(false);
        return;
      }
      if (popped()) { load(); return; }
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
    isPopped: popped,
    popOut, putBack,
    store, canvas
  };
}
