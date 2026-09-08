/**
 * Guided labs.
 *
 * Checks resolve nodes through part labels rather than node numbers, because
 * node numbering falls out of the drawing and shifts the moment a student
 * rewires anything. Asking for "the node on pin 1 of R2" survives that; asking
 * for "node 2" does not.
 */

import { buildNodes, buildNetlist, nodesFor, formatEng } from "./netlist.js";
import { runNetlist, findTrace, lastValue } from "./engine.js";
import { PARTS, netlistNameOf } from "./parts.js";

const near = (a, b, tol) => isFinite(a) && Math.abs(a - b) <= tol;

/* ------------------------------------------------------------- circuits */

const P = (type, x, y, rot, fields) => ({ type, x, y, rot, ...fields });
const W = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

export const LABS = [
  {
    id: "divider",
    title: "Voltage divider",
    summary: "Confirm the divider equation against a real solver, then reshape it to hit a target.",
    tasks: [
      "Run the operating point and read the voltage on the node between R1 and R2.",
      "Check it against R2 / (R1 + R2) × 10 V worked out by hand.",
      "Change R1 so the midpoint sits at 4.00 V, leaving R2 at 3.3 kΩ."
    ],
    circuit: {
      title: "Voltage divider",
      analysis: { type: "op" },
      comps: [
        P("V", 200, 180, 90, { label: "V1", value: "DC 10", ac: "" }),
        P("R", 380, 180, 90, { label: "R1", value: "6.8k" }),
        P("R", 380, 280, 90, { label: "R2", value: "3.3k" }),
        P("GND", 200, 400, 0, { label: "GND" })
      ],
      wires: [
        W(200, 180, 380, 180), W(380, 240, 380, 280),
        W(380, 340, 380, 400), W(380, 400, 200, 400), W(200, 240, 200, 400)
      ],
      seq: { R: 2, V: 1 },
      probes: []
    },
    analysis: { type: "op" },
    checks: [
      {
        label: "The midpoint reaches 4.00 V, within 20 mV",
        test: (ctx) => {
          const v = ctx.v("R2", 0);
          return { pass: near(v, 4.0, 0.02), detail: `midpoint is ${formatEng(v, 4)} V` };
        }
      },
      {
        label: "R2 is still 3.3 kΩ",
        test: (ctx) => {
          const r2 = ctx.part("R2");
          return { pass: !!r2 && Math.abs(ctx.value(r2.value) - 3300) < 1, detail: r2 ? `R2 = ${r2.value}` : "R2 is missing" };
        }
      }
    ]
  },

  {
    id: "rc-lowpass",
    title: "RC low-pass filter",
    summary: "Sweep an RC filter and find the corner frequency where the response falls 3 dB.",
    tasks: [
      "Run the AC sweep and switch the plot to magnitude in dB.",
      "Hover the plot to find where the response has dropped 3 dB below its flat region.",
      "Compare it against 1 / (2πRC).",
      "Change C to 10 nF and predict the new corner before you re-run."
    ],
    circuit: {
      title: "RC low-pass filter",
      analysis: { type: "ac", acPts: "25", acStart: "10", acStop: "1meg" },
      comps: [
        P("V", 200, 180, 90, { label: "V1", value: "SIN(0 1 1k)", ac: "1" }),
        P("R", 280, 180, 0, { label: "R1", value: "1.6k" }),
        P("C", 440, 180, 90, { label: "C1", value: "100n", ic: "" }),
        P("GND", 200, 400, 0, { label: "GND" })
      ],
      wires: [
        W(200, 180, 280, 180), W(340, 180, 440, 180),
        W(440, 240, 440, 400), W(440, 400, 200, 400), W(200, 240, 200, 400)
      ],
      seq: { R: 1, C: 1, V: 1 },
      probes: [{ kind: "v", ref: "440,180", x: 440, y: 180 }]
    },
    analysis: { type: "ac", acPts: "25", acStart: "10", acStop: "1meg" },
    checks: [
      {
        label: "The corner frequency lands near 1 kHz",
        test: (ctx) => {
          const t = ctx.trace(ctx.vname("C1", 0));
          if (!t || !t.db) return { pass: false, detail: "no AC data on the capacitor node" };
          const flat = t.db[0];
          let fc = NaN;
          for (let i = 0; i < t.db.length; i++) {
            if (t.db[i] <= flat - 3) { fc = ctx.result.sweep.values[i]; break; }
          }
          return { pass: near(fc, 995, 250), detail: isFinite(fc) ? `−3 dB near ${formatEng(fc, 3)} Hz` : "never fell 3 dB in the swept range" };
        }
      }
    ]
  },

  {
    id: "rectifier",
    title: "Half-wave rectifier",
    summary: "Watch a diode clip the negative half cycle, then measure the forward drop it costs you.",
    tasks: [
      "Run the transient and compare the source with the load voltage.",
      "Measure the peak output and work out the diode's forward drop.",
      "Add a 10 µF capacitor across the load and re-run to see the ripple flatten."
    ],
    circuit: {
      title: "Half-wave rectifier",
      analysis: { type: "tran", trStep: "100u", trStop: "50m", trUic: false },
      comps: [
        P("V", 200, 180, 90, { label: "V1", value: "SIN(0 10 60)", ac: "" }),
        P("D", 280, 180, 0, { label: "D1", model: "D1N4148" }),
        P("R", 440, 180, 90, { label: "RL", value: "1k" }),
        P("GND", 200, 400, 0, { label: "GND" })
      ],
      wires: [
        W(200, 180, 280, 180), W(340, 180, 440, 180),
        W(440, 240, 440, 400), W(440, 400, 200, 400), W(200, 240, 200, 400)
      ],
      seq: { R: 1, D: 1, V: 1 },
      probes: [
        { kind: "v", ref: "200,180", x: 200, y: 180 },
        { kind: "v", ref: "440,180", x: 440, y: 180 }
      ]
    },
    analysis: { type: "tran", trStep: "100u", trStop: "50m", trUic: false },
    checks: [
      {
        label: "Load peak is roughly a diode drop below the 10 V source peak",
        test: (ctx) => {
          const t = ctx.trace(ctx.vname("RL", 0));
          if (!t) return { pass: false, detail: "no data on the load" };
          const peak = Math.max(...t.values);
          return { pass: peak > 8.8 && peak < 9.9, detail: `load peaks at ${formatEng(peak, 4)} V` };
        }
      },
      {
        label: "The negative half cycle is blocked",
        test: (ctx) => {
          const t = ctx.trace(ctx.vname("RL", 0));
          if (!t) return { pass: false, detail: "no data on the load" };
          const min = Math.min(...t.values);
          return { pass: min > -1.0, detail: `most negative load voltage is ${formatEng(min, 3)} V` };
        }
      }
    ]
  },

  {
    id: "common-emitter",
    title: "Transistor bias point",
    summary: "Set the DC operating point of a common-emitter stage and keep it out of saturation.",
    tasks: [
      "Run the operating point and read the collector and emitter voltages.",
      "Work out V_CE and confirm the transistor is in the active region.",
      "Aim for a collector current near 2 mA by adjusting RB."
    ],
    circuit: {
      title: "Common-emitter bias",
      analysis: { type: "op" },
      comps: [
        P("V", 160, 100, 90, { label: "V1", value: "DC 12", ac: "" }),
        P("R", 240, 100, 90, { label: "RB", value: "1meg" }),
        P("R", 440, 100, 90, { label: "RC", value: "2.2k" }),
        P("NPN", 300, 220, 0, { label: "Q1", model: "QNPN" }),
        P("R", 340, 300, 90, { label: "RE", value: "1k" }),
        P("GND", 160, 420, 0, { label: "GND" })
      ],
      wires: [
        W(160, 100, 440, 100),
        W(240, 160, 240, 220), W(240, 220, 300, 220),
        W(440, 160, 440, 180), W(440, 180, 340, 180),
        W(340, 260, 340, 300),
        W(340, 360, 340, 420), W(340, 420, 160, 420), W(160, 160, 160, 420)
      ],
      seq: { R: 3, V: 1, Q: 1 },
      probes: []
    },
    analysis: { type: "op" },
    checks: [
      {
        label: "Collector current is close to 2 mA",
        test: (ctx) => {
          const vcc = ctx.v("RC", 0), vc = ctx.v("RC", 1);
          const rc = ctx.value(ctx.part("RC")?.value);
          const ic = (vcc - vc) / rc;
          return { pass: near(ic, 2e-3, 4e-4), detail: `collector current is ${formatEng(ic, 3)} A` };
        }
      },
      {
        label: "The transistor is in the active region, V_CE above 1 V",
        test: (ctx) => {
          const vce = ctx.v("RC", 1) - ctx.v("RE", 0);
          return { pass: vce > 1, detail: `V_CE is ${formatEng(vce, 3)} V` };
        }
      }
    ]
  }
  ,{
    id: "inverting-amp",
    title: "Inverting amplifier and clipping",
    summary: "Set the gain with two resistors, then drive the amplifier until the supply rails stop it.",
    tasks: [
      "Run it. The output should be ten times the input and upside down — check the measurement table under the plot.",
      "Confirm that against Rf / Rin worked out by hand.",
      "Change V1 to SIN(0 2 1k) and run again. The output cannot reach 20 V, so it flattens against the rails.",
      "Set U1's rails to +5 and −5, re-run, and watch the clipping tighten."
    ],
    circuit: {
      title: "Inverting amplifier",
      analysis: { type: "tran", trStep: "20u", trStop: "4m", trUic: false },
      comps: [
        P("V", 140, 160, 90, { label: "V1", value: "SIN(0 0.5 1k)", ac: "" }),
        P("R", 200, 160, 0, { label: "R1", value: "1k" }),
        P("R", 360, 60, 0, { label: "R2", value: "10k" }),
        P("OPAMP", 400, 140, 0, { label: "U1", gain: "200k", vpos: "15", vneg: "-15" }),
        P("GND", 340, 120, 0, { label: "GND" }),
        P("GND", 140, 300, 0, { label: "GND" })
      ],
      wires: [
        W(140, 160, 200, 160),
        W(260, 160, 400, 160),
        W(300, 60, 360, 60), W(300, 60, 300, 160),
        W(420, 60, 520, 60), W(520, 60, 520, 140), W(480, 140, 520, 140),
        W(400, 120, 340, 120),
        W(140, 220, 140, 300)
      ],
      seq: { R: 2, V: 1, U: 1 },
      probes: [
        { kind: "v", ref: "140,160", x: 140, y: 160 },
        { kind: "v", ref: "480,140", x: 480, y: 140 }
      ]
    },
    analysis: { type: "tran", trStep: "20u", trStop: "4m", trUic: false },
    checks: [
      {
        label: "The output is inverted relative to the input",
        test: (ctx) => {
          const vin = ctx.trace(ctx.vname("R1", 0));
          const vout = ctx.trace(ctx.vname("U1", 2));
          if (!vin || !vout) return { pass: false, detail: "no data on the input or output node" };
          let k = 0;
          for (let i = 1; i < vin.values.length; i++) {
            if (Math.abs(vin.values[i]) > Math.abs(vin.values[k])) k = i;
          }
          const a = vin.values[k], b = vout.values[k];
          return { pass: a * b < 0, detail: `input ${formatEng(a, 3)} V while output ${formatEng(b, 3)} V` };
        }
      },
      {
        label: "The output is clipping at both supply rails",
        test: (ctx) => {
          const u = ctx.part("U1");
          const vout = ctx.trace(ctx.vname("U1", 2));
          if (!u || !vout) return { pass: false, detail: "U1 or its output is missing" };
          const hi = ctx.value(u.vpos), lo = ctx.value(u.vneg);
          const max = Math.max(...vout.values), min = Math.min(...vout.values);
          const pass = Math.abs(max - hi) < 0.05 && Math.abs(min - lo) < 0.05;
          return {
            pass,
            detail: `output runs ${formatEng(min, 4)} to ${formatEng(max, 4)} V against rails ${lo} and ${hi}`
          };
        }
      }
    ]
  }
];

