/**
 * Importable lab files.
 *
 * A lab written in `src/labs.js` is JavaScript: its checks are functions. That
 * is fine for labs that ship with the app, but a lab passed between people has
 * to be inert, so an imported lab is JSON and nothing in it is ever executed.
 * This module compiles that JSON into the same check objects the built-in labs
 * use, through the same `K` builders, so an imported lab is marked by exactly
 * the code that marks a built-in one.
 *
 * Anything a lab file cannot say, it cannot do: unknown rules, unknown part
 * types and unparsable expressions are reported when the file is imported,
 * not silently ignored.
 */

import { K, PARTS, corners } from "./labs.js";
import { parseValue, formatEng, nodesFor } from "./netlist.js";
import { levelOf } from "./digital.js";

export const LABFILE_FORMAT = "q-circuits-lab";
export const LABFILE_VERSION = 1;

const lc = (s) => String(s ?? "").trim().toLowerCase();
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/* ------------------------------------------------------------ node specs */

/**
 * A node in a lab file is written as:
 *   "OUT"      a net alias, power symbol or port name
 *   "0"        ground
 *   "R1:1"     pin 1 of R1 (pin numbers are the order in the parts table)
 */
function toSpec(token, errs, where) {
  const s = String(token).trim();
  if (s === "0" || lc(s) === "gnd") return 0;
  const m = s.match(/^([A-Za-z_][\w+-]*):(\d+)$/);
  if (m) return [m[1], Number(m[2])];
  if (!/^[A-Za-z_$][\w+-]*$/.test(s)) {
    errs.push(`${where}: "${s}" is not a net name or a part pin like R1:1`);
    return s;
  }
  return s;
}

/* ------------------------------------------------------- expressions */

/**
 * The expression language for graded answers and simulated checks. It is
 * deliberately small: every reading Labs 4 to 14 ask for can be written with
 * it, and nothing in it can reach outside the simulation result.
 *
 *   v(OUT)                  node voltage
 *   v(A,B)                  difference between two nodes
 *   i(R1)                   current through a part
 *   v(B) @ 12               value at a sweep point, or a time: v(OUT) @ 4.5m
 *   max(v(IN,OUT))          largest value over the run
 *   max(v(OUT) @ 1m..3m)    largest over part of the run
 *   min(...) avg(...)
 *   peak(OUT)               flat (mid-band) level of an AC sweep, in dB
 *   corner(OUT, upper)      the -3 dB frequency above (or below) the peak
 *   gain(OUT) @ 10          the dB level at one frequency
 *   logic(Q) @ 4.5m         0 or 1
 *   logicWhile(Q, A=0, B=1) a gate's output while its inputs hold a combination
 *   count(Q3,Q2,Q1,Q0) @ 11.5m    bits read as a binary number
 *   nodes()                 how many nodes there are above ground
 *   step(2, v(B) @ 12)      the same, in one run of a parametric sweep
 */
