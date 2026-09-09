/**
 * ngspice, compiled to WebAssembly, wrapped in something the UI can hold.
 *
 * The engine bundle is roughly 20 MB, so it is pulled in with a dynamic
 * import() the first time a simulation is actually requested rather than at
 * page load. Everything runs in this tab: no circuit ever leaves the browser.
 */

let simPromise = null;
let sim = null;

/** Load and boot the engine. Safe to call repeatedly; only the first one works. */
export function startEngine(onProgress) {
  if (simPromise) return simPromise;
  simPromise = (async () => {
    onProgress?.("Downloading the ngspice engine…");
    const { Simulation } = await import("eecircuit-engine");
    onProgress?.("Starting the simulator…");
    const s = new Simulation();
    await s.start();
    if (!s.isInitialized()) throw new Error("The ngspice engine loaded but would not initialise.");
    sim = s;
    onProgress?.("Ready.");
    return s;
  })();
  return simPromise;
}

export function engineReady() { return sim !== null; }

/**
 * ngspice reports problems on a side channel rather than by throwing, so a run
 * that produced no usable vectors has to be turned into an error here.
 */
function collectErrors(s) {
  let errs = [];
  try { errs = s.getError() || []; } catch { errs = []; }
  return errs
    .map((e) => String(e).trim())
    .filter((e) => e && !/^\s*$/.test(e));
}

/** Pull the readable part out of ngspice's chatter for the error panel. */
function summariseErrors(errs, info) {
  const interesting = errs.filter((e) => !/^Note:/i.test(e));
  if (interesting.length) return interesting.slice(0, 6).join("\n");
  const hint = String(info || "").split("\n")
    .filter((l) => /error|singular|no such|unknown|cannot|fail/i.test(l))
    .slice(0, 4).join("\n");
  return hint || "ngspice returned no data. Check the netlist for an unconnected node or a missing model.";
}

const SWEEP_TYPES = new Set(["time", "frequency"]);

/**
 * Run one netlist.
 * Returns { kind, sweep, traces, numPoints, info } where a complex result
 * (an AC sweep) also carries magnitude in dB and phase in degrees per trace.
 */
export async function runNetlist(netlist, onProgress) {
  const s = await startEngine(onProgress);
  onProgress?.("Simulating…");

  s.setNetList(netlist);
  let result;
  try {
    result = await s.runSim();
  } catch (e) {
    throw new Error(summariseErrors(collectErrors(s), s.getInfo?.()) + (e?.message ? `\n${e.message}` : ""));
  }

  if (!result || !result.data || !result.data.length || !result.numPoints) {
    throw new Error(summariseErrors(collectErrors(s), s.getInfo?.()));
  }

  const complex = result.dataType === "complex";
  let sweep = null;
  const traces = [];

  result.data.forEach((v) => {
    if (!sweep && SWEEP_TYPES.has(v.type)) {
      sweep = {
        name: v.name,
        type: v.type,
        values: complex ? v.values.map((z) => z.real) : v.values.slice()
      };
      return;
    }
    if (complex) {
      const mag = [], db = [], phase = [];
      for (const z of v.values) {
        const m = Math.hypot(z.real, z.img);
        mag.push(m);
        db.push(20 * Math.log10(m > 0 ? m : Number.MIN_VALUE));
        phase.push((Math.atan2(z.img, z.real) * 180) / Math.PI);
      }
      traces.push({ name: v.name, type: v.type, complex: true, mag, db, phase, values: mag });
    } else {
      traces.push({ name: v.name, type: v.type, complex: false, values: v.values.slice() });
    }
  });

  // A .dc sweep names its swept source as the first vector rather than giving
  // it a distinguishing type, so promote it when the run is clearly a sweep.
  if (!sweep && result.numPoints > 1 && traces.length > 1) {
    const first = traces.shift();
    sweep = { name: first.name, type: "sweep", values: first.values };
  }

  return {
    kind: complex ? "complex" : "real",
    sweep,
    traces,
    numPoints: result.numPoints,
    info: (() => { try { return s.getInfo(); } catch { return ""; } })()
  };
}

/** Look up one trace by ngspice's own vector name, case-insensitively. */
export function findTrace(result, name) {
  if (!result) return null;
  const want = String(name).toLowerCase();
  return result.traces.find((t) => t.name.toLowerCase() === want) || null;
}

/** Value of a trace at the final sweep point, which is what .op results need. */
export function lastValue(trace) {
  if (!trace || !trace.values.length) return NaN;
  return trace.values[trace.values.length - 1];
}
