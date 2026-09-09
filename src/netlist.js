/**
 * Connectivity and netlist generation.
 *
 * The only genuinely fiddly part is deciding which drawn points are
 * electrically the same node. Pins and wire endpoints are collected as a flat
 * list, then merged with a union-find: identical coordinates merge, and any
 * point lying on a wire's span merges with that wire. That second rule is what
 * makes a wire ending part-way along another wire behave as a real tee.
 */

import { PARTS, MODEL_CARDS, pinsOf, netlistNameOf } from "./parts.js";

/* ----------------------------------------------------------- connectivity */

function onSegment(p, w) {
  const minx = Math.min(w.x1, w.x2), maxx = Math.max(w.x1, w.x2);
  const miny = Math.min(w.y1, w.y2), maxy = Math.max(w.y1, w.y2);
  if (p.x < minx - 0.5 || p.x > maxx + 0.5) return false;
  if (p.y < miny - 0.5 || p.y > maxy + 0.5) return false;
  const cross = (p.x - w.x1) * (w.y2 - w.y1) - (p.y - w.y1) * (w.x2 - w.x1);
  return Math.abs(cross) < 1;
}

export function buildNodes(comps, wires) {
  const pts = [];
  comps.forEach((c) => {
    pinsOf(c).forEach((p, i) => pts.push({ x: p.x, y: p.y, comp: c, pin: i }));
  });
  wires.forEach((w) => {
    pts.push({ x: w.x1, y: w.y1, wire: w });
    pts.push({ x: w.x2, y: w.y2, wire: w });
  });

  const parent = pts.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  const firstAt = new Map();
  pts.forEach((p, i) => {
    const k = `${p.x},${p.y}`;
    if (!firstAt.has(k)) firstAt.set(k, i); else union(firstAt.get(k), i);
  });

  wires.forEach((w) => {
    const anchor = firstAt.get(`${w.x1},${w.y1}`);
    pts.forEach((p, i) => { if (onSegment(p, w)) union(anchor, i); });
  });

  // any group touching a ground symbol is node 0
  const grounded = new Set();
  pts.forEach((p, i) => { if (p.comp && p.comp.type === "GND") grounded.add(find(i)); });

  const nodeOfRoot = new Map();
  let next = 0;
  pts.forEach((_, i) => {
    const r = find(i);
    if (nodeOfRoot.has(r)) return;
    nodeOfRoot.set(r, grounded.has(r) ? 0 : ++next);
  });

  const pinNode = new Map();      // comp.id:pinIndex -> node
  const coordNode = new Map();    // "x,y" -> node
  const degree = new Map();       // "x,y" -> connection count, for junction dots
  pts.forEach((p, i) => {
    const node = nodeOfRoot.get(find(i));
    if (p.comp) pinNode.set(`${p.comp.id}:${p.pin}`, node);
    const k = `${p.x},${p.y}`;
    coordNode.set(k, node);
    degree.set(k, (degree.get(k) || 0) + 1);
  });
  wires.forEach((w) => {
    degree.forEach((v, k) => {
      const [x, y] = k.split(",").map(Number);
      const isEnd = (x === w.x1 && y === w.y1) || (x === w.x2 && y === w.y2);
      if (!isEnd && onSegment({ x, y }, w)) degree.set(k, v + 2);
    });
  });

  const pinCount = new Map();     // node -> how many part pins touch it
  comps.forEach((c) => {
    if (c.type === "GND") return;
    pinsOf(c).forEach((_, i) => {
      const nd = pinNode.get(`${c.id}:${i}`);
      pinCount.set(nd, (pinCount.get(nd) || 0) + 1);
    });
  });

  return { pinNode, coordNode, degree, pinCount, count: next };
}

export function nodesFor(comp, net) {
  return PARTS[comp.type].pins.map((_, i) => net.pinNode.get(`${comp.id}:${i}`));
}

/* -------------------------------------------------------------- directives */