export function compileExpr(src, errs, where = "value") {
  const text = String(src ?? "").trim();
  if (!text) { errs.push(`${where}: no expression`); return null; }

  const at = splitAt(text);
  const body = at.body;
  const call = body.match(/^([a-zA-Z]+)\s*\((.*)\)$/s);
  if (!call) { errs.push(`${where}: "${text}" is not one of the readings a lab file can ask for`); return null; }
  const fn = lc(call[1]);
  const args = splitArgs(call[2]);

  const point = at.point === null ? null : parsePoint(at.point, errs, where);
  const need = (n) => {
    if (args.length !== n) errs.push(`${where}: ${fn}() takes ${n} argument${n === 1 ? "" : "s"}`);
    return args.length === n;
  };

  switch (fn) {
    case "v": {
      if (args.length === 1) {
        const spec = toSpec(args[0], errs, where);
        return (ctx, res) => (point === null ? ctx.vn(spec, res) : sampleTrace(ctx.nodeTrace(spec, null, res), point, ctx, res));
      }
      if (args.length === 2) {
        const a = toSpec(args[0], errs, where), b = toSpec(args[1], errs, where);
        return (ctx, res) => {
          const t = diffTrace(ctx, a, b, res);
          if (t) return sampleTrace(t, point, ctx, res);
          return ctx.vn(a, res) - ctx.vn(b, res);
        };
      }
      errs.push(`${where}: v() takes one node, or two for a difference`);
      return null;
    }
    case "i": {
      if (!need(1)) return null;
      const label = String(args[0]).trim();
      return (ctx, res) => {
        const t = currentTrace(ctx, label, res);
        return t ? sampleTrace(t, point, ctx, res) : NaN;
      };
    }
    case "max": case "min": case "avg": {
      if (!need(1)) return null;
      const inner = compileTrace(args[0], errs, where);
      if (!inner) return null;
      return (ctx, res) => {
        const got = inner(ctx, res);
        if (!got || !got.trace) return NaN;
        const vals = window_(got.trace, got.point, ctx, res);
        if (!vals.length) return NaN;
        if (fn === "max") return Math.max(...vals);
        if (fn === "min") return Math.min(...vals);
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
    }
    case "peak": case "corner": {
      const spec = toSpec(args[0], errs, where);
      let which = "peak";
      if (fn === "corner") {
        if (!need(2)) return null;
        which = lc(args[1]);
        if (which !== "upper" && which !== "lower") errs.push(`${where}: corner() takes upper or lower`);
      } else if (!need(1)) return null;
      return (ctx, res) => {
        const c = corners(ctx.nodeTrace(spec, null, res), res?.sweep?.values);
        return fn === "peak" ? c.peak : which === "upper" ? c.hi : c.lo;
      };
    }
    case "gain": {
      if (!need(1)) return null;
      const spec = toSpec(args[0], errs, where);
      if (point === null) errs.push(`${where}: gain() needs a frequency, as gain(OUT) @ 1k`);
      return (ctx, res) => {
        const t = ctx.nodeTrace(spec, null, res);
        return t && t.db ? sampleTrace({ values: t.db }, point, ctx, res) : NaN;
      };
    }
    case "logic": {
      if (!need(1)) return null;
      const spec = toSpec(args[0], errs, where);
      if (point === null) errs.push(`${where}: logic() needs a time, as logic(Q) @ 4.5m`);
      return (ctx, res) => {
        const v = sampleTrace(ctx.nodeTrace(spec, null, res), point, ctx, res);
        return isFinite(v) ? levelOf(v) : NaN;
      };
    }
    case "count": {
      if (!args.length) { errs.push(`${where}: count() needs the bits, least significant first`); return null; }
      const specs = args.map((a) => toSpec(a, errs, where));
      if (point === null) errs.push(`${where}: count() needs a time, as count(Q0,Q1) @ 11.5m`);
      return (ctx, res) => specs.reduce((sum, spec, i) => {
        const v = sampleTrace(ctx.nodeTrace(spec, null, res), point, ctx, res);
        return isFinite(v) ? sum + (levelOf(v) << i) : NaN;
      }, 0);
    }
    case "logicwhile": {
      if (args.length < 2) { errs.push(`${where}: logicWhile() needs an output and at least one input, as logicWhile(Q, A=0, B=1)`); return null; }
      const out = toSpec(args[0], errs, where);
      const ins = [], want = [];
      args.slice(1).forEach((a) => {
        const m = String(a).match(/^([^=]+)=\s*([01])\s*$/);
        if (!m) { errs.push(`${where}: "${a}" should look like A=1`); return; }
        ins.push(toSpec(m[1], errs, where));
        want.push(Number(m[2]));
      });
      return (ctx, res) => logicWhile(ctx, res, ins, out, want);
    }
    case "nodes": {
      need(0);
      return (ctx) => {
        const seen = new Set();
        ctx.real.forEach((c) => nodesFor(c, ctx.net).forEach((n) => { if (n !== undefined && n !== 0) seen.add(n); }));
        return seen.size;
      };
    }
    case "step": {
      if (args.length !== 2) { errs.push(`${where}: step() takes a run number and a reading, as step(0, v(B) @ 12)`); return null; }
      const k = Number(args[0]);
      if (!Number.isInteger(k) || k < 0) errs.push(`${where}: step()'s first argument is a run number, counting from 0`);
      const inner = compileExpr(args[1], errs, where);
      if (!inner) return null;
      return (ctx, res) => inner(withStep(ctx, k), res);
    }
    default:
      errs.push(`${where}: there is no reading called ${call[1]}()`);
      return null;
  }
}

/** A reading that must resolve to a trace, for max/min/avg. */
function compileTrace(src, errs, where) {
  const at = splitAt(String(src));
  const point = at.point === null ? null : parsePoint(at.point, errs, where, true);
  const call = at.body.match(/^([a-zA-Z]+)\s*\((.*)\)$/s);
  if (!call) { errs.push(`${where}: "${src}" is not a trace`); return null; }
  const fn = lc(call[1]);
  const args = splitArgs(call[2]);
  if (fn === "v" && args.length === 1) {
    const spec = toSpec(args[0], errs, where);
    return (ctx, res) => ({ trace: ctx.nodeTrace(spec, null, res), point });
  }
  if (fn === "v" && args.length === 2) {
    const a = toSpec(args[0], errs, where), b = toSpec(args[1], errs, where);
    return (ctx, res) => ({ trace: diffTrace(ctx, a, b, res), point });
  }
  if (fn === "i" && args.length === 1) {
    const label = String(args[0]).trim();
    return (ctx, res) => ({ trace: currentTrace(ctx, label, res), point });
  }
  errs.push(`${where}: max(), min() and avg() work on v(...) or i(...)`);
  return null;
}

function splitAt(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "@" && depth === 0) return { body: text.slice(0, i).trim(), point: text.slice(i + 1).trim() };
  }
  return { body: text.trim(), point: null };
}

