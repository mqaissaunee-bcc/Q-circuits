/**
 * The schematic sheet: rendering and every pointer gesture that edits it.
 *
 * The whole sheet is redrawn from state on each change. At the scale these
 * circuits reach that is far cheaper than maintaining a diff, and it keeps the
 * drawing code a pure function of the store.
 */

import { GRID, PARTS, PALETTE, pinsOf, boxOf, shapeOf, filledIndices, textAnchor, netlistNameOf } from "./parts.js";
import { buildNodes } from "./netlist.js";

const NS = "http://www.w3.org/2000/svg";
const SHEET_W = 1400, SHEET_H = 900;

function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

const snap = (v) => Math.round(v / GRID) * GRID;

function distToSeg(px, py, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - w.x1) * dx + (py - w.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (w.x1 + t * dx), py - (w.y1 + t * dy));
}

export function createCanvas({ host, store, onStatus, onSelectionChange, onNeedsInspector }) {
  const svg = el("svg", {
    class: "sheet",
    viewBox: `0 0 ${SHEET_W} ${SHEET_H}`,
    tabindex: "0",
    role: "application",
    "aria-label": "Schematic sheet. Use the parts table below for a text equivalent."
  });
  host.appendChild(svg);

  let view = { x: 0, y: 0, w: SHEET_W, h: SHEET_H };
  let tool = "select";
  let hover = null;
  let wireRun = null;      // {x, y} anchor of the segment being drawn
  let gesture = null;      // {mode, ...}
  let net = null;          // last connectivity result, for probe hit tests
  let editing = null;      // the inline <input>, when one is open
  let lastDown = null;     // for detecting a double-click ourselves
  let caret = null;        // grid position for keyboard placement
  let viewLocked = false;  // when set, the sheet ignores wheel and middle-drag
  const noteBoxes = new Map();  // note id -> measured bounds, for hit testing

  const say = (m) => onStatus?.(m);

  /* ------------------------------------------------------------ view box */

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function toSheet(evt) {
    const r = svg.getBoundingClientRect();
    return {
      x: view.x + ((evt.clientX - r.left) / r.width) * view.w,
      y: view.y + ((evt.clientY - r.top) / r.height) * view.h
    };
  }

  function zoomBy(factor, focus) {
    const nw = Math.min(SHEET_W * 2.5, Math.max(260, view.w * factor));
    const scale = nw / view.w;
    const f = focus || { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    view.x = f.x - (f.x - view.x) * scale;
    view.y = f.y - (f.y - view.y) * scale;
    view.w = nw;
    view.h = nw * (SHEET_H / SHEET_W);
    applyView();
    render();
  }

  /**
   * Bounding box of everything drawn, padded, in sheet coordinates.
   * Measured from the rendered SVG so label and value text are included —
   * the geometric bounds cover only the symbols, and text sits outside them.
   */
  function contentBox(pad = 26) {
    const { comps, wires, notes } = store.state;
    if (!comps.length && !wires.length && !notes.length) return { x: 0, y: 0, w: SHEET_W, h: SHEET_H };

    try {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, seen = false;
      for (const node of svg.children) {
        if (node.tagName !== "g" || node.classList.contains("grid-layer")) continue;
        const b = node.getBBox();
        if (!b.width && !b.height) continue;
        seen = true;
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      }
      if (seen) {
        return { x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2 };
      }
    } catch { /* no layout available; fall through to the geometric bounds */ }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    comps.forEach((c) => {
      const b = boxOf(c, pad);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    });
    wires.forEach((w) => {
      x0 = Math.min(x0, w.x1 - pad, w.x2 - pad); y0 = Math.min(y0, w.y1 - pad, w.y2 - pad);
      x1 = Math.max(x1, w.x1 + pad, w.x2 + pad); y1 = Math.max(y1, w.y1 + pad, w.y2 + pad);
    });
    store.state.notes.forEach((n) => {
      const width = (n.text || "").length * 7;
      x0 = Math.min(x0, n.x - pad); y0 = Math.min(y0, n.y - 14 - pad);
      x1 = Math.max(x1, n.x + width + pad); y1 = Math.max(y1, n.y + pad);
    });
    return { x: x0, y: y0, w: Math.max(80, x1 - x0), h: Math.max(80, y1 - y0) };
  }

  /** Frame a dragged rectangle, widened to the sheet's aspect ratio. */
  function zoomToRect(r) {
    const ratio = SHEET_H / SHEET_W;
    const w = Math.max(r.w, r.h / ratio, 80);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    view = { x: cx - w / 2, y: cy - (w * ratio) / 2, w, h: w * ratio };
    applyView();
    render();
  }

  function fit() {
    // Measure after a render so annotation text, which has no geometric
    // bounds of its own, is included rather than cropped.
    render();
    const b = contentBox();
    const ratio = SHEET_H / SHEET_W;
    const w = Math.max(b.w, b.h / ratio, 300);
    view = {
      x: b.x + b.w / 2 - w / 2,
      y: b.y + b.h / 2 - (w * ratio) / 2,
      w,
      h: w * ratio
    };
    applyView();
    render();
  }


  /* ------------------------------------------------------------ hit test */

  function hitAt(p) {
    for (let i = store.state.notes.length - 1; i >= 0; i--) {
      const n = store.state.notes[i];
      const b = noteBoxes.get(n.id);
      if (b && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) {
        return { kind: "note", id: n.id };
      }
    }
    const comps = store.state.comps;
    for (let i = comps.length - 1; i >= 0; i--) {
      const b = boxOf(comps[i], 4);
      if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) return { kind: "comp", id: comps[i].id };
    }
    const wires = store.state.wires;
    const tol = 7 * (view.w / SHEET_W);
    for (let i = wires.length - 1; i >= 0; i--) {
      if (distToSeg(p.x, p.y, wires[i]) < tol) return { kind: "wire", id: wires[i].id };
    }
    return null;
  }

  /** A free wire end near the pointer, ignoring ends that sit on a pin. */
  function wireEndAt(p) {
    const tol = 8 * (view.w / SHEET_W);
    const pins = new Set();
    store.state.comps.forEach((c) => pinsOf(c).forEach((q) => pins.add(`${q.x},${q.y}`)));
    for (const w of store.state.wires) {
      for (const end of [1, 2]) {
        const x = end === 1 ? w.x1 : w.x2;
        const y = end === 1 ? w.y1 : w.y2;
        if (pins.has(`${x},${y}`)) continue;      // that end belongs to a part
        if (Math.hypot(p.x - x, p.y - y) < tol) return { wire: w, end };
      }
    }
    return null;
  }

  /** Nearest wire or pin coordinate to click for a voltage probe. */
  function probeTargetAt(p) {
    const tol = 9 * (view.w / SHEET_W);
    for (const c of store.state.comps) {
      if (c.type === "GND") continue;
      const pins = pinsOf(c);
      for (const pin of pins) {
        if (Math.hypot(p.x - pin.x, p.y - pin.y) < tol) return { x: pin.x, y: pin.y };
      }
    }
    for (const w of store.state.wires) {
      if (distToSeg(p.x, p.y, w) < tol) {
        const horizontal = w.y1 === w.y2;
        return horizontal ? { x: snap(p.x), y: w.y1 } : { x: w.x1, y: snap(p.y) };
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- render */

  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    net = buildNodes(store.state.comps, store.state.wires);

    drawGrid();
    drawWires();
    drawJunctions();
    drawComps();
    drawNodeTags();
    drawNotes();
    drawProbes();
    drawSelection();
    drawGhosts();
  }

  function drawGrid() {
    const g = el("g", { "aria-hidden": "true", class: "grid-layer" }, svg);
    const step = view.w > SHEET_W * 1.2 ? GRID * 2 : GRID;
    const x0 = Math.floor(view.x / step) * step, x1 = view.x + view.w;
    const y0 = Math.floor(view.y / step) * step, y1 = view.y + view.h;
    for (let x = x0; x <= x1; x += step) {
      for (let y = y0; y <= y1; y += step) {
        const major = x % 100 === 0 && y % 100 === 0;
        el("circle", { cx: x, cy: y, r: major ? 1.5 : 0.9, class: major ? "grid-major" : "grid-dot" }, g);
      }
    }
  }

  function drawWires() {
    const g = el("g", null, svg);
    store.state.wires.forEach((w) => {
      const sel = store.selection.has(w.id);
      el("line", { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, class: "wire" + (sel ? " is-selected" : "") }, g);
      if (sel) {
        el("rect", { x: w.x1 - 4, y: w.y1 - 4, width: 8, height: 8, class: "wire-handle" }, g);
        el("rect", { x: w.x2 - 4, y: w.y2 - 4, width: 8, height: 8, class: "wire-handle" }, g);
      }
    });
  }

  function drawJunctions() {
    const g = el("g", { "aria-hidden": "true" }, svg);
    net.degree.forEach((deg, k) => {
      const [x, y] = k.split(",").map(Number);
      if (deg >= 3) {
        el("circle", { cx: x, cy: y, r: 3.4, class: "junction" }, g);
      } else if (deg === 1) {
        // A wire end touching nothing. Common while drawing, but a floating
        // run left behind by a move is otherwise easy to miss.
        el("circle", { cx: x, cy: y, r: 4.5, class: "wire-open" }, g);
      }
    });
  }

  function drawComps() {
    const g = el("g", null, svg);
    store.state.comps.forEach((c) => {
      const def = PARTS[c.type];
      const sel = store.selection.has(c.id);
      const grp = el("g", {
        transform: `translate(${c.x},${c.y}) rotate(${c.rot || 0})`,
        class: "part" + (sel ? " is-selected" : "")
      }, g);
      const fills = filledIndices(c.type);
      shapeOf(c).forEach((d, i) => {
        el("path", { d, class: fills.includes(i) ? "part-path is-filled" : "part-path" }, grp);
      });

      pinsOf(c).forEach((p, i) => {
        const node = net.pinNode.get(`${c.id}:${i}`);
        const alone = node !== 0 && (net.pinCount.get(node) || 0) < 2;
        el("circle", { cx: p.x, cy: p.y, r: alone ? 4.5 : 2.6, class: alone ? "pin is-open" : "pin" }, g);
      });

      if (!def.noLabel) {
        const t = textAnchor(c);
        const lab = el("text", {
          x: t.lx, y: t.ly, class: "part-label", "text-anchor": t.anchor,
          "data-edit": "label", "data-id": c.id
        }, g);
        lab.textContent = c.label;
        const valueText = summarise(c);
        if (valueText) {
          const val = el("text", {
            x: t.vx, y: t.vy, class: "part-value", "text-anchor": t.anchor,
            "data-edit": "value", "data-id": c.id
          }, g);
          val.textContent = valueText;
        }
      }
    });
  }

  function summarise(c) {
    const def = PARTS[c.type];
    if (def.summary) return def.summary(c);
    const parts = [];
    def.fields.forEach((f) => {
      const v = c[f.k];
      if (!String(v ?? "").trim()) return;
      if (f.k === "closed") { parts.push(f.labels[String(v)]); return; }
      if (f.k === "ac") { parts.push(`ac ${v}`); return; }
      if (f.k === "ic") { parts.push(`ic ${v}`); return; }
      parts.push(String(v));
    });
    return parts.join(" ");
  }

  function drawNodeTags() {
    const g = el("g", { "aria-hidden": "true" }, svg);
    const shown = new Set();
    store.state.comps.forEach((c) => {
      if (c.type === "GND") return;
      pinsOf(c).forEach((p, i) => {
        const nd = net.pinNode.get(`${c.id}:${i}`);
        if (nd === undefined || nd === 0 || shown.has(nd)) return;
        shown.add(nd);
        const t = el("text", { x: p.x + 6, y: p.y - 7, class: "node-tag" }, g);
        t.textContent = String(nd);
      });
    });
  }

  function drawNotes() {
    noteBoxes.clear();
    const g = el("g", null, svg);
    store.state.notes.forEach((n) => {
      const sel = store.selection.has(n.id);
      const t = el("text", {
        x: n.x, y: n.y,
        class: "note" + (sel ? " is-selected" : ""),
        "data-edit": "note", "data-id": n.id
      }, g);
      t.textContent = n.text || "…";
      try {
        const b = t.getBBox();
        noteBoxes.set(n.id, { x0: b.x - 4, y0: b.y - 3, x1: b.x + b.width + 4, y1: b.y + b.height + 3 });
      } catch {
        const w = (n.text || "…").length * 7.4;
        noteBoxes.set(n.id, { x0: n.x - 4, y0: n.y - 16, x1: n.x + w + 4, y1: n.y + 5 });
      }
      if (sel) {
        const b = noteBoxes.get(n.id);
        el("rect", { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, class: "sel-box", rx: 2 }, g);
      }
    });
  }

  function drawProbes() {
    const g = el("g", null, svg);
    store.state.probes.forEach((pr, i) => {
      if (pr.kind === "v") {
        const cls = `probe probe-${i % 6}`;
        el("circle", { cx: pr.x, cy: pr.y, r: 6, class: cls }, g);
        const t = el("text", { x: pr.x + 9, y: pr.y + 14, class: "probe-label" }, g);
        t.textContent = probeName(pr);
      } else {
        const c = store.state.comps.find((k) => netlistNameOf(k) === pr.ref);
        if (!c) return;
        const b = boxOf(c, 6);
        el("rect", { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, class: "probe-box", rx: 3 }, g);
        // above the part's own label, so it never lands on the wire it measures
        const t = el("text", { x: (b.x0 + b.x1) / 2, y: b.y0 - 14, class: "probe-label", "text-anchor": "middle" }, g);
        t.textContent = probeName(pr);
      }
    });
  }

  function probeName(pr) {
    if (pr.kind === "i") return `i(${pr.ref.toLowerCase()})`;
    const nd = net.coordNode.get(`${pr.x},${pr.y}`);
    return nd === undefined ? "v(?)" : `v(${nd})`;
  }

  function drawSelection() {
    const g = el("g", { "aria-hidden": "true" }, svg);
    store.selectedComps().forEach((c) => {
      const b = boxOf(c, 5);
      el("rect", { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, class: "sel-box", rx: 2 }, g);
    });
  }

  function drawGhosts() {
    if (gesture?.mode === "band" || gesture?.mode === "zoomband") {
      const b = gesture.box;
      el("rect", {
        x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1),
        width: Math.abs(b.x1 - b.x0), height: Math.abs(b.y1 - b.y0),
        class: "band"
      }, svg);
    }
    if (tool === "wire" && wireRun && hover) {
      const e = ortho(wireRun, hover);
      el("line", { x1: wireRun.x, y1: wireRun.y, x2: e.x, y2: e.y, class: "preview" }, svg);
    }
    if (caret && tool !== "select" && tool !== "pan" && tool !== "zoomrect") {
      const g = el("g", { class: "caret", "aria-hidden": "true" }, svg);
      el("path", { d: `M${caret.x - 11} ${caret.y}H${caret.x + 11}M${caret.x} ${caret.y - 11}V${caret.y + 11}` }, g);
      el("circle", { cx: caret.x, cy: caret.y, r: 3 }, g);
    }
    if (tool === "text" && hover) {
      const t = el("text", { x: hover.x, y: hover.y, class: "note", opacity: "0.45" }, svg);
      t.textContent = "text";
    }
    if (PARTS[tool] && hover) {
      const grp = el("g", { transform: `translate(${hover.x},${hover.y})`, class: "ghost" }, svg);
      const fake = { type: tool, rot: ghostRot, ...defaultsFor(tool) };
      grp.setAttribute("transform", `translate(${hover.x},${hover.y}) rotate(${ghostRot})`);
      shapeOf(fake).forEach((d) => el("path", { d, class: "part-path" }, grp));
    }
    if (tool === "probe" && hover) {
      const t = probeTargetAt(hover);
      if (t) el("circle", { cx: t.x, cy: t.y, r: 6, class: "probe probe-ghost" }, svg);
    }
  }

  function defaultsFor(type) {
    const o = {};
    PARTS[type].fields.forEach((f) => { o[f.k] = f.def; });
    return o;
  }

  let ghostRot = 0;

  function ortho(a, b) {
    if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) return { x: b.x, y: a.y };
    return { x: a.x, y: b.y };
  }

  /* ----------------------------------------------------------- gestures */

  svg.addEventListener("pointerdown", (evt) => {
    if (evt.button === 1 && viewLocked) return;
    if (evt.button === 1 || (evt.button === 0 && tool === "pan")) {
      gesture = { mode: "pan", start: toSheet(evt), view: { ...view } };
      svg.setPointerCapture(evt.pointerId);
      evt.preventDefault();
      return;
    }
    if (evt.button !== 0) return;
    svg.focus({ preventScroll: true });
    const p = toSheet(evt);
    const sp = { x: snap(p.x), y: snap(p.y) };

    // render() rebuilds the sheet on every pointerdown, which detaches the
    // node the press landed on. Chrome then has no common ancestor for the
    // press and release, so it never fires click or dblclick here at all.
    // Double-clicks are therefore timed by hand.
    const now = performance.now();
    const isDouble = lastDown && now - lastDown.t < 400 &&
      Math.abs(evt.clientX - lastDown.cx) < 6 && Math.abs(evt.clientY - lastDown.cy) < 6;
    lastDown = { t: now, cx: evt.clientX, cy: evt.clientY };

    if (isDouble) {
      // Suppress the compatibility mouse events. Without this the default
      // mousedown focus lands on the sheet, blurring the editor we are about
      // to open and committing it before a key is pressed.
      evt.preventDefault();
      if (tool === "wire") { wireRun = null; render(); return; }
      if (tool === "select") { handleDoubleClick(evt, p); return; }
    }

    if (tool === "zoomrect") {
      gesture = { mode: "zoomband", box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } };
      svg.setPointerCapture(evt.pointerId);
      render();
      return;
    }

    if (tool === "text") {
      const note = { ref: null };
      store.edit(() => { note.ref = store.addNote(sp.x, sp.y, ""); }, "note");
      store.selection = new Set([note.ref.id]);
      onSelectionChange?.();
      render();
      const anchor = svg.querySelector(`[data-edit="note"][data-id="${note.ref.id}"]`);
      if (anchor) beginNoteEdit(note.ref, anchor);
      say("Annotation added. Type the text, then press Enter.");
      return;
    }

    if (tool === "probe") {
      const target = probeTargetAt(p);
      if (target) {
        const ref = `${target.x},${target.y}`;
        const added = store.toggleProbe("v", ref, { x: target.x, y: target.y });
        say(added ? `Voltage probe added at ${probeName({ kind: "v", ...target })}.` : "Voltage probe removed.");
      } else {
        const hit = hitAt(p);
        const c = hit?.kind === "comp" ? store.comp(hit.id) : null;
        if (c && (c.type === "V" || c.type === "L" || c.type === "AM")) {
          const added = store.toggleProbe("i", netlistNameOf(c), {});
          say(added ? `Current probe added on ${c.label}.` : "Current probe removed.");
        } else {
          say("Click a wire or a pin for a voltage probe, or an ammeter, voltage source or inductor for a current probe.");
        }
      }
      render();
      return;
    }

    if (tool === "wire") {
      if (!wireRun) {
        wireRun = sp;
        say("Wire started. Click the next corner; Escape ends the run.");
      } else {
        const e = ortho(wireRun, sp);
        if (e.x !== wireRun.x || e.y !== wireRun.y) {
          store.edit(() => store.addWire(wireRun.x, wireRun.y, e.x, e.y), "wire");
          wireRun = e;
        }
      }
      render();
      return;
    }

    if (PARTS[tool]) {
      let placed;
      store.edit(() => {
        placed = store.addComp(tool, sp.x, sp.y, PARTS[tool].prefix);
        placed.rot = ghostRot;
      }, "place");
      store.selection = new Set([placed.id]);
      onSelectionChange?.();
      say(`${placed.label} placed at ${sp.x}, ${sp.y}.`);
      render();
      return;
    }

    // select tool: grabbing a wire end reroutes it
    if (tool === "select" && !evt.altKey) {
      const grab = wireEndAt(p);
      if (grab) {
        store.selection = new Set([grab.wire.id]);
        onSelectionChange?.();
        store.begin();
        gesture = { mode: "wire-end", wire: grab.wire, end: grab.end, moved: false };
        svg.setPointerCapture(evt.pointerId);
        render();
        say("Dragging the end of a wire.");
        return;
      }
    }

    const hit = hitAt(p);
    if (!hit) {
      if (!evt.shiftKey) { store.selection.clear(); onSelectionChange?.(); }
      gesture = { mode: "band", box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, additive: evt.shiftKey };
      svg.setPointerCapture(evt.pointerId);
      render();
      return;
    }

    if (evt.shiftKey) {
      if (store.selection.has(hit.id)) store.selection.delete(hit.id);
      else store.selection.add(hit.id);
    } else if (!store.selection.has(hit.id)) {
      store.selection = new Set([hit.id]);
    }
    onSelectionChange?.();

    // Alt-drag leaves a copy behind: the duplicates are created on the spot and
    // it is those that follow the pointer.
    let duplicating = false;
    if (evt.altKey && store.selection.size) {
      store.copySelection();
      if (store.paste(0, 0)) {
        duplicating = true;
        onSelectionChange?.();
        say("Dragging a copy.");
      }
    }

    // Command or Control detaches: the parts move and every wire stays exactly
    // where it is. Shift is not used for this — it already means "add to the
    // selection", and overloading it meant shift-dragging an unselected part
    // quietly added it to the selection and dragged everything at once.
    const detach = evt.metaKey || evt.ctrlKey;
    if (detach) say("Moving without dragging the wires.");

    store.begin();
    gesture = {
      mode: "move",
      duplicating,
      detach,
      attached: (detach ? [] : store.attachedWireEnds(store.selectedComps())).map((a) => ({
        ...a,
        x: a.end === 1 ? a.wire.x1 : a.wire.x2,
        y: a.end === 1 ? a.wire.y1 : a.wire.y2
      })),
      origin: sp,
      moved: false,
      comps: store.selectedComps().map((c) => ({ c, x: c.x, y: c.y })),
      wires: store.selectedWires().map((w) => ({ w, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
      notes: store.selectedNotes().map((n) => ({ n, x: n.x, y: n.y }))
    };
    svg.setPointerCapture(evt.pointerId);
    render();
  });

  svg.addEventListener("pointermove", (evt) => {
    const p = toSheet(evt);
    const sp = { x: snap(p.x), y: snap(p.y) };

    if (gesture?.mode === "pan") {
      view.x = gesture.view.x - (p.x - gesture.start.x);
      view.y = gesture.view.y - (p.y - gesture.start.y);
      applyView();
      return;
    }
    if (gesture?.mode === "band" || gesture?.mode === "zoomband") {
      gesture.box.x1 = p.x; gesture.box.y1 = p.y;
      render();
      return;
    }
    if (gesture?.mode === "wire-end") {
      const w = gesture.wire;
      if (gesture.end === 1) { w.x1 = sp.x; w.y1 = sp.y; } else { w.x2 = sp.x; w.y2 = sp.y; }
      gesture.moved = true;
      render();
      return;
    }

    if (gesture?.mode === "move") {
      const dx = sp.x - gesture.origin.x, dy = sp.y - gesture.origin.y;
      if (dx || dy) gesture.moved = true;
      gesture.comps.forEach((r) => { r.c.x = r.x + dx; r.c.y = r.y + dy; });
      gesture.wires.forEach((r) => {
        r.w.x1 = r.x1 + dx; r.w.y1 = r.y1 + dy;
        r.w.x2 = r.x2 + dx; r.w.y2 = r.y2 + dy;
      });
      gesture.notes.forEach((r) => { r.n.x = r.x + dx; r.n.y = r.y + dy; });
      // Attached wire ends travel with the part, so the wire stretches rather
      // than detaching. It may end up diagonal; that is the trade for keeping
      // the connection.
      gesture.attached.forEach((a) => {
        if (a.end === 1) { a.wire.x1 = a.x + dx; a.wire.y1 = a.y + dy; }
        else { a.wire.x2 = a.x + dx; a.wire.y2 = a.y + dy; }
      });
      render();
      return;
    }

    if (!hover || hover.x !== sp.x || hover.y !== sp.y) {
      hover = sp;
      if (tool !== "select") render();
    }
  });

  svg.addEventListener("pointerup", (evt) => {
    try { svg.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
    if (!gesture) return;

    if (gesture.mode === "zoomband") {
      const b = gesture.box;
      const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
      gesture = null;
      if (w < 8 && h < 8) {
        zoomBy(0.7, { x: b.x0, y: b.y0 });          // a plain click steps in
        say("Zoomed in.");
      } else {
        zoomToRect({ x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1), w, h });
        say("Zoomed to the selected region.");
      }
      return;
    }

    if (gesture.mode === "band") {
      const b = gesture.box;
      const r = {
        x0: Math.min(b.x0, b.x1), x1: Math.max(b.x0, b.x1),
        y0: Math.min(b.y0, b.y1), y1: Math.max(b.y0, b.y1)
      };
      if (!gesture.additive) store.selection.clear();
      store.state.comps.forEach((c) => {
        const cb = boxOf(c, 0);
        if (cb.x0 >= r.x0 && cb.x1 <= r.x1 && cb.y0 >= r.y0 && cb.y1 <= r.y1) store.selection.add(c.id);
      });
      store.state.wires.forEach((w) => {
        if (Math.min(w.x1, w.x2) >= r.x0 && Math.max(w.x1, w.x2) <= r.x1 &&
            Math.min(w.y1, w.y2) >= r.y0 && Math.max(w.y1, w.y2) <= r.y1) store.selection.add(w.id);
      });
      store.state.notes.forEach((n) => {
        const b = noteBoxes.get(n.id);
        if (b && b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1) store.selection.add(n.id);
      });
      onSelectionChange?.();
      const n = store.selection.size;
      say(n ? `${n} item${n === 1 ? "" : "s"} selected.` : "Selection cleared.");
    }

    if (gesture.mode === "wire-end") {
      const w = gesture.wire;
      if (gesture.moved && w.x1 === w.x2 && w.y1 === w.y2) {
        // Dragged onto itself: a zero-length wire is invisible and confusing.
        store.state.wires = store.state.wires.filter((k) => k.id !== w.id);
        say("Wire removed.");
      }
      if (gesture.moved) store.commit("wire-edit"); else store.pendingSnapshot = null;
      gesture = null;
      render();
      return;
    }

    if (gesture.mode === "move") {
      if (gesture.moved) store.squareUpAttached(gesture.attached);
      if (gesture.moved || gesture.duplicating) store.commit("move");
      else store.pendingSnapshot = null;
    }

    gesture = null;
    render();
  });

  svg.addEventListener("pointerleave", () => {
    if (hover) { hover = null; if (tool !== "select") render(); }
  });

  svg.addEventListener("contextmenu", (evt) => {
    if (tool === "wire" && wireRun) { evt.preventDefault(); wireRun = null; render(); }
  });

  /**
   * Edit an annotation in place. An annotation left empty is removed, so a
   * stray click with the text tool does not leave an invisible object behind.
   */
  function beginNoteEdit(note, anchorEl) {
    openEditor({
      anchorEl,
      value: note.text,
      label: "Annotation text",
      commit: (next) => {
        if (next) store.edit(() => { note.text = next; }, "note-edit");
        else store.edit((s) => { s.notes = s.notes.filter((n) => n.id !== note.id); }, "note-remove");
      },
      cancelIfEmpty: () => {
        if (!note.text) store.edit((s) => { s.notes = s.notes.filter((n) => n.id !== note.id); }, "note-remove");
      }
    });
  }

  /** Drop the active part, or start/extend a wire, at a grid point. */
  function placeAt(sp) {
    if (PARTS[tool]) {
      let placed;
      store.edit(() => {
        placed = store.addComp(tool, sp.x, sp.y, PARTS[tool].prefix);
        placed.rot = ghostRot;
      }, "place");
      store.selection = new Set([placed.id]);
      onSelectionChange?.();
      render();
      say(`${placed.label} placed at ${sp.x}, ${sp.y}.`);
      return placed;
    }
    if (tool === "wire") {
      if (!wireRun) { wireRun = { ...sp }; say("Wire started."); }
      else {
        const e = ortho(wireRun, sp);
        if (e.x !== wireRun.x || e.y !== wireRun.y) {
          store.edit(() => store.addWire(wireRun.x, wireRun.y, e.x, e.y), "wire");
          wireRun = e;
          say("Wire segment added.");
        }
      }
      render();
      return null;
    }
    if (tool === "text") {
      let note;
      store.edit(() => { note = store.addNote(sp.x, sp.y, ""); }, "note");
      store.selection = new Set([note.id]);
      render();
      const anchor = svg.querySelector(`[data-edit="note"][data-id="${note.id}"]`);
      if (anchor) beginNoteEdit(note, anchor);
      say("Annotation added. Type the text, then press Enter.");
      return note;
    }
    return null;
  }

  /** Route a double-click to the right editor, or to the inspector. */
  function handleDoubleClick(evt, sheetPoint) {
    lastDown = null;
    const text = evt.target.closest?.("[data-edit]");
    if (text && text.isConnected) {
      const id = Number(text.getAttribute("data-id"));
      const kind = text.getAttribute("data-edit");
      if (kind === "note") {
        const note = store.note(id);
        if (note) { beginNoteEdit(note, text); return; }
      }
      const comp = store.comp(id);
      if (comp) { beginInlineEdit(comp, kind, text); return; }
    }
    const noteHit = hitAt(sheetPoint);
    if (noteHit?.kind === "note") {
      const note = store.note(noteHit.id);
      const anchor = svg.querySelector(`[data-edit="note"][data-id="${note.id}"]`);
      if (note && anchor) { beginNoteEdit(note, anchor); return; }
    }
    const hit = hitAt(sheetPoint);
    if (hit?.kind !== "comp") return;
    const comp = store.comp(hit.id);
    if (!comp || !PARTS[comp.type].fields.length) return;
    const anchor = svg.querySelector(`[data-edit="value"][data-id="${comp.id}"]`)
      || svg.querySelector(`[data-edit="label"][data-id="${comp.id}"]`);
    if (anchor) beginInlineEdit(comp, "value", anchor);
  }

  /** The first field that makes sense in a one-line text box. */
  function inlineField(comp) {
    return PARTS[comp.type].fields.find((f) => !f.options) || null;
  }

  /**
   * Edit a value without leaving the sheet. An HTML input is parked over the
   * text it replaces rather than using foreignObject, which keeps focus and
   * selection behaving the way people expect from an ordinary field.
   */
  /**
   * One text editor parked over whatever is being changed — a part value, a
   * designator, or an annotation. Shared so all three behave identically:
   * Enter commits, Escape abandons, clicking away commits.
   */
  function openEditor({ anchorEl, value, label, commit, cancelIfEmpty }) {
    const hostRect = host.getBoundingClientRect();
    const rect = anchorEl.getBoundingClientRect();

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit";
    input.value = value ?? "";
    input.setAttribute("aria-label", label);
    input.style.left = `${Math.max(2, rect.left - hostRect.left - 6)}px`;
    input.style.top = `${rect.top - hostRect.top - 4}px`;
    input.style.width = `${Math.max(96, rect.width + 40)}px`;

    let done = false;
    const openedAt = performance.now();
    const finish = (accept) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.remove();
      editing = null;
      if (accept) commit(next);
      else { cancelIfEmpty?.(); render(); }
    };

    input.addEventListener("keydown", (evt) => {
      evt.stopPropagation();
      if (evt.key === "Enter") { evt.preventDefault(); finish(true); }
      if (evt.key === "Escape") { evt.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => {
      // The click that opened the editor can bounce focus straight back to the
      // sheet. Reclaim it rather than treating that as the user leaving.
      if (performance.now() - openedAt < 60) { input.focus(); return; }
      finish(true);
    });

    host.appendChild(input);
    editing = input;
    input.focus();
    input.select();
  }

  function beginInlineEdit(comp, which, anchorEl) {
    const field = which === "label" ? null : inlineField(comp);
    if (which !== "label" && !field) {
      onNeedsInspector?.(comp);
      return;
    }
    openEditor({
      anchorEl,
      value: which === "label" ? comp.label : (comp[field.k] ?? ""),
      label: which === "label"
        ? `Reference designator for ${comp.label}`
        : `${field.label} for ${comp.label}`,
      commit: (next) => {
        if (!next) { render(); return; }
        store.edit(() => {
          if (which === "label") comp.label = next;
          else comp[field.k] = next;
        }, "inline-edit");
        say(`${comp.label} set to ${next}.`);
      }
    });
  }


  svg.addEventListener("wheel", (evt) => {
    // A plain two-finger scroll belongs to the page. macOS reports a trackpad
    // pinch as a wheel event with ctrlKey set, and Ctrl or Command plus wheel
    // is the equivalent with a mouse — those are the only ones that zoom.
    // Swallowing every wheel event trapped the page behind the sheet.
    if (!(evt.ctrlKey || evt.metaKey)) return;
    if (viewLocked) return;
    evt.preventDefault();
    zoomBy(evt.deltaY > 0 ? 1.12 : 0.89, toSheet(evt));
  }, { passive: false });

  /* -------------------------------------------------------------- public */

  return {
    svg,
    render,
    fit,
    isEditing: () => !!editing,
    contentBox,

    /** Freeze the accidental view gestures: wheel zoom and middle-drag pan. */
    setViewLocked(locked) {
      viewLocked = locked;
      svg.classList.toggle("is-locked", locked);
    },
    isViewLocked: () => viewLocked,

    /** True when a tool places things and so owns the arrow keys. */
    isPlacing: () => !!PARTS[tool] || tool === "wire" || tool === "text",

    /** Nudge the keyboard placement cursor, creating it at the view centre. */
    moveCaret(dx, dy) {
      if (!caret) caret = { x: snap(view.x + view.w / 2), y: snap(view.y + view.h / 2) };
      else caret = { x: snap(caret.x + dx), y: snap(caret.y + dy) };
      render();
      return caret;
    },

    /** Place whatever the active tool places, at the cursor. */
    commitCaret() {
      if (!caret) caret = { x: snap(view.x + view.w / 2), y: snap(view.y + view.h / 2) };
      return placeAt({ ...caret });
    },

    clearCaret() { caret = null; render(); },
    zoomIn: () => zoomBy(0.8),
    zoomOut: () => zoomBy(1.25),
    getTool: () => tool,
    setTool(t) {
      tool = t;
      wireRun = null;
      svg.classList.toggle("mode-select", t === "select");
      svg.classList.toggle("mode-probe", t === "probe");
      svg.classList.toggle("mode-pan", t === "pan");
      svg.classList.toggle("mode-zoom", t === "zoomrect");
      svg.classList.toggle("mode-text", t === "text");
      render();
    },
    rotateGhost() {
      ghostRot = (ghostRot + 90) % 360;
      render();
      return ghostRot;
    },
    cancel() {
      wireRun = null;
      gesture = null;
      render();
    },
    lastNet: () => net
  };
}

export { PALETTE };
