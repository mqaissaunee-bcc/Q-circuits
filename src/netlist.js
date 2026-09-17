/**
 * Connectivity and netlist generation.
 *
 * The only genuinely fiddly part is deciding which drawn points are
 * electrically the same node. Pins and wire endpoints are collected as a flat
 * list, then merged with a union-find: identical coordinates merge, and any
 * point lying on a wire's span merges with that wire. That second rule is what
 * makes a wire ending part-way along another wire behave as a real tee.
 */

import { PARTS, MODEL_CARDS, pinsOf, boxOf, netlistNameOf, isVirtual, netNameOf } from "./parts.js";
import { parseStimulus } from "./digital.js";

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

  // Aliases and power symbols with the same name are one node, however far
  // apart they are drawn. SPICE names are case-insensitive, so matching is too.
  const byName = new Map();
  pts.forEach((p, i) => {
    const nm = p.comp ? netNameOf(p.comp) : null;
    if (!nm) return;
    const key = nm.toLowerCase();
    if (byName.has(key)) union(byName.get(key), i); else byName.set(key, i);
  });

  // any group touching a ground symbol, or an alias called 0 or GND, is node 0
  const grounded = new Set();
  const namesOfRoot = new Map();
  pts.forEach((p, i) => {
    if (!p.comp) return;
    if (p.comp.type === "GND") { grounded.add(find(i)); return; }
    const nm = netNameOf(p.comp);
    if (!nm) return;
    if (nm === "0" || nm.toLowerCase() === "gnd") { grounded.add(find(i)); return; }
    const r = find(i);
    if (!namesOfRoot.has(r)) namesOfRoot.set(r, new Map());
    namesOfRoot.get(r).set(nm.toLowerCase(), nm);
  });

  const nodeOfRoot = new Map();
  const conflicts = [];            // [[nameA, nameB, ...]] one node, several names
  let next = 0;
  pts.forEach((_, i) => {
    const r = find(i);
    if (nodeOfRoot.has(r)) return;
    if (grounded.has(r)) { nodeOfRoot.set(r, 0); return; }
    const names = namesOfRoot.get(r);
    if (names && names.size) {
      const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));
      if (sorted.length > 1) conflicts.push(sorted);
      nodeOfRoot.set(r, spiceNodeName(sorted[0]));
      return;
    }
    nodeOfRoot.set(r, ++next);
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
    const def = PARTS[c.type];
    if (isVirtual(c) && !def.countsAsPin) return;
    pinsOf(c).forEach((_, i) => {
      const nd = pinNode.get(`${c.id}:${i}`);
      // An output nobody listens to is normal (a flip-flop's Q̄), so it
      // counts as connected on its own.
      const weight = def.optionalPins?.includes(i) ? 2 : 1;
      pinCount.set(nd, (pinCount.get(nd) || 0) + weight);
    });
  });

  const distinct = new Set([...nodeOfRoot.values()].filter((n) => n !== 0));
  return { pinNode, coordNode, degree, pinCount, conflicts, count: distinct.size };
}

/**
 * Turn a user's net name into something ngspice will accept as a node.
 * A bare number would collide with the numbers the connectivity pass hands
 * out, so it gets a prefix.
 */
export function spiceNodeName(name) {
  const clean = String(name).trim().replace(/[^A-Za-z0-9_]/g, "_");
  return /^\d+$/.test(clean) ? `N${clean}` : clean;
}

/**
 * The node under a sheet point: a pin or wire end, or anywhere along a wire.
 * Probes can sit mid-wire, and those points are not in coordNode.
 */