function splitArgs(text) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out.filter((s) => s.length);
}

function parsePoint(text, errs, where, allowRange = false) {
  const range = String(text).split("..");
  const nums = range.map((s) => parseValue(s.trim()));
  if (nums.some((n) => !isFinite(n))) { errs.push(`${where}: "${text}" is not a time or sweep value`); return null; }
  if (nums.length === 1) return { from: nums[0], to: nums[0], single: true };
  if (nums.length === 2) {
    if (!allowRange) errs.push(`${where}: a range only makes sense inside max(), min() or avg()`);
    return { from: nums[0], to: nums[1], single: false };
  }
  errs.push(`${where}: "${text}" is not a time or a range`);
  return null;
}

/* --------------------------------------------------------- reading traces */

function diffTrace(ctx, a, b, res) {
  const na = ctx.resolve(a), nb = ctx.resolve(b);
  if (na === undefined || nb === undefined) return null;
  return ctx.trace(`v(${String(na).toLowerCase()},${String(nb).toLowerCase()})`, null, res);
}

function currentTrace(ctx, label, res) {
  const c = ctx.part(label);
  if (!c) return null;
  const name = String(c.label).toLowerCase();
  return ctx.trace(`i(${name})`, null, res) || ctx.trace(`i(@${name}[i])`, null, res);
}

/** A trace's value at a point; the last value when no point is given. */
function sampleTrace(trace, point, ctx, res) {
  if (!trace || !trace.values) return NaN;
  if (point === null) {
    return res?.sweep ? trace.values[trace.values.length - 1] : trace.values[trace.values.length - 1];
  }
  const xs = res?.sweep?.values;
  if (!xs) return trace.values[trace.values.length - 1];
  // The last sample at or before the point: a transient puts its points
  // wherever the solver chose, so an exact match cannot be required.
  let k = 0;
  while (k < xs.length - 1 && xs[k + 1] <= point.from) k++;
  return trace.values[k];
}

/** Every sample of a trace, or those inside a range. */
function window_(trace, point, ctx, res) {
  const vals = trace.values || [];
  const xs = res?.sweep?.values;
  if (!point || !xs) return vals.slice();
  const out = [];
  for (let i = 0; i < vals.length; i++) if (xs[i] >= point.from && xs[i] <= point.to) out.push(vals[i]);
  return out.length ? out : vals.slice();
}