export function analysisDirective(a) {
  switch (a.type) {
    case "op": return ".op";
    case "dc": return `.dc ${a.dcSrc} ${a.dcStart} ${a.dcStop} ${a.dcStep}`;
    case "ac": return `.ac dec ${a.acPts} ${a.acStart} ${a.acStop}`;
    default: return `.tran ${a.trStep} ${a.trStop}${a.trUic ? " uic" : ""}`;
  }
}

/* ---------------------------------------------------------------- netlist */

export function buildNetlist(comps, wires, analysis, title = "Circuit from the schematic sheet") {
  const net = buildNodes(comps, wires);
  const lines = [`* ${title}`];
  const models = new Set();

  comps.forEach((c) => {
    const def = PARTS[c.type];
    const nd = nodesFor(c, net);
    def.emit(c, nd).forEach((l) => lines.push(l));
    def.models(c).forEach((m) => models.add(m));
  });

  if (models.size) {
    lines.push("");
    [...models].sort().forEach((m) => {
      const card = MODEL_CARDS[m];
      if (card) lines.push(card);
    });
  }

  lines.push("");
  lines.push(analysisDirective(analysis));
  lines.push(".end");
  return { text: lines.join("\n"), net };
}

/* ------------------------------------------------------------- validation */

export function validate(comps, wires, net, analysis) {
  const msgs = [];
  const parts = comps.filter((c) => c.type !== "GND");

  if (!parts.length) {
    return [{ level: "warn", text: "The sheet is empty. Drop a part, or open one of the labs." }];
  }
  if (!comps.some((c) => c.type === "GND")) {
    msgs.push({ level: "error", text: "No ground. SPICE needs one node numbered 0 as its voltage reference — place a ground symbol." });
  }

  const seen = new Map();
  parts.forEach((c) => {
    const name = netlistNameOf(c);
    if (seen.has(name)) msgs.push({ level: "error", text: `Two parts are both called ${name}. Reference designators have to be unique.` });
    seen.set(name, true);
    PARTS[c.type].fields.forEach((f) => {
      if (f.k === "ic" || f.k === "ac") return;
      if (!String(c[f.k] ?? "").trim()) {
        msgs.push({ level: "error", text: `${c.label} has no ${f.label.toLowerCase()}.` });
      }
    });
  });

  net.pinCount.forEach((n, node) => {
    if (node !== 0 && n < 2) {
      msgs.push({ level: "warn", text: `Node ${node} has only one pin on it. ngspice will refuse to converge on a dangling node.` });
    }
  });

  if (analysis.type === "ac") {
    const anyAc = comps.some((c) => (c.type === "V" || c.type === "I") &&
      (String(c.ac || "").trim() || /\bac\b/i.test(String(c.value || ""))));
    if (!anyAc) msgs.push({ level: "warn", text: "An AC sweep needs a source with an AC magnitude. Select a source and set it to 1." });
  }
  if (analysis.type === "dc") {
    const wanted = String(analysis.dcSrc || "").trim().toLowerCase();
    if (!comps.some((c) => netlistNameOf(c).toLowerCase() === wanted)) {
      msgs.push({ level: "error", text: `The DC sweep names ${analysis.dcSrc}, which is not on the sheet.` });
    }
  }

  if (!msgs.length) {
    msgs.push({ level: "ok", text: `Connectivity is clean. ${net.count} node${net.count === 1 ? "" : "s"} above ground, ${parts.length} part${parts.length === 1 ? "" : "s"}.` });
  }
  return msgs;
}

/* ------------------------------------------------------ numbers and units */

const MULT = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, mil: 25.4e-6, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };

export function parseValue(s) {
  if (s === null || s === undefined) return NaN;
  const m = String(s).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|mil|[tgkmunpf])?/i);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  const suf = (m[2] || "").toLowerCase();
  if (suf && MULT[suf] !== undefined) v *= MULT[suf];
  return v;
}

const UNITS = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];

export function formatEng(v, digits = 4) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  for (const [scale, suffix] of UNITS) {
    if (a >= scale) {
      const s = (v / scale).toPrecision(digits).replace(/\.?0+$/, "");
      return s + suffix;
    }
  }
  return v.toExponential(2);
}
