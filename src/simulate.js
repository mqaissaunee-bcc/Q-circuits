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

import { PARTS, netlistNameOf, isVirtual, netNameOf } from "./parts.js";
import { buildNodes, buildNetlist, nodesFor, nodeAtPoint, paramValues, temperatures, parseValue, formatEng } from "./netlist.js";
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
        // ngspice lower-cases node names; match it so the legend reads evenly.
        const label = `v(${String(a).toLowerCase()},${String(b).toLowerCase()})${sfx}`;
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
/**
 * Nodes with a single pin on them have no path for current, and ngspice does
 * not fail on those: it iterates until something gives up. A half-built sheet
 * would freeze the page, so the run is refused before it starts.
 */
function floatingNodes(state) {
  const net = buildNodes(state.comps, state.wires);
  const named = new Map();
  state.comps.forEach((c) => {
    const def = PARTS[c.type];
    // Labels and ports count as a connection; a bus label names a bus, and
    // a bus carries no current, so it does not.
    if (isVirtual(c) && !(def.countsAsPin && (!def.netName || netNameOf(c)))) return;
    nodesFor(c, net).forEach((nd, i) => {
      if (nd === 0 || nd === undefined) return;
      if ((net.pinCount.get(nd) || 0) >= 2) return;
      if (!named.has(nd)) named.set(nd, `${c.label} ${PARTS[c.type].pinNames[i] || ""}`.trim());
    });
  });
  return [...named.entries()].map(([node, where]) => ({ node, where }));
}

export async function simulate(state, onProgress, analysis = state.analysis) {
  const loose = floatingNodes(state);
  if (loose.length) {
    const list = loose.slice(0, 3).map((f) => f.where).join(", ");
    throw new Error(`Nothing is connected to ${list}${loose.length > 3 ? `, and ${loose.length - 3} more` : ""}. `
      + "A pin with nothing on it has no path for current, and the simulator would spin rather than stop. "
      + "Wire it up, or delete the part, and run again.");
  }
  const saves = savesFor(state, analysis);
  const values = paramValues(analysis);
  const net = buildNodes(state.comps, state.wires);

  const temps = temperatures(analysis);
  const key = analysis.paramOn ? String(analysis.paramName).trim().toLowerCase() : null;
  const pname = String(analysis.paramName || "").trim();

  // One run per parameter value, per temperature. Either can be off, and
  // with both on it is every combination, which is why the cap matters.
  const runsWanted = [];
  (values || [null]).forEach((v) => {
    (temps || [null]).forEach((t) => {
      const bits = [];
      if (v !== null) bits.push(`${pname}=${formatEng(v, 4)}`);
      if (t !== null) bits.push(`${formatEng(t, 3)}\u00B0C`);
      runsWanted.push({ value: v, temp: t, suffix: bits.length ? `${STEP_SEP}${bits.join(", ")}` : "" });
    });
  });

  if (runsWanted.length === 1 && !runsWanted[0].suffix) {
    const { text } = buildNetlist(state.comps, state.wires, analysis, state.title,
      { saves, temp: runsWanted[0].temp });
    const result = await run(text, onProgress);
    result.netlist = text;
    addDerived(result, state, net, analysis, [paramDefaults(state)]);
    return withFourier(result, state, analysis);
  }

  const runs = [];
  let first = "";
  for (let k = 0; k < runsWanted.length; k++) {
    const { value, temp, suffix } = runsWanted[k];
    onProgress?.(`Run ${k + 1} of ${runsWanted.length}${suffix ? `: ${suffix.replace(STEP_SEP, "")}` : ""}`);
    const { text } = buildNetlist(state.comps, state.wires, analysis, state.title,
      { saves, temp, overrides: value === null ? {} : { [key]: value } });
    if (!k) first = text;
    runs.push(await run(text, k ? undefined : onProgress));
  }

  const base = runs[0];
  const grid = base.sweep ? base.sweep.values : null;
  const traces = [];
  const steps = runsWanted.map(({ value, temp, suffix }) => ({ name: pname, value, temp, suffix }));

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
  addDerived(merged, state, net, analysis, runsWanted.map(({ value }) => (value === null ? defaults : { ...defaults, [key]: value })));
  return withFourier(merged, state, analysis);
}

/* ---------------------------------------------------------------- Fourier */

/**
 * Harmonics of a transient waveform, measured over a whole number of cycles
 * at the end of the run, where a circuit has settled. ngspice's own .four
 * writes to its log rather than to vectors, so this does the arithmetic:
 * the waveform is resampled onto an even grid, then correlated with a sine
 * and cosine at each harmonic.
 */
export function fourierOf(times, values, f0, harmonics = 9) {
  const period = 1 / f0;
  const end = times[times.length - 1];
  const cycles = Math.max(1, Math.min(8, Math.floor((end - times[0]) / period)));
  const span = cycles * period;
  const start = end - span;
  if (!(span > 0) || start < times[0]) return null;

  const N = Math.max(256, 64 * harmonics);
  const grid = Array.from({ length: N }, (_, i) => start + (span * i) / N);
  const ys = [];
  let j = 0;
  for (const t of grid) {
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const t0 = times[j], t1 = times[j + 1] ?? t0;
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    ys.push(values[j] + f * ((values[j + 1] ?? values[j]) - values[j]));
  }

  const dc = ys.reduce((a, b) => a + b, 0) / N;
  const out = [];
  for (let h = 1; h <= harmonics; h++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      const ang = (2 * Math.PI * h * i * cycles) / N;
      re += ys[i] * Math.cos(ang);
      im += ys[i] * Math.sin(ang);
    }
    re = (2 * re) / N;
    im = (-2 * im) / N;
    out.push({ harmonic: h, freq: h * f0, mag: Math.hypot(re, im), phase: (Math.atan2(im, re) * 180) / Math.PI });
  }
  const fundamental = out[0].mag;
  const thd = fundamental > 0
    ? Math.sqrt(out.slice(1).reduce((a, h) => a + h.mag * h.mag, 0)) / fundamental
    : NaN;
  out.forEach((h) => { h.relative = fundamental > 0 ? h.mag / fundamental : NaN; });
  return { dc, cycles, thd, harmonics: out };
}

/** Attach harmonics to a transient result, when the analysis asked for them. */
function withFourier(result, state, analysis) {
  if (!analysis.fourierOn || analysis.type !== "tran" || !result.sweep) return result;
  const f0 = parseValue(analysis.fourierFreq);
  if (!(f0 > 0)) return result;
  const times = result.sweep.values;
  result.fourier = { f0, traces: [] };
  probedTraces(result, state).traces.forEach((t) => {
    if (t.complex) return;
    const spectrum = fourierOf(times, t.values, f0);
    if (spectrum) result.fourier.traces.push({ name: t.name, unit: t.type === "current" ? "A" : "V", ...spectrum });
  });
  return result;
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