/** Read from one run of a parametric sweep. */
function withStep(ctx, k) {
  return {
    ...ctx,
    nodeTrace: (spec, step = null, res = ctx.result) => ctx.nodeTrace(spec, step === null ? k : step, res),
    trace: (name, step = null, res = ctx.result) => ctx.trace(name, step === null ? k : step, res)
  };
}

/**
 * The level of `out` while the inputs hold `want`, read at the end of the
 * first stretch where they do, when the output has had longest to settle.
 */
function logicWhile(ctx, res, inputs, out, want) {
  const ts = res?.sweep?.values;
  const tin = inputs.map((n) => ctx.nodeTrace(n, null, res));
  const tout = ctx.nodeTrace(out, null, res);
  if (!ts || !tout || tin.some((t) => !t)) return NaN;
  let start = -1;
  for (let k = 0; k < ts.length; k++) {
    const ok = tin.every((t, i) => levelOf(t.values[k]) === want[i]);
    if (ok && start < 0) start = k;
    if (start >= 0 && (!ok || k === ts.length - 1)) {
      const end = ok ? k : k - 1;
      if (ts[end] - ts[start] > 0) return levelOf(tout.values[end]);
      start = -1;
    }
  }
  return NaN;
}

/* ------------------------------------------------------------ rules */