export function nodeAtPoint(net, wires, x, y) {
  const direct = net.coordNode.get(`${x},${y}`);
  if (direct !== undefined) return direct;
  const w = wires.find((k) => onSegment({ x, y }, k));
  return w ? net.coordNode.get(`${w.x1},${w.y1}`) : undefined;
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

/** A DC sweep may name a source by its label (RANDOM) or its SPICE name (V_RANDOM). */
function sweepSourceOf(comps, name) {
  const want = String(name || "").trim().toLowerCase();
  return comps.find((c) => netlistNameOf(c).toLowerCase() === want)
    || comps.find((c) => ["V", "I", "VPULSE"].includes(c.type) && String(c.label).toLowerCase() === want)
    || null;
}

function resolveSweepSource(comps, a) {
  if (a.type !== "dc") return a;
  const c = sweepSourceOf(comps, a.dcSrc);
  return c ? { ...a, dcSrc: netlistNameOf(c) } : a;
}

/**
 * `extra.overrides` maps lower-case parameter names to the value a parametric
 * sweep wants for this run. `extra.saves` lists device quantities to keep,
 * such as @r1[i], which ngspice does not record unless asked.
 */
export function buildNetlist(comps, wires, analysis, title = "Circuit from the schematic sheet", extra = {}) {
  const net = buildNodes(comps, wires);
  const lines = [`* ${title}`];
  const models = new Set();
  const ctx = { overrides: extra.overrides || {}, analysis };

  // .param cards first: ngspice resolves {NAME} as it reads each line.
  const ordered = [...comps].sort((a, b) => (a.type === "PARAM" ? 0 : 1) - (b.type === "PARAM" ? 0 : 1));
  ordered.forEach((c) => {
    const def = PARTS[c.type];
    const nd = nodesFor(c, net);
    def.emit(c, nd, ctx).forEach((l) => lines.push(l));
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
  if (extra.saves && extra.saves.length) lines.push(`.save all ${extra.saves.join(" ")}`);
  lines.push(analysisDirective(resolveSweepSource(comps, analysis)));
  lines.push(".end");
  return { text: lines.join("\n"), net };
}

/* ------------------------------------------------------------- validation */

export function validate(comps, wires, net, analysis) {
  const msgs = [];
  const parts = comps.filter((c) => !isVirtual(c));

  if (!comps.length) {
    return [{ level: "warn", text: "The sheet is empty. Drop a part, or open one of the labs." }];
  }
  if (!parts.length) {
    msgs.push({ level: "warn", text: "There are no circuit parts on the sheet yet, only labels and symbols." });
  } else if (!comps.some((c) => c.type === "GND") && !parts.every((c) => PARTS[c.type].digital)) {
    // Digital parts carry their own ground, as PSpice's do; anything
    // analog on the sheet still needs one.
    msgs.push({ level: "error", text: "No ground. SPICE needs one node numbered 0 as its voltage reference — place a ground symbol." });
  }

  const seen = new Map();
  parts.forEach((c) => {
    const name = netlistNameOf(c);
    if (seen.has(name.toLowerCase())) msgs.push({ level: "error", text: `Two parts are both called ${name}. Reference designators have to be unique.` });
    seen.set(name.toLowerCase(), true);
    const prefix = PARTS[c.type].prefix;
    if (!PARTS[c.type].netlistName && !c.label.toUpperCase().startsWith(prefix)) {
      msgs.push({ level: "error", text: `${c.label} is a ${PARTS[c.type].name.toLowerCase()}, so its name has to start with ${prefix}. SPICE reads the first letter as the part type.` });
    }
  });

  comps.forEach((c) => {
    const def = PARTS[c.type];
    const who = def.virtual ? `A ${def.name.toLowerCase()}` : c.label;
    def.fields.forEach((f) => {
      if (f.k === "ic" || f.k === "ac") return;
      const v = String(c[f.k] ?? "").trim();
      if (!v) {
        msgs.push({ level: "error", text: `${who} has no ${f.label.toLowerCase()}.` });
        return;
      }
      if (f.options) return;
      // "1 k" is two tokens to SPICE: the value 1 and a model called k.
      if (["R", "C", "L"].includes(c.type) && /\s/.test(v)) {
        msgs.push({ level: "error", text: `${c.label} is "${v}". Take out the space: SPICE reads "${v.split(/\s+/)[0]}" as the value and the rest as something else.` });
      }
      if ((f.k === "name") && !/^[A-Za-z0-9_]+$/.test(v)) {
        msgs.push({ level: "warn", text: `The name "${v}" has characters SPICE cannot use in a node name. Stick to letters, digits and _.` });
      }
    });
  });

  // Digital sources: a mistyped command table or clock silently becomes 0 V.
  comps.forEach((c) => {
    if (c.type === "STIM") {
      const { error } = parseStimulus(c.commands, parseValue);
      if (error) msgs.push({ level: "error", text: `${c.label}: ${error}.` });
    }
    if (c.type === "DCLK") {
      ["ontime", "offtime"].forEach((k) => {
        if (!(parseValue(c[k]) > 0)) msgs.push({ level: "error", text: `${c.label}: ${k.toUpperCase()} has to be a time above zero.` });
      });
    }
  });
  if (analysis.type === "tran" && comps.some((c) => c.type === "JKFF") && (analysis.ffInit ?? "X") === "X") {
    msgs.push({ level: "warn", text: "The flip-flops start in an unknown state. Set Initialize flip-flops to 0 in the Analysis panel, as the handout does." });
  }

  // A part with both ends on one node does nothing: it has been wired out.
  parts.forEach((c) => {
    const nodes = nodesFor(c, net);
    if (nodes.length === 2 && nodes[0] !== undefined && nodes[0] === nodes[1]) {
      msgs.push({ level: "warn", text: `${c.label} has both ends on the same node, so it is shorted out. Look for a wire running across it.` });
    }
  });

  // Two parts dropped on the same spot hide each other.
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (a.x === b.x && a.y === b.y && (a.rot || 0) === (b.rot || 0)) {
        msgs.push({ level: "warn", text: `${a.label} and ${b.label} are drawn on top of each other. Drag one aside to see both.` });
      } else {
        const ba = boxOf(a, -6), bb = boxOf(b, -6);
        const overlap = ba.x0 < bb.x1 && bb.x0 < ba.x1 && ba.y0 < bb.y1 && bb.y0 < ba.y1;
        if (overlap && a.type === b.type) {
          msgs.push({ level: "warn", text: `${a.label} and ${b.label} overlap on the sheet.` });
        }
      }
    }
  }

  (net.conflicts || []).forEach((names) => {
    msgs.push({ level: "warn", text: `One node carries several names: ${names.join(", ")}. It is called ${spiceNodeName(names[0])} in the netlist.` });
  });

  comps.forEach((c) => {
    if (!PARTS[c.type].netName) return;
    const p = pinsOf(c)[0];
    if ((net.degree.get(`${p.x},${p.y}`) || 0) < 2) {
      msgs.push({ level: "warn", text: `The ${PARTS[c.type].name.toLowerCase()} ${c.name || ""} is not touching a wire or a pin, so it names nothing.` });
    }
  });

  // {NAME} values need a PARAMETERS block that defines NAME.
  const defined = new Set(comps.filter((c) => c.type === "PARAM").map((c) => String(c.name || "").trim().toLowerCase()));
  comps.forEach((c) => {
    PARTS[c.type].fields.forEach((f) => {
      const v = String(c[f.k] ?? "");
      for (const m of v.matchAll(/\{\s*([A-Za-z_]\w*)\s*\}/g)) {
        if (!defined.has(m[1].toLowerCase())) {
          msgs.push({ level: "error", text: `${c.label} uses {${m[1]}}, but no Parameter part defines ${m[1]}. Place one and name it ${m[1]}.` });
        }
      }
    });
  });
  if (analysis.paramOn) {
    const want = String(analysis.paramName || "").trim();
    if (!want) msgs.push({ level: "error", text: "The parametric sweep is on but has no parameter name." });
    else if (!defined.has(want.toLowerCase())) {
      msgs.push({ level: "error", text: `The parametric sweep varies ${want}, but no Parameter part defines it.` });
    } else if (!paramValues(analysis)) {
      msgs.push({ level: "error", text: "The parametric sweep values do not make a usable list. Check start, stop and increment." });
    }
  }

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
    if (!sweepSourceOf(comps, analysis.dcSrc)) {
      msgs.push({ level: "error", text: `The DC sweep names ${analysis.dcSrc}, which is not on the sheet.` });
    }
  }

  if (!msgs.length && parts.length) {
    msgs.push({ level: "ok", text: `Connectivity is clean. ${net.count} node${net.count === 1 ? "" : "s"} above ground, ${parts.length} part${parts.length === 1 ? "" : "s"}.` });
  }
  return msgs;
}