/* -------------------------------------------------------------- checking */

/**
 * Build the context a lab check runs against: node lookups by part label,
 * trace lookups by ngspice vector name, and SPICE value parsing.
 */
function makeContext(store, result) {
  const net = buildNodes(store.state.comps, store.state.wires);

  const part = (label) => store.state.comps.find((c) => c.label === label) || null;

  const node = (label, pin) => {
    const c = part(label);
    if (!c) return null;
    const nd = nodesFor(c, net);
    return nd[pin] ?? null;
  };

  const vname = (label, pin) => {
    const n = node(label, pin);
    return n === null ? null : `v(${n})`;
  };

  const trace = (name) => (name ? findTrace(result, name) : null);

  const v = (label, pin) => {
    const n = node(label, pin);
    if (n === null) return NaN;
    if (n === 0) return 0;
    return lastValue(findTrace(result, `v(${n})`));
  };

  const i = (label) => {
    const c = part(label);
    if (!c) return NaN;
    return lastValue(findTrace(result, `i(${netlistNameOf(c).toLowerCase()})`));
  };

  return {
    result, net, part, node, vname, trace, v, i,
    value: (s) => {
      const m = String(s ?? "").trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|[tgkmunpf])?/i);
      if (!m) return NaN;
      const mult = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
      const suf = (m[2] || "").toLowerCase();
      return parseFloat(m[1]) * (suf && mult[suf] !== undefined ? mult[suf] : 1);
    }
  };
}

/**
 * Run a lab's checks against the current sheet.
 * Returns { ok, results:[{label, pass, detail}], error }.
 */
export async function runChecks(lab, store, onProgress) {
  const analysis = { ...store.state.analysis, ...(lab.analysis || {}) };
  const { text } = buildNetlist(store.state.comps, store.state.wires, analysis, lab.title);

  let result;
  try {
    result = await runNetlist(text, onProgress);
  } catch (e) {
    return { ok: false, results: [], error: e.message };
  }

  const ctx = makeContext(store, result);
  const results = lab.checks.map((chk) => {
    try {
      const out = chk.test(ctx);
      return { label: chk.label, pass: !!out.pass, detail: out.detail || "" };
    } catch (e) {
      return { label: chk.label, pass: false, detail: `could not be evaluated: ${e.message}` };
    }
  });

  return { ok: results.every((r) => r.pass), results, error: null, result };
}

export function labById(id) {
  return LABS.find((l) => l.id === id) || null;
}

export { PARTS };
