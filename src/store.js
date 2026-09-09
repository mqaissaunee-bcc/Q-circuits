/**
 * Application state.
 *
 * Undo is snapshot based: the schematic is small enough that cloning it on
 * every committed edit costs nothing, and it removes a whole class of bugs
 * that command-pattern undo tends to attract. Edits during a drag are applied
 * live but only committed to the history when the gesture ends.
 */

import { makeComp, pinsOf } from "./parts.js";

const STORAGE_KEY = "q-circuits-v1";
const LEGACY_STORAGE_KEY = "spice-lab-v1";     // autosave from before the rename
const DOC_FORMAT = "q-circuits-circuit";
const LIBRARY_KEY = "q-circuits-library-v1";
const PROGRESS_KEY = "q-circuits-progress-v1";
const LEGACY_DOC_FORMATS = new Set([DOC_FORMAT, "spice-lab-circuit"]);
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
      probes: [],          // [{kind:'v'|'i', node, label}]
      notes: []            // free text on the sheet; never reaches the netlist
    };
    this.selection = new Set();   // ids of comps and wires
    this.uid = 1;
    this.past = [];
    this.future = [];
    this.clipboard = null;
    this.listeners = new Set();
    this.pendingSnapshot = null;
    this.baseline = null;   // serialised state as last saved or loaded
  }

  /* ------------------------------------------------- unsaved-work tracking */

  /** Mark the current sheet as the reference point for "has this changed?". */
  markClean() { this.baseline = JSON.stringify(this.state); }

  /**
   * True when the sheet differs from the last save or load. Used to warn
   * before anything replaces it — opening a lab used to discard a student's
   * work outright, with the only recovery being an undo they had no reason to
   * know about.
   */
  isDirty() {
    if (this.baseline === null) return this.state.comps.length > 0;
    return JSON.stringify(this.state) !== this.baseline;
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
  note(id) { return this.state.notes.find((n) => n.id === id) || null; }

  selectedComps() {
    return this.state.comps.filter((c) => this.selection.has(c.id));
  }
  selectedWires() {
    return this.state.wires.filter((w) => this.selection.has(w.id));
  }
  selectedNotes() {
    return this.state.notes.filter((n) => this.selection.has(n.id));
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

  addNote(x, y, text = "") {
    const n = { id: this.uid++, x, y, text };
    this.state.notes.push(n);
    return n;
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
      s.notes = s.notes.filter((n) => !this.selection.has(n.id));
    }, "delete");
    this.selection.clear();
    return n;
  }

  copySelection() {
    const comps = this.selectedComps();
    const wires = this.selectedWires();
    const notes = this.selectedNotes();
    if (!comps.length && !wires.length && !notes.length) return 0;
    this.clipboard = JSON.parse(JSON.stringify({ comps, wires, notes }));
    return comps.length + wires.length + notes.length;
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
      (this.clipboard.notes || []).forEach((src) => {
        const n = { id: this.uid++, x: src.x + dx, y: src.y + dy, text: src.text };
        s.notes.push(n);
        added.push(n.id);
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
      // Annotations move with the group but stay upright: sideways text helps
      // nobody.
      this.selectedNotes().forEach((n) => {
        const x = cx - (n.y - cy), y = cy + (n.x - cx);
        n.x = x; n.y = y;
      });
    }, "rotate");
    return true;
  }

  /**
   * Wire ends sitting on a pin of one of `comps`. Moving a part drags these
   * with it so the wire stretches instead of tearing off. Wires that are
   * themselves selected are skipped — those travel whole.
   */
  attachedWireEnds(comps) {
    const pins = new Set();
    comps.forEach((c) => pinsOf(c).forEach((p) => pins.add(`${p.x},${p.y}`)));
    const out = [];
    this.state.wires.forEach((w) => {
      if (this.selection.has(w.id)) return;
      const horizontal = w.y1 === w.y2;
      if (pins.has(`${w.x1},${w.y1}`)) out.push({ wire: w, end: 1, horizontal });
      if (pins.has(`${w.x2},${w.y2}`)) out.push({ wire: w, end: 2, horizontal });
    });
    return out;
  }

  /**
   * A stretched wire ends up diagonal, which is not how a schematic is drawn.
   * Once the move is finished, bend each one into an elbow: along its original
   * axis from the end that stayed put, then square across to the end that moved.
   */
  squareUpAttached(attached) {
    attached.forEach(({ wire, end, horizontal }) => {
      const w = this.wire(wire.id);
      if (!w || w.x1 === w.x2 || w.y1 === w.y2) return;   // already orthogonal
      if (end === 2) {
        const corner = horizontal ? { x: w.x2, y: w.y1 } : { x: w.x1, y: w.y2 };
        const moved = { x: w.x2, y: w.y2 };
        w.x2 = corner.x; w.y2 = corner.y;
        this.addWire(corner.x, corner.y, moved.x, moved.y);
      } else {
        const corner = horizontal ? { x: w.x1, y: w.y2 } : { x: w.x2, y: w.y1 };
        const moved = { x: w.x1, y: w.y1 };
        w.x1 = corner.x; w.y1 = corner.y;
        this.addWire(moved.x, moved.y, corner.x, corner.y);
      }
    });
  }

  moveSelection(dx, dy) {
    const comps = this.selectedComps();
    const wires = this.selectedWires();
    const notes = this.selectedNotes();
    if (!comps.length && !wires.length && !notes.length) return false;
    // Work out what is attached before anything moves.
    const attached = this.attachedWireEnds(comps);
    this.edit(() => {
      comps.forEach((c) => { c.x += dx; c.y += dy; });
      wires.forEach((w) => { w.x1 += dx; w.y1 += dy; w.x2 += dx; w.y2 += dy; });
      notes.forEach((n) => { n.x += dx; n.y += dy; });
      attached.forEach(({ wire, end }) => {
        if (end === 1) { wire.x1 += dx; wire.y1 += dy; } else { wire.x2 += dx; wire.y2 += dy; }
      });
      this.squareUpAttached(attached);
    }, "move");
    return true;
  }

  clear() {
    this.edit((s) => {
      s.comps = []; s.wires = []; s.seq = {}; s.probes = []; s.notes = [];
      s.title = "Untitled circuit";
    }, "clear");
    this.selection.clear();
    this.markClean();
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

  /* ------------------------------------------------------------- library */

  readLibrary() {
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  }

  writeLibrary(lib) {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
      return true;
    } catch { return false; }
  }

  /** Names in the library, most recently saved first. */
  listSaved() {
    const lib = this.readLibrary();
    return Object.keys(lib)
      .map((name) => ({ name, savedAt: lib[name].savedAt || "" }))
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  saveToLibrary(name) {
    const key = String(name || "").trim();
    if (!key) return false;
    const lib = this.readLibrary();
    lib[key] = { savedAt: new Date().toISOString(), doc: JSON.parse(this.toDocument()) };
    if (!this.writeLibrary(lib)) return false;
    this.state.title = key;
    this.markClean();
    this.save();
    this.emit("library");
    return true;
  }

  openFromLibrary(name) {
    const entry = this.readLibrary()[name];
    if (!entry) return false;
    this.loadDocument(JSON.stringify(entry.doc));
    return true;
  }

  deleteFromLibrary(name) {
    const lib = this.readLibrary();
    if (!(name in lib)) return false;
    delete lib[name];
    this.writeLibrary(lib);
    this.emit("library");
    return true;
  }

  /* ------------------------------------------------------- lab progress */

  readProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  }

  /** Record a lab as passed. Progress only ever moves forwards. */
  recordLabPass(labId) {
    const progress = this.readProgress();
    if (progress[labId]?.passed) return progress;
    progress[labId] = { passed: true, at: new Date().toISOString() };
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch { /* storage blocked */ }
    return progress;
  }

  labPassed(labId) { return !!this.readProgress()[labId]?.passed; }

  clearProgress() {
    try { localStorage.removeItem(PROGRESS_KEY); } catch { /* storage blocked */ }
  }

  /* --------------------------------------------------------- persistence */

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: this.state, uid: this.uid }));
    } catch { /* private browsing; autosave is a convenience, not a contract */ }
  }

  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed?.state?.comps) return false;
      this.state = { ...this.state, ...parsed.state };
      this.state.analysis = { ...DEFAULT_ANALYSIS, ...(parsed.state.analysis || {}) };
      this.state.probes = parsed.state.probes || [];
      this.state.notes = parsed.state.notes || [];
      this.uid = parsed.uid || 1;
      this.markClean();
      return true;
    } catch { return false; }
  }

  /** Serialise for a .circuit.json download. */
  toDocument() {
    return JSON.stringify({
      format: DOC_FORMAT,
      version: 1,
      savedAt: new Date().toISOString(),
      ...this.state
    }, null, 2);
  }

  loadDocument(text) {
    const doc = JSON.parse(text);
    if (!LEGACY_DOC_FORMATS.has(doc.format)) throw new Error("That file is not a Q Circuits circuit.");
    if (!Array.isArray(doc.comps)) throw new Error("That circuit file has no parts in it.");
    this.edit((s) => {
      s.title = doc.title || "Untitled circuit";
      s.comps = doc.comps;
      s.wires = doc.wires || [];
      s.seq = doc.seq || {};
      s.probes = doc.probes || [];
      s.notes = doc.notes || [];
      s.analysis = { ...DEFAULT_ANALYSIS, ...(doc.analysis || {}) };
    }, "open");
    this.selection.clear();
    this.uid = Math.max(0, ...this.state.comps.map((c) => c.id || 0),
                           ...this.state.wires.map((w) => w.id || 0),
                           ...this.state.notes.map((n) => n.id || 0)) + 1;
    this.markClean();
  }

  /** Replace the sheet with a circuit built by a lab definition. */
  loadCircuit(circuit) {
    this.edit((s) => {
      s.title = circuit.title || "Untitled circuit";
      s.comps = circuit.comps.map((c) => ({ ...c, id: this.uid++ }));
      s.wires = (circuit.wires || []).map((w) => ({ ...w, id: this.uid++ }));
      s.seq = { ...(circuit.seq || {}) };
      s.probes = circuit.probes ? JSON.parse(JSON.stringify(circuit.probes)) : [];
      s.notes = (circuit.notes || []).map((n) => ({ ...n, id: this.uid++ }));
      s.analysis = { ...DEFAULT_ANALYSIS, ...(circuit.analysis || {}) };
    }, "load");
    this.selection.clear();
    this.markClean();
  }
}