/* ------------------------------------------------------ parametric sweep */

const PARAM_RUN_LIMIT = 12;

/**
 * The values a parametric sweep steps through, or null when it is off or
 * malformed. Capped, because every value is a separate ngspice run.
 */
export function paramValues(a) {
  if (!a || !a.paramOn) return null;
  let vals;
  if (a.paramMode === "list") {
    vals = String(a.paramList || "").split(/[\s,]+/).filter(Boolean).map(parseValue);
  } else {
    const start = parseValue(a.paramStart), stop = parseValue(a.paramStop), step = parseValue(a.paramStep);
    if (![start, stop, step].every(isFinite) || step <= 0) return null;
    vals = [];
    const dir = stop >= start ? 1 : -1;
    for (let k = 0; k <= PARAM_RUN_LIMIT; k++) {
      const v = start + dir * k * step;
      if ((dir > 0 && v > stop + step * 1e-9) || (dir < 0 && v < stop - step * 1e-9)) break;
      vals.push(Number(v.toPrecision(12)));
    }
  }
  if (!vals.length || vals.some((v) => !isFinite(v)) || vals.length > PARAM_RUN_LIMIT) return null;
  return vals;
}

export { PARAM_RUN_LIMIT };

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
      // Trim zeros only after a decimal point: 100 must stay 100, not 1.
      let s = (v / scale).toPrecision(digits);
      if (s.includes(".") && !/e/i.test(s)) s = s.replace(/0+$/, "").replace(/\.$/, "");
      return s + suffix;
    }
  }
  return v.toExponential(2);
}
