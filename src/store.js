/**
 * Application state.
 *
 * Undo is snapshot based: the schematic is small enough that cloning it on
 * every committed edit costs nothing, and it removes a whole class of bugs
 * that command-pattern undo tends to attract. Edits during a drag are applied
 * live but only committed to the history when the gesture ends.
 */

import { makeComp } from "./parts.js";

const STORAGE_KEY = "spice-lab-v1";
const HISTORY_LIMIT = 60;

export const DEFAULT_ANALYSIS = {
  type: "tran",
  dcSrc: "V1", dcStart: "0", dcStop: "10", dcStep: "0.05",
  trStep: "10u", trStop: "5m", trUic: false,
  acPts: "25", acStart: "10", acStop: "1meg"
};

export class Store {
  constructor() {
    this.state = {
      title: "Untitled circuit",
      comps: [],
      wires: [],
      seq: {},
      analysis: { ...DEFAULT_ANALYSIS },
      probes: []           // [{kind:'v'|'i', node, label}]
    };
    this.selection = new Set();   // ids of comps and wires
    this.uid = 1;
    this.past = [];
    this.future = [];
    this.clipboard = null;
    this.listeners = new Set();
    this.pendingSnapshot = null;
  }

  /* ------------------------------------------------------------ plumbing */

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(reason = "change") { this.listeners.forEach((fn) => fn(this.state, reason)); }

  snapshot() { return JSON.parse(JSON.stringify(this.state)); }

  /** Take a checkpoint before a mutation that should be undoable. */
  begin() {
    if (this.pendingSnapshot) return;
    this.pendingSnapshot = this.snapshot();
  }

  /** Commit the checkpoint taken by begin(). */
  commit(reason = "edit") {
    if (this.pendingSnapshot) {
      this.past.push(this.pendingSnapshot);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future.length = 0;
      this.pendingSnapshot = null;
    }
    this.save();
    this.emit(reason);
  }

  /** One-shot edit: checkpoint, mutate, commit. */
  edit(fn, reason) {
    this.begin();
    fn(this.state);
    this.commit(reason);
  }

  /** Mutate without touching history, for live drag feedback. */
  touch(reason = "live") { this.emit(reason); }

  undo() {
    if (!this.past.length) return false;
    this.future.push(this.snapshot());
    this.state = this.past.pop();
    this.pruneSelection();
    this.save();
    this.emit("undo");
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(this.snapshot());
    this.state = this.future.pop();
    this.pruneSelection();
    this.save();
    this.emit("redo");
    return true;
  }