/** One compiler per rule name. Each returns a check object, or null on error. */
const RULES = {
  /**
   * The sheet's name. A code like "15A" is matched the way the built-in labs
   * match theirs ("LAB 15A", "lab15-a"); any other text must simply appear.
   */
  title: (v, errs) => {
    if (typeof v !== "string" || !v.trim()) { errs.push("title: expected the name the sheet must have, like \"15A\""); return null; }
    const code = v.trim();
    const m = code.match(/^0*(\d+)\s*-?\s*([A-Za-z])$/);
    const re = m
      ? new RegExp(`\\blab\\s*0*${m[1]}\\s*-?\\s*${m[2]}\\b`, "i")
      : new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "i");
    return {
      label: m ? `The sheet title reads LAB ${code}` : `The sheet title contains "${code}"`,
      test: (ctx) => ({ pass: re.test(ctx.title), detail: `the title is "${ctx.title}"` })
    };
  },

  parts: (v, errs) => {
    if (!isObj(v)) { errs.push("parts: expected an object of part names"); return null; }
    const spec = {};
    Object.entries(v).forEach(([ref, want]) => {
      if (typeof want === "string" || typeof want === "number") { spec[ref] = String(want); return; }
      if (!isObj(want)) { errs.push(`parts.${ref}: expected a value or an object`); return; }
      const out = {};
      ["dc", "ac", "model", "type", "text"].forEach((k) => { if (want[k] !== undefined) out[k] = want[k]; });
      if (want.value !== undefined) out.text = undefined, spec[ref] = String(want.value);
      if (want.sin) out.sin = want.sin.map(Number);
      if (want.pulse) out.pulse = want.pulse;
      if (want.fields) out.fields = want.fields;
      if (want.type && !PARTS[want.type]) errs.push(`parts.${ref}: there is no part type called ${want.type}`);
      if (spec[ref] === undefined) spec[ref] = out;
    });
    return K.parts(spec);
  },

  wiring: (v, errs) => {
    if (!Array.isArray(v)) { errs.push("wiring: expected a list of connections"); return null; }
    const rows = v.map((row, i) => {
      if (!Array.isArray(row) || row.length < 2 || !Array.isArray(row[1])) {
        errs.push(`wiring[${i}]: expected ["R1", ["A", "B"]]`);
        return null;
      }
      return [row[0], row[1].map((s) => toSpec(s, errs, `wiring[${i}]`)), !!row[2]];
    }).filter(Boolean);
    return K.wiring(rows);
  },

  gate: (v, errs) => {
    if (!isObj(v) || !v.part || !Array.isArray(v.inputs) || v.out === undefined) {
      errs.push("gate: expected { part, inputs: [...], out }");
      return null;
    }
    return K.gate(v.part, v.inputs.map((s) => toSpec(s, errs, "gate.inputs")), toSpec(v.out, errs, "gate.out"));
  },

  pins: (v, errs) => {
    if (!isObj(v) || !v.part || !isObj(v.map)) { errs.push("pins: expected { part, map: { \"0\": \"J\" } }"); return null; }
    const map = {};
    Object.entries(v.map).forEach(([pin, spec]) => { map[pin] = toSpec(spec, errs, "pins.map"); });
    return K.pins(v.part, map, v.label || `${v.part}'s pins are connected as the handout shows`);
  },

  noOpenEnds: () => K.noOpenEnds(),

  aliasOn: (v, errs) => {
    if (!isObj(v) || !v.name || v.at === undefined) { errs.push("aliasOn: expected { name, at }"); return null; }
    return K.aliasOn(v.name, toSpec(v.at, errs, "aliasOn.at"), v.where || `the node it names`);
  },

  param: (v, errs) => {
    if (!isObj(v) || !v.name || !Array.isArray(v.values)) { errs.push("param: expected { name, values: [...] }"); return null; }
    return K.param(v.name, v.values.map((x) => parseValue(String(x))));
  },

  paramPart: (v, errs) => {
    if (!isObj(v) || !v.name) { errs.push("paramPart: expected { name, value }"); return null; }
    const want = parseValue(String(v.value));
    return {
      label: `A Parameter part defines ${v.name} = ${v.value}`,
      test: (ctx) => {
        const p = ctx.state.comps.find((c) => c.type === "PARAM" && lc(c.name) === lc(v.name));
        if (!p) return { pass: false, detail: `no Parameter part named ${v.name}` };
        const got = parseValue(p.value);
        const ok = isFinite(want) ? Math.abs(got - want) <= Math.abs(want) * 1e-6 : true;
        return { pass: ok, detail: ok ? "" : `${v.name} = ${p.value}` };
      }
    };
  },

  mirrored: (v, errs) => {
    if (!isObj(v)) { errs.push("mirrored: expected { U1A: { my: true } }"); return null; }
    const want = {};
    Object.entries(v).forEach(([ref, flags]) => {
      want[ref] = { mx: !!(flags && flags.mx), my: !!(flags && flags.my) };
    });
    return K.mirrored(want, "The parts the handout mirrors are mirrored, and the others are not");
  },

  bus: (v, errs) => (Array.isArray(v) ? K.bus(v) : errs.push("bus: expected a list of signal names") && null),

  probe: (v, errs) => {
    const spec = isObj(v) ? v.at : v;
    return K.probe(toSpec(spec, errs, "probe"), String(spec));
  },

  probeOrder: (v, errs) => (Array.isArray(v) ? K.probeOrder(v.map((s) => toSpec(s, errs, "probeOrder"))) : errs.push("probeOrder: expected a list of nodes") && null),

  diffProbe: (v, errs) => {
    if (!isObj(v) || !v.plus || !v.minus) { errs.push("diffProbe: expected { plus, minus }"); return null; }
    return K.diff(toSpec(v.plus, errs, "diffProbe"), toSpec(v.minus, errs, "diffProbe"));
  },

  currentProbe: (v) => ({
    label: `A current probe sits on ${v}`,
    test: (ctx) => ({ pass: ctx.currentProbe(v), detail: ctx.currentProbe(v) ? "" : `click ${v}'s body with the Probe tool` })
  }),

  dbMode: () => K.dbMode(),

  axis: (v, errs) => {
    if (!isObj(v)) { errs.push("axis: expected { xMin, xMax, yMin, yMax }"); return null; }
    const want = {};
    ["xMin", "xMax", "yMin", "yMax"].forEach((k) => { if (v[k] !== undefined) want[k] = parseValue(String(v[k])); });
    return K.axis(want);
  },

  ffInit: (v, errs) => (["X", "0", "1"].includes(String(v)) ? K.ffInit(String(v)) : errs.push("ffInit: expected X, 0 or 1") && null),

  stim: (v, errs) => {
    if (!isObj(v) || !v.part || !v.commands) { errs.push("stim: expected { part, commands, until }"); return null; }
    return K.stim(v.part, v.commands, parseValue(String(v.until ?? "8m")));
  },

  analysis: (v, errs) => {
    if (!isObj(v)) { errs.push("analysis: expected { op } or { dc | ac | tran: {...} }"); return null; }
    if (v.op) return K.op();
    if (isObj(v.dc)) {
      const d = v.dc;
      if (!d.src) errs.push("analysis.dc: needs the source to sweep");
      return K.dc(d.src, parseValue(String(d.start)), parseValue(String(d.stop)), parseValue(String(d.step)));
    }
    if (isObj(v.ac)) {
      const a = v.ac;
      return K.ac(parseValue(String(a.start)), parseValue(String(a.stop)), parseValue(String(a.pts)));
    }
    if (isObj(v.tran)) {
      const t = v.tran;
      return K.tran(parseValue(String(t.stop)), parseValue(String(t.maxStep ?? t.step)));
    }
    errs.push("analysis: expected op, dc, ac or tran");
    return null;
  },

  expect: (v, errs) => {
    if (!isObj(v) || v.value === undefined || v.is === undefined) {
      errs.push("expect: expected { value, is, tol }");
      return null;
    }
    const read = compileExpr(v.value, errs, "expect.value");
    if (!read) return null;
    const want = parseValue(String(v.is));
    const tol = v.tol === undefined ? Math.max(1e-9, Math.abs(want) * 0.02) : parseValue(String(v.tol));
    return K.sim(v.label || `The simulation gives ${v.value} \u2248 ${formatEng(want, 4)}`, (ctx) => {
      const got = read(ctx, ctx.result);
      const ok = isFinite(got) && Math.abs(got - want) <= tol;
      return { pass: ok, detail: isFinite(got) ? `it comes out at ${formatEng(got, 4)}` : "that reading is not in the results" };
    });
  }
};

