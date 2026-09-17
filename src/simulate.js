/**
 * One place that turns the sheet into results.
 *
 * The Run button and the lab checker both come through here, so a student's
 * run and the grader's run are built the same way: the same saved currents,
 * the same parametric steps, the same derived probe traces.
 *
 * Two ngspice limits shape this file.
 *
 * - ngspice only records currents through voltage sources and inductors
 *   unless told to `.save` a device quantity such as @r1[i]. Asking for a
 *   resistor or capacitor current in an AC analysis hangs this build, so in
 *   AC those two are computed from the node voltages instead.
 * - There is no .step. A parametric sweep is a series of separate runs with
 *   the parameter overridden, merged into one result afterwards.
 */

import { PARTS, netlistNameOf } from "./parts.js";
import { buildNodes, buildNetlist, nodesFor, nodeAtPoint, paramValues, parseValue, formatEng } from "./netlist.js";
import { runNetlist } from "./engine.js";

export const STEP_SEP = " \u00B7 ";

/** Name of the trace a current probe on this part produces. */
export function currentVectorOf(comp) {
  const name = netlistNameOf(comp).toLowerCase();
  switch (comp.type) {
    // Saved as @r1[i]; renamed to i(r1) once the run returns (see tidyNames).
    case "R": case "C": return { save: `@${name}[i]`, vector: `i(${name})` };
    case "D": return { save: `@${name}[id]`, vector: `i(${name})` };
    default: return { save: null, vector: `i(${name})` };
  }
}

/** Parts a current probe can sit on. */
export function canProbeCurrent(comp) {
  return ["V", "L", "AM", "R", "C", "D"].includes(comp.type);
}

const findComp = (state, ref) =>
  state.comps.find((c) => netlistNameOf(c).toLowerCase() === String(ref).toLowerCase()) || null;

/** Device quantities to .save for the probes on the sheet. */
function savesFor(state, analysis) {
  const out = new Set();
  state.probes.forEach((p) => {
    if (p.kind !== "i") return;
    const c = findComp(state, p.ref);
    if (!c) return;
    const v = currentVectorOf(c);
    if (!v.save) return;
    if (analysis.type === "ac" && (c.type === "R" || c.type === "C")) return;
    out.add(v.save);
  });
  return [...out];
}

/** Trace name for a probe, or null if it points at nothing. */
export function probeTraceName(probe, state, net) {
  if (probe.kind === "v") {
    const nd = nodeAtPoint(net, state.wires, probe.x, probe.y);
    return nd === undefined ? null : `v(${nd})`;
  }
  if (probe.kind === "vd") {
    const a = nodeAtPoint(net, state.wires, probe.x, probe.y);
    const b = nodeAtPoint(net, state.wires, probe.x2, probe.y2);
    return a === undefined || b === undefined ? null : `v(${a},${b})`;
  }
  const c = findComp(state, probe.ref);
  return c ? currentVectorOf(c).vector : null;
}

/* ------------------------------------------------------ derived traces */

const lower = (s) => String(s).toLowerCase();
const baseName = (name) => String(name).split(STEP_SEP)[0];
const suffixOf = (name) => {
  const i = String(name).indexOf(STEP_SEP);
  return i < 0 ? "" : String(name).slice(i);
};

function complexOf(trace, n) {
  if (!trace) return { re: new Array(n).fill(0), im: new Array(n).fill(0) };
  return { re: trace.re, im: trace.im };
}

function complexTrace(name, type, re, im) {
  const mag = [], db = [], phase = [];
  for (let k = 0; k < re.length; k++) {
    const m = Math.hypot(re[k], im[k]);
    mag.push(m);
    db.push(20 * Math.log10(m > 0 ? m : Number.MIN_VALUE));
    phase.push((Math.atan2(im[k], re[k]) * 180) / Math.PI);
  }
  return { name, type, complex: true, re, im, mag, db, phase, values: mag };
}

/**
 * Add the traces ngspice cannot give directly: differential voltages, and
 * resistor and capacitor currents in an AC run. Works per parametric step,
 * so every step gets its own derived trace.
 */
