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

  // A net label renames the node it sits on, so the netlist reads in the
  // circuit's own terms rather than in numbers the editor happened to assign.
  const labelOfRoot = new Map();
  const labelClashes = [];
  pts.forEach((p, i) => {
    if (!p.comp || p.comp.type !== "NET") return;
    const wanted = String(p.comp.netname || "").trim();
    if (!wanted) return;
    const r = find(i);
    if (labelOfRoot.has(r) && labelOfRoot.get(r) !== wanted) {
      labelClashes.push({ kind: "two-names", a: labelOfRoot.get(r), b: wanted });
    } else {
      labelOfRoot.set(r, wanted);
    }
  });

  const nodeOfRoot = new Map();
  const usedNames = new Map();
  let next = 0;
  pts.forEach((_, i) => {
    const r = find(i);
    if (nodeOfRoot.has(r)) return;
    if (grounded.has(r)) { nodeOfRoot.set(r, "0"); return; }
    const label = labelOfRoot.get(r);
    if (label) {
      if (usedNames.has(label)) labelClashes.push({ kind: "reused", a: label });
      usedNames.set(label, r);
      nodeOfRoot.set(r, label);
    } else {
      nodeOfRoot.set(r, String(++next));
    }
  });

  // a label on the ground net cannot rename node 0
  const groundLabels = [];
  labelOfRoot.forEach((name, r) => { if (grounded.has(r)) groundLabels.push(name); });

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

  return { pinNode, coordNode, degree, pinCount, count: next, labelClashes, groundLabels };
}

export function nodesFor(comp, net) {
  return PARTS[comp.type].pins.map((_, i) => net.pinNode.get(`${comp.id}:${i}`));
}

/* ----------------------------------------------------------- ascii safety */

/**
 * ngspice compiled to WASM does not merely reject a non-ASCII byte — it hangs,
 * locking the browser thread with no error and no way back. A student typing
 * 10µF or 4.7kΩ, or a circuit title with an em dash, would freeze the tab.
 *
 * So the netlist is transliterated to plain ASCII before it is ever generated.
 * The substitutions are the ones that carry meaning — µ really does mean u to
 * SPICE — and anything else outside printable ASCII is dropped, which turns
 * 4.7kΩ into the 4.7k that was meant.
 */
const ASCII_SUBSTITUTIONS = [
  [/[\u00B5\u03BC]/g, "u"],        // micro sign, Greek mu
  [/[\u03A9\u2126]/g, ""],         // ohm sign: the unit is implied
  [/[\u2212\u2013\u2014]/g, "-"], // minus sign, en dash, em dash
  [/[\u2018\u2019]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/\u00D7/g, "*"],
  [/\u00F7/g, "/"],
  [/\u03C0/g, "pi"],
  [/\u00A0/g, " "],                // non-breaking space
  [/\u00B0/g, ""]                  // degree sign
];

export function toAscii(text) {
  let out = String(text);
  ASCII_SUBSTITUTIONS.forEach(([pattern, replacement]) => {
    out = out.replace(pattern, replacement);
  });
  // Anything still outside printable ASCII would hang the engine.
  return out.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

export function hasNonAscii(text) {
  return /[^\x09\x0A\x0D\x20-\x7E]/.test(String(text));
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

  const body = lines.slice(1).join("\n");
  const text = toAscii(lines.join("\n"));
  // Only flag characters the student typed; the title line is ours to clean.
  return { text, net, transliterated: toAscii(body) !== body };
}

/* --------------------------------------------------------- blocking faults */

/**
 * Faults that must never reach the engine.
 *
 * ngspice-WASM does not reject a loop of voltage sources — it spins forever,
 * locking the browser thread with no error and no way to recover short of
 * closing the tab. Two identical sources wired in parallel is a routine
 * student mistake, so the circuit is inspected for it here and the run is
 * refused with an explanation instead.
 *
 * Only genuinely hanging constructs belong in this list. Ordinary mistakes —
 * a bad value, a dangling node — produce a clean ngspice error and are far
 * more useful to a student when they see the engine report them.
 */
export function blockingFaults(comps, net) {
  const faults = [];

  // Each of these drives a node hard: a voltage source, an ammeter (a 0 V
  // source) and an ideal op-amp output, which is a source referred to ground.
  const driven = [];
  comps.forEach((c) => {
    if (c.type === "V" || c.type === "AM") {
      const nd = nodesFor(c, net);
      driven.push({ label: c.label, a: nd[0], b: nd[1] });
    } else if (c.type === "OPAMP") {
      const nd = nodesFor(c, net);
      driven.push({ label: c.label, a: nd[2], b: "0" });
    }
  });

  driven.forEach((d) => {
    if (d.a === d.b) {
      faults.push(`${d.label} has both of its terminals on the same node, which short-circuits it. Remove the short, or the part.`);
    }
  });

  for (let i = 0; i < driven.length; i++) {
    for (let j = i + 1; j < driven.length; j++) {
      const x = driven[i], y = driven[j];
      if (x.a === x.b || y.a === y.b) continue;
      const same = (x.a === y.a && x.b === y.b) || (x.a === y.b && x.b === y.a);
      if (same) {
        faults.push(`${x.label} and ${y.label} are wired in parallel across the same two nodes. Two sources cannot both set the voltage there — remove one of them.`);
      }
    }
  }

  return faults;
}

/* ------------------------------------------------------------- validation */

export function validate(comps, wires, net, analysis, transliterated = false) {
  const msgs = [];

  if (transliterated) {
    msgs.push({
      level: "warn",
      text: "Characters such as µ or Ω were converted to plain text for the simulator. Write values as 10u and 4.7k."
    });
  }
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

  net.labelClashes.forEach((c) => {
    if (c.kind === "two-names") {
      msgs.push({ level: "error", text: `The same node is labelled both ${c.a} and ${c.b}. A node can only have one name.` });
    } else {
      msgs.push({ level: "error", text: `The name ${c.a} is used on two different nodes. Net names have to be unique.` });
    }
  });
  net.groundLabels.forEach((name) => {
    msgs.push({ level: "warn", text: `The label ${name} sits on the ground net, which is always node 0 and cannot be renamed.` });
  });
  comps.filter((c) => c.type === "NET").forEach((c) => {
    const name = String(c.netname || "").trim();
    if (name && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      msgs.push({ level: "error", text: `${name} is not a usable net name. Start with a letter and use only letters, digits and underscore — no spaces.` });
    }
  });

  net.pinCount.forEach((n, node) => {
    if (node !== "0" && n < 2) {
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
    const nodes = new Set([...net.pinNode.values()].filter((n) => n !== "0")).size;
    msgs.push({ level: "ok", text: `Connectivity is clean. ${nodes} node${nodes === 1 ? "" : "s"} above ground, ${parts.length} part${parts.length === 1 ? "" : "s"}.` });
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