/* ------------------------------------------------------------ compiling */

const KINDS = new Set(["draw", "simulate", "fix", "explore"]);

/** Check a circuit the file supplies: only known parts, and plain data. */
function validateCircuit(circuit, errs, where) {
  if (!isObj(circuit)) { errs.push(`${where}: expected a circuit object`); return null; }
  const comps = Array.isArray(circuit.comps) ? circuit.comps : [];
  comps.forEach((c, i) => {
    if (!isObj(c)) { errs.push(`${where}.comps[${i}]: expected an object`); return; }
    if (!PARTS[c.type]) errs.push(`${where}.comps[${i}]: there is no part type called ${c.type}`);
    if (!isFinite(c.x) || !isFinite(c.y)) errs.push(`${where}.comps[${i}]: needs x and y`);
    Object.values(c).forEach((val) => {
      if (val !== null && typeof val === "object") errs.push(`${where}.comps[${i}]: part fields must be text or numbers`);
    });
  });
  const wires = Array.isArray(circuit.wires) ? circuit.wires : [];
  wires.forEach((w, i) => {
    if (!isObj(w) || ["x1", "y1", "x2", "y2"].some((k) => !isFinite(w[k]))) errs.push(`${where}.wires[${i}]: needs x1, y1, x2, y2`);
  });
  return {
    title: typeof circuit.title === "string" ? circuit.title : "Untitled circuit",
    comps, wires,
    probes: Array.isArray(circuit.probes) ? circuit.probes : [],
    notes: Array.isArray(circuit.notes) ? circuit.notes : [],
    seq: isObj(circuit.seq) ? circuit.seq : {},
    analysis: isObj(circuit.analysis) ? circuit.analysis : undefined,
    plot: isObj(circuit.plot) ? circuit.plot : undefined
  };
}

/**
 * Compile a parsed lab file. Returns { lab, errors, warnings }: `lab` is null
 * when anything is wrong, because a lab that half works is worse than one that
 * refuses to open.
 */