function addDerived(result, state, net, analysis, params) {
  const want = new Map();                           // name -> probe
  state.probes.forEach((p) => {
    const n = probeTraceName(p, state, net);
    if (n) want.set(lower(n), p);
  });
  if (!want.size) return;

  const suffixes = result.steps ? result.steps.map((s) => s.suffix) : [""];
  const byName = new Map(result.traces.map((t) => [lower(t.name), t]));
  const npts = result.numPoints;
  const volt = (nd, sfx) => {
    if (nd === 0) return null;
    return byName.get(lower(`v(${nd})${sfx}`)) || null;
  };

  suffixes.forEach((sfx, stepIdx) => {
    want.forEach((probe, name) => {
      if (byName.has(lower(name + sfx))) return;

      if (probe.kind === "vd") {
        const a = nodeAtPoint(net, state.wires, probe.x, probe.y);
        const b = nodeAtPoint(net, state.wires, probe.x2, probe.y2);
        const ta = volt(a, sfx), tb = volt(b, sfx);
        if ((a !== 0 && !ta) || (b !== 0 && !tb)) return;
        const label = `v(${a},${b})${sfx}`;
        let t;
        if (result.kind === "complex") {
          const A = complexOf(ta, npts), B = complexOf(tb, npts);
          t = complexTrace(label, "voltage", A.re.map((v, k) => v - B.re[k]), A.im.map((v, k) => v - B.im[k]));
        } else {
          const len = (ta || tb).values.length;
          const va = ta ? ta.values : new Array(len).fill(0);
          const vb = tb ? tb.values : new Array(len).fill(0);
          t = { name: label, type: "voltage", complex: false, values: va.map((v, k) => v - vb[k]) };
        }
        t.step = stepIdx;
        result.traces.push(t);
        byName.set(lower(label), t);
        return;
      }

      if (probe.kind === "i" && result.kind === "complex" && result.sweep) {
        const c = findComp(state, probe.ref);
        if (!c || (c.type !== "R" && c.type !== "C")) return;
        const [n1, n2] = nodesFor(c, net);
        const A = complexOf(volt(n1, sfx), npts), B = complexOf(volt(n2, sfx), npts);
        const value = resolveValue(c.value, params[stepIdx]);
        if (!isFinite(value) || value === 0) return;
        const f = result.sweep.values;
        const re = [], im = [];
        for (let k = 0; k < npts; k++) {
          const dr = A.re[k] - B.re[k], di = A.im[k] - B.im[k];
          if (c.type === "R") { re.push(dr / value); im.push(di / value); }
          else {
            const w = 2 * Math.PI * f[k] * value;       // i = jωC·v
            re.push(-di * w); im.push(dr * w);
          }
        }
        const t = complexTrace(`${currentVectorOf(c).vector}${sfx}`, "current", re, im);
        t.step = stepIdx;
        result.traces.push(t);
        byName.set(lower(t.name), t);
      }
    });
  });
}

/** A part value, with {NAME} replaced from the parameters in force. */
function resolveValue(text, params) {
  const s = String(text ?? "").trim();
  const m = s.match(/^\{\s*([A-Za-z_]\w*)\s*\}$/);
  if (m) return params?.[m[1].toLowerCase()] ?? NaN;
  return parseValue(s);
}

function paramDefaults(state) {
  const out = {};
  state.comps.forEach((c) => {
    if (c.type === "PARAM" && c.name) out[String(c.name).trim().toLowerCase()] = parseValue(c.value);
  });
  return out;
}

/** ngspice reports a saved device current as i(@r1[i]); students read i(r1). */
function tidyNames(result) {
  result.traces.forEach((t) => {
    const m = String(t.name).match(/^i\(@([^[\]]+)\[i[a-z]*\]\)$/i);
    if (m) t.name = `i(${m[1]})`;
  });
  return result;
}

async function run(text, onProgress) {
  return tidyNames(await runNetlist(text, onProgress));
}

/* ------------------------------------------------------------ resample */

/** Linear interpolation of ys over xs onto grid. */
function resample(xs, ys, grid) {
  const out = new Array(grid.length);
  let j = 0;
  for (let k = 0; k < grid.length; k++) {
    const g = grid[k];
    while (j < xs.length - 2 && xs[j + 1] < g) j++;
    const x0 = xs[j], x1 = xs[j + 1] ?? x0;
    const t = x1 === x0 ? 0 : Math.min(1, Math.max(0, (g - x0) / (x1 - x0)));
    out[k] = ys[j] + t * ((ys[j + 1] ?? ys[j]) - ys[j]);
  }
  return out;
}