  /** Keep only ids that still exist, so undoing an unrelated edit does not
   *  silently drop what the user had selected. */
  pruneSelection() {
    const live = new Set([
      ...this.state.comps.map((c) => c.id),
      ...this.state.wires.map((w) => w.id)
    ]);
    [...this.selection].forEach((id) => { if (!live.has(id)) this.selection.delete(id); });
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  /* ------------------------------------------------------------- lookups */

  comp(id) { return this.state.comps.find((c) => c.id === id) || null; }
  wire(id) { return this.state.wires.find((w) => w.id === id) || null; }

  selectedComps() {
    return this.state.comps.filter((c) => this.selection.has(c.id));
  }
  selectedWires() {
    return this.state.wires.filter((w) => this.selection.has(w.id));
  }

  /* ----------------------------------------------------------- mutations */

  nextLabel(prefix) {
    const seq = this.state.seq;
    let n = (seq[prefix] || 0) + 1;
    const taken = new Set(this.state.comps.map((c) => c.label));
    while (taken.has(prefix + n)) n++;
    seq[prefix] = n;
    return prefix + n;
  }

  addComp(type, x, y, prefix) {
    const label = type === "GND" ? "GND" : this.nextLabel(prefix);
    const c = makeComp(type, x, y, label);
    c.id = this.uid++;
    this.state.comps.push(c);
    return c;
  }

  addWire(x1, y1, x2, y2) {
    const w = { id: this.uid++, x1, y1, x2, y2 };
    this.state.wires.push(w);
    return w;
  }

  deleteSelection() {
    if (!this.selection.size) return 0;
    const n = this.selection.size;
    this.edit((s) => {
      s.comps = s.comps.filter((c) => !this.selection.has(c.id));
      s.wires = s.wires.filter((w) => !this.selection.has(w.id));
    }, "delete");
    this.selection.clear();
    return n;
  }

  copySelection() {
    const comps = this.selectedComps();
    const wires = this.selectedWires();
    if (!comps.length && !wires.length) return 0;
    this.clipboard = JSON.parse(JSON.stringify({ comps, wires }));
    return comps.length + wires.length;
  }

  cutSelection() {
    const n = this.copySelection();
    if (n) this.deleteSelection();
    return n;
  }

  /** Paste offset by one grid diagonal so the copy is visible. */
  paste(dx = 40, dy = 40) {
    if (!this.clipboard) return 0;
    const added = [];
    this.edit((s) => {
      this.clipboard.comps.forEach((src) => {
        const c = JSON.parse(JSON.stringify(src));
        c.id = this.uid++;
        c.x += dx; c.y += dy;
        if (c.type !== "GND") {
          const prefix = c.label.replace(/\d+$/, "") || "X";
          c.label = this.nextLabel(prefix);
        }
        s.comps.push(c);
        added.push(c.id);
      });
      this.clipboard.wires.forEach((src) => {
        const w = { id: this.uid++, x1: src.x1 + dx, y1: src.y1 + dy, x2: src.x2 + dx, y2: src.y2 + dy };
        s.wires.push(w);
        added.push(w.id);
      });
    }, "paste");
    this.selection = new Set(added);
    return added.length;
  }

  /** Rotate the selection about the centre of its own bounding box. */
  rotateSelection(step = 90) {
    const comps = this.selectedComps();
    if (!comps.length) return false;
    this.edit(() => {
      if (comps.length === 1) {
        comps[0].rot = (((comps[0].rot || 0) + step) % 360 + 360) % 360;
        return;
      }
      const cx = Math.round(comps.reduce((a, c) => a + c.x, 0) / comps.length / 20) * 20;
      const cy = Math.round(comps.reduce((a, c) => a + c.y, 0) / comps.length / 20) * 20;
      comps.forEach((c) => {
        const dx = c.x - cx, dy = c.y - cy;
        c.x = cx - dy; c.y = cy + dx;
        c.rot = (((c.rot || 0) + step) % 360 + 360) % 360;
      });
      this.selectedWires().forEach((w) => {
        const a = { x: cx - (w.y1 - cy), y: cy + (w.x1 - cx) };
        const b = { x: cx - (w.y2 - cy), y: cy + (w.x2 - cx) };
        w.x1 = a.x; w.y1 = a.y; w.x2 = b.x; w.y2 = b.y;
      });
    }, "rotate");
    return true;
  }

  moveSelection(dx, dy) {
    const comps = this.selectedComps();
    const wires = this.selectedWires();
    if (!comps.length && !wires.length) return false;
    this.edit(() => {
      comps.forEach((c) => { c.x += dx; c.y += dy; });
      wires.forEach((w) => { w.x1 += dx; w.y1 += dy; w.x2 += dx; w.y2 += dy; });
    }, "move");
    return true;
  }

  clear() {
    this.edit((s) => {
      s.comps = []; s.wires = []; s.seq = {}; s.probes = [];
      s.title = "Untitled circuit";
    }, "clear");
    this.selection.clear();
  }

  /* -------------------------------------------------------------- probes */

  toggleProbe(kind, ref, extra = {}) {
    const i = this.state.probes.findIndex((p) => p.kind === kind && p.ref === ref);
    this.edit((s) => {
      if (i >= 0) s.probes.splice(i, 1);
      else s.probes.push({ kind, ref, ...extra });
    }, "probe");
    return i < 0;
  }

  hasProbe(kind, ref) {
    return this.state.probes.some((p) => p.kind === kind && p.ref === ref);
  }

  /* --------------------------------------------------------- persistence */

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: this.state, uid: this.uid }));
    } catch { /* private browsing; autosave is a convenience, not a contract */ }
  }

  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed?.state?.comps) return false;
      this.state = { ...this.state, ...parsed.state };
      this.state.analysis = { ...DEFAULT_ANALYSIS, ...(parsed.state.analysis || {}) };
      this.state.probes = parsed.state.probes || [];
      this.uid = parsed.uid || 1;
      return true;
    } catch { return false; }
  }

  /** Serialise for a .circuit.json download. */
  toDocument() {
    return JSON.stringify({
      format: "spice-lab-circuit",
      version: 1,
      savedAt: new Date().toISOString(),
      ...this.state
    }, null, 2);
  }

  loadDocument(text) {
    const doc = JSON.parse(text);
    if (doc.format !== "spice-lab-circuit") throw new Error("That file is not a Spice Lab circuit.");
    if (!Array.isArray(doc.comps)) throw new Error("That circuit file has no parts in it.");
    this.edit((s) => {
      s.title = doc.title || "Untitled circuit";
      s.comps = doc.comps;
      s.wires = doc.wires || [];
      s.seq = doc.seq || {};
      s.probes = doc.probes || [];
      s.analysis = { ...DEFAULT_ANALYSIS, ...(doc.analysis || {}) };
    }, "open");
    this.selection.clear();
    this.uid = Math.max(0, ...this.state.comps.map((c) => c.id || 0),
                           ...this.state.wires.map((w) => w.id || 0)) + 1;
  }

  /** Replace the sheet with a circuit built by a lab definition. */
  loadCircuit(circuit) {
    this.edit((s) => {
      s.title = circuit.title || "Untitled circuit";
      s.comps = circuit.comps.map((c) => ({ ...c, id: this.uid++ }));
      s.wires = (circuit.wires || []).map((w) => ({ ...w, id: this.uid++ }));
      s.seq = { ...(circuit.seq || {}) };
      s.probes = circuit.probes ? JSON.parse(JSON.stringify(circuit.probes)) : [];
      s.analysis = { ...DEFAULT_ANALYSIS, ...(circuit.analysis || {}) };
    }, "load");
    this.selection.clear();
  }
}