export function compileLab(doc) {
  const errs = [], warn = [];
  if (!isObj(doc)) return { lab: null, errors: ["That file does not contain a lab."], warnings: warn };
  if (doc.format !== LABFILE_FORMAT) errs.push(`This file says it is "${doc.format}"; a lab file says "${LABFILE_FORMAT}".`);
  if (Number(doc.version) > LABFILE_VERSION) errs.push(`This lab was written for a newer version of Q Circuits (version ${doc.version}).`);
  if (!doc.id || !/^[\w.-]+$/.test(String(doc.id))) errs.push("id: needed, and it may only contain letters, numbers, dots and dashes.");
  if (!doc.title) errs.push("title: needed.");
  const kind = doc.kind || "draw";
  if (!KINDS.has(kind)) errs.push(`kind: ${doc.kind} is not one of draw, simulate, fix, explore.`);
  const tasks = Array.isArray(doc.tasks) ? doc.tasks.map(String) : [];
  if (!tasks.length) warn.push("This lab has no task list, so students see no instructions.");

  const circuit = doc.circuit ? validateCircuit(doc.circuit, errs, "circuit") : { title: "Untitled circuit", comps: [], wires: [], probes: [], notes: [], seq: {} };
  const diagram = doc.diagram ? validateCircuit(doc.diagram, errs, "diagram") : null;

  const checks = [];
  (Array.isArray(doc.checks) ? doc.checks : []).forEach((rule, i) => {
    if (!isObj(rule)) { errs.push(`checks[${i}]: expected an object like { "noOpenEnds": true }`); return; }
    const names = Object.keys(rule).filter((k) => k !== "label");
    if (names.length !== 1) { errs.push(`checks[${i}]: expected exactly one rule, found ${names.length || "none"}`); return; }
    const name = names[0];
    const make = RULES[name];
    if (!make) { errs.push(`checks[${i}]: there is no rule called "${name}"`); return; }
    const before = errs.length;
    const check = make(rule[name], errs);
    if (check && errs.length === before) checks.push(rule.label ? { ...check, label: rule.label } : check);
  });
  if (!checks.length) warn.push("This lab has no checks, so Check my work will always pass.");

  const questions = [];
  (Array.isArray(doc.questions) ? doc.questions : []).forEach((q, i) => {
    if (!isObj(q) || !q.id || !q.prompt || q.value === undefined) {
      errs.push(`questions[${i}]: expected { id, prompt, value }`);
      return;
    }
    const read = compileExpr(q.value, errs, `questions[${i}].value`);
    if (!read) return;
    if (q.abs === undefined && q.rel === undefined) warn.push(`questions[${i}]: no tolerance given, so the answer must match to 2%.`);
    questions.push({
      id: String(q.id),
      prompt: String(q.prompt),
      abs: q.abs === undefined ? undefined : parseValue(String(q.abs)),
      rel: q.rel === undefined ? (q.abs === undefined ? 0.02 : undefined) : Number(q.rel),
      expect: (ctx) => read(ctx, ctx.ref || ctx.result)
    });
  });

  if (errs.length) return { lab: null, errors: errs, warnings: warn };

  const lab = {
    id: String(doc.id),
    imported: true,
    source: doc,
    group: doc.group ? `imported:${doc.group}` : "imported",
    groupTitle: doc.group || "Imported labs",
    code: doc.code ? String(doc.code) : "",
    kind,
    title: String(doc.title),
    summary: String(doc.summary || ""),
    tasks,
    circuit,
    checks,
    questions,
    simulate: doc.simulate !== false,
    useStudentAnalysis: !!doc.useStudentAnalysis,
    ...(doc.analysis ? { analysis: doc.analysis } : {}),
    ...(doc.reference ? { reference: doc.reference } : {}),
    ...(doc.carryFrom ? { carryFrom: String(doc.carryFrom) } : {}),
    ...(diagram ? { diagram } : {}),
    ...(doc.lesson ? { lesson: String(doc.lesson) } : {})
  };
  return { lab, errors: [], warnings: warn };
}

export function parseLabFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { lab: null, errors: [`That file is not valid JSON: ${e.message}`], warnings: [] };
  }
  return compileLab(doc);
}