function sameGrid(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (Math.abs(a[k] - b[k]) > 1e-9 * Math.max(1, Math.abs(a[k]))) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- run */

/**
 * Simulate the sheet. `analysis` defaults to the sheet's own.
 * Returns the engine result, plus `steps` when a parametric sweep ran, plus
 * `netlist`, the text of the first run.
 */
export async function simulate(state, onProgress, analysis = state.analysis) {
  const saves = savesFor(state, analysis);
  const values = paramValues(analysis);
  const net = buildNodes(state.comps, state.wires);

  if (!values) {
    const { text } = buildNetlist(state.comps, state.wires, analysis, state.title, { saves });
    const result = await run(text, onProgress);
    result.netlist = text;
    addDerived(result, state, net, analysis, [paramDefaults(state)]);
    return result;
  }

  const pname = String(analysis.paramName).trim();
  const key = pname.toLowerCase();
  const runs = [];
  let first = "";
  for (let k = 0; k < values.length; k++) {
    onProgress?.(`Parametric run ${k + 1} of ${values.length}: ${pname} = ${formatEng(values[k], 4)}`);
    const { text } = buildNetlist(state.comps, state.wires, analysis, state.title,
      { saves, overrides: { [key]: values[k] } });
    if (!k) first = text;
    runs.push(await run(text, k ? undefined : onProgress));
  }

  const base = runs[0];
  const grid = base.sweep ? base.sweep.values : null;
  const traces = [];
  const steps = values.map((v) => ({ name: pname, value: v, suffix: `${STEP_SEP}${pname}=${formatEng(v, 4)}` }));

  runs.forEach((r, k) => {
    const needs = grid && r.sweep && !sameGrid(grid, r.sweep.values);
    r.traces.forEach((t) => {
      const name = `${t.name}${steps[k].suffix}`;
      if (!needs) { traces.push({ ...t, name, step: k }); return; }
      const xs = r.sweep.values;
      if (t.complex) {
        traces.push({ ...complexTrace(name, t.type, resample(xs, t.re, grid), resample(xs, t.im, grid)), step: k });
      } else {
        traces.push({ ...t, name, step: k, values: resample(xs, t.values, grid) });
      }
    });
  });

  const defaults = paramDefaults(state);
  const merged = {
    kind: base.kind,
    sweep: base.sweep,
    traces,
    numPoints: base.numPoints,
    info: base.info,
    steps,
    netlist: first
  };
  addDerived(merged, state, net, analysis, values.map((v) => ({ ...defaults, [key]: v })));
  return merged;
}

/** The netlist the Netlist panel shows: the first run, saves included. */
export function previewNetlist(state) {
  const a = state.analysis;
  const saves = savesFor(state, a);
  const values = paramValues(a);
  const overrides = values ? { [String(a.paramName).trim().toLowerCase()]: values[0] } : {};
  return buildNetlist(state.comps, state.wires, a, state.title, { saves, overrides });
}

/**
 * The traces to show for the probes on the sheet: every step of every probed
 * quantity. With no probes, everything.
 */
export function probedTraces(result, state) {
  if (!state.probes.length) return result;
  const net = buildNodes(state.comps, state.wires);
  const order = [];
  state.probes.forEach((p) => {
    const n = probeTraceName(p, state, net);
    if (n && !order.includes(lower(n))) order.push(lower(n));
  });
  const traces = [];
  order.forEach((n) => {
    result.traces.forEach((t) => { if (lower(baseName(t.name)) === n) traces.push(t); });
  });
  return traces.length ? { ...result, traces } : result;
}

/** Look up a trace, optionally at one parametric step. */
export function traceAt(result, name, step = null) {
  if (!result || !name) return null;
  const want = lower(name);
  return result.traces.find((t) =>
    lower(baseName(t.name)) === want && (step === null ? true : t.step === step)) || null;
}

export { baseName, suffixOf };

void PARTS;
