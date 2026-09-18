/**
 * Guided labs.
 *
 * Checks resolve nodes through part labels and net names rather than node
 * numbers, because node numbering falls out of the drawing and shifts the
 * moment a student rewires anything. Asking for "the node on pin 1 of R2" or
 * "the node called OUT" survives that; asking for "node 2" does not.
 *
 * A lab is one of four kinds:
 *   explore   a working circuit to investigate and adjust
 *   fix       a circuit with deliberate errors to find and correct
 *   simulate  a finished circuit; the student sets up the analysis and probes
 *   draw      a blank sheet; the student draws the circuit from the handout
 *
 * For `simulate` and `draw` labs that grade the student's own simulation
 * settings, `useStudentAnalysis` is set and the checker runs exactly what the
 * student configured. Otherwise `analysis` overrides it for the check run.
 */

import { buildNodes, nodesFor, nodeAtPoint, formatEng, parseValue, paramValues } from "./netlist.js";
import { lastValue } from "./engine.js";
import { PARTS, pinsOf, netNameOf, placePoint } from "./parts.js";
import { parseStimulus, levelOf as logicOf, RAIL } from "./digital.js";
import { simulate, traceAt, probeTraceName } from "./simulate.js";

const near = (a, b, tol) => isFinite(a) && Math.abs(a - b) <= tol;
const lc = (s) => String(s ?? "").trim().toLowerCase();

/* ------------------------------------------------------------- circuits */

const P = (type, x, y, rot, fields) => ({ type, x, y, rot, ...fields });
const W = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const G = (x, y, rot = 0) => P("GND", x, y, rot, { label: "GND" });
const NET = (x, y, name) => P("NET", x, y, 0, { label: `NET_${name}`, name });
const PWR = (x, y, name, rot = 0) => P("PWR", x, y, rot, { label: `PWR_${name}_${x}_${y}`, name });

const EXPLORATIONS = [
  {
    id: "divider",
    group: "explore",
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
    group: "explore",
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
    group: "explore",
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
    group: "explore",
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
    group: "explore",
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

/* -------------------------------------------------------------- context */

/** DC value of a source, or NaN for a time-varying one. */
export function dcOf(comp) {
  const s = String(comp?.value ?? "").trim();
  if (/^(sin|pulse|pwl|exp|sffm|am)\s*\(/i.test(s)) return NaN;
  return parseValue(s.replace(/^dc\s*/i, ""));
}

/** Arguments of SIN(...), as numbers. */
function sinOf(comp) {
  const m = String(comp?.value ?? "").match(/^\s*sin\s*\(([^)]*)\)/i);
  return m ? m[1].trim().split(/[\s,]+/).map(parseValue) : null;
}

function makeContext(state, result, ref) {
  const net = buildNodes(state.comps, state.wires);
  const real = state.comps.filter((c) => !PARTS[c.type].virtual && c.type !== "GND");

  const part = (label) => real.find((c) => lc(c.label) === lc(label)) || null;
  const node = (label, pin) => {
    const c = part(label);
    return c ? nodesFor(c, net)[pin] : undefined;
  };
  const named = (name) => {
    if (name === "0" || lc(name) === "gnd") return 0;
    if (name === RAIL) return state.comps.some((c) => c.type === "DHI") ? RAIL : undefined;
    const c = state.comps.find((k) => lc(netNameOf(k)) === lc(name));
    return c ? net.pinNode.get(`${c.id}:0`) : undefined;
  };

  /**
   * A node specification:
   *   0 or "0"             ground
   *   "OUT"                the node carrying that net name
   *   ["R1", 1]            pin 1 of R1
   *   { other: "R1", from: spec }   whichever end of R1 is not on `from`
   */
  const resolve = (spec) => {
    if (spec === 0) return 0;
    if (typeof spec === "string") return named(spec);
    if (Array.isArray(spec)) return node(spec[0], spec[1]);
    if (spec && spec.other) {
      const c = part(spec.other);
      const from = resolve(spec.from);
      if (!c || from === undefined) return undefined;
      const ends = nodesFor(c, net);
      if (ends[0] === from) return ends[1];
      if (ends[1] === from) return ends[0];
      return undefined;
    }
    return undefined;
  };

  const describeSpec = (spec) => {
    if (spec === 0 || spec === "0") return "ground";
    if (spec === RAIL) return "logic 1 ($D_HI)";
    if (typeof spec === "string") return spec;
    if (Array.isArray(spec)) {
      const c = part(spec[0]);
      const pin = c ? PARTS[c.type].pinNames[spec[1]] : spec[1];
      return `${spec[0]} ${pin}`;
    }
    if (spec && spec.other) return `the far end of ${spec.other}`;
    return "?";
  };
  const describeNode = (n) => (n === 0 ? "ground" : n === undefined ? "nothing"
    : n === RAIL ? "logic 1 ($D_HI)" : typeof n === "string" ? n : `node ${n}`);

  const volt = (res, nd) => {
    if (nd === undefined || nd === null) return NaN;
    if (nd === 0) return 0;
    return lastValue(traceAt(res, `v(${nd})`));
  };

  const probes = state.probes.map((p) => ({
    ...p,
    trace: probeTraceName(p, state, net),
    node: p.kind === "i" ? undefined : nodeAtPoint(net, state.wires, p.x, p.y),
    node2: p.kind === "vd" ? nodeAtPoint(net, state.wires, p.x2, p.y2) : undefined
  }));

  const openEnds = () => {
    const out = [];
    state.wires.forEach((w) => {
      if (w.bus) return;
      [[w.x1, w.y1], [w.x2, w.y2]].forEach(([x, y]) => {
        if ((net.degree.get(`${x},${y}`) || 0) < 2) out.push(`a wire end at ${x}, ${y}`);
      });
    });
    real.forEach((c) => {
      nodesFor(c, net).forEach((nd, i) => {
        if (nd !== 0 && (net.pinCount.get(nd) || 0) < 2) out.push(`${c.label} ${PARTS[c.type].pinNames[i]}`);
      });
    });
    return out;
  };

  /** Pin extents of a part, for layout checks. */
  const span = (label) => {
    const c = part(label);
    if (!c) return null;
    const ps = pinsOf(c);
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
             cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
  };

  /** Value of a trace at the sweep point nearest x. */
  const at = (trace, x, res = result) => {
    if (!trace || !res?.sweep) return NaN;
    const xs = res.sweep.values;
    let best = 0;
    for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - x) < Math.abs(xs[best] - x)) best = k;
    return Math.abs(xs[best] - x) > Math.abs(x) * 0.02 + 1e-9 ? NaN : trace.values[best];
  };

  return {
    state, result, ref, net, real,
    title: state.title || "",
    analysis: state.analysis,
    answers: state.answers || {},
    part, node, named, resolve, describeSpec, describeNode, span, at, openEnds, probes,
    count: (type) => real.filter((c) => c.type === type).length,
    dc: (label) => dcOf(part(label)),
    sin: (label) => sinOf(part(label)),

    /** Voltage at a node spec in the check run (or `res`). */
    vn: (spec, res = result) => volt(res, resolve(spec)),
    // Kept for the exploration labs, which address nodes as label + pin.
    v: (label, pin) => volt(result, node(label, pin)),
    vname: (label, pin) => {
      const n = node(label, pin);
      return n === undefined ? null : `v(${n})`;
    },
    nodeTrace: (spec, step = null, res = result) => {
      const n = resolve(spec);
      return n === undefined || n === 0 ? null : traceAt(res, `v(${n})`, step);
    },
    trace: (name, step = null, res = result) => traceAt(res, name, step),
    i: (label) => {
      const c = part(label);
      return c ? lastValue(traceAt(result, `i(${lc(c.label)})`)) : NaN;
    },

    joins(label, specs, ordered = false) {
      const c = part(label);
      if (!c) return { pass: false, detail: `there is no part called ${label}` };
      const want = specs.map(resolve);
      const missing = specs.find((s, k) => want[k] === undefined && typeof s === "string");
      if (missing) return { pass: false, detail: `there is no net alias called ${missing}` };
      const have = nodesFor(c, net);
      const ok = ordered
        ? want.every((n, k) => n !== undefined && n === have[k])
        : want.length === 2 && want.every((n) => n !== undefined) &&
          ((have[0] === want[0] && have[1] === want[1]) || (have[0] === want[1] && have[1] === want[0]));
      if (ok) return { pass: true, detail: "" };
      const names = PARTS[c.type].pinNames;
      const wanted = specs.map((s, k) => (ordered ? `${names[k]} to ${describeSpec(s)}` : describeSpec(s))).join(ordered ? ", " : " and ");
      const got = have.map((n, k) => (ordered ? `${names[k]} to ${describeNode(n)}` : describeNode(n))).join(ordered ? ", " : " and ");
      return { pass: false, detail: `${label} should connect ${wanted}; it connects ${got}` };
    },

    value: (s) => parseValue(s),
    probeOn: (spec) => {
      const n = resolve(spec);
      return n !== undefined && probes.some((p) => p.kind === "v" && p.node === n);
    },
    diffProbe: (a, b) => {
      const na = resolve(a), nb = resolve(b);
      return na !== undefined && nb !== undefined && probes.some((p) => p.kind === "vd" && p.node === na && p.node2 === nb);
    },
    currentProbe: (label) => probes.some((p) => p.kind === "i" && lc(p.ref) === lc(label))
  };
}

/* --------------------------------------------------------- check builders */

const sameNum = (a, b) => isFinite(a) && isFinite(b) && Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-6);

const K = {
  /** The sheet title names the lab, e.g. "LAB 06A". */
  title(code) {
    const m = code.match(/^0*(\d+)([A-Za-z])$/);
    const re = new RegExp(`\\blab\\s*0*${m[1]}\\s*-?\\s*${m[2]}\\b`, "i");
    return {
      label: `The sheet title reads LAB ${code}`,
      test: (ctx) => ({ pass: re.test(ctx.title), detail: `the title is "${ctx.title}"` })
    };
  },

  /**
   * Parts and values. `spec` maps a reference designator to one of:
   * a value string, { dc }, { dc, ac }, { sin: [off, amp, freq] }, { model }, { text }.
   */
  parts(spec, label = "Every part has the name and value from the handout") {
    return {
      label,
      test: (ctx) => {
        for (const [ref, want] of Object.entries(spec)) {
          const c = ctx.part(ref);
          if (!c) return { pass: false, detail: `there is no part called ${ref}` };
          if (typeof want === "object" && want.type && c.type !== want.type) {
            return { pass: false, detail: `${ref} is a ${PARTS[c.type].name.toLowerCase()}; it should be a ${PARTS[want.type].name.toLowerCase()}` };
          }
          if (typeof want === "string") {
            if (/\s/.test(String(c.value).trim())) return { pass: false, detail: `${ref} is "${c.value}", with a space in it` };
            if (!sameNum(parseValue(c.value), parseValue(want))) return { pass: false, detail: `${ref} is ${c.value || "blank"}; it should be ${want}` };
            continue;
          }
          if (want.text !== undefined && lc(c.value).replace(/\s/g, "") !== lc(want.text)) {
            return { pass: false, detail: `${ref} is ${c.value || "blank"}; it should be ${want.text}` };
          }
          if (want.dc !== undefined && !sameNum(dcOf(c), want.dc)) {
            return { pass: false, detail: `${ref} is ${c.value || "blank"}; it should be DC ${want.dc}` };
          }
          if (want.ac !== undefined && !sameNum(parseValue(c.ac), want.ac)) {
            return { pass: false, detail: `${ref} has an AC magnitude of ${c.ac || "nothing"}; it should be ${want.ac}` };
          }
          if (want.sin) {
            const got = sinOf(c);
            if (!got || !want.sin.every((v, k) => sameNum(got[k], v))) {
              return { pass: false, detail: `${ref} is ${c.value}; it should be SIN(${want.sin.join(" ")})` };
            }
          }
          if (want.pulse) {
            for (const [k, v] of Object.entries(want.pulse)) {
              if (!sameNum(parseValue(c[k]), parseValue(v))) {
                return { pass: false, detail: `${ref} has ${k.toUpperCase()} = ${c[k] || "blank"}; it should be ${v}` };
              }
            }
          }
          if (want.fields) {
            for (const [k, v] of Object.entries(want.fields)) {
              if (!sameNum(parseValue(c[k]), parseValue(v))) {
                const f = PARTS[c.type].fields.find((q) => q.k === k);
                return { pass: false, detail: `${ref} has ${f ? f.label.split(",")[0] : k} = ${c[k] || "blank"}; it should be ${v}` };
              }
            }
          }
          if (want.model && c.model !== want.model) {
            return { pass: false, detail: `${ref} uses the ${c.model} model; it should be ${want.model}` };
          }
          if (want.type && c.type !== want.type) {
            return { pass: false, detail: `${ref} is a ${PARTS[c.type].name.toLowerCase()}; it should be a ${PARTS[want.type].name.toLowerCase()}` };
          }
        }
        return { pass: true, detail: "" };
      }
    };
  },

  /** Rows of [label, [spec, spec], ordered?]. */
  wiring(rows, label = "The circuit is wired as the handout shows") {
    return {
      label,
      test: (ctx) => {
        for (const [ref, specs, ordered] of rows) {
          const r = ctx.joins(ref, specs, !!ordered);
          if (!r.pass) return r;
        }
        return { pass: true, detail: "" };
      }
    };
  },

  noOpenEnds() {
    return {
      label: "Nothing is left hanging: every wire end and pin connects to something",
      test: (ctx) => {
        const open = ctx.openEnds();
        return { pass: !open.length, detail: open.length ? `open: ${open.slice(0, 3).join(", ")}${open.length > 3 ? ` and ${open.length - 3} more` : ""}` : "" };
      }
    };
  },

  aliasOn(name, spec, where) {
    return {
      label: `A net alias named ${name} sits on ${where}`,
      test: (ctx) => {
        const n = ctx.named(name);
        if (n === undefined) return { pass: false, detail: `there is no alias called ${name}` };
        const want = ctx.resolve(spec);
        return { pass: n === want, detail: n === want ? "" : `${name} is on ${ctx.describeNode(n)}, not on ${where}` };
      }
    };
  },

  op() {
    return {
      label: "The analysis is Operating point (PSpice's Bias Point)",
      test: (ctx) => ({ pass: ctx.analysis.type === "op", detail: `the analysis is ${ctx.analysis.type}` })
    };
  },

  dc(src, start, stop, step) {
    return {
      label: `The analysis is a DC sweep of ${src} from ${start} to ${stop} in steps of ${step}`,
      test: (ctx) => {
        const a = ctx.analysis;
        if (a.type !== "dc") return { pass: false, detail: `the analysis is ${a.type}, not a DC sweep` };
        if (lc(a.dcSrc) !== lc(src)) return { pass: false, detail: `the sweep is of ${a.dcSrc || "nothing"}` };
        const ok = sameNum(parseValue(a.dcStart), start) && sameNum(parseValue(a.dcStop), stop) && sameNum(parseValue(a.dcStep), step);
        return { pass: ok, detail: ok ? "" : `the sweep runs ${a.dcStart} to ${a.dcStop} in steps of ${a.dcStep}` };
      }
    };
  },

  ac(start, stop, pts) {
    return {
      label: `The analysis is an AC sweep from ${formatEng(start)} Hz to ${formatEng(stop)} Hz at ${pts} points per decade`,
      test: (ctx) => {
        const a = ctx.analysis;
        if (a.type !== "ac") return { pass: false, detail: `the analysis is ${a.type}, not an AC sweep` };
        const ok = sameNum(parseValue(a.acStart), start) && sameNum(parseValue(a.acStop), stop) && sameNum(parseValue(a.acPts), pts);
        return { pass: ok, detail: ok ? "" : `the sweep runs ${a.acStart} to ${a.acStop} Hz at ${a.acPts} points per decade` };
      }
    };
  },

  tran(stop, maxStep) {
    return {
      label: `The analysis is a transient to ${formatEng(stop)} s with a step of ${formatEng(maxStep)} s or less`,
      test: (ctx) => {
        const a = ctx.analysis;
        if (a.type !== "tran") return { pass: false, detail: `the analysis is ${a.type}, not a transient` };
        const st = parseValue(a.trStop), sp = parseValue(a.trStep);
        const ok = sameNum(st, stop) && sp > 0 && sp <= maxStep * (1 + 1e-6);
        return { pass: ok, detail: ok ? "" : `the run is to ${a.trStop} with a step of ${a.trStep}` };
      }
    };
  },

  param(name, values) {
    return {
      label: `A parametric sweep steps ${name} through ${values.map((v) => formatEng(v, 3)).join(", ")}`,
      test: (ctx) => {
        const a = ctx.analysis;
        if (!a.paramOn) return { pass: false, detail: "the parametric sweep is not turned on" };
        if (lc(a.paramName) !== lc(name)) return { pass: false, detail: `the sweep varies ${a.paramName || "nothing"}` };
        const got = paramValues(a) || [];
        const ok = got.length === values.length && values.every((v, k) => sameNum(got[k], v));
        return { pass: ok, detail: ok ? "" : got.length ? `it steps through ${got.map((v) => formatEng(v, 3)).join(", ")}` : "the sweep values could not be read; check start, stop and increment" };
      }
    };
  },

  probe(spec, where) {
    return {
      label: `A voltage probe sits on ${where}`,
      test: (ctx) => ({ pass: ctx.probeOn(spec), detail: ctx.probeOn(spec) ? "" : `no voltage probe on ${where} yet` })
    };
  },

  /** The plot's User Defined axis ranges. */
  axis(want) {
    const show = (k) => (want[k] === undefined ? "" : formatEng(want[k], 3));
    const parts = [];
    if (want.xMin !== undefined) parts.push(`X ${show("xMin")} to ${show("xMax")}`);
    if (want.yMin !== undefined) parts.push(`Y ${show("yMin")} to ${show("yMax")}`);
    return {
      label: `The plot's axis ranges are ${parts.join(", ")}`,
      test: (ctx) => {
        const p = ctx.state.plot || {};
        for (const k of Object.keys(want)) {
          if (!sameNum(parseValue(p[k]), want[k])) {
            const axis = k[0].toUpperCase();
            const lo = p[`${k[0]}Min`], hi = p[`${k[0]}Max`];
            return { pass: false, detail: String(lo ?? "").trim() || String(hi ?? "").trim()
              ? `the ${axis} range is ${lo || "auto"} to ${hi || "auto"}`
              : `the ${axis} axis is still automatic. Open Axis ranges under the plot` };
          }
        }
        return { pass: true, detail: "" };
      }
    };
  },

  dbMode() {
    return {
      label: "The plot shows magnitude in dB",
      test: (ctx) => {
        const m = ctx.state.plot?.mode || "db";
        return { pass: m === "db", detail: m === "db" ? "" : `the plot is showing ${m === "mag" ? "plain magnitude" : "phase"}` };
      }
    };
  },

  diff(a, b) {
    return {
      label: `A differential probe measures ${a} (+) against ${b} (−)`,
      test: (ctx) => ({ pass: ctx.diffProbe(a, b), detail: ctx.diffProbe(a, b) ? "" : `use Diff probe: click ${a}, then ${b}` })
    };
  },

  /** A gate's inputs, in any order, and its output. */
  gate(label, inputs, out) {
    return {
      label: `${label}'s inputs are ${inputs.join(", ")} and its output is ${out}`,
      test: (ctx) => {
        const c = ctx.part(label);
        if (!c) return { pass: false, detail: `there is no part called ${label}` };
        const nodes = nodesFor(c, ctx.net);
        const ins = nodes.slice(0, -1), o = nodes[nodes.length - 1];
        const want = inputs.map(ctx.resolve);
        const missing = inputs.find((n, i) => want[i] === undefined);
        if (missing) return { pass: false, detail: `nothing is named ${ctx.describeSpec(missing)}` };
        const sorted = (a) => a.map(String).sort().join("|");
        if (sorted(ins) !== sorted(want)) {
          return { pass: false, detail: `its inputs are on ${ins.map(ctx.describeNode).join(", ")}` };
        }
        const wo = ctx.resolve(out);
        return { pass: o === wo, detail: o === wo ? "" : `its output is on ${ctx.describeNode(o)}` };
      }
    };
  },

  /** Specific pins of a many-pinned part: { pinIndex: spec }. */
  pins(label, map, text) {
    return {
      label: text,
      test: (ctx) => {
        const c = ctx.part(label);
        if (!c) return { pass: false, detail: `there is no part called ${label}` };
        const nodes = nodesFor(c, ctx.net);
        for (const [i, spec] of Object.entries(map)) {
          const want = ctx.resolve(spec);
          if (want === undefined || nodes[i] !== want) {
            return { pass: false, detail: `${label} ${PARTS[c.type].pinNames[i]} should be on ${ctx.describeSpec(spec)}; it is on ${ctx.describeNode(nodes[i])}` };
          }
        }
        return { pass: true, detail: "" };
      }
    };
  },

  /** Voltage probes placed in this order, as PSpice stacks them. */
  probeOrder(names) {
    return {
      label: `Voltage probes on ${names.join(", ")}, placed in that order`,
      test: (ctx) => {
        const want = names.map(ctx.resolve);
        const got = ctx.probes.filter((p) => p.kind === "v").map((p) => p.node);
        const missing = names.filter((n, i) => !got.includes(want[i]));
        if (missing.length) return { pass: false, detail: `no probe on ${missing.join(", ")} yet` };
        const order = got.filter((n) => want.includes(n));
        const ok = want.every((n, i) => order[i] === n);
        const shown = order.map((n) => names[want.indexOf(n)]);
        return { pass: ok, detail: ok ? "" : `they are in the order ${shown.join(", ")}. Remove them and place them again` };
      }
    };
  },

  /** A STIM1 source whose commands give the handout's waveform up to `until`. */
  stim(label, commands, until) {
    const ref = parseStimulus(commands, parseValue).points;
    const level = (pts, t) => { let v = pts[0]?.[1] ?? 0; for (const [tt, vv] of pts) if (tt <= t) v = vv; return v; };
    return {
      label: `${label} has the handout's commands, at least up to ${formatEng(until, 3)} s`,
      test: (ctx) => {
        const c = ctx.part(label);
        if (!c) return { pass: false, detail: `there is no part called ${label}` };
        if (c.type !== "STIM") return { pass: false, detail: `${label} should be a digital stimulus (STIM1)` };
        const { points, error } = parseStimulus(c.commands, parseValue);
        if (error) return { pass: false, detail: error };
        const step = until / 400;
        for (let t = step / 2; t < until; t += step) {
          if (level(points, t) !== level(ref, t)) {
            return { pass: false, detail: `at ${formatEng(t, 3)} s it is ${level(points, t)}; the table says ${level(ref, t)}` };
          }
        }
        return { pass: true, detail: "" };
      }
    };
  },

  /**
   * Named signals reach a bus: each has a bus entry on its wire, and the
   * entry's far end is on a bus line.
   */
  bus(names) {
    return {
      label: `${names[0]} to ${names[names.length - 1]} each reach a bus through a bus entry`,
      test: (ctx) => {
        const buses = ctx.state.wires.filter((w) => w.bus);
        if (!buses.length) return { pass: false, detail: "there is no bus on the sheet. Use the Bus tool (Y)" };
        const entries = ctx.state.comps.filter((c) => c.type === "BUSENTRY");
        const onBus = (x, y) => buses.some((b) => Math.min(b.x1, b.x2) <= x && x <= Math.max(b.x1, b.x2) &&
          Math.min(b.y1, b.y2) <= y && y <= Math.max(b.y1, b.y2) &&
          (b.x1 === b.x2 ? x === b.x1 : y === b.y1));
        for (const n of names) {
          const node = ctx.named(n);
          if (node === undefined) return { pass: false, detail: `nothing is named ${n}` };
          const e = entries.find((c) => ctx.net.pinNode.get(`${c.id}:0`) === node);
          if (!e) return { pass: false, detail: `${n} has no bus entry` };
          const [dx, dy] = placePoint(...PARTS.BUSENTRY.busEnd, e);
          if (!onBus(e.x + dx, e.y + dy)) return { pass: false, detail: `the bus entry on ${n} does not reach the bus` };
        }
        return { pass: true, detail: "" };
      }
    };
  },

  /** Parts mirrored (or not) as the handout asks: { label: { mx, my } }. */
  mirrored(want, label) {
    return {
      label,
      test: (ctx) => {
        for (const [ref, flags] of Object.entries(want)) {
          const c = ctx.part(ref);
          if (!c) return { pass: false, detail: `there is no part called ${ref}` };
          for (const [k, v] of Object.entries(flags)) {
            if (!!c[k] !== v) {
              const how = k === "mx" ? "left to right (⇆)" : "top to bottom (⇅)";
              return { pass: false, detail: `${ref} should ${v ? "" : "not "}be mirrored ${how}` };
            }
          }
        }
        return { pass: true, detail: "" };
      }
    };
  },

  ffInit(value) {
    return {
      label: `Flip-flops are initialized to ${value}`,
      test: (ctx) => {
        const v = ctx.analysis.ffInit ?? "X";
        return { pass: v === value, detail: v === value ? "" : `Initialize flip-flops to is ${v}. It is in the Analysis panel, under the transient settings` };
      }
    };
  },

  /** A check that needs the simulation to have run. */
  sim(label, test) {
    return { label, sim: true, test };
  }
};

/** A graded numeric answer. Never reveals the expected value. */
function answerCheck(q) {
  return {
    label: `Your answer: ${q.prompt}`,
    answer: true,
    test: (ctx) => {
      const raw = String(ctx.answers[q.id] ?? "").trim();
      if (!raw) return { pass: false, detail: "no answer entered yet" };
      const got = parseValue(raw.replace(/,/g, ""));
      if (!isFinite(got)) return { pass: false, detail: `"${raw}" is not a number` };
      const expected = q.expect(ctx);
      if (!isFinite(expected)) return { pass: false, detail: "the circuit has to simulate correctly before this can be marked" };
      const tol = Math.max(q.abs ?? 0, (q.rel ?? 0) * Math.abs(expected));
      const ok = Math.abs(got - expected) <= tol;
      return { pass: ok, detail: ok ? `you entered ${raw}` : `you entered ${raw}, which does not match the simulation. Read it again from the plot or the table` };
    }
  };
}

/** The −3 dB corners and peak of an AC magnitude trace. */
function corners(trace, freqs) {
  if (!trace || !trace.db || !freqs) return { peak: NaN, lo: NaN, hi: NaN };
  const db = trace.db;
  let k = 0;
  for (let i = 1; i < db.length; i++) if (db[i] > db[k]) k = i;
  const peak = db[k], level = peak - 3;
  const cross = (i, j) => {
    const t = (level - db[i]) / (db[j] - db[i]);
    return Math.pow(10, Math.log10(freqs[i]) + t * (Math.log10(freqs[j]) - Math.log10(freqs[i])));
  };
  let lo = NaN, hi = NaN;
  for (let i = k; i > 0; i--) if (db[i - 1] <= level) { lo = cross(i - 1, i); break; }
  for (let i = k; i < db.length - 1; i++) if (db[i + 1] <= level) { hi = cross(i, i + 1); break; }
  return { peak, lo, hi };
}

/* ------------------------------------------------------ ELEC 101 labs */

// `code` is kept for readability at the call sites.
const blank = (code, extra = {}) => ({
  title: "Untitled circuit",
  analysis: { type: "op", ...extra },
  comps: [], wires: [], seq: {}, probes: [], notes: []
});

/* Lab 4A: the handout's lab04a, errors included. */
const LAB04A = {
  title: "Untitled circuit",
  analysis: { type: "op" },
  comps: [
    P("V", 160, 200, 90, { label: "V1", value: "", ac: "" }),
    P("R", 260, 140, 0, { label: "R1", value: "1k" }),
    P("NPN", 420, 140, 0, { label: "Q1", model: "Q2N3904" }),
    P("R", 460, 220, 90, { label: "R2", value: "1k" }),
    // Dropped exactly on top of V1, as in the handout. The later part is
    // the one a click picks, so a single click and Delete removes it.
    P("V", 160, 200, 90, { label: "V2", value: "", ac: "" })
  ],
  wires: [
    W(160, 200, 160, 140), W(160, 140, 260, 140),
    W(260, 140, 320, 140),                         // shorts R1 out
    W(320, 140, 420, 140),
    W(460, 100, 460, 40),                          // collector lead to nowhere
    W(460, 180, 460, 220),
    W(460, 280, 460, 340), W(460, 340, 160, 340), W(160, 260, 160, 340)
  ],
  seq: { R: 2, V: 2, Q: 1 },
  probes: []
};

/* Lab 4B: poorly drawn, and R1 has a space in its value. */
const LAB04B = {
  title: "Untitled circuit",
  analysis: { type: "op" },
  comps: [
    P("V", 120, 100, 90, { label: "V1", value: "DC 12", ac: "" }),
    P("R", 180, 80, 0, { label: "R1", value: "1 k" }),
    P("R", 400, 160, 90, { label: "R2", value: "1k" }),
    P("R", 720, 80, 0, { label: "R3", value: "1k" }),
    P("R", 840, 160, 90, { label: "R4", value: "1k" }),
    G(200, 300)
  ],
  wires: [
    W(120, 100, 120, 80), W(120, 80, 180, 80), W(240, 80, 400, 80),
    W(400, 80, 720, 80), W(780, 80, 840, 80), W(840, 80, 840, 160),
    W(400, 80, 400, 160), W(400, 220, 400, 280), W(840, 220, 840, 280),
    W(120, 280, 200, 280), W(200, 280, 400, 280), W(400, 280, 840, 280),
    W(120, 160, 120, 280), W(200, 280, 200, 300)
  ],
  seq: { R: 4, V: 1 },
  probes: []
};

/* Lab 5A: two-stage LM324 band-pass. */
const LAB05A = {
  title: "Untitled circuit",
  analysis: { type: "op" },
  comps: [
    P("V", 60, 200, 90, { label: "VS1", value: "DC 15", ac: "" }),
    P("V", 60, 260, 90, { label: "VS2", value: "DC 15", ac: "" }),
    PWR(60, 180, "VCC"), PWR(60, 340, "VEE", 180), G(100, 260, 270),

    P("V", 160, 380, 90, { label: "VIN", value: "DC 0", ac: "1" }),
    G(160, 460),
    P("C", 220, 320, 0, { label: "C1", value: ".15u", ic: "" }),
    P("R", 340, 360, 90, { label: "R1", value: "15.9k" }),
    G(340, 440),

    G(220, 140, 90),
    P("R", 240, 140, 0, { label: "RIN1", value: "10k" }),
    P("R", 380, 140, 0, { label: "RF1", value: "20k" }),
    P("OPAMP5", 400, 300, 0, { label: "U1", model: "Behavioral", gain: "100k", gbw: "1meg", headroom: "1.5" }),
    PWR(440, 240, "VCC"), PWR(440, 360, "VEE", 180),

    P("R", 540, 300, 0, { label: "R2", value: "15.9k" }),
    P("C", 640, 340, 90, { label: "C2", value: ".56n", ic: "" }),
    G(640, 420),

    G(560, 140, 90),
    P("R", 580, 140, 0, { label: "RIN2", value: "10k" }),
    P("R", 720, 140, 0, { label: "RF2", value: "20k" }),
    P("OPAMP5", 700, 280, 0, { label: "U2", model: "Behavioral", gain: "100k", gbw: "1meg", headroom: "1.5" }),
    PWR(740, 220, "VCC"), PWR(740, 340, "VEE", 180),
    NET(820, 140, "OUT")
  ],
  wires: [
    W(60, 180, 60, 200), W(60, 320, 60, 340), W(60, 260, 100, 260),
    W(160, 440, 160, 460), W(160, 380, 160, 320), W(160, 320, 220, 320),
    W(280, 320, 400, 320), W(340, 320, 340, 360), W(340, 420, 340, 440),
    W(220, 140, 240, 140), W(300, 140, 380, 140),
    W(440, 140, 500, 140), W(500, 140, 500, 300), W(480, 300, 500, 300),
    W(340, 140, 340, 280), W(340, 280, 400, 280),
    W(440, 240, 440, 260), W(440, 340, 440, 360),
    W(500, 300, 540, 300), W(600, 300, 700, 300),
    W(640, 300, 640, 340), W(640, 400, 640, 420),
    W(740, 220, 740, 240), W(740, 320, 740, 340),
    W(560, 140, 580, 140), W(640, 140, 720, 140),
    W(780, 140, 820, 140), W(820, 140, 820, 280), W(780, 280, 820, 280),
    W(680, 140, 680, 260), W(680, 260, 700, 260)
  ],
  seq: { R: 2, C: 2, V: 2, U: 2 },
  probes: []
};

/* Lab 5B: zener in a half-wave circuit. */
const LAB05B = {
  title: "Untitled circuit",
  analysis: { type: "op" },
  comps: [
    P("V", 160, 200, 90, { label: "VS", value: "SIN(0 5 1k)", ac: "" }),
    P("D", 260, 120, 0, { label: "D1", model: "D1N750" }),
    P("R", 420, 200, 90, { label: "R1", value: "1k" }),
    G(300, 340),
    NET(160, 120, "IN"), NET(420, 120, "OUT")
  ],
  wires: [
    W(160, 200, 160, 120), W(160, 120, 260, 120),
    W(320, 120, 420, 120), W(420, 120, 420, 200),
    W(420, 260, 420, 320), W(420, 320, 160, 320), W(160, 260, 160, 320),
    W(300, 320, 300, 340)
  ],
  seq: { R: 1, D: 1 },
  probes: []
};

/* Lab 5C: resistor network for a bias point. */
const LAB05C = {
  title: "Untitled circuit",
  analysis: { type: "tran" },
  comps: [
    P("V", 120, 220, 90, { label: "VS", value: "DC 12", ac: "" }),
    P("R", 200, 140, 0, { label: "R1", value: "2k" }),
    P("R", 420, 140, 0, { label: "R2", value: "1k" }),
    P("R", 340, 220, 90, { label: "R3", value: "4k" }),
    P("R", 560, 220, 90, { label: "R4", value: "3k" }),
    G(340, 360)
  ],
  wires: [
    W(120, 220, 120, 140), W(120, 140, 200, 140),
    W(260, 140, 420, 140), W(480, 140, 560, 140), W(560, 140, 560, 220),
    W(340, 140, 340, 220),
    W(120, 280, 120, 340), W(120, 340, 560, 340),
    W(340, 280, 340, 340), W(560, 280, 560, 340), W(340, 340, 340, 360)
  ],
  seq: { R: 4 },
  probes: []
};

const SERIES_7 = { VS: { dc: 12, type: "V" }, R1: "100", R2: "300" };
const SERIES_7_WIRING = [["VS", ["A", 0], true], ["R1", ["A", "B"]], ["R2", ["B", 0]]];

/** V(node) at a sweep value, for one parametric step or the only run. */
const sweepAt = (ctx, spec, x, step = null) => ctx.at(ctx.nodeTrace(spec, step), x);


/* Lab 8: the series RC circuit of 8A–8C. */
const SERIES_8 = { VS: { dc: 0, ac: 1, type: "V" }, R1: "1k", C1: "1u" };
const SERIES_8_WIRING = [["VS", ["A", 0], true], ["R1", ["A", "B"]], ["C1", ["B", 0]]];
const CVAL_VALUES = [1e-6, 1.5e-6, 2e-6, 2.5e-6, 3e-6];
const CVAL_SWEEP = { paramOn: true, paramName: "CVAL", paramMode: "lin", paramStart: "1u", paramStop: "3u", paramStep: "0.5u" };

function PARAM_IS(name, value) {
  return {
    label: `A Parameter part defines ${name} = ${formatEng(value, 3)}`,
    test: (ctx) => {
      const p = ctx.state.comps.find((c) => c.type === "PARAM" && lc(c.name) === lc(name));
      return { pass: !!p && sameNum(parseValue(p.value), value), detail: p ? `${name} = ${p.value}` : `no Parameter part named ${name}` };
    }
  };
}

/* Lab 9: the four pulse sources of Figure 9-1. */
const PULSE_LABS = [
  { letter: "a", ref: "RANDOM", shape: "Random pulse",
    pulse: { v1: ".3", v2: "4.6", td: "1n", tr: "1n", tf: "2n", pw: "0.5u", per: ".1m" },
    r: "750", c: "100p", stop: "1.2u", step: "1.2n", outMax: 4.595,
    summary: "A single long pulse into an RC circuit. With a 75 ns time constant against a 0.5 µs pulse, the capacitor charges fully and the voltage across R1 spikes at each edge.",
    simLabel: "OUT charges all the way to 4.6 V" },
  { letter: "b", ref: "SQUARE", shape: "Square wave",
    pulse: { v1: ".3", v2: "4.6", td: "0.1n", tr: "0.5n", tf: "0.75n", pw: "0.05u", per: "0.5u" },
    r: "750", c: "10p", stop: "0.12u", step: "0.12n", outMax: 4.595,
    summary: "A faster pulse into a faster RC circuit: 7.5 ns against a 50 ns pulse, so the output still settles each time.",
    simLabel: "OUT settles at 4.6 V during the pulse" },
  { letter: "c", ref: "TRIANGLE", shape: "Triangle wave",
    pulse: { v1: ".3", v2: "4.6", td: "1u", tr: "49.5u", tf: "49.5u", pw: "0.01u", per: "100u" },
    r: "6800", c: "1n", stop: "200u", step: ".2u", outMax: 4.191,
    summary: "Equal rise and fall times make a triangle. The capacitor lags the input, and the voltage across R1 becomes a nearly square wave: RC times the slope.",
    simLabel: "OUT follows the triangle, lagging it to a 4.19 V peak" },
  { letter: "d", ref: "VRAMP", shape: "Ramp",
    pulse: { v1: ".3", v2: "4.6", td: "10n", tr: "49.5u", tf: "0.5u", pw: "0.01u", per: "50u" },
    r: "1600", c: "1000p", stop: "160u", step: "1u", outMax: 4.463,
    summary: "A slow rise and a fast fall make a sawtooth. The voltage across R1 sits at a small step during the ramp and swings hard negative at each drop.",
    simLabel: "OUT follows the ramp to about 4.46 V" }
];

/** Max or min of V(IN,OUT) in the reference run. */
function extreme(ctx, which) {
  const t = ctx.trace(`v(${ctx.named("IN")},${ctx.named("OUT")})`, null, ctx.ref);
  if (!t) return NaN;
  return which === "max" ? Math.max(...t.values) : Math.min(...t.values);
}


/* ------------------------------------------------ digital readings */

/**
 * The logic level of `out` while the inputs hold the combination `want`,
 * read at the end of the first stretch where they do, when the output has
 * had the longest to settle. NaN if the combination never occurs.
 */
function logicWhile(ctx, res, inputs, out, want) {
  const ts = res?.sweep?.values;
  const tin = inputs.map((n) => ctx.nodeTrace(n, null, res));
  const tout = ctx.nodeTrace(out, null, res);
  if (!ts || !tout || tin.some((t) => !t)) return NaN;
  let start = -1;
  for (let k = 0; k < ts.length; k++) {
    const ok = tin.every((t, i) => logicOf(t.values[k]) === want[i]);
    if (ok && start < 0) start = k;
    const closes = start >= 0 && (!ok || k === ts.length - 1);
    if (closes) {
      const end = ok ? k : k - 1;
      if (ts[end] - ts[start] > 0) return logicOf(tout.values[end]);
      start = -1;
    }
  }
  return NaN;
}

/** Logic level of a node at time t. */
function logicAt(ctx, res, node, t) {
  const tr = ctx.nodeTrace(node, null, res);
  const ts = res?.sweep?.values;
  if (!tr || !ts) return NaN;
  // The last point at or before t: a transient's points are wherever the
  // solver put them, so there is no tolerance to apply as for a DC sweep.
  let k = 0;
  while (k < ts.length - 1 && ts[k + 1] <= t) k++;
  return logicOf(tr.values[k]);
}

/** Truth-table questions for a gate, one per input combination. */
function truthQuestions(inputs, out) {
  const rows = [];
  for (let m = 0; m < 1 << inputs.length; m++) {
    const want = inputs.map((_, i) => (m >> (inputs.length - 1 - i)) & 1);
    rows.push({
      id: `tt${want.join("")}`,
      prompt: `${out} when ${inputs.map((n, i) => `${n} = ${want[i]}`).join(", ")}`,
      abs: 0,
      expect: (ctx) => logicWhile(ctx, ctx.ref, inputs, out, want)
    });
  }
  return rows;
}

const DSTM_TABLE = (period, count) => Array.from({ length: count }, (_, i) =>
  `${i ? `${+(i * period).toPrecision(6)}m` : "0s"} ${i % 2}`).join("; ");

/** The Lab 10 command tables, 16 commands each. */
const DSTM1_CMDS = DSTM_TABLE(1, 16);
const DSTM2_CMDS = DSTM_TABLE(2, 16);
const DSTM3_CMDS = DSTM_TABLE(0.5, 16);

/* Lab 10: one gate at a time, with the handout's stimulus tables. */
const LAB10_SOURCES2 = [["DSTM1", DSTM1_CMDS, "A"], ["DSTM2", DSTM2_CMDS, "B"]];
const LAB10_SOURCES3 = [...LAB10_SOURCES2, ["DSTM3", DSTM3_CMDS, "C"]];
const STIM_PARTS2 = { DSTM1: { type: "STIM" }, DSTM2: { type: "STIM" } };
const STIM_PARTS3 = { ...STIM_PARTS2, DSTM3: { type: "STIM" } };
const logicCheck = (inputs, out, fn) => (ctx) => {
  for (let m = 0; m < 1 << inputs.length; m++) {
    const want = inputs.map((_, i) => (m >> (inputs.length - 1 - i)) & 1);
    const got = logicWhile(ctx, ctx.result, inputs, out, want);
    if (got !== fn(want)) return { pass: false, detail: `with ${inputs.map((n, i) => `${n} = ${want[i]}`).join(", ")}, ${out} is ${got}` };
  }
  return { pass: true, detail: "" };
};
const STIM_STEPS = (n) => [
  `Place ${n} Digital stimulus (STIM1) parts on the left, named DSTM1${n === 3 ? ", DSTM2 and DSTM3" : " and DSTM2"}. Give each the commands from the handout's table, as time and level pairs separated by semicolons: DSTM1 is 0s 0; 1m 1; 2m 0; 3m 1 …, DSTM2 changes every 2m${n === 3 ? ", DSTM3 every 0.5m" : ""}. The run only uses the first 8m.`,
  `Wire each stimulus to one gate input, and name those wires A, B${n === 3 ? " and C" : ""}.`
];

const LAB10 = [
  { letter: "a", title: "OR gate", sources: LAB10_SOURCES2,
    summary: "A 7432 OR gate driven by two digital stimuli. The output is 1 when either input is.",
    steps: ["Place a 2-input gate (Gate), set its Device to 7432 OR, and name it U1A.", ...STIM_STEPS(2),
      "Run a short wire from the output and name it Q."],
    parts: { U1A: { type: "GATE2", fields: { device: "7432" } }, ...STIM_PARTS2 },
    wiring: [K.gate("U1A", ["A", "B"], "Q")], probes: ["A", "B", "Q"],
    questions: truthQuestions(["A", "B"], "Q"),
    simLabel: "Q follows A OR B", simTest: logicCheck(["A", "B"], "Q", ([a, b]) => a | b) },
  { letter: "b", title: "NOR gate", from: "e101-10a", sources: LAB10_SOURCES2,
    summary: "Swap the OR for a 7402 NOR: the same function, inverted.",
    steps: ["Start from your 10A circuit. Select U1A and change its Device to 7402 NOR.",
      "Double-click the Q alias and rename it QBAR."],
    parts: { U1A: { type: "GATE2", fields: { device: "7402" } }, ...STIM_PARTS2 },
    wiring: [K.gate("U1A", ["A", "B"], "QBAR")], probes: ["A", "B", "QBAR"],
    questions: truthQuestions(["A", "B"], "QBAR"),
    simLabel: "QBAR is NOT (A OR B)", simTest: logicCheck(["A", "B"], "QBAR", ([a, b]) => 1 - (a | b)) },
  { letter: "c", title: "3-input AND gate", from: "e101-10a", sources: LAB10_SOURCES3,
    summary: "A 7411 three-input AND gate: 1 only when all three inputs are.",
    steps: ["Start from your 10A circuit. Delete the 7432 and place a 3-input gate (Gate3) set to 7411 AND, named U1A.",
      "Move DSTM2 and its wire so it meets the middle input.",
      "Add DSTM3 below, with the handout's commands (it changes every 0.5m), wire it to the bottom input, and name that wire C.",
      "Keep Q on the output."],
    parts: { U1A: { type: "GATE3", fields: { device: "7411" } }, ...STIM_PARTS3 },
    wiring: [K.gate("U1A", ["A", "B", "C"], "Q")], probes: ["A", "B", "C", "Q"],
    questions: truthQuestions(["A", "B", "C"], "Q"),
    simLabel: "Q follows A AND B AND C", simTest: logicCheck(["A", "B", "C"], "Q", ([a, b, c]) => a & b & c) },
  { letter: "d", title: "3-input NAND gate", from: "e101-10c", sources: LAB10_SOURCES3,
    summary: "Swap the AND for a 7410 NAND.",
    steps: ["Start from your 10C circuit. Change U1A's Device to 7410 NAND.", "Rename the Q alias QBAR."],
    parts: { U1A: { type: "GATE3", fields: { device: "7410" } }, ...STIM_PARTS3 },
    wiring: [K.gate("U1A", ["A", "B", "C"], "QBAR")], probes: ["A", "B", "C", "QBAR"],
    questions: truthQuestions(["A", "B", "C"], "QBAR"),
    simLabel: "QBAR is NOT (A AND B AND C)", simTest: logicCheck(["A", "B", "C"], "QBAR", ([a, b, c]) => 1 - (a & b & c)) },
  { letter: "e", title: "NAND then NOT", from: "e101-10d", sources: LAB10_SOURCES3,
    summary: "Put a 7404 inverter after the 7410. Two inversions cancel: the pair behaves like one gate you have already used.",
    steps: ["Start from your 10D circuit.",
      "Place an Inverter (NOT, 7404), U2A, to the right. Wire QBAR to its input.",
      "Run a short wire from its output and name it Q."],
    parts: { U1A: { type: "GATE3", fields: { device: "7410" } }, U2A: { type: "INV" }, ...STIM_PARTS3 },
    wiring: [K.gate("U1A", ["A", "B", "C"], "QBAR"), K.gate("U2A", ["QBAR"], "Q")], probes: ["A", "B", "C", "QBAR", "Q"],
    questions: [
      { id: "same", prompt: "Which single part number behaves like the 7410 followed by the 7404?", abs: 0, expect: () => 7411 },
      { id: "q111", prompt: "Q when A = 1, B = 1, C = 1", abs: 0, expect: (ctx) => logicWhile(ctx, ctx.ref, ["A", "B", "C"], "Q", [1, 1, 1]) },
      { id: "q110", prompt: "Q when A = 1, B = 1, C = 0", abs: 0, expect: (ctx) => logicWhile(ctx, ctx.ref, ["A", "B", "C"], "Q", [1, 1, 0]) }
    ],
    simLabel: "Q is A AND B AND C again", simTest: logicCheck(["A", "B", "C"], "Q", ([a, b, c]) => a & b & c) }
];

/* Lab 11 */
const CLK = (off, on, start, opp) => ({ offtime: off, ontime: on, delay: "0", startval: String(start), oppval: String(opp) });
const CLEAR_CMDS = "0s 1; 2.2m 0; 2.3m 1; 7.9m 0; 8.6m 1";

/** Q3 Q2 Q1 Q0 as a number at time t. */
function countAt(ctx, t, res = ctx.ref, names = ["Q0", "Q1", "Q2", "Q3"]) {
  return names.reduce((sum, q, i) => sum + (logicAt(ctx, res, q, t) << i), 0);
}
const BCD = ["QA", "QB", "QC", "QD"];

/* Lab 12 */
const SUPPLY_SPLIT = { VS1: { dc: 18, type: "V" }, VS2: { dc: 18, type: "V" } };
const SUPPLY_WIRING = [["VS1", ["VCC", 0], true], ["VS2", [0, "VEE"], true]];
const LM = { type: "OPAMP5", model: "LM324" };
const OPAMP_STEPS = [
  "Place the split supply: VS1 and VS2 (DC 18), stacked + up, with their junction grounded, a VCC power symbol on VS1 + and a VEE symbol (rotated 180°) on VS2 −.",
  "Place the LM324 and keep its Model on LM324 (PSpice macromodel): that is the model the handout has you type in. Its inverting input is on top."
];
const LAB12 = [
  { letter: "a", title: "Common-emitter amplifier", gain: 19.9, axis: { yMin: 0, yMax: 20 }, axisText: "Y from 0 to 20",
    summary: "One Q2N2222 stage with voltage-divider bias, a partly bypassed emitter resistor, and coupling capacitors in and out.",
    steps: [
      "Place VS2 (DC 18) with a VCC power symbol on its + side and its − side grounded.",
      "Draw the amplifier from the handout: R1 62k and R2 10k divide VCC for the base; RC 2700 to the collector; RE1 100 then RE2 420 below the emitter, with CE 47u across RE2.",
      "Q1 is an NPN with its Model set to Q2N2222 (the handout's card).",
      "VS1 (DC 0, AC 1) drives the base through C1 = 2u. The collector drives OUT through C2 = 2u, and RL = 1800 loads OUT to ground."
    ],
    parts: {
      VS1: { dc: 0, ac: 1, type: "V" }, VS2: { dc: 18, type: "V" }, Q1: { model: "Q2N2222" },
      R1: "62k", R2: "10k", RC: "2700", RE1: "100", RE2: "420", CE: "47u", C1: "2u", C2: "2u", RL: "1800"
    },
    wiring: [
      ["VS2", ["VCC", 0], true],
      ["C1", [["VS1", 0], ["Q1", 0]]], ["VS1", [{ other: "C1", from: ["Q1", 0] }, 0], true],
      ["R1", ["VCC", ["Q1", 0]]], ["R2", [["Q1", 0], 0]],
      ["RC", ["VCC", ["Q1", 1]]], ["RE1", [["Q1", 2], { other: "RE1", from: ["Q1", 2] }]],
      ["RE2", [{ other: "RE1", from: ["Q1", 2] }, 0]], ["CE", [{ other: "RE1", from: ["Q1", 2] }, 0]],
      ["C2", [["Q1", 1], "OUT"]], ["RL", ["OUT", 0]]
    ],
    extra: [] },
  { letter: "b", title: "Two-stage amplifier", from: "e101-12a", gain: 39.4,
    axis: { xMin: 100, xMax: 10e6, yMin: 20, yMax: 40 }, axisText: "X from 100 to 10MEG and Y from 20 to 40",
    summary: "Two common-emitter stages in cascade, the first coupled to the second through C2. Gains in dB add.",
    steps: [
      "Start from your 12A circuit if you like. Rename its parts for the first stage: RC1, RE1A, RE1B, CE1.",
      "Add the second stage: R3 62k and R4 10k bias Q2 (Q2N2222); RC2 2700; RE2A 200 and RE2B 330 with CE2 47u across RE2B.",
      "Couple Q1's collector to Q2's base through C2 = 2u. Q2's collector drives OUT through C3 = 2u into RL = 1800."
    ],
    parts: {
      VS1: { dc: 0, ac: 1, type: "V" }, VS2: { dc: 18, type: "V" }, Q1: { model: "Q2N2222" }, Q2: { model: "Q2N2222" },
      R1: "62k", R2: "10k", RC1: "2700", RE1A: "100", RE1B: "420", CE1: "47u",
      R3: "62k", R4: "10k", RC2: "2700", RE2A: "200", RE2B: "330", CE2: "47u",
      C1: "2u", C2: "2u", C3: "2u", RL: "1800"
    },
    wiring: [
      ["VS2", ["VCC", 0], true],
      ["C1", [["VS1", 0], ["Q1", 0]]], ["VS1", [{ other: "C1", from: ["Q1", 0] }, 0], true],
      ["R1", ["VCC", ["Q1", 0]]], ["R2", [["Q1", 0], 0]], ["RC1", ["VCC", ["Q1", 1]]],
      ["RE1A", [["Q1", 2], { other: "RE1A", from: ["Q1", 2] }]],
      ["RE1B", [{ other: "RE1A", from: ["Q1", 2] }, 0]], ["CE1", [{ other: "RE1A", from: ["Q1", 2] }, 0]],
      ["C2", [["Q1", 1], ["Q2", 0]]],
      ["R3", ["VCC", ["Q2", 0]]], ["R4", [["Q2", 0], 0]], ["RC2", ["VCC", ["Q2", 1]]],
      ["RE2A", [["Q2", 2], { other: "RE2A", from: ["Q2", 2] }]],
      ["RE2B", [{ other: "RE2A", from: ["Q2", 2] }, 0]], ["CE2", [{ other: "RE2A", from: ["Q2", 2] }, 0]],
      ["C3", [["Q2", 1], "OUT"]], ["RL", ["OUT", 0]]
    ],
    extra: [] },
  { letter: "c", title: "Inverting op-amp amplifier", gain: 20, axis: { yMin: 0, yMax: 20 }, axisText: "Y from 0 to 20",
    summary: "An LM324 with a gain of −RF/R1 = −10, which is 20 dB. RCM matches the resistance each input sees.",
    steps: [...OPAMP_STEPS,
      "VS (DC 0, AC 1) drives the inverting input through R1 = 1k. RF = 10k runs from that input to the output, OUT.",
      "RCM = 990 runs from the non-inverting input to ground. Wire V+ to VCC and V− to VEE with power symbols."],
    parts: { ...SUPPLY_SPLIT, VS: { dc: 0, ac: 1, type: "V" }, R1: "1k", RF: "10k", RCM: "990", U1A: LM },
    wiring: [...SUPPLY_WIRING, ["R1", [["VS", 0], ["U1A", 0]]], ["VS", [{ other: "R1", from: ["U1A", 0] }, 0], true],
      ["RF", [["U1A", 0], "OUT"]], ["RCM", [["U1A", 1], 0]]],
    extra: [K.pins("U1A", { 2: "OUT", 3: "VCC", 4: "VEE" }, "U1A's output is OUT and its supplies are VCC and VEE")] },
  { letter: "d", title: "Non-inverting op-amp amplifier", from: "e101-12c", gain: 20.83,
    axis: { yMin: 1, yMax: 21 }, axisText: "Y from 1 to 21",
    summary: "The same parts rearranged for a gain of 1 + RF/R1 = 11, about 20.8 dB, with the input on the non-inverting side.",
    steps: [...OPAMP_STEPS,
      "R1 = 1k runs from the inverting input to ground; RF = 10k from the inverting input to OUT.",
      "VS (DC 0, AC 1) drives the non-inverting input directly. There is no RCM."],
    parts: { ...SUPPLY_SPLIT, VS: { dc: 0, ac: 1, type: "V" }, R1: "1k", RF: "10k", U1A: LM },
    wiring: [...SUPPLY_WIRING, ["R1", [["U1A", 0], 0]], ["RF", [["U1A", 0], "OUT"]], ["VS", [["U1A", 1], 0], true]],
    extra: [K.pins("U1A", { 2: "OUT", 3: "VCC", 4: "VEE" }, "U1A's output is OUT and its supplies are VCC and VEE")] },
  { letter: "e", title: "Two-stage inverting amplifier", from: "e101-12c", gain: 40,
    axis: { xMin: 100, xMax: 10e6, yMin: 20, yMax: 40 }, axisText: "X from 100 to 10MEG and Y from 20 to 40",
    summary: "Two 20 dB inverting stages in a row: 40 dB, and the two inversions cancel.",
    steps: ["Start from your 12C circuit. Rename RF and RCM to RF1 and RCM1.",
      "Add a second stage, U1B (LM324): R2 = 1k from U1A's output to U1B's inverting input, RF2 = 10k from there to OUT, RCM2 = 990 from its non-inverting input to ground.",
      "Wire U1B's supplies to VCC and VEE."],
    parts: { ...SUPPLY_SPLIT, VS: { dc: 0, ac: 1, type: "V" }, R1: "1k", RF1: "10k", RCM1: "990", R2: "1k", RF2: "10k", RCM2: "990", U1A: LM, U1B: LM },
    wiring: [...SUPPLY_WIRING, ["R1", [["VS", 0], ["U1A", 0]]], ["VS", [{ other: "R1", from: ["U1A", 0] }, 0], true],
      ["RF1", [["U1A", 0], ["U1A", 2]]], ["RCM1", [["U1A", 1], 0]],
      ["R2", [["U1A", 2], ["U1B", 0]]], ["RF2", [["U1B", 0], "OUT"]], ["RCM2", [["U1B", 1], 0]]],
    extra: [K.pins("U1A", { 3: "VCC", 4: "VEE" }, "U1A is powered from VCC and VEE"),
      K.pins("U1B", { 2: "OUT", 3: "VCC", 4: "VEE" }, "U1B's output is OUT and its supplies are VCC and VEE")] }
];

const ELEC101 = [
  /* ---------------------------------------------------------- Lab 4 */
  {
    id: "e101-04a",
    group: "e101-4",
    code: "04A",
    kind: "fix",
    title: "4A · Fix the wiring errors",
    summary: "This is the handout's lab04a with its mistakes left in. The open circles on the sheet and the warnings under Parts and connections point at them. Fix every one.",
    tasks: [
      "Type LAB 04A in the circuit name box at the top of the page. That is your title block.",
      "Two sources are stacked on the same spot. Click the source once: the top one, V2, is selected. Press Delete. The Parts table should now list only V1.",
      "V1 has no value. Double-click it and type DC 12.",
      "A wire runs straight across R1 and shorts it out. ⌘-drag (Ctrl-drag on Windows) R1 up out of the way, click the bare wire underneath, press Delete, then drag R1 back onto the gap.",
      "Q1's collector lead goes nowhere. Draw a wire from its top end across and down to the wire feeding the base, so collector and base are joined.",
      "Add a ground to the bottom wire.",
      "Press Run simulation with the analysis on Operating point, and enter the voltage at Q1's emitter below."
    ],
    questions: [
      { id: "ve", prompt: "Voltage at Q1's emitter, in volts", rel: 0.03,
        expect: (ctx) => ctx.vn(["Q1", 2]) }
    ],
    circuit: LAB04A,
    analysis: { type: "op" },
    checks: [
      K.title("04A"),
      {
        label: "V2 is gone, leaving V1 as the only source",
        test: (ctx) => ({ pass: ctx.count("V") === 1 && !!ctx.part("V1"), detail: `${ctx.count("V")} voltage source${ctx.count("V") === 1 ? "" : "s"} on the sheet` })
      },
      K.parts({ V1: { dc: 12 }, R1: "1k", R2: "1k", Q1: { model: "Q2N3904" } }),
      {
        label: "R1 is back in series between V1 and Q1's base, not shorted",
        test: (ctx) => {
          const r = ctx.joins("R1", [["V1", 0], ["Q1", 0]]);
          if (!r.pass) return r;
          return { pass: ctx.node("R1", 0) !== ctx.node("R1", 1), detail: "R1 still has both ends on one node" };
        }
      },
      {
        label: "Q1's collector is joined to its base",
        test: (ctx) => {
          const b = ctx.node("Q1", 0), c = ctx.node("Q1", 1);
          return { pass: b !== undefined && b === c, detail: b === c ? "" : `the collector is on ${ctx.describeNode(c)} and the base on ${ctx.describeNode(b)}` };
        }
      },
      K.wiring([["R2", [["Q1", 2], ["V1", 1]]]], "R2 runs from Q1's emitter to V1's negative side"),
      {
        label: "The negative side of V1 is grounded",
        test: (ctx) => ({ pass: ctx.node("V1", 1) === 0, detail: `V1 − is on ${ctx.describeNode(ctx.node("V1", 1))}` })
      },
      K.noOpenEnds(),
      K.sim("The emitter sits about 5.6 V up, a diode drop short of half the supply", (ctx) => {
        const v = ctx.vn(["Q1", 2]);
        return { pass: near(v, 5.64, 0.25), detail: `the emitter is at ${formatEng(v, 4)} V` };
      })
    ]
  },

  {
    id: "e101-04b",
    group: "e101-4",
    code: "04B",
    kind: "fix",
    title: "4B · Fix a poor layout",
    summary: "The circuit works in principle but is drawn carelessly, and R1's value will not simulate. Tidy it into the corrected layout from the handout.",
    tasks: [
      "Type LAB 04B in the circuit name box.",
      "R1 reads \"1 k\". SPICE sees the 1 and then a stray k. Double-click the value and make it 1k with no space.",
      "V1 sits higher than R2 and R4. Click V1 and press ↓ until its centre is level with theirs. The wires follow it.",
      "Make the two halves of the top wire match. The lead into R3 (from R2's junction) should be as long as the lead into R1 (from V1), and the lead from R3 to R4 as long as the lead from R1 to the junction. Drag R3 left, then box-select R4 with its wires and move them left.",
      "The ground hangs off to one side. Box-select it with its short wire and move it to hang under R2.",
      "Run the operating point and enter the voltage across R2."
    ],
    questions: [
      { id: "vr2", prompt: "Voltage across R2, in volts", rel: 0.02,
        expect: (ctx) => ctx.vn(["R2", 0]) - ctx.vn(["R2", 1]) }
    ],
    circuit: LAB04B,
    analysis: { type: "op" },
    checks: [
      K.title("04B"),
      K.parts({ R1: "1k", R2: "1k", R3: "1k", R4: "1k", V1: { dc: 12 } }, "R1 reads 1k with no space, and the other values are unchanged"),
      {
        label: "V1, R2 and R4 are centred at the same height",
        test: (ctx) => {
          const [a, b, c] = ["V1", "R2", "R4"].map(ctx.span);
          if (!a || !b || !c) return { pass: false, detail: "a part is missing" };
          const ok = a.cy === b.cy && b.cy === c.cy;
          return { pass: ok, detail: ok ? "" : `their centres are at ${a.cy}, ${b.cy} and ${c.cy}` };
        }
      },
      {
        label: "The leads into R1 and R3 are the same length",
        test: (ctx) => {
          const [v, r1, r2, r3] = ["V1", "R1", "R2", "R3"].map(ctx.span);
          if (!v || !r1 || !r2 || !r3) return { pass: false, detail: "a part is missing" };
          const a = r1.x0 - v.cx, b = r3.x0 - r2.cx;
          return { pass: a === b, detail: a === b ? "" : `into R1 is ${a / 20} grid steps, into R3 is ${b / 20}` };
        }
      },
      {
        label: "The leads out of R1 and R3 are the same length",
        test: (ctx) => {
          const [r1, r2, r3, r4] = ["R1", "R2", "R3", "R4"].map(ctx.span);
          if (!r1 || !r2 || !r3 || !r4) return { pass: false, detail: "a part is missing" };
          const a = r2.cx - r1.x1, b = r4.cx - r3.x1;
          return { pass: a === b, detail: a === b ? "" : `out of R1 is ${a / 20} grid steps, out of R3 is ${b / 20}` };
        }
      },
      {
        label: "The ground hangs directly under R2",
        test: (ctx) => {
          const r2 = ctx.span("R2");
          const gx = ctx.state.comps.filter((c) => c.type === "GND").map((c) => c.x);
          const ok = !!r2 && gx.includes(r2.cx);
          return { pass: ok, detail: ok ? "" : `the ground is at x = ${gx.join(", ")}; R2 is at x = ${r2?.cx}` };
        }
      },
      K.wiring([
        ["V1", [["R1", 0], 0], true],
        ["R1", [["V1", 0], ["R2", 0]]],
        ["R2", [["R1", 1], 0]],
        ["R3", [["R2", 0], ["R4", 0]]],
        ["R4", [["R3", 1], 0]]
      ], "Tidying did not break any connection"),
      K.noOpenEnds(),
      K.sim("R2 sits at 4.8 V, as it should", (ctx) => {
        const v = ctx.vn(["R2", 0]);
        return { pass: near(v, 4.8, 0.02), detail: `R2 is at ${formatEng(v, 4)} V` };
      })
    ]
  },

  /* ---------------------------------------------------------- Lab 5 */
  {
    id: "e101-05a",
    group: "e101-5",
    code: "05A",
    kind: "simulate",
    title: "5A · AC sweep of a band-pass amplifier",
    summary: "A finished two-stage LM324 filter. Set up the AC sweep the handout asks for, probe the output in dB, and read off the gain and the two −3 dB frequencies.",
    tasks: [
      "Type LAB 05A in the circuit name box.",
      "In Analysis, choose AC sweep. Start at 10 Hz, stop at 100k, 101 points per decade. These are PSpice's Start Frequency, End Frequency and Points/Decade.",
      "Pick Probe (B) and click the OUT wire. That is PSpice's dB marker: an AC plot opens in dB.",
      "Run it. The flat top is the mid-band gain. Hover the plot; the legend reads the value under the cursor. The faint lines between decades are the minor grid.",
      "Find the two frequencies where the response is 3 dB below the flat top, and enter all three values below."
    ],
    questions: [
      { id: "gain", prompt: "Mid-band gain, in dB", abs: 0.3,
        expect: (ctx) => corners(ctx.nodeTrace("OUT", null, ctx.ref), ctx.ref?.sweep?.values).peak },
      { id: "flo", prompt: "Lower −3 dB frequency, in Hz", rel: 0.08,
        expect: (ctx) => corners(ctx.nodeTrace("OUT", null, ctx.ref), ctx.ref?.sweep?.values).lo },
      { id: "fhi", prompt: "Upper −3 dB frequency, in Hz", rel: 0.08,
        expect: (ctx) => corners(ctx.nodeTrace("OUT", null, ctx.ref), ctx.ref?.sweep?.values).hi }
    ],
    circuit: LAB05A,
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "1", acStop: "1meg" },
    checks: [
      K.title("05A"),
      K.parts({ C1: ".15u", C2: ".56n", R1: "15.9k", R2: "15.9k", RF1: "20k", RF2: "20k", RIN1: "10k", RIN2: "10k", VIN: { ac: 1 } },
        "The circuit is as supplied"),
      K.ac(10, 100e3, 101),
      K.probe("OUT", "OUT"),
      K.sim("The run shows about 19 dB of gain at OUT", (ctx) => {
        const t = ctx.nodeTrace("OUT");
        const g = t?.db ? Math.max(...t.db) : NaN;
        return { pass: near(g, 19.08, 0.5), detail: isFinite(g) ? `OUT peaks at ${formatEng(g, 4)} dB` : "no AC result at OUT" };
      })
    ]
  },

  {
    id: "e101-05b",
    group: "e101-5",
    code: "05B",
    kind: "simulate",
    title: "5B · Transient with current and voltage",
    summary: "A 5 V sine drives a 4.7 V zener into a 1 kΩ load. Set up the transient run, plot the load current and the input together, and read the current.",
    tasks: [
      "Type LAB 05B in the circuit name box.",
      "In Analysis, choose Transient. Stop time 5m, time step 0.01m. These are PSpice's Run to Time and Maximum step.",
      "Pick Probe (B) and click the body of R1. That is PSpice's current marker: it plots the current into R1's top end.",
      "With the Probe tool still active, click the IN wire to add V(IN). Volts and amps are drawn in separate panes, which is PSpice's Add Plot to Window.",
      "Run it. Enter the peak current in R1 and the most negative current you can see. (Type milliamps with an m: 4.2m.) Why is there any negative current at all? A 4.7 V zener breaks down in reverse."
    ],
    questions: [
      { id: "ipk", prompt: "Peak current in R1, in amps", rel: 0.05,
        expect: (ctx) => {
          const t = ctx.trace("i(r1)", null, ctx.ref);
          return t ? Math.max(...t.values) : NaN;
        } },
      { id: "imin", prompt: "Most negative current in R1, in amps", abs: 0.08e-3,
        expect: (ctx) => {
          const t = ctx.trace("i(r1)", null, ctx.ref);
          return t ? Math.min(...t.values) : NaN;
        } }
    ],
    circuit: LAB05B,
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "10u", trStop: "5m", trUic: false },
    checks: [
      K.title("05B"),
      K.parts({ VS: { sin: [0, 5, 1000] }, D1: { model: "D1N750" }, R1: "1k" }, "The circuit is as supplied"),
      K.tran(5e-3, 1e-5),
      {
        label: "A current probe sits on R1",
        test: (ctx) => ({ pass: ctx.currentProbe("R1"), detail: ctx.currentProbe("R1") ? "" : "click R1's body with the Probe tool" })
      },
      K.probe("IN", "IN"),
      K.sim("The run shows a half-wave current of about 4 mA", (ctx) => {
        const t = ctx.trace("i(r1)");
        const pk = t ? Math.max(...t.values) : NaN;
        return { pass: pk > 3.5e-3 && pk < 4.8e-3, detail: isFinite(pk) ? `R1 current peaks at ${formatEng(pk, 3)} A` : "no current trace for R1" };
      })
    ]
  },

  {
    id: "e101-05c",
    group: "e101-5",
    code: "05C",
    kind: "simulate",
    title: "5C · Bias point and node voltages",
    summary: "Name the input and output nodes, run a bias point, and print every node voltage on the schematic.",
    tasks: [
      "Type LAB 05C in the circuit name box.",
      "Pick Net alias (K) and click the wire between VS and R1. Type IN and press Enter.",
      "Place a second alias on the wire between R2 and R4, named OUT. (PSpice: place IN, then Edit Properties to make the next one OUT.)",
      "In Analysis, choose Operating point. That is PSpice's Bias Point. The plot stays empty: nothing is swept.",
      "Run it, then press Show DC voltages above the sheet. Every node voltage appears on the schematic, like PSpice's V button.",
      "Enter the voltage at OUT and at the junction of R1, R2 and R3."
    ],
    questions: [
      { id: "vout", prompt: "Voltage at OUT, in volts", abs: 0.02, expect: () => 4.5 },
      { id: "vmid", prompt: "Voltage where R1, R2 and R3 meet, in volts", abs: 0.02, expect: () => 6 }
    ],
    circuit: LAB05C,
    useStudentAnalysis: true,
    checks: [
      K.title("05C"),
      K.parts({ VS: { dc: 12 }, R1: "2k", R2: "1k", R3: "4k", R4: "3k" }, "The circuit is as supplied"),
      K.aliasOn("IN", ["VS", 0], "the node between VS and R1"),
      K.aliasOn("OUT", ["R4", 0], "the node between R2 and R4"),
      K.op(),
      {
        label: "Node voltages are showing on the sheet",
        test: (ctx) => ({ pass: !!ctx.state.showBias, detail: ctx.state.showBias ? "" : "press Show DC voltages" })
      },
      K.sim("OUT sits at 4.5 V", (ctx) => {
        const v = ctx.vn("OUT");
        return { pass: near(v, 4.5, 0.01), detail: `OUT is at ${formatEng(v, 4)} V` };
      })
    ]
  },

  /* ---------------------------------------------------------- Lab 6 */
  {
    id: "e101-06a",
    group: "e101-6",
    code: "06A",
    kind: "draw",
    title: "6A · Draw a series circuit",
    summary: "Draw a two-resistor series circuit from scratch, name its nodes, and see how the names appear in the netlist.",
    tasks: [
      "Type LAB 06A in the circuit name box.",
      "Pick R and place R1 across the top. Then press O once, so the next resistor stands upright, and place R2 below and to the right of R1.",
      "Pick V, keep the rotation upright so + is at the top, and place the source level with R2 on the left. Double-click its name and rename it VS.",
      "Set the values: R1 = 100, R2 = 300, VS = DC 12. Double-click a value to change it.",
      "Wire the loop: VS + up and across to R1, R1 across and down to R2, R2 down and back to VS −. Then place a ground on the bottom wire.",
      "Pick Net alias (K). Put A on the corner between VS and R1, and B on the corner between R1 and R2.",
      "Press Full view above the sheet and open the Netlist panel: the nodes are now called A and B instead of numbers. Enter how many nodes there are above ground, then switch back to Lab view if you like."
    ],
    questions: [
      { id: "nodes", prompt: "Nodes above ground", abs: 0, expect: () => 2 }
    ],
    circuit: blank("06A"),
    analysis: { type: "op" },
    checks: [
      K.title("06A"),
      K.parts({ VS: { dc: 12, type: "V" }, R1: "100", R2: "300" }),
      K.wiring(SERIES_7_WIRING),
      K.noOpenEnds(),
      K.sim("B sits at 9 V", (ctx) => {
        const v = ctx.vn("B");
        return { pass: near(v, 9, 0.01), detail: `B is at ${formatEng(v, 4)} V` };
      })
    ]
  },

  {
    id: "e101-06b",
    group: "e101-6",
    code: "06B",
    kind: "draw",
    title: "6B · Draw a series-parallel circuit",
    summary: "Draw a four-resistor series-parallel network. R4 is in parallel with the series pair R2 and R3, and that combination is in series with R1.",
    tasks: [
      "Type LAB 06B in the circuit name box.",
      "Place VS (DC 12, + up) on the left. Place R1 = 100 across the top to its upper right, and R2 = 600 across the top further right.",
      "Press O and place R3 = 600 upright, below and right of R2. Place R4 = 1.2k upright, level with VS, halfway between R1 and R2.",
      "Wire it: VS + to R1; R1 to R2; R2 across and down to R3; R3 down and back along the bottom to VS −. Then R4's top up to the wire between R1 and R2, and R4's bottom down to the bottom wire. A wire that ends on another wire joins it.",
      "Ground the bottom wire.",
      "Place net aliases: IN where VS meets R1, and OUT where R2 meets R3.",
      "Run the operating point and enter the voltage at OUT."
    ],
    questions: [
      { id: "vout", prompt: "Voltage at OUT, in volts", abs: 0.02, expect: () => 36 / 7 }
    ],
    circuit: blank("06B"),
    analysis: { type: "op" },
    checks: [
      K.title("06B"),
      K.parts({ VS: { dc: 12, type: "V" }, R1: "100", R2: "600", R3: "600", R4: "1.2k" }),
      K.wiring([
        ["VS", ["IN", 0], true],
        ["R1", ["IN", { other: "R1", from: "IN" }]],
        ["R4", [{ other: "R1", from: "IN" }, 0]],
        ["R2", [{ other: "R1", from: "IN" }, "OUT"]],
        ["R3", ["OUT", 0]]
      ]),
      K.noOpenEnds(),
      K.sim("OUT sits at 5.14 V", (ctx) => {
        const v = ctx.vn("OUT");
        return { pass: near(v, 36 / 7, 0.01), detail: `OUT is at ${formatEng(v, 4)} V` };
      })
    ]
  },

  {
    id: "e101-06c",
    group: "e101-6",
    code: "06C",
    kind: "draw",
    title: "6C · Draw a differential pair with crossovers",
    summary: "A two-transistor differential stage with split supplies. The new ideas are power symbols in place of long wires, and a wire crossing without connecting.",
    tasks: [
      "Type LAB 06C in the circuit name box.",
      "Place VS (+ up) with value DC 0 and AC magnitude 1: the VAC source. Place C1 = 10u to its upper right, then Q (NPN) to the right of C1 with its base facing left. Name it Q1 and set its model to Q2N2222 in the Selected part panel.",
      "Place Q2, another Q2N2222, lower and further right than Q1.",
      "Wire VS + to C1 and C1 to Q1's base. Run a wire down from VS − and ground it.",
      "Join the two emitters with a wire below the transistors. Then wire Q2's base left, straight across Q1's emitter lead, and down to the wire from VS −. Where it crosses, there must be no dot: wires only connect where one ends on the other.",
      "Place RC1 and RC2 (5k) upright above the two collectors and join their tops with a wire. Place REE (4.8k) upright below the middle of the emitter wire and wire its top up to it.",
      "Place VS1 and VS2 (DC 12, + up), stacked so VS1 − lands on VS2 +. Ground that junction with a wire and a ground symbol.",
      "Pick Power symbol (P). Put VCC on VS1 + and on the wire joining RC1 and RC2. Press O twice so the bar points down, name it VEE, and put it on VS2 − and on the bottom of REE."
    ],
    circuit: blank("06C"),
    simulate: false,
    checks: [
      K.title("06C"),
      K.parts({
        VS: { dc: 0, ac: 1, type: "V" }, C1: "10u",
        Q1: { model: "Q2N2222" }, Q2: { model: "Q2N2222" },
        RC1: "5k", RC2: "5k", REE: "4.8k",
        VS1: { dc: 12, type: "V" }, VS2: { dc: 12, type: "V" }
      }, "Every part has the name, value and model from the handout"),
      K.wiring([
        ["C1", [["VS", 0], ["Q1", 0]]],
        ["VS", [{ other: "C1", from: ["Q1", 0] }, 0], true],
        ["REE", [["Q1", 2], "VEE"]],
        ["REE", [["Q2", 2], "VEE"]],
        ["RC1", [["Q1", 1], "VCC"]],
        ["RC2", [["Q2", 1], "VCC"]],
        ["VS1", ["VCC", 0], true],
        ["VS2", [0, "VEE"], true]
      ]),
      {
        label: "Q2's base goes to ground, and the crossover has no junction",
        test: (ctx) => {
          const b = ctx.node("Q2", 0), e = ctx.node("Q1", 2);
          if (b === e && b !== undefined) return { pass: false, detail: "Q2's base is tied to the emitter wire. Where the wires cross, one must pass over, not end on, the other" };
          return { pass: b === 0, detail: b === 0 ? "" : `Q2's base is on ${ctx.describeNode(b)}` };
        }
      },
      {
        label: "VCC and VEE are power symbols, each used at both ends",
        test: (ctx) => {
          const n = (name) => ctx.state.comps.filter((c) => c.type === "PWR" && lc(c.name) === lc(name)).length;
          const ok = n("VCC") >= 2 && n("VEE") >= 2;
          return { pass: ok, detail: ok ? "" : `found ${n("VCC")} VCC and ${n("VEE")} VEE symbols` };
        }
      },
      K.noOpenEnds()
    ]
  },

  /* ---------------------------------------------------------- Lab 7 */
  {
    id: "e101-07a",
    group: "e101-7",
    code: "07A",
    kind: "draw",
    title: "7A · DC sweep",
    summary: "Draw a series circuit and sweep its source from −12 V to +12 V, plotting the output node.",
    tasks: [
      "Type LAB 07A in the circuit name box.",
      "Draw the series circuit: R1 = 100 across the top, R2 = 300 upright on the right, and VS = DC 12 on the left with + up. Ground the bottom wire.",
      "Place net aliases: A where VS meets R1, and B where R1 meets R2.",
      "In Analysis, choose DC sweep. Source VS, start -12, stop 12, step 0.1.",
      "Pick Probe (B) and click the B node, then run. The plot is V(B) against VS.",
      "Hover the ends of the line and enter V(B) at both ends of the sweep."
    ],
    questions: [
      { id: "vhi", prompt: "V(B) when VS = 12, in volts", abs: 0.05, expect: () => 9 },
      { id: "vlo", prompt: "V(B) when VS = −12, in volts", abs: 0.05, expect: () => -9 }
    ],
    circuit: blank("07A"),
    useStudentAnalysis: true,
    checks: [
      K.title("07A"),
      K.parts(SERIES_7),
      K.wiring(SERIES_7_WIRING),
      K.noOpenEnds(),
      K.dc("VS", -12, 12, 0.1),
      K.probe("B", "B"),
      K.sim("V(B) runs from −9 V to +9 V across the sweep", (ctx) => {
        const hi = sweepAt(ctx, "B", 12), lo = sweepAt(ctx, "B", -12);
        return { pass: near(hi, 9, 0.02) && near(lo, -9, 0.02), detail: `V(B) runs ${formatEng(lo, 3)} to ${formatEng(hi, 3)} V` };
      })
    ]
  },

  {
    id: "e101-07b",
    group: "e101-7",
    code: "07B",
    kind: "draw",
    carryFrom: "e101-07a",
    title: "7B · Differential probe",
    summary: "Same circuit, but measure the voltage across R1 itself, between A and B, instead of against ground.",
    tasks: [
      "Start from your 7A circuit: opening this lab offers to copy it. Rename it LAB 07B.",
      "Keep the same DC sweep: VS from -12 to 12, step 0.1.",
      "Pick Diff probe (X). Click A first, the + side, then B, the − side. If a ground-referenced probe is still on B, remove it with the Probe tool.",
      "Run. The trace is V(A,B), the drop across R1. Enter its value when VS = 12."
    ],
    questions: [
      { id: "vab", prompt: "V(A,B) when VS = 12, in volts", abs: 0.05, expect: () => 3 }
    ],
    circuit: blank("07B"),
    useStudentAnalysis: true,
    checks: [
      K.title("07B"),
      K.parts(SERIES_7),
      K.wiring(SERIES_7_WIRING),
      K.dc("VS", -12, 12, 0.1),
      {
        label: "A differential probe measures A (+) against B (−)",
        test: (ctx) => ({ pass: ctx.diffProbe("A", "B"), detail: ctx.diffProbe("A", "B") ? "" : "use Diff probe: click A, then B" })
      },
      K.sim("V(A,B) runs from −3 V to +3 V", (ctx) => {
        const na = ctx.named("A"), nb = ctx.named("B");
        const t = ctx.trace(`v(${na},${nb})`);
        const hi = ctx.at(t, 12), lo = ctx.at(t, -12);
        return { pass: near(hi, 3, 0.02) && near(lo, -3, 0.02), detail: t ? `V(A,B) runs ${formatEng(lo, 3)} to ${formatEng(hi, 3)} V` : "no differential trace in the results" };
      })
    ]
  },

  {
    id: "e101-07c",
    group: "e101-7",
    code: "07C",
    kind: "draw",
    carryFrom: "e101-07a",
    title: "7C · Parametric sweep",
    summary: "Let R1 take three values in one run. Its value becomes a parameter, and a parametric sweep steps the parameter while the DC sweep runs.",
    tasks: [
      "Start from your 7A circuit and rename it LAB 07C.",
      "Double-click R1's value and type {RVAL}, curly braces included. The braces tell SPICE to look the value up.",
      "Place a Parameter part anywhere on the sheet. Name RVAL, value 100. It connects to nothing: it just defines RVAL.",
      "In Analysis, keep the DC sweep and tick Parametric sweep. Parameter RVAL, linear, start 100, stop 300, step 100. (A value list of 100 200 300 does the same.)",
      "Probe B and run. There is one line for each value of RVAL. Enter V(B) at VS = 12 for each."
    ],
    questions: [
      { id: "v100", prompt: "V(B) at VS = 12 with RVAL = 100, in volts", abs: 0.05, expect: () => 9 },
      { id: "v200", prompt: "V(B) at VS = 12 with RVAL = 200, in volts", abs: 0.05, expect: () => 7.2 },
      { id: "v300", prompt: "V(B) at VS = 12 with RVAL = 300, in volts", abs: 0.05, expect: () => 6 }
    ],
    circuit: blank("07C"),
    useStudentAnalysis: true,
    checks: [
      K.title("07C"),
      K.parts({ VS: { dc: 12, type: "V" }, R1: { text: "{rval}" }, R2: "300" }, "R1 is {RVAL}; R2 and VS are unchanged"),
      {
        label: "A Parameter part defines RVAL = 100",
        test: (ctx) => {
          const p = ctx.state.comps.find((c) => c.type === "PARAM" && lc(c.name) === "rval");
          return { pass: !!p && sameNum(parseValue(p.value), 100), detail: p ? `RVAL = ${p.value}` : "no Parameter part named RVAL" };
        }
      },
      K.wiring(SERIES_7_WIRING),
      K.dc("VS", -12, 12, 0.1),
      K.param("RVAL", [100, 200, 300]),
      K.probe("B", "B"),
      K.sim("Three lines, reaching 9, 7.2 and 6 V at VS = 12", (ctx) => {
        const got = [0, 1, 2].map((k) => sweepAt(ctx, "B", 12, k));
        const ok = [9, 7.2, 6].every((v, k) => near(got[k], v, 0.02));
        return { pass: ok, detail: `at VS = 12: ${got.map((v) => formatEng(v, 3)).join(", ")} V` };
      })
    ]
  },

  {
    id: "e101-07d",
    group: "e101-7",
    code: "07D",
    kind: "draw",
    carryFrom: "e101-07c",
    title: "7D · Extend the swept circuit",
    summary: "Add a second divider after the first and move the output to it. The parametric sweep carries straight over.",
    tasks: [
      "Start from your 7C circuit and rename it LAB 07D.",
      "Place R3 = 150 across, to the right of the B corner. Press O and place R4 = 150 upright, below and right of R3.",
      "Wire the old B corner to R3, R3 to R4, and R4's bottom down to the ground wire.",
      "Move the B alias to the corner between R3 and R4: drag it there. The corner it left, between R1 and R2, now has no name, and that is fine.",
      "Keep the DC and parametric sweeps. Probe B (remove the old probe if it stayed behind) and run.",
      "Enter V(B) at VS = 12 for RVAL = 100."
    ],
    questions: [
      { id: "v100", prompt: "V(B) at VS = 12 with RVAL = 100, in volts", abs: 0.03, expect: () => 3.6 }
    ],
    circuit: blank("07D"),
    useStudentAnalysis: true,
    checks: [
      K.title("07D"),
      K.parts({ VS: { dc: 12, type: "V" }, R1: { text: "{rval}" }, R2: "300", R3: "150", R4: "150" }),
      K.wiring([
        ["VS", ["A", 0], true],
        ["R1", ["A", { other: "R1", from: "A" }]],
        ["R2", [{ other: "R1", from: "A" }, 0]],
        ["R3", [{ other: "R1", from: "A" }, "B"]],
        ["R4", ["B", 0]]
      ]),
      K.noOpenEnds(),
      K.dc("VS", -12, 12, 0.1),
      K.param("RVAL", [100, 200, 300]),
      K.probe("B", "B"),
      K.sim("Three lines, reaching 3.6, 2.57 and 2 V at VS = 12", (ctx) => {
        const got = [0, 1, 2].map((k) => sweepAt(ctx, "B", 12, k));
        const ok = [3.6, 12 * 150 / 350 / 2, 2].every((v, k) => near(got[k], v, 0.02));
        return { pass: ok, detail: `at VS = 12: ${got.map((v) => formatEng(v, 3)).join(", ")} V` };
      })
    ]
  },

  /* ---------------------------------------------------------- Lab 8 */
  {
    id: "e101-08a",
    group: "e101-8",
    code: "08A",
    kind: "draw",
    title: "8A · AC sweep of an RC circuit",
    summary: "Draw a series RC circuit with an AC source, sweep it from 1 Hz to 100 kHz, and frame the Bode plot the way the handout does to read the critical frequency.",
    tasks: [
      "Type LAB 08A in the circuit name box.",
      "Place R1 = 1k across the top, C1 = 1u upright below and right of it, and VS on the left with + up. VS is PSpice's VAC source: value DC 0, AC magnitude 1.",
      "Wire the loop, ground the bottom wire, and add net aliases A (between VS and R1) and B (between R1 and C1).",
      "In Analysis, choose AC sweep: start 1, stop 100k, 201 points per decade. The start can never be 0.",
      "Probe B. The AC plot opens in Magnitude dB, PSpice's dB marker.",
      "Run it. Open Axis ranges under the plot and set Y from -20 to 0, and X from 1 to 10k: one flat decade and 20 dB of roll-off. The faint lines are the 10 minor divisions.",
      "Hover the plot and find the critical frequency, where the gain has dropped 3 dB from the flat part. Enter it below."
    ],
    questions: [
      { id: "fc", prompt: "Critical frequency, in Hz", rel: 0.05,
        expect: (ctx) => corners(ctx.nodeTrace("B", null, ctx.ref), ctx.ref?.sweep?.values).hi }
    ],
    circuit: blank("08A"),
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "1", acStop: "100k" },
    checks: [
      K.title("08A"),
      K.parts(SERIES_8),
      K.wiring(SERIES_8_WIRING),
      K.noOpenEnds(),
      K.ac(1, 100e3, 201),
      K.probe("B", "B"),
      K.dbMode(),
      K.axis({ xMin: 1, xMax: 10e3, yMin: -20, yMax: 0 }),
      K.sim("B rolls off with a corner near 159 Hz", (ctx) => {
        const fc = corners(ctx.nodeTrace("B"), ctx.result?.sweep?.values).hi;
        return { pass: near(fc, 159.2, 8), detail: isFinite(fc) ? `the corner is at ${formatEng(fc, 3)} Hz` : "no −3 dB point in the sweep" };
      })
    ]
  },

  {
    id: "e101-08b",
    group: "e101-8",
    code: "08B",
    kind: "draw",
    carryFrom: "e101-08a",
    title: "8B · The voltage across R1",
    summary: "Same circuit, measured across R1 with a differential probe. The voltage across the resistor rises with frequency: the other half of the same filter.",
    tasks: [
      "Start from your 8A circuit and rename it LAB 08B.",
      "Remove the probe on B: pick Probe and click it again.",
      "Pick Diff probe (X). Click A first, then B. The trace is V(A,B).",
      "Keep the 8A sweep and run. There is no need for PSpice's DB( ) trace edit: in Magnitude dB mode every trace is already in dB.",
      "Set the axis ranges: Y from -20 to 0, X from 10 to 10k.",
      "Enter the frequency where V(A,B) is 3 dB below its high-frequency level."
    ],
    questions: [
      { id: "fc", prompt: "Frequency where V(A,B) is 3 dB down, in Hz", rel: 0.05,
        expect: (ctx) => corners(ctx.trace(`v(${ctx.named("A")},${ctx.named("B")})`, null, ctx.ref), ctx.ref?.sweep?.values).lo }
    ],
    circuit: blank("08B"),
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "1", acStop: "100k" },
    checks: [
      K.title("08B"),
      K.parts(SERIES_8),
      K.wiring(SERIES_8_WIRING),
      K.ac(1, 100e3, 201),
      K.diff("A", "B"),
      K.dbMode(),
      K.axis({ xMin: 10, xMax: 10e3, yMin: -20, yMax: 0 }),
      K.sim("V(A,B) rises to 0 dB, with its corner near 159 Hz", (ctx) => {
        const t = ctx.trace(`v(${ctx.named("A")},${ctx.named("B")})`);
        const c = corners(t, ctx.result?.sweep?.values);
        return { pass: near(c.peak, 0, 0.1) && near(c.lo, 159.2, 8),
          detail: t ? `peaks at ${formatEng(c.peak, 3)} dB, corner ${formatEng(c.lo, 3)} Hz` : "no differential trace in the results" };
      })
    ]
  },

  {
    id: "e101-08c",
    group: "e101-8",
    code: "08C",
    kind: "draw",
    carryFrom: "e101-08a",
    title: "8C · Sweeping the capacitor",
    summary: "Step C1 through five values in one run and watch the corner frequency move down as the capacitance goes up.",
    tasks: [
      "Start from your 8A circuit and rename it LAB 08C.",
      "Change C1's value to {CVAL}, curly braces included.",
      "Place a Parameter part anywhere: name CVAL, value 1u.",
      "Keep the AC sweep and tick Parametric sweep: parameter CVAL, linear, start 1u, end 3u, increment 0.5u.",
      "Keep the probe on B and the 8A axis ranges (Y -20 to 0, X 1 to 10k), then run. Five curves, one per value.",
      "Enter the critical frequency for the smallest and largest capacitor."
    ],
    questions: [
      { id: "f1", prompt: "Critical frequency with CVAL = 1u, in Hz", rel: 0.05,
        expect: (ctx) => corners(ctx.nodeTrace("B", 0, ctx.ref), ctx.ref?.sweep?.values).hi },
      { id: "f3", prompt: "Critical frequency with CVAL = 3u, in Hz", rel: 0.05,
        expect: (ctx) => corners(ctx.nodeTrace("B", 4, ctx.ref), ctx.ref?.sweep?.values).hi }
    ],
    circuit: blank("08C"),
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "1", acStop: "100k", ...CVAL_SWEEP },
    checks: [
      K.title("08C"),
      K.parts({ ...SERIES_8, C1: { text: "{cval}" } }, "C1 is {CVAL}; R1 and VS are unchanged"),
      PARAM_IS("CVAL", 1e-6),
      K.wiring(SERIES_8_WIRING),
      K.ac(1, 100e3, 201),
      K.param("CVAL", CVAL_VALUES),
      K.probe("B", "B"),
      K.dbMode(),
      K.axis({ xMin: 1, xMax: 10e3, yMin: -20, yMax: 0 }),
      K.sim("Five curves, with corners from about 159 Hz down to 53 Hz", (ctx) => {
        const fc = [0, 1, 2, 3, 4].map((k) => corners(ctx.nodeTrace("B", k), ctx.result?.sweep?.values).hi);
        const want = CVAL_VALUES.map((c) => 1 / (2 * Math.PI * 1000 * c));
        const ok = fc.every((f, k) => near(f, want[k], want[k] * 0.05));
        return { pass: ok, detail: `corners at ${fc.map((f) => formatEng(f, 3)).join(", ")} Hz` };
      })
    ]
  },

  {
    id: "e101-08d",
    group: "e101-8",
    code: "08D",
    kind: "draw",
    carryFrom: "e101-08c",
    title: "8D · Adding a transformer",
    summary: "Put a step-up transformer between the source and the filter. The source side now floats, so a very large resistor gives it the path to ground SPICE needs.",
    tasks: [
      "Start from your 8C circuit and rename it LAB 08D.",
      "Cut VS (⌘X) and paste it about an inch to the left. Place the Transformer (Xfmr) in the gap it left: primary (left pins) toward VS, secondary (right pins) toward R1. Name it TX1.",
      "In the Selected part panel set L1_VALUE 10u, L2_VALUE 10m, COUPLING 0.975. That makes a step-up transformer.",
      "Place RS = 1u between A (VS +) and the top primary pin (pin 1). Wire VS − to the bottom primary pin (pin 2).",
      "Wire the top secondary pin (3) to R1 and the bottom secondary pin (4) to the ground wire under C1.",
      "Place RD = 1000MEG from VS − to its own ground. Without it the primary side has no DC path to ground, and SPICE cannot solve it.",
      "Keep the AC and parametric sweeps and the probe on B. Run, then set the Y range to 10 to 30: the output is now above the input.",
      "Enter the low-frequency gain at B for CVAL = 1u, in dB."
    ],
    questions: [
      { id: "gain", prompt: "Gain at B at 10 Hz with CVAL = 1u, in dB", abs: 0.3,
        expect: (ctx) => {
          const t = ctx.nodeTrace("B", 0, ctx.ref);
          return t?.db ? ctx.at({ values: t.db }, 10, ctx.ref) : NaN;
        } }
    ],
    circuit: blank("08D"),
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "1", acStop: "100k", ...CVAL_SWEEP },
    checks: [
      K.title("08D"),
      K.parts({
        ...SERIES_8, C1: { text: "{cval}" }, RS: "1u", RD: "1000MEG",
        TX1: { type: "XFORM", fields: { l1: "10u", l2: "10m", k: "0.975" } }
      }, "Every part has the name and value from the handout"),
      PARAM_IS("CVAL", 1e-6),
      K.wiring([
        ["VS", ["A", ["TX1", 1]], true],
        ["RS", ["A", ["TX1", 0]]],
        ["RD", [["TX1", 1], 0]],
        ["R1", [["TX1", 2], "B"]],
        ["C1", ["B", 0]],
        ["TX1", [{ other: "RS", from: "A" }, ["VS", 1], { other: "R1", from: "B" }, 0], true]
      ]),
      {
        label: "The primary side floats, tied to ground only through RD",
        test: (ctx) => {
          const n = ctx.node("VS", 1);
          return { pass: n !== undefined && n !== 0, detail: n === 0 ? "VS − is wired straight to ground, which shorts RD out" : "" };
        }
      },
      K.noOpenEnds(),
      K.ac(1, 100e3, 201),
      K.param("CVAL", CVAL_VALUES),
      K.probe("B", "B"),
      K.dbMode(),
      K.axis({ xMin: 1, xMax: 10e3, yMin: 10, yMax: 30 }),
      K.sim("The transformer steps the signal up to about +30 dB", (ctx) => {
        const t = ctx.nodeTrace("B", 0);
        const g = t?.db ? t.db[0] : NaN;
        return { pass: near(g, 29.8, 0.6), detail: isFinite(g) ? `B starts at ${formatEng(g, 3)} dB` : "no result at B" };
      })
    ]
  },

  /* ---------------------------------------------------------- Lab 9 */
  ...PULSE_LABS.map((p) => ({
    id: `e101-09${p.letter}`,
    group: "e101-9",
    code: `09${p.letter.toUpperCase()}`,
    kind: "draw",
    carryFrom: p.letter === "a" ? undefined : "e101-09a",
    title: `9${p.letter.toUpperCase()} · ${p.shape} input`,
    summary: p.summary,
    tasks: [
      p.letter === "a"
        ? "Type LAB 09A in the circuit name box."
        : `Start from your 9A circuit if you like, and rename it LAB 09${p.letter.toUpperCase()}.`,
      p.letter === "a"
        ? `Place a Pulse source on the left with + up and name it ${p.ref}. Place R1 across the top from its + terminal and C1 upright on the right, back to its − terminal. Ground the node where the source and C1 meet.`
        : `Rename the pulse source ${p.ref} (double-click its name).`,
      `Set ${p.ref} in the Selected part panel: V1 ${p.pulse.v1}, V2 ${p.pulse.v2}, TD ${p.pulse.td}, TR ${p.pulse.tr}, TF ${p.pulse.tf}, PW ${p.pulse.pw}, PER ${p.pulse.per}. Set R1 = ${p.r} and C1 = ${p.c}.`,
      "Name the input node IN (across the source) and the output node OUT (across C1).",
      `In Analysis, choose Transient: stop time ${p.stop}, time step ${p.step}. These are PSpice's Run to Time and Maximum Step Size.`,
      "Probe IN and OUT, then use Diff probe (X) with + on IN and − on OUT for the voltage across R1.",
      "Run it. If a trace crowds the top or bottom of its plot, set a Y range under Axis ranges, as PSpice's User Defined range does.",
      "The Measurements table under the plot has each trace's Max and Min. Enter the two below."
    ],
    questions: [
      { id: "dmax", prompt: "Most positive V(IN,OUT), in volts", rel: 0.04, abs: 0.02,
        expect: (ctx) => extreme(ctx, "max") },
      { id: "dmin", prompt: "Most negative V(IN,OUT), in volts", rel: 0.04, abs: 0.02,
        expect: (ctx) => extreme(ctx, "min") }
    ],
    circuit: blank(`09${p.letter.toUpperCase()}`),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: p.step, trStop: p.stop, trUic: false },
    checks: [
      K.title(`09${p.letter.toUpperCase()}`),
      K.parts({ [p.ref]: { type: "VPULSE", pulse: p.pulse }, R1: p.r, C1: p.c }),
      K.wiring([[p.ref, ["IN", 0], true], ["R1", ["IN", "OUT"]], ["C1", ["OUT", 0]]]),
      K.noOpenEnds(),
      K.tran(parseValue(p.stop), parseValue(p.step)),
      K.probe("IN", "IN"),
      K.probe("OUT", "OUT"),
      K.diff("IN", "OUT"),
      K.sim(p.simLabel, (ctx) => {
        const t = ctx.nodeTrace("OUT");
        const hi = t ? Math.max(...t.values) : NaN;
        return { pass: near(hi, p.outMax, 0.05), detail: isFinite(hi) ? `OUT peaks at ${formatEng(hi, 4)} V` : "no result at OUT" };
      })
    ]
  })),

  /* --------------------------------------------------------- Lab 10 */
  ...LAB10.map((g) => ({
    id: `e101-10${g.letter}`,
    group: "e101-10",
    code: `10${g.letter.toUpperCase()}`,
    kind: "draw",
    carryFrom: g.from,
    title: `10${g.letter.toUpperCase()} · ${g.title}`,
    summary: g.summary,
    tasks: [
      `Type LAB 10${g.letter.toUpperCase()} in the circuit name box.`,
      ...g.steps,
      "In Analysis, choose Transient: stop time 8m, time step 0.8m.",
      `Pick Probe and click ${g.probes.join(", then ")}, in that order. Logic signals plot as separate 0/1 lanes, top to bottom in the order you placed them.`,
      "Run it, then read the output for each input combination and fill in the truth table below."
    ],
    questions: g.questions,
    circuit: blank(`10${g.letter.toUpperCase()}`),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "0.05m", trStop: "8m", trUic: false },
    checks: [
      K.title(`10${g.letter.toUpperCase()}`),
      K.parts(g.parts, "Every part has the part number and name from the handout"),
      ...g.sources.map(([ref, cmds]) => K.stim(ref, cmds, 8e-3)),
      K.wiring(g.sources.map(([ref, , net]) => [ref, [net], true]), "Each stimulus drives its own named node"),
      ...g.wiring,
      K.tran(8e-3, 0.8e-3),
      K.probeOrder(g.probes),
      K.sim(g.simLabel, g.simTest)
    ]
  })),

  /* --------------------------------------------------------- Lab 11 */
  {
    id: "e101-11a",
    group: "e101-11",
    code: "11A",
    kind: "draw",
    title: "11A · XOR with clock inputs",
    summary: "An exclusive-OR gate fed by two digital clocks at different rates, so every input combination comes round in half a millisecond.",
    tasks: [
      "Type LAB 11A in the circuit name box.",
      "Place a 2-input gate (Gate) and set its Device to 7486 XOR. Name it U1A.",
      "Place two DigClock sources, DSTM1 above-left and DSTM2 below-left. DSTM1: OFFTIME .2m, ONTIME .2m. DSTM2: OFFTIME .1m, ONTIME .1m. Leave DELAY 0, STARTVAL 0, OPPVAL 1.",
      "Wire DSTM1 to the top input and DSTM2 to the bottom input, and run a short wire from the output.",
      "Net aliases: A on the DSTM1 wire, B on the DSTM2 wire, Q at the end of the output wire.",
      "In Analysis, choose Transient: stop time .5m, time step 1u.",
      "Probe A, then B, then Q, in that order. Run it and fill in the truth table."
    ],
    questions: truthQuestions(["A", "B"], "Q"),
    circuit: blank("11A"),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "2u", trStop: "0.5m", trUic: false },
    checks: [
      K.title("11A"),
      K.parts({
        U1A: { type: "GATE2", fields: { device: "7486" } },
        DSTM1: { type: "DCLK", fields: CLK(".2m", ".2m", 0, 1) },
        DSTM2: { type: "DCLK", fields: CLK(".1m", ".1m", 0, 1) }
      }, "Every part has the part number and settings from the handout"),
      K.wiring([["DSTM1", ["A"], true], ["DSTM2", ["B"], true]], "Each clock drives its own named node"),
      K.gate("U1A", ["A", "B"], "Q"),
      K.tran(0.5e-3, 1e-6),
      K.probeOrder(["A", "B", "Q"]),
      K.sim("Q is 1 exactly when A and B differ", (ctx) => {
        const bad = [[0, 0], [0, 1], [1, 0], [1, 1]].find(([a, b]) => logicWhile(ctx, ctx.result, ["A", "B"], "Q", [a, b]) !== (a ^ b));
        return { pass: !bad, detail: bad ? `with A = ${bad[0]}, B = ${bad[1]} the output is wrong` : "" };
      })
    ]
  },

  {
    id: "e101-11b",
    group: "e101-11",
    code: "11B",
    kind: "draw",
    title: "11B · RS latch",
    summary: "Two NAND gates, each feeding the other, make a latch: a circuit that remembers. SBAR low sets Q, RBAR low resets it, and with both high it holds whatever it last had.",
    tasks: [
      "Type LAB 11B in the circuit name box.",
      "Place two 2-input gates, U1A and U1B, both 7400 NAND, U1B below U1A.",
      "Place DigClock DSTM1 at U1A's top input: OFFTIME 75u, ONTIME 75u, STARTVAL 1, OPPVAL 0. Place DSTM2 at U1B's bottom input: OFFTIME .15m, ONTIME .15m, STARTVAL 0, OPPVAL 1.",
      "Run a wire from each output to the right. Name them Q (U1A) and QBAR (U1B), and name the input wires SBAR (DSTM1) and RBAR (DSTM2).",
      "Cross-couple the gates: Q to U1B's top input, and QBAR to U1A's bottom input. The handout draws these as diagonals; here route them around with right angles. Where they cross, there must be no dot.",
      "In Analysis, choose Transient: stop time 0.5m, time step 1u.",
      "Probe SBAR, RBAR, Q, then QBAR. Run it and answer the questions below from the lanes."
    ],
    questions: [
      { id: "set", prompt: "Q while SBAR = 0 and RBAR = 1", abs: 0, expect: (ctx) => logicWhile(ctx, ctx.ref, ["SBAR", "RBAR"], "Q", [0, 1]) },
      { id: "reset", prompt: "Q while SBAR = 1 and RBAR = 0", abs: 0, expect: (ctx) => logicWhile(ctx, ctx.ref, ["SBAR", "RBAR"], "Q", [1, 0]) },
      { id: "both", prompt: "QBAR while SBAR = 0 and RBAR = 0 (the state a latch should avoid)", abs: 0,
        expect: (ctx) => logicWhile(ctx, ctx.ref, ["SBAR", "RBAR"], "QBAR", [0, 0]) }
    ],
    circuit: blank("11B"),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "1u", trStop: "0.5m", trUic: false },
    checks: [
      K.title("11B"),
      K.parts({
        U1A: { type: "GATE2", fields: { device: "7400" } },
        U1B: { type: "GATE2", fields: { device: "7400" } },
        DSTM1: { type: "DCLK", fields: CLK("75u", "75u", 1, 0) },
        DSTM2: { type: "DCLK", fields: CLK(".15m", ".15m", 0, 1) }
      }, "Every part has the part number and settings from the handout"),
      K.wiring([["DSTM1", ["SBAR"], true], ["DSTM2", ["RBAR"], true]], "The clocks drive SBAR and RBAR"),
      K.gate("U1A", ["SBAR", "QBAR"], "Q"),
      K.gate("U1B", ["Q", "RBAR"], "QBAR"),
      K.tran(0.5e-3, 1e-6),
      K.probeOrder(["SBAR", "RBAR", "Q", "QBAR"]),
      K.sim("The latch sets, resets and holds", (ctx) => {
        const set = logicWhile(ctx, ctx.result, ["SBAR", "RBAR"], "Q", [0, 1]);
        const reset = logicWhile(ctx, ctx.result, ["SBAR", "RBAR"], "Q", [1, 0]);
        return { pass: set === 1 && reset === 0, detail: `set gives Q = ${set}, reset gives Q = ${reset}` };
      })
    ]
  },

  {
    id: "e101-11c",
    group: "e101-11",
    code: "11C",
    kind: "draw",
    title: "11C · JK flip-flop",
    summary: "A 7473 JK flip-flop driven by three clocks and a clear line. Its output changes only when the clock falls: J = 1 sets it, K = 1 resets it, both toggle it, and CLEAR low forces it to 0.",
    tasks: [
      "Type LAB 11C in the circuit name box.",
      "Place a JK flip-flop (7473) and name it U1A.",
      "Place three DigClocks on the left: DSTM1 to J (OFFTIME 2.5m, ONTIME 2.5m, STARTVAL 0, OPPVAL 1), DSTM2 to CLK (OFFTIME .75m, ONTIME .75m, STARTVAL 1, OPPVAL 0), DSTM3 to K (OFFTIME 4.5m, ONTIME 4.5m, STARTVAL 0, OPPVAL 1).",
      "Below them place a STIM1 (Digital stimulus), name it Clear, wire it to CLR, and give it the commands 0s 1; 2.2m 0; 2.3m 1; 7.9m 0; 8.6m 1.",
      "Run a short wire from Q. Net aliases: J, Clock, K, Clear on the input wires, and Q on the output.",
      "In Analysis, choose Transient: stop time 10m, time step 0.1m, and set Initialize flip-flops to 0.",
      "Probe Clear, Clock, J, K, then Q. Run it and read Q at the times below."
    ],
    questions: [
      { id: "q45", prompt: "Q at 4.5 ms (0 or 1)", abs: 0, expect: (ctx) => logicAt(ctx, ctx.ref, "Q", 4.5e-3) },
      { id: "q82", prompt: "Q at 8.2 ms, while Clear is low", abs: 0, expect: (ctx) => logicAt(ctx, ctx.ref, "Q", 8.2e-3) },
      { id: "q99", prompt: "Q at 9.9 ms", abs: 0, expect: (ctx) => logicAt(ctx, ctx.ref, "Q", 9.9e-3) }
    ],
    circuit: blank("11C"),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "0.05m", trStop: "10m", trUic: false, ffInit: "0" },
    checks: [
      K.title("11C"),
      K.parts({
        U1A: { type: "JKFF" },
        DSTM1: { type: "DCLK", fields: CLK("2.5m", "2.5m", 0, 1) },
        DSTM2: { type: "DCLK", fields: CLK(".75m", ".75m", 1, 0) },
        DSTM3: { type: "DCLK", fields: CLK("4.5m", "4.5m", 0, 1) }
      }, "Every part has the part number and settings from the handout"),
      K.stim("Clear", CLEAR_CMDS, 10e-3),
      K.pins("U1A", { 0: "J", 1: "Clock", 2: "K", 3: "Clear", 4: "Q" }, "U1A's J, CLK, K, CLR and Q are on J, Clock, K, Clear and Q"),
      K.wiring([["DSTM1", ["J"], true], ["DSTM2", ["Clock"], true], ["DSTM3", ["K"], true], ["Clear", ["Clear"], true]],
        "Each source drives its own named node"),
      K.tran(10e-3, 0.1e-3),
      K.ffInit("0"),
      K.probeOrder(["Clear", "Clock", "J", "K", "Q"]),
      K.sim("Q sets on the falling clock edge after J goes high", (ctx) => {
        const q = logicAt(ctx, ctx.result, "Q", 4.5e-3);
        return { pass: q === 1, detail: `Q at 4.5 ms is ${q}` };
      })
    ]
  },

  {
    id: "e101-11d",
    group: "e101-11",
    code: "11D",
    kind: "draw",
    title: "11D · Synchronous counter",
    summary: "Four 7473s clocked together, with two AND gates deciding which ones toggle. Q0 toggles every clock, Q1 when Q0 is 1, Q2 when Q0 and Q1 are, and so on: a binary count.",
    tasks: [
      "Type LAB 11D in the circuit name box.",
      "Place four JK flip-flops, U1A, U1B, U2A and U2B, left to right, and two 2-input gates, U3A and U3B, set to 7408 AND, above them.",
      "Place a $D_HI (logic 1) and wire it to U1A's J and K. Wire every CLR to the same logic 1 line.",
      "Place a DigClock, DSTM1: OFFTIME 1m, ONTIME 1m, STARTVAL 1, OPPVAL 0. Name its wire Clock and run it to all four CLK inputs. Where it crosses other wires there must be no dot.",
      "Name the Q outputs Q0 (U1A), Q1 (U1B), Q2 (U2A) and Q3 (U2B). Leave the Q̄ outputs open.",
      "Wire Q0 to U1B's J and K. U3A takes Q1 and Q0; its output goes to U2A's J and K. U3B takes Q2 and U3A's output; its output goes to U2B's J and K.",
      "In Analysis, choose Transient: stop time 32m, time step 0.1m, and Initialize flip-flops to 0.",
      "Probe Clock, Q3, Q2, Q1, then Q0. Run it. Read Q3 Q2 Q1 Q0 as a binary number to answer the questions."
    ],
    questions: [
      { id: "c115", prompt: "The count (Q3 Q2 Q1 Q0 as a decimal number) at 11.5 ms", abs: 0, expect: (ctx) => countAt(ctx, 11.5e-3) },
      { id: "c205", prompt: "The count at 20.5 ms", abs: 0, expect: (ctx) => countAt(ctx, 20.5e-3) },
      { id: "cmax", prompt: "The highest count it reaches before starting again", abs: 0,
        expect: (ctx) => Math.max(...Array.from({ length: 32 }, (_, i) => countAt(ctx, (i + 0.5) * 1e-3))) }
    ],
    circuit: blank("11D"),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "0.1m", trStop: "32m", trUic: false, ffInit: "0" },
    checks: [
      K.title("11D"),
      K.parts({
        U1A: { type: "JKFF" }, U1B: { type: "JKFF" }, U2A: { type: "JKFF" }, U2B: { type: "JKFF" },
        U3A: { type: "GATE2", fields: { device: "7408" } },
        U3B: { type: "GATE2", fields: { device: "7408" } },
        DSTM1: { type: "DCLK", fields: CLK("1m", "1m", 1, 0) }
      }, "Every part has the part number and settings from the handout"),
      K.wiring([["DSTM1", ["Clock"], true]], "The clock drives the Clock node"),
      K.pins("U1A", { 0: RAIL, 1: "Clock", 2: RAIL, 3: RAIL, 4: "Q0" }, "U1A: J and K high, clocked, output Q0"),
      K.pins("U1B", { 0: "Q0", 1: "Clock", 2: "Q0", 3: RAIL, 4: "Q1" }, "U1B: J and K from Q0, output Q1"),
      K.gate("U3A", ["Q1", "Q0"], ["U2A", 0]),
      K.pins("U2A", { 1: "Clock", 2: ["U2A", 0], 3: RAIL, 4: "Q2" }, "U2A: J and K from U3A, output Q2"),
      K.gate("U3B", ["Q2", ["U2A", 0]], ["U2B", 0]),
      K.pins("U2B", { 1: "Clock", 2: ["U2B", 0], 3: RAIL, 4: "Q3" }, "U2B: J and K from U3B, output Q3"),
      K.tran(32e-3, 0.1e-3),
      K.ffInit("0"),
      K.probeOrder(["Clock", "Q3", "Q2", "Q1", "Q0"]),
      K.sim("It counts up by one on each falling clock edge", (ctx) => {
        const got = Array.from({ length: 16 }, (_, i) => countAt(ctx, (i + 0.5) * 1e-3, ctx.result));
        const want = got.map((_, i) => Math.floor((i + 1) / 2));
        const ok = got.every((v, i) => v === want[i]);
        return { pass: ok, detail: ok ? "" : `the first counts are ${got.join(", ")}` };
      })
    ]
  },

  /* --------------------------------------------------------- Lab 12 */
  ...LAB12.map((a) => ({
    id: `e101-12${a.letter}`,
    group: "e101-12",
    code: `12${a.letter.toUpperCase()}`,
    kind: "draw",
    carryFrom: a.from,
    title: `12${a.letter.toUpperCase()} · ${a.title}`,
    summary: a.summary,
    tasks: [
      `Type LAB 12${a.letter.toUpperCase()} in the circuit name box.`,
      ...a.steps,
      "In Analysis, choose AC sweep: start 100, stop 100MEG, 101 points per decade.",
      "Probe OUT (the plot opens in dB), and run it.",
      `Under Axis ranges set ${a.axisText}. The minor gridlines are already there.`,
      "Enter the mid-band gain, and the frequency where the gain has fallen 3 dB below it at the high end."
    ],
    questions: [
      { id: "gain", prompt: "Mid-band gain, in dB", abs: 0.3,
        expect: (ctx) => corners(ctx.nodeTrace("OUT", null, ctx.ref), ctx.ref?.sweep?.values).peak },
      { id: "fhi", prompt: "Upper −3 dB frequency, in Hz (SPICE suffixes work: 4.5meg)", rel: 0.1,
        expect: (ctx) => corners(ctx.nodeTrace("OUT", null, ctx.ref), ctx.ref?.sweep?.values).hi }
    ],
    circuit: blank(`12${a.letter.toUpperCase()}`),
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "100", acStop: "100meg", paramOn: false },
    checks: [
      K.title(`12${a.letter.toUpperCase()}`),
      K.parts(a.parts, "Every part has the name, value and model from the handout"),
      K.wiring(a.wiring),
      ...a.extra,
      K.noOpenEnds(),
      K.ac(100, 100e6, 101),
      K.probe("OUT", "OUT"),
      K.dbMode(),
      K.axis(a.axis),
      K.sim(`OUT has about ${a.gain} dB of gain`, (ctx) => {
        const g = corners(ctx.nodeTrace("OUT"), ctx.result?.sweep?.values).peak;
        return { pass: near(g, a.gain, 0.6), detail: isFinite(g) ? `OUT peaks at ${formatEng(g, 3)} dB` : "no AC result at OUT" };
      })
    ]
  })),

  /* --------------------------------------------------------- Lab 13 */
  {
    id: "e101-13a",
    group: "e101-13",
    code: "13A",
    kind: "draw",
    title: "13A · 16-line multiplexer with a bus",
    summary: "Two 74151A 8-to-1 selectors make a 16-to-1 multiplexer. The sixteen data lines come off a bus, and a 7402 combines the two outputs. S3 enables one chip or the other.",
    tasks: [
      "Type LAB 13A in the circuit name box.",
      "Place two 74151A multiplexers, U1 above U2, from the Digital tab.",
      "Pick Bus (Y) and draw a vertical bus to the left of both. Optionally name it D[0:15] with a net alias on the bus.",
      "For each data input, place a Bus entry with its diagonal end on the bus, and run a wire from it to the input. U1's I0–I7 take D0–D7; U2's I0–I7 take D8–D15. Name each wire D0 … D15 with a net alias: the name is what connects a wire to a bus.",
      "Run select lines S0, S1 and S2 to both chips' S0, S1, S2 pins, and name them. Where they cross the data wires there must be no dot.",
      "S3 goes straight to U1's Ē, and through a 7404 inverter (U3A) to U2's Ē.",
      "Wire both Z outputs into a 7402 NOR (U4A), and its output to a Port named MUXOutput. The Z̄ outputs stay open.",
      "Optionally, add Text labels such as Data Bus and Select Inputs, as the handout does."
    ],
    circuit: blank("13A"),
    simulate: false,
    checks: [
      K.title("13A"),
      K.parts({ U1: { type: "MUX151" }, U2: { type: "MUX151" }, U3A: { type: "INV" }, U4A: { type: "GATE2", fields: { device: "7402" } } },
        "U1 and U2 are 74151As, U3A a 7404 and U4A a 7402"),
      K.pins("U1", Object.fromEntries(Array.from({ length: 8 }, (_, k) => [1 + k, `D${k}`])), "U1's inputs I0–I7 are D0–D7"),
      K.pins("U2", Object.fromEntries(Array.from({ length: 8 }, (_, k) => [1 + k, `D${8 + k}`])), "U2's inputs I0–I7 are D8–D15"),
      K.pins("U1", { 9: "S0", 10: "S1", 11: "S2", 0: "S3" }, "U1's selects are S0–S2 and its enable is S3"),
      K.pins("U2", { 9: "S0", 10: "S1", 11: "S2" }, "U2's selects are S0–S2"),
      K.gate("U3A", ["S3"], ["U2", 0]),
      K.gate("U4A", [["U1", 12], ["U2", 12]], "MUXOutput"),
      K.bus(Array.from({ length: 16 }, (_, k) => `D${k}`)),
      K.noOpenEnds()
    ]
  },

  {
    id: "e101-13b",
    group: "e101-13",
    code: "13B",
    kind: "draw",
    title: "13B · 16-line demultiplexer with a bus",
    summary: "A 74154 decoder sends the multiplexed signal back out to one of sixteen lines. Its outputs are active low, so each passes through a 7404 before it joins the data bus.",
    tasks: [
      "Type LAB 13B in the circuit name box.",
      "Place a 74154 decoder, U1. Wire its A, B, C and D inputs to wires named S0, S1, S2 and S3.",
      "Place a Port, rotate it 180° so it points right, name it MUXInput, and wire it to both Ḡ1 and Ḡ2.",
      "Place sixteen 7404 inverters, one per output. The handout names them U2A–U2F, U3A–U3F and U4A–U4D; standing them upright (press O) keeps the drawing narrow, as the handout's does.",
      "Wire each output Yk to its own inverter, and each inverter's output to a wire named Dk.",
      "Draw a vertical bus on the right. Each Dk wire reaches it through a Bus entry (⇆ points the entries the other way).",
      "Where wires cross there must be no dot."
    ],
    circuit: blank("13B"),
    simulate: false,
    checks: [
      K.title("13B"),
      {
        label: "U1 is a 74154, with sixteen 7404 inverters",
        test: (ctx) => {
          const u = ctx.part("U1");
          const n = ctx.count("INV");
          if (!u || u.type !== "DEC154") return { pass: false, detail: "U1 should be a 74154 decoder" };
          return { pass: n === 16, detail: `there ${n === 1 ? "is" : "are"} ${n} inverter${n === 1 ? "" : "s"}` };
        }
      },
      K.pins("U1", { 0: "S0", 1: "S1", 2: "S2", 3: "S3", 4: "MUXInput", 5: "MUXInput" }, "A–D are S0–S3, and both enables are on MUXInput"),
      {
        label: "Each output Yk passes through its own inverter to Dk",
        test: (ctx) => {
          const u = ctx.part("U1");
          if (!u) return { pass: false, detail: "there is no U1" };
          const nodes = nodesFor(u, ctx.net);
          const invs = ctx.real.filter((c) => c.type === "INV").map((c) => nodesFor(c, ctx.net));
          for (let k = 0; k < 16; k++) {
            const y = nodes[6 + k];
            const inv = invs.find(([i]) => i === y);
            if (!inv) return { pass: false, detail: `no inverter takes Y${k}` };
            const d = ctx.named(`D${k}`);
            if (d === undefined) return { pass: false, detail: `nothing is named D${k}` };
            if (inv[1] !== d) return { pass: false, detail: `the inverter on Y${k} drives ${ctx.describeNode(inv[1])}, not D${k}` };
          }
          return { pass: true, detail: "" };
        }
      },
      K.bus(Array.from({ length: 16 }, (_, k) => `D${k}`)),
      K.noOpenEnds()
    ]
  },

  {
    id: "e101-13c",
    group: "e101-13",
    code: "13C",
    kind: "draw",
    title: "13C · Glitchless MOD 10 counter",
    summary: "A synchronous decade counter: 11D's four flip-flops with gating that sends the count from 9 back to 0. Draw it, then run it to watch it count.",
    tasks: [
      "Type LAB 13C in the circuit name box.",
      "Place four 7473s (U1A, U1B, U2A, U2B), four 7408 ANDs (U3A–U3D) and a 7432 OR (U4A). Name the Q outputs QA, QB, QC and QD.",
      "Place a $D_HI on U1A's J and K, and tie every CLR to it. Place a DigClock, DSTM1 (OFFTIME .5m, ONTIME .5m, STARTVAL 1, OPPVAL 0), and run its wire, named CLOCK, to every CLK.",
      "U3A takes QA and QD's Q̄ (U2B's Q̄ output); it drives U1B's J and K.",
      "U3B takes U3A's output and QB; it drives U2A's J and K.",
      "U3C takes QD and QA. U3D takes U3B's output and QC. U4A takes both, and drives U2B's J and K.",
      "In Analysis, choose Transient: stop time 12m, time step 0.1m, Initialize flip-flops to 0. Probe CLOCK, QD, QC, QB and QA, and run.",
      "Read QD QC QB QA as a binary number to answer the questions."
    ],
    questions: [
      { id: "c42", prompt: "The count at 4.2 ms", abs: 0, expect: (ctx) => countAt(ctx, 4.2e-3, ctx.ref, BCD) },
      { id: "c92", prompt: "The count at 9.2 ms", abs: 0, expect: (ctx) => countAt(ctx, 9.2e-3, ctx.ref, BCD) },
      { id: "c102", prompt: "The count at 10.2 ms, one clock later", abs: 0, expect: (ctx) => countAt(ctx, 10.2e-3, ctx.ref, BCD) }
    ],
    circuit: blank("13C"),
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "0.05m", trStop: "12m", trUic: false, ffInit: "0" },
    checks: [
      K.title("13C"),
      K.parts({
        U1A: { type: "JKFF" }, U1B: { type: "JKFF" }, U2A: { type: "JKFF" }, U2B: { type: "JKFF" },
        U3A: { type: "GATE2", fields: { device: "7408" } }, U3B: { type: "GATE2", fields: { device: "7408" } },
        U3C: { type: "GATE2", fields: { device: "7408" } }, U3D: { type: "GATE2", fields: { device: "7408" } },
        U4A: { type: "GATE2", fields: { device: "7432" } },
        DSTM1: { type: "DCLK", fields: CLK(".5m", ".5m", 1, 0) }
      }, "Every part has the part number and settings from the handout"),
      K.wiring([["DSTM1", ["CLOCK"], true]], "The clock drives CLOCK"),
      K.pins("U1A", { 0: RAIL, 1: "CLOCK", 2: RAIL, 3: RAIL, 4: "QA" }, "U1A: J and K high, clocked, output QA"),
      K.gate("U3A", ["QA", ["U2B", 5]], ["U1B", 0]),
      K.pins("U1B", { 1: "CLOCK", 2: ["U1B", 0], 3: RAIL, 4: "QB" }, "U1B: J and K from U3A, output QB"),
      K.gate("U3B", [["U1B", 0], "QB"], ["U2A", 0]),
      K.pins("U2A", { 1: "CLOCK", 2: ["U2A", 0], 3: RAIL, 4: "QC" }, "U2A: J and K from U3B, output QC"),
      K.gate("U3C", ["QD", "QA"], ["U3C", 2]),
      K.gate("U3D", [["U2A", 0], "QC"], ["U3D", 2]),
      K.gate("U4A", [["U3C", 2], ["U3D", 2]], ["U2B", 0]),
      K.pins("U2B", { 1: "CLOCK", 2: ["U2B", 0], 3: RAIL, 4: "QD" }, "U2B: J and K from U4A, output QD"),
      K.tran(12e-3, 0.1e-3),
      K.ffInit("0"),
      {
        label: "Voltage probes on CLOCK, QD, QC, QB and QA",
        test: (ctx) => {
          const missing = ["CLOCK", "QD", "QC", "QB", "QA"].filter((n) => !ctx.probeOn(n));
          return { pass: !missing.length, detail: missing.length ? `no probe on ${missing.join(", ")} yet` : "" };
        }
      },
      K.sim("It counts 0 to 9 and starts again", (ctx) => {
        const got = Array.from({ length: 11 }, (_, i) => countAt(ctx, i * 1e-3 + 0.2e-3, ctx.result, BCD));
        const want = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
        const ok = got.every((v, i) => v === want[i]);
        return { pass: ok, detail: ok ? "" : `the counts are ${got.join(", ")}` };
      })
    ]
  },

  /* --------------------------------------------------------- Lab 14 */
  {
    id: "e101-14a",
    group: "e101-14",
    code: "14A",
    kind: "draw",
    title: "14A · Instrumentation amplifier",
    summary: "Three LM324s: two buffered inputs with a shared gain resistor RB, then a difference amplifier. A resistor bridge supplies the two inputs, with R2 set by the RVAL parameter.",
    tasks: [
      "Type LAB 14A in the circuit name box.",
      "Place the split supply: VS1 and VS2 (DC 18) with VCC and VEE power symbols and the junction grounded.",
      "Draw the bridge: VS (DC 6) across two dividers, R1 over R3 and R2 over R4, all 10k except R2 = {RVAL}. Place a Parameter part: RVAL = 10k.",
      "Place three LM324s. Select U1A and press ⇅ (Mirror vertically) so its + input is on top; U1B and U1C stay as placed.",
      "The R2–R4 junction is IN-, to U1A's + input. The R1–R3 junction is IN+, to U1B's + input. The IN+ wire crosses the R2–R4 line without joining it: no dot.",
      "RA1 (10k), RB (1k) and RA2 (10k) run in a column from U1A's output to U1B's output. U1A's − input joins the RA1–RB junction, and U1B's − input joins the RB–RA2 junction.",
      "RIN1 (10k) runs from U1A's output to U1C's − input, and RF1 (1MEG) from there to OUT. RIN2 (10k) runs from U1B's output to U1C's + input, and RF2 (1MEG) from there to ground.",
      "Power every op-amp from VCC and VEE, and name U1C's output OUT."
    ],
    circuit: blank("14A"),
    simulate: false,
    checks: [
      K.title("14A"),
      K.parts({
        ...SUPPLY_SPLIT, VS: { dc: 6, type: "V" },
        R1: "10k", R2: { text: "{rval}" }, R3: "10k", R4: "10k",
        RA1: "10k", RB: "1k", RA2: "10k", RIN1: "10k", RF1: "1meg", RIN2: "10k", RF2: "1meg",
        U1A: LM, U1B: LM, U1C: LM
      }),
      PARAM_IS("RVAL", 10e3),
      K.wiring([
        ...SUPPLY_WIRING,
        ["R1", [["VS", 0], "IN+"]], ["R3", ["IN+", ["VS", 1]]],
        ["R2", [["VS", 0], "IN-"]], ["R4", ["IN-", ["VS", 1]]],
        ["RA1", [["U1A", 2], ["U1A", 0]]], ["RB", [["U1A", 0], ["U1B", 0]]], ["RA2", [["U1B", 0], ["U1B", 2]]],
        ["RIN1", [["U1A", 2], ["U1C", 0]]], ["RF1", [["U1C", 0], "OUT"]],
        ["RIN2", [["U1B", 2], ["U1C", 1]]], ["RF2", [["U1C", 1], 0]]
      ]),
      K.pins("U1A", { 1: "IN-", 3: "VCC", 4: "VEE" }, "U1A's + input is IN-, and it is powered from VCC and VEE"),
      K.pins("U1B", { 1: "IN+", 3: "VCC", 4: "VEE" }, "U1B's + input is IN+, and it is powered from VCC and VEE"),
      K.pins("U1C", { 2: "OUT", 3: "VCC", 4: "VEE" }, "U1C's output is OUT, and it is powered from VCC and VEE"),
      K.mirrored({ U1A: { my: true }, U1B: { my: false }, U1C: { my: false } }, "U1A is mirrored so its + input is on top; U1B and U1C are not"),
      K.noOpenEnds()
    ]
  },

  {
    id: "e101-14b",
    group: "e101-14",
    code: "14B",
    kind: "draw",
    title: "14B · Inside an operational amplifier",
    summary: "A discrete op-amp: a JFET differential pair with a transistor current source, a second differential stage, a level shifter and an emitter-follower output. Twelve resistors, eight transistors, three diodes, and wires that sometimes cross and sometimes join.",
    tasks: [
      "Type LAB 14B in the circuit name box.",
      "Place every part first, lining up the columns as Figure 14-2 does: R1–R12, J1 and J2 (N-channel JFET, J2N3819), Q1–Q6 (NPN, Q2N2222), D1 and D2 (D1N914) and D3 (D1N750).",
      "Select J2 and Q3 and press ⇆ (Mirror horizontally), so J2's gate and Q3's base face right.",
      "Draw a vcc rail across the top and a vee rail across the bottom, and label them with power symbols named vcc and vee. Add power symbols named vin+, vin- and vo for the inputs and output.",
      "Wire it as Figure 14-2 shows. Check every crossing against the figure: a dot means the wires join; no dot means they only cross.",
      "The front end: R1, D1 and D3 bias Q1, whose collector feeds both JFET sources. vin+ drives J1's gate and vin- J2's gate. R2 and R3 load the drains.",
      "The second stage: J2's drain drives Q2's base, and J1's drain crosses over to Q3's base. R4 and R5 are the collector loads; the emitters share R7.",
      "The output: Q3's collector drives Q4. R8, D2 and R9 bias Q5 under R10 and R11. Q4's emitter, through R10, drives Q6's base, and Q6's emitter is vo, loaded by R12.",
      "Like the handout's, this circuit has no ground: its supplies and inputs come from outside the sheet. Parts and connections will say No ground, and that is expected here. The lab is marked on the drawing."
    ],
    circuit: blank("14B"),
    simulate: false,
    checks: [
      K.title("14B"),
      K.parts({
        R1: "15.3k", R2: "10k", R3: "10k", R4: "10k", R5: "10k", R6: "4k", R7: "14.3k",
        R8: "14.3k", R9: "5k", R10: "3.6k", R11: "5k", R12: "10k",
        J1: { type: "NJF", model: "J2N3819" }, J2: { type: "NJF", model: "J2N3819" },
        ...Object.fromEntries(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"].map((q) => [q, { type: "NPN", model: "Q2N2222" }])),
        D1: { type: "D", model: "D1N914" }, D2: { type: "D", model: "D1N914" }, D3: { type: "D", model: "D1N750" }
      }),
      K.wiring([
        ["R1", ["vcc", ["Q1", 0]]], ["D1", [["Q1", 0], ["D3", 1]], true], ["D3", ["vee", ["D1", 1]], true],
        ["R6", [["Q1", 2], "vee"]],
        ["R2", ["vcc", ["J1", 1]]], ["R3", ["vcc", ["J2", 1]]],
        ["R4", ["vcc", ["Q2", 1]]], ["R5", ["vcc", ["Q3", 1]]], ["R7", [["Q2", 2], "vee"]],
        ["R10", [["Q4", 2], ["Q5", 1]]],
        ["R8", ["vcc", ["Q5", 0]]], ["D2", [["Q5", 0], ["R9", 0]], true], ["R9", [["D2", 1], "vee"]],
        ["R11", [["Q5", 2], "vee"]], ["R12", ["vo", "vee"]]
      ], "The resistors and diodes connect as Figure 14-2 shows"),
      K.pins("J1", { 0: "vin+", 2: ["Q1", 1] }, "J1: gate on vin+, source on Q1's collector"),
      K.pins("J2", { 0: "vin-", 2: ["Q1", 1] }, "J2: gate on vin-, source shared with J1"),
      K.pins("Q2", { 0: ["J2", 1], 2: ["Q3", 2] }, "Q2's base is J2's drain, and the emitters of Q2 and Q3 are joined"),
      K.pins("Q3", { 0: ["J1", 1] }, "Q3's base is J1's drain, by the wire that crosses over"),
      K.pins("Q4", { 0: ["Q3", 1], 1: "vcc" }, "Q4: base on Q3's collector, collector on vcc"),
      K.pins("Q6", { 0: ["Q5", 1], 1: "vcc", 2: "vo" }, "Q6: base on Q5's collector, collector on vcc, emitter on vo"),
      K.mirrored({ J2: { mx: true }, Q3: { mx: true } }, "J2 and Q3 are mirrored horizontally, as the handout asks"),
      K.noOpenEnds()
    ]
  }
];



/* ---------------------------------------------------- reference diagrams */

/*
 * What each lab's floating Reference diagram draws. For a fix lab it is the
 * corrected circuit, for a simulate lab the supplied circuit with the
 * handout's markers, for a draw lab the circuit to draw. test/labs101.mjs
 * loads every one of these and requires it to pass its lab, so a diagram can
 * never show something the checker would reject.
 */

const vp = (x, y) => ({ kind: "v", ref: `${x},${y}`, x, y });
const ip = (ref) => ({ kind: "i", ref });
const dp = (x, y, x2, y2) => ({ kind: "vd", ref: `${x},${y}|${x2},${y2}`, x, y, x2, y2 });
const plus = (base, { comps = [], wires = [], probes = [], drop = [] } = {}) => ({
  comps: [...base.comps.filter((c) => !drop.includes(c.label)), ...comps],
  wires: [...base.wires, ...wires],
  probes
});

const D04A = {
  comps: [
    P("V", 160, 200, 90, { label: "V1", value: "DC 12", ac: "" }),
    P("R", 260, 140, 0, { label: "R1", value: "1k" }),
    P("NPN", 420, 140, 0, { label: "Q1", model: "Q2N3904" }),
    P("R", 460, 220, 90, { label: "R2", value: "1k" }),
    G(300, 360)
  ],
  wires: [
    W(160, 200, 160, 140), W(160, 140, 260, 140), W(320, 140, 420, 140),
    W(460, 100, 460, 40), W(460, 40, 380, 40), W(380, 40, 380, 140),
    W(460, 180, 460, 220),
    W(460, 280, 460, 340), W(460, 340, 160, 340), W(160, 260, 160, 340),
    W(300, 340, 300, 360)
  ],
  probes: []
};

const D04B = {
  comps: [
    P("V", 120, 160, 90, { label: "V1", value: "DC 12", ac: "" }),
    P("R", 180, 80, 0, { label: "R1", value: "1k" }),
    P("R", 400, 160, 90, { label: "R2", value: "1k" }),
    P("R", 460, 80, 0, { label: "R3", value: "1k" }),
    P("R", 680, 160, 90, { label: "R4", value: "1k" }),
    G(400, 300)
  ],
  wires: [
    W(120, 160, 120, 80), W(120, 80, 180, 80), W(240, 80, 400, 80), W(400, 80, 400, 160),
    W(400, 80, 460, 80), W(520, 80, 680, 80), W(680, 80, 680, 160),
    W(400, 220, 400, 280), W(680, 220, 680, 280), W(120, 280, 680, 280),
    W(120, 220, 120, 280), W(400, 280, 400, 300)
  ],
  probes: []
};

const D05A = plus(LAB05A, { probes: [vp(820, 140)] });
const D05B = plus(LAB05B, { probes: [ip("R1"), vp(160, 120)] });
const D05C = plus(LAB05C, { comps: [NET(160, 140, "IN"), NET(520, 140, "OUT")] });

/** The series circuit of 6A and all of Lab 7. */
const D_SERIES = {
  comps: [
    P("V", 160, 160, 90, { label: "VS", value: "DC 12", ac: "" }),
    P("R", 220, 100, 0, { label: "R1", value: "100" }),
    P("R", 340, 160, 90, { label: "R2", value: "300" }),
    G(250, 300),
    NET(160, 100, "A"), NET(340, 100, "B")
  ],
  wires: [
    W(160, 160, 160, 100), W(160, 100, 220, 100), W(280, 100, 340, 100), W(340, 100, 340, 160),
    W(340, 220, 340, 280), W(340, 280, 160, 280), W(160, 220, 160, 280), W(250, 280, 250, 300)
  ],
  probes: []
};

const D06B = {
  comps: [
    P("V", 160, 200, 90, { label: "VS", value: "DC 12", ac: "" }),
    P("R", 220, 120, 0, { label: "R1", value: "100" }),
    P("R", 440, 120, 0, { label: "R2", value: "600" }),
    P("R", 560, 200, 90, { label: "R3", value: "600" }),
    P("R", 360, 200, 90, { label: "R4", value: "1.2k" }),
    G(360, 340),
    NET(160, 120, "IN"), NET(560, 120, "OUT")
  ],
  wires: [
    W(160, 200, 160, 120), W(160, 120, 220, 120), W(280, 120, 440, 120), W(500, 120, 560, 120),
    W(560, 120, 560, 200), W(560, 260, 560, 320), W(560, 320, 160, 320), W(160, 260, 160, 320),
    W(360, 120, 360, 200), W(360, 260, 360, 320), W(360, 320, 360, 340)
  ],
  probes: []
};

const D06C = {
  comps: [
    P("V", 100, 260, 90, { label: "VS", value: "DC 0", ac: "1" }),
    P("C", 160, 200, 0, { label: "C1", value: "10u", ic: "" }),
    P("NPN", 300, 200, 0, { label: "Q1", model: "Q2N2222" }),
    P("NPN", 480, 280, 0, { label: "Q2", model: "Q2N2222" }),
    P("R", 340, 80, 90, { label: "RC1", value: "5k" }),
    P("R", 520, 80, 90, { label: "RC2", value: "5k" }),
    P("R", 430, 380, 90, { label: "REE", value: "4.8k" }),
    P("V", 40, 120, 90, { label: "VS1", value: "DC 12", ac: "" }),
    P("V", 40, 180, 90, { label: "VS2", value: "DC 12", ac: "" }),
    G(100, 420), G(70, 180, 270),
    PWR(430, 80, "VCC"), PWR(40, 120, "VCC"),
    PWR(430, 440, "VEE", 180), PWR(40, 240, "VEE", 180)
  ],
  wires: [
    W(100, 260, 100, 200), W(100, 200, 160, 200), W(220, 200, 300, 200),
    W(340, 240, 340, 360), W(340, 360, 520, 360), W(520, 320, 520, 360),
    W(480, 280, 260, 280), W(260, 280, 260, 400), W(260, 400, 100, 400),
    W(100, 320, 100, 400), W(100, 400, 100, 420),
    W(340, 140, 340, 160), W(520, 140, 520, 240), W(340, 80, 520, 80),
    W(430, 360, 430, 380), W(40, 180, 70, 180)
  ],
  probes: []
};

const D07A = plus(D_SERIES, { probes: [vp(340, 100)] });
const D07B = plus(D_SERIES, { probes: [dp(160, 100, 340, 100)] });
const D07C = plus(D_SERIES, {
  drop: ["R1"],
  comps: [
    P("R", 220, 100, 0, { label: "R1", value: "{RVAL}" }),
    P("PARAM", 420, 40, 0, { label: "PARAM1", name: "RVAL", value: "100" })
  ],
  probes: [vp(340, 100)]
});
const D07D = plus(D07C, {
  drop: ["NET_B"],
  comps: [
    P("R", 400, 100, 0, { label: "R3", value: "150" }),
    P("R", 520, 160, 90, { label: "R4", value: "150" }),
    NET(520, 100, "B")
  ],
  wires: [W(340, 100, 400, 100), W(460, 100, 520, 100), W(520, 100, 520, 160),
          W(520, 220, 520, 280), W(520, 280, 340, 280)],
  probes: [vp(520, 100)]
});


/* Lab 8: 8A's series RC, and 8D laid out like the handout's Figure. */
const D08A = {
  comps: [
    P("V", 160, 160, 90, { label: "VS", value: "DC 0", ac: "1" }),
    P("R", 220, 100, 0, { label: "R1", value: "1k" }),
    P("C", 340, 160, 90, { label: "C1", value: "1u", ic: "" }),
    G(250, 300),
    NET(160, 100, "A"), NET(340, 100, "B")
  ],
  wires: D_SERIES.wires,
  probes: [vp(340, 100)]
};
const D08B = { ...D08A, probes: [dp(160, 100, 340, 100)] };
const D08C = plus(D08A, {
  drop: ["C1"],
  comps: [
    P("C", 340, 160, 90, { label: "C1", value: "{CVAL}", ic: "" }),
    P("PARAM", 420, 40, 0, { label: "PARAM1", name: "CVAL", value: "1u" })
  ],
  probes: [vp(340, 100)]
});
const D08D = {
  comps: [
    P("PARAM", 160, 40, 0, { label: "PARAM1", name: "CVAL", value: "1u" }),
    P("V", 100, 200, 90, { label: "VS", value: "DC 0", ac: "1" }),
    P("R", 160, 140, 0, { label: "RS", value: "1u" }),
    P("XFORM", 260, 140, 0, { label: "TX1", l1: "10u", l2: "10m", k: "0.975" }),
    P("R", 380, 140, 0, { label: "R1", value: "1k" }),
    P("C", 500, 200, 90, { label: "C1", value: "{CVAL}", ic: "" }),
    P("R", 140, 360, 0, { label: "RD", value: "1000MEG" }),
    G(240, 360), G(410, 320),
    NET(100, 140, "A"), NET(500, 140, "B")
  ],
  wires: [
    W(100, 200, 100, 140), W(100, 140, 160, 140), W(220, 140, 260, 140),
    W(260, 200, 240, 200), W(240, 200, 240, 280), W(240, 280, 100, 280), W(100, 260, 100, 280),
    W(100, 280, 100, 360), W(100, 360, 140, 360), W(200, 360, 240, 360),
    W(320, 140, 380, 140), W(440, 140, 500, 140), W(500, 140, 500, 200),
    W(500, 260, 500, 300), W(500, 300, 340, 300), W(320, 200, 340, 200), W(340, 200, 340, 300),
    W(410, 300, 410, 320)
  ],
  probes: [vp(500, 140)]
};

/* Lab 9: one series RC circuit, driven by each pulse source in turn. */
function D09(p) {
  return {
    comps: [
      P("VPULSE", 160, 160, 90, { label: p.ref, ...p.pulse }),
      P("R", 220, 100, 0, { label: "R1", value: p.r }),
      P("C", 340, 160, 90, { label: "C1", value: p.c, ic: "" }),
      G(250, 300),
      NET(160, 100, "IN"), NET(340, 100, "OUT")
    ],
    wires: D_SERIES.wires,
    probes: [vp(160, 100), vp(340, 100), dp(160, 100, 340, 100)]
  };
}

/* Lab 10: gates with their stimuli on the left. */
const STIM = (x, y, label, commands) => P("STIM", x, y, 0, { label, commands });
const D10_2 = (device, out) => ({
  comps: [
    P("GATE2", 300, 200, 0, { label: "U1A", device }),
    STIM(200, 140, "DSTM1", DSTM1_CMDS), STIM(200, 260, "DSTM2", DSTM2_CMDS),
    NET(240, 140, "A"), NET(240, 260, "B"), NET(460, 200, out)
  ],
  wires: [
    W(200, 140, 260, 140), W(260, 140, 260, 180), W(260, 180, 300, 180),
    W(200, 260, 260, 260), W(260, 260, 260, 220), W(260, 220, 300, 220),
    W(380, 200, 460, 200)
  ],
  probes: [vp(240, 140), vp(240, 260), vp(460, 200)]
});
const D10_3_BASE = (device) => ({
  comps: [
    P("GATE3", 300, 200, 0, { label: "U1A", device }),
    STIM(200, 120, "DSTM1", DSTM1_CMDS), STIM(200, 200, "DSTM2", DSTM2_CMDS), STIM(200, 280, "DSTM3", DSTM3_CMDS),
    NET(240, 120, "A"), NET(240, 200, "B"), NET(240, 280, "C")
  ],
  wires: [
    W(200, 120, 260, 120), W(260, 120, 260, 180), W(260, 180, 300, 180),
    W(200, 200, 300, 200),
    W(200, 280, 260, 280), W(260, 280, 260, 220), W(260, 220, 300, 220)
  ]
});
const D10_3 = (device, out) => {
  const b = D10_3_BASE(device);
  return {
    comps: [...b.comps, NET(460, 200, out)],
    wires: [...b.wires, W(380, 200, 460, 200)],
    probes: [vp(240, 120), vp(240, 200), vp(240, 280), vp(460, 200)]
  };
};
const D10E = (() => {
  const b = D10_3_BASE("7410");
  return {
    comps: [...b.comps, P("INV", 500, 200, 0, { label: "U2A", device: "7404" }), NET(460, 200, "QBAR"), NET(660, 200, "Q")],
    wires: [...b.wires, W(380, 200, 500, 200), W(580, 200, 660, 200)],
    probes: [vp(240, 120), vp(240, 200), vp(240, 280), vp(460, 200), vp(660, 200)]
  };
})();

/* Lab 11 */
const DCLK = (x, y, label, off, on, start, opp) => P("DCLK", x, y, 0, { label, ...CLK(off, on, start, opp) });
const D11A = {
  comps: [
    P("GATE2", 300, 200, 0, { label: "U1A", device: "7486" }),
    DCLK(200, 120, "DSTM1", ".2m", ".2m", 0, 1), DCLK(200, 280, "DSTM2", ".1m", ".1m", 0, 1),
    NET(240, 120, "A"), NET(240, 280, "B"), NET(460, 200, "Q")
  ],
  wires: [
    W(200, 120, 260, 120), W(260, 120, 260, 180), W(260, 180, 300, 180),
    W(200, 280, 260, 280), W(260, 280, 260, 220), W(260, 220, 300, 220),
    W(380, 200, 460, 200)
  ],
  probes: [vp(240, 120), vp(240, 280), vp(460, 200)]
};
const D11B = {
  comps: [
    P("GATE2", 300, 140, 0, { label: "U1A", device: "7400" }),
    P("GATE2", 300, 300, 0, { label: "U1B", device: "7400" }),
    DCLK(200, 120, "DSTM1", "75u", "75u", 1, 0), DCLK(200, 320, "DSTM2", ".15m", ".15m", 0, 1),
    NET(240, 120, "SBAR"), NET(240, 320, "RBAR"), NET(460, 140, "Q"), NET(460, 300, "QBAR")
  ],
  wires: [
    W(200, 120, 300, 120), W(200, 320, 300, 320),
    W(380, 140, 460, 140), W(380, 300, 460, 300),
    // Q back to U1B's top input, QBAR back to U1A's bottom input; the two
    // runs cross at (280, 240) without joining.
    W(420, 140, 420, 200), W(420, 200, 280, 200), W(280, 200, 280, 280), W(280, 280, 300, 280),
    W(440, 300, 440, 240), W(440, 240, 260, 240), W(260, 240, 260, 160), W(260, 160, 300, 160)
  ],
  probes: [vp(240, 120), vp(240, 320), vp(460, 140), vp(460, 300)]
};
const D11C = {
  comps: [
    P("JKFF", 400, 200, 0, { label: "U1A", device: "7473" }),
    DCLK(240, 80, "DSTM1", "2.5m", "2.5m", 0, 1),
    DCLK(240, 200, "DSTM2", ".75m", ".75m", 1, 0),
    DCLK(240, 320, "DSTM3", "4.5m", "4.5m", 0, 1),
    STIM(240, 400, "Clear", CLEAR_CMDS),
    NET(320, 80, "J"), NET(320, 200, "Clock"), NET(320, 320, "K"), NET(320, 400, "Clear"), NET(540, 160, "Q")
  ],
  wires: [
    W(240, 80, 360, 80), W(360, 80, 360, 160), W(360, 160, 400, 160),
    W(240, 200, 400, 200),
    W(240, 320, 360, 320), W(360, 320, 360, 240), W(360, 240, 400, 240),
    W(240, 400, 440, 400), W(440, 400, 440, 280),
    W(480, 160, 540, 160)
  ],
  probes: [vp(320, 400), vp(320, 200), vp(320, 80), vp(320, 320), vp(540, 160)]
};
const FF = (x, label) => P("JKFF", x, 240, 0, { label, device: "7473" });
const D11D = {
  comps: [
    FF(200, "U1A"), FF(360, "U1B"), FF(600, "U2A"), FF(880, "U2B"),
    P("GATE2", 480, 120, 0, { label: "U3A", device: "7408" }),
    P("GATE2", 760, 120, 0, { label: "U3B", device: "7408" }),
    P("DHI", 140, 200, 0, { label: "HI1" }),
    DCLK(120, 420, "DSTM1", "1m", "1m", 1, 0),
    NET(140, 420, "Clock"), NET(300, 60, "Q0"), NET(460, 60, "Q1"), NET(700, 60, "Q2"), NET(980, 60, "Q3")
  ],
  wires: [
    // logic 1 to U1A's J and K, and the clear bus
    W(140, 200, 200, 200), W(160, 200, 160, 280), W(160, 280, 200, 280), W(160, 280, 160, 360),
    W(160, 360, 920, 360),
    W(240, 320, 240, 360), W(400, 320, 400, 360), W(640, 320, 640, 360), W(920, 320, 920, 360),
    // clock bus, crossing the clear bus and the K wires without joining
    W(120, 420, 840, 420),
    W(180, 420, 180, 240), W(180, 240, 200, 240),
    W(340, 420, 340, 240), W(340, 240, 360, 240),
    W(560, 420, 560, 240), W(560, 240, 600, 240),
    W(840, 420, 840, 240), W(840, 240, 880, 240),
    // Q0
    W(280, 200, 360, 200), W(300, 60, 300, 200), W(320, 200, 320, 280), W(320, 280, 360, 280),
    W(300, 140, 480, 140),
    // Q1
    W(440, 200, 460, 200), W(460, 60, 460, 200), W(460, 100, 480, 100),
    // T2 = Q0·Q1, to U2A's J and K and on to U3B
    W(560, 120, 580, 120), W(580, 120, 580, 200), W(580, 200, 600, 200),
    W(580, 200, 580, 280), W(580, 280, 600, 280),
    W(580, 160, 740, 160), W(740, 160, 740, 140), W(740, 140, 760, 140),
    // Q2
    W(680, 200, 700, 200), W(700, 60, 700, 200), W(700, 100, 760, 100),
    // T3 = Q2·T2, to U2B's J and K
    W(840, 120, 860, 120), W(860, 120, 860, 200), W(860, 200, 880, 200),
    W(860, 200, 860, 280), W(860, 280, 880, 280),
    // Q3
    W(960, 200, 980, 200), W(980, 60, 980, 200)
  ],
  probes: [vp(140, 420), vp(980, 60), vp(700, 60), vp(460, 60), vp(300, 60)]
};

/* Lab 12 */
const R_ = (x, y, rot, label, value) => P("R", x, y, rot, { label, value });
const C_ = (x, y, rot, label, value) => P("C", x, y, rot, { label, value, ic: "" });
const V_ = (x, y, label, value, ac = "") => P("V", x, y, 90, { label, value, ac });
const Q_ = (x, y, label) => P("NPN", x, y, 0, { label, model: "Q2N2222" });
const U_ = (x, y, label) => P("OPAMP5", x, y, 0, { label, model: "LM324", gain: "100k", gbw: "1meg", headroom: "1.5" });

const D12A = {
  comps: [
    V_(60, 120, "VS2", "DC 18"), PWR(60, 100, "VCC"), G(60, 200), PWR(340, 60, "VCC"),
    R_(240, 120, 90, "R1", "62k"), R_(440, 120, 90, "RC", "2700"),
    Q_(400, 280, "Q1"), R_(240, 340, 90, "R2", "10k"),
    C_(140, 280, 0, "C1", "2u"), V_(80, 380, "VS1", "DC 0", "1"),
    R_(440, 340, 90, "RE1", "100"), R_(440, 440, 90, "RE2", "420"), C_(520, 440, 90, "CE", "47u"),
    C_(500, 200, 0, "C2", "2u"), R_(620, 300, 90, "RL", "1800"), NET(620, 200, "OUT"),
    G(340, 580)
  ],
  wires: [
    W(60, 100, 60, 120), W(60, 180, 60, 200),
    W(240, 60, 440, 60), W(240, 60, 240, 120), W(440, 60, 440, 120),
    W(440, 180, 440, 240),
    W(240, 180, 240, 280), W(240, 280, 240, 340), W(240, 280, 400, 280), W(200, 280, 240, 280),
    W(80, 380, 80, 280), W(80, 280, 140, 280),
    W(440, 320, 440, 340), W(440, 400, 440, 440), W(440, 420, 520, 420), W(520, 420, 520, 440),
    W(440, 200, 500, 200), W(560, 200, 620, 200), W(620, 200, 620, 300),
    W(80, 440, 80, 560), W(240, 400, 240, 560), W(440, 500, 440, 560), W(520, 500, 520, 560),
    W(620, 360, 620, 560), W(80, 560, 620, 560), W(340, 560, 340, 580)
  ],
  probes: [vp(620, 200)]
};

const D12B = {
  comps: [
    V_(60, 120, "VS2", "DC 18"), PWR(60, 100, "VCC"), G(60, 200), PWR(520, 60, "VCC"),
    R_(240, 120, 90, "R1", "62k"), R_(400, 120, 90, "RC1", "2700"),
    Q_(360, 280, "Q1"), R_(240, 340, 90, "R2", "10k"),
    C_(140, 280, 0, "C1", "2u"), V_(80, 380, "VS1", "DC 0", "1"),
    R_(400, 340, 90, "RE1A", "100"), R_(400, 440, 90, "RE1B", "420"), C_(480, 440, 90, "CE1", "47u"),
    C_(500, 280, 0, "C2", "2u"),
    R_(600, 120, 90, "R3", "62k"), R_(600, 340, 90, "R4", "10k"),
    Q_(720, 280, "Q2"), R_(760, 120, 90, "RC2", "2700"),
    R_(760, 340, 90, "RE2A", "200"), R_(760, 440, 90, "RE2B", "330"), C_(840, 440, 90, "CE2", "47u"),
    C_(840, 200, 0, "C3", "2u"), R_(960, 300, 90, "RL", "1800"), NET(960, 200, "OUT"),
    G(520, 580)
  ],
  wires: [
    W(60, 100, 60, 120), W(60, 180, 60, 200),
    W(240, 60, 760, 60), W(240, 60, 240, 120), W(400, 60, 400, 120), W(600, 60, 600, 120), W(760, 60, 760, 120),
    W(400, 180, 400, 240),
    W(240, 180, 240, 280), W(240, 280, 240, 340), W(240, 280, 360, 280), W(200, 280, 240, 280),
    W(80, 380, 80, 280), W(80, 280, 140, 280),
    W(400, 320, 400, 340), W(400, 400, 400, 440), W(400, 420, 480, 420), W(480, 420, 480, 440),
    W(400, 200, 460, 200), W(460, 200, 460, 280), W(460, 280, 500, 280),
    W(600, 180, 600, 280), W(600, 280, 600, 340), W(560, 280, 600, 280), W(600, 280, 720, 280),
    W(760, 180, 760, 240),
    W(760, 320, 760, 340), W(760, 400, 760, 440), W(760, 420, 840, 420), W(840, 420, 840, 440),
    W(760, 200, 840, 200), W(900, 200, 960, 200), W(960, 200, 960, 300),
    W(80, 440, 80, 560), W(240, 400, 240, 560), W(400, 500, 400, 560), W(480, 500, 480, 560),
    W(600, 400, 600, 560), W(760, 500, 760, 560), W(840, 500, 840, 560), W(960, 360, 960, 560),
    W(80, 560, 960, 560), W(520, 560, 520, 580)
  ],
  probes: [vp(960, 200)]
};

/** The split ±18 V supply of 12C–12E. */
const SPLIT = {
  comps: [V_(60, 140, "VS1", "DC 18"), V_(60, 200, "VS2", "DC 18"), PWR(60, 120, "VCC"), PWR(60, 280, "VEE", 180), G(100, 200, 270)],
  wires: [W(60, 120, 60, 140), W(60, 260, 60, 280), W(60, 200, 100, 200)]
};
/** One op-amp stage, U at (x0 + 140, 260), with its supplies. */
const STAGE = (x0, label) => ({
  comps: [U_(x0 + 140, 260, label), PWR(x0 + 180, 200, "VCC"), PWR(x0 + 180, 320, "VEE", 180)],
  wires: [W(x0 + 180, 200, x0 + 180, 220), W(x0 + 180, 300, x0 + 180, 320),
    W(x0 + 100, 120, x0 + 100, 240), W(x0 + 100, 240, x0 + 140, 240),
    W(x0 + 220, 260, x0 + 280, 260), W(x0 + 280, 260, x0 + 280, 120)]
});
const join = (...parts) => ({
  comps: parts.flatMap((p) => p.comps || []),
  wires: parts.flatMap((p) => p.wires || []),
  probes: parts.flatMap((p) => p.probes || [])
});

const D12C = join(SPLIT, STAGE(240, "U1A"), {
  comps: [V_(180, 300, "VS", "DC 0", "1"), G(180, 380), R_(240, 120, 0, "R1", "1k"), R_(400, 120, 0, "RF", "10k"),
    R_(340, 320, 90, "RCM", "990"), G(340, 400), NET(560, 120, "OUT")],
  wires: [W(180, 360, 180, 380), W(180, 300, 180, 120), W(180, 120, 240, 120),
    W(300, 120, 400, 120), W(460, 120, 560, 120),
    W(380, 280, 340, 280), W(340, 280, 340, 320), W(340, 380, 340, 400)],
  probes: [vp(560, 120)]
});
const D12D = join(SPLIT, STAGE(240, "U1A"), {
  comps: [G(220, 120, 90), R_(240, 120, 0, "R1", "1k"), R_(400, 120, 0, "RF", "10k"),
    V_(300, 320, "VS", "DC 0", "1"), G(300, 400), NET(560, 120, "OUT")],
  wires: [W(220, 120, 240, 120), W(300, 120, 400, 120), W(460, 120, 560, 120),
    W(380, 280, 300, 280), W(300, 280, 300, 320), W(300, 380, 300, 400)],
  probes: [vp(560, 120)]
});
const D12E = join(SPLIT, STAGE(240, "U1A"), STAGE(560, "U1B"), {
  comps: [V_(180, 300, "VS", "DC 0", "1"), G(180, 380),
    R_(240, 120, 0, "R1", "1k"), R_(400, 120, 0, "RF1", "10k"), R_(340, 320, 90, "RCM1", "990"), G(340, 400),
    R_(560, 120, 0, "R2", "1k"), R_(720, 120, 0, "RF2", "10k"), R_(660, 320, 90, "RCM2", "990"), G(660, 400),
    NET(880, 120, "OUT")],
  wires: [W(180, 360, 180, 380), W(180, 300, 180, 120), W(180, 120, 240, 120),
    W(300, 120, 400, 120), W(460, 120, 560, 120),
    W(380, 280, 340, 280), W(340, 280, 340, 320), W(340, 380, 340, 400),
    W(620, 120, 720, 120), W(780, 120, 880, 120),
    W(700, 280, 660, 280), W(660, 280, 660, 320), W(660, 380, 660, 400)],
  probes: [vp(880, 120)]
});

/* Lab 13 */
const BE = (x, y, mx = false) => P("BUSENTRY", x, y, 0, { label: `BE_${x}_${y}`, ...(mx ? { mx: true } : {}) });
const BUS = (x1, y1, x2, y2) => ({ ...W(x1, y1, x2, y2), bus: true });
const PORTP = (x, y, name, rot = 0) => P("PORT", x, y, rot, { label: `PORT_${name}`, name });

const D13A = (() => {
  // U2 sits two grid rows lower than U1's mirror image, so the inverter
  // feeding its enable clears the data rows.
  const comps = [
    P("MUX151", 300, 200, 0, { label: "U1", device: "74151A" }),
    P("MUX151", 300, 580, 0, { label: "U2", device: "74151A" }),
    P("INV", 220, 440, 0, { label: "U3A", device: "7404" }),
    P("GATE2", 480, 300, 0, { label: "U4A", device: "7402" }),
    PORTP(600, 300, "MUXOutput"),
    NET(100, 100, "D[0:15]"),
    NET(140, 760, "S0"), NET(160, 780, "S1"), NET(180, 800, "S2"), NET(200, 820, "S3")
  ];
  const wires = [
    BUS(100, 100, 100, 680),
    // selects: S0–S2 up to both chips, S3 to U1's enable and the inverter
    W(140, 760, 140, 300), W(140, 300, 300, 300), W(140, 680, 300, 680),
    W(160, 780, 160, 320), W(160, 320, 300, 320), W(160, 700, 300, 700),
    W(180, 800, 180, 340), W(180, 340, 300, 340), W(180, 720, 300, 720),
    W(200, 820, 200, 100), W(200, 100, 300, 100), W(200, 440, 220, 440), W(300, 440, 300, 480),
    // outputs into the NOR
    W(400, 140, 440, 140), W(440, 140, 440, 280), W(440, 280, 480, 280),
    W(400, 520, 440, 520), W(440, 520, 440, 320), W(440, 320, 480, 320),
    W(560, 300, 600, 300)
  ];
  for (let k = 0; k < 8; k++) {
    const y1 = 120 + 20 * k, y2 = 500 + 20 * k;
    // Labels at x = 240, clear of the select lines at 140–200: a label
    // dropped where a wire crosses would sit on, and join, both.
    comps.push(BE(120, y1), BE(120, y2), NET(240, y1, `D${k}`), NET(240, y2, `D${8 + k}`));
    wires.push(W(120, y1, 300, y1), W(120, y2, 300, y2));
  }
  return { comps, wires, probes: [], notes: [] };
})();

const D13B = (() => {
  const comps = [
    P("DEC154", 200, 400, 0, { label: "U1", device: "74154" }),
    PORTP(100, 440, "MUXInput", 180),
    NET(140, 360, "S0"), NET(140, 340, "S1"), NET(140, 320, "S2"), NET(140, 300, "S3"),
    NET(1000, 20, "D[0:15]")
  ];
  const wires = [
    W(140, 360, 200, 360), W(140, 340, 200, 340), W(140, 320, 200, 320), W(140, 300, 200, 300),
    W(100, 440, 200, 440), W(160, 440, 160, 460), W(160, 460, 200, 460),
    BUS(1000, 20, 1000, 780)
  ];
  const invName = (k) => (k < 6 ? `U2${"ABCDEF"[k]}` : k < 12 ? `U3${"ABCDEF"[k - 6]}` : `U4${"ABCD"[k - 12]}`);
  for (let k = 0; k < 16; k++) {
    const y = 550 - 20 * k;                          // Yk pin row
    const top = k >= 8;
    const x = top ? 340 + 60 * (15 - k) : 340 + 60 * k;
    const d = top ? 60 + 20 * (15 - k) : 760 - 20 * k;   // Dk row
    const out = top ? y - 80 : y + 80;
    comps.push(P("INV", x, y, top ? 270 : 90, { label: invName(k), device: "7404" }));
    comps.push(BE(980, d, true), NET(940, d, `D${k}`));
    wires.push(W(300, y, x, y), W(x, out, x, d), W(x, d, 980, d));
  }
  return { comps, wires, probes: [] };
})();

const FF13 = (x, label) => P("JKFF", x, 300, 0, { label, device: "7473" });
const AND = (x, y, label) => P("GATE2", x, y, 0, { label, device: "7408" });
const D13C = {
  comps: [
    FF13(200, "U1A"), FF13(460, "U1B"), FF13(720, "U2A"), FF13(1000, "U2B"),
    AND(340, 160, "U3A"), AND(600, 160, "U3B"), AND(880, 60, "U3C"), AND(880, 160, "U3D"),
    P("GATE2", 1000, 120, 0, { label: "U4A", device: "7432" }),
    P("DHI", 140, 260, 0, { label: "HI1" }),
    DCLK(120, 480, "DSTM1", ".5m", ".5m", 1, 0),
    NET(140, 480, "CLOCK"), NET(300, 60, "QA"), NET(560, 60, "QB"), NET(820, 60, "QC"), NET(1100, 0, "QD")
  ],
  wires: [
    // logic 1 and the clear bus
    W(140, 260, 200, 260), W(160, 260, 160, 340), W(160, 340, 200, 340), W(160, 340, 160, 420),
    W(160, 420, 1040, 420),
    W(240, 380, 240, 420), W(500, 380, 500, 420), W(760, 380, 760, 420), W(1040, 380, 1040, 420),
    // clock bus
    W(120, 480, 960, 480),
    W(180, 480, 180, 300), W(180, 300, 200, 300),
    W(440, 480, 440, 300), W(440, 300, 460, 300),
    W(680, 480, 680, 300), W(680, 300, 720, 300),
    W(960, 480, 960, 300), W(960, 300, 1000, 300),
    // QA, and on to U3A and U3C
    W(280, 260, 300, 260), W(300, 60, 300, 260), W(300, 140, 340, 140), W(300, 80, 880, 80),
    // QD̄ back round the bottom to U3A
    W(1080, 340, 1120, 340), W(1120, 340, 1120, 540), W(1120, 540, 320, 540), W(320, 540, 320, 180), W(320, 180, 340, 180),
    // T1 to U1B's J and K, and on to U3B
    W(420, 120, 420, 160), W(420, 160, 420, 260), W(420, 260, 420, 340), W(420, 260, 460, 260), W(420, 340, 460, 340),
    W(420, 120, 580, 120), W(580, 120, 580, 140), W(580, 140, 600, 140),
    // QB
    W(540, 260, 560, 260), W(560, 60, 560, 260), W(560, 180, 600, 180),
    // T2 to U2A's J and K, and on to U3D
    W(680, 160, 700, 160), W(700, 100, 700, 160), W(700, 160, 700, 260), W(700, 260, 700, 340),
    W(700, 260, 720, 260), W(700, 340, 720, 340),
    W(700, 100, 860, 100), W(860, 100, 860, 140), W(860, 140, 880, 140),
    // QC
    W(800, 260, 820, 260), W(820, 60, 820, 260), W(820, 180, 880, 180),
    // QD to U3C
    W(1080, 260, 1100, 260), W(1100, 0, 1100, 260), W(1100, 0, 860, 0), W(860, 0, 860, 40), W(860, 40, 880, 40),
    // U3C and U3D into the OR, and the OR to U2B's J and K
    W(960, 60, 980, 60), W(980, 60, 980, 100), W(980, 100, 1000, 100),
    W(960, 160, 980, 160), W(980, 160, 980, 140), W(980, 140, 1000, 140),
    W(1080, 120, 1080, 200), W(1080, 200, 980, 200), W(980, 200, 980, 260), W(980, 260, 1000, 260),
    W(980, 260, 980, 340), W(980, 340, 1000, 340)
  ],
  probes: [vp(140, 480), vp(1100, 0), vp(820, 60), vp(560, 60), vp(300, 60)]
};

/* Lab 14 */
const D14A = join(SPLIT, {
  comps: [
    P("PARAM", 260, 120, 0, { label: "PARAM1", name: "RVAL", value: "10k" }),
    V_(180, 300, "VS", "DC 6"),
    R_(260, 240, 90, "R1", "10k"), R_(340, 240, 90, "R2", "{RVAL}"),
    R_(260, 380, 90, "R3", "10k"), R_(340, 380, 90, "R4", "10k"),
    { ...U_(500, 160, "U1A"), my: true }, U_(500, 480, "U1B"), U_(800, 320, "U1C"),
    PWR(540, 100, "VEE"), PWR(540, 220, "VCC", 180),
    PWR(540, 420, "VCC"), PWR(540, 540, "VEE", 180),
    PWR(840, 260, "VCC"), PWR(840, 380, "VEE", 180),
    R_(640, 200, 90, "RA1", "10k"), R_(640, 300, 90, "RB", "1k"), R_(640, 400, 90, "RA2", "10k"),
    R_(680, 160, 0, "RIN1", "10k"), R_(800, 160, 0, "RF1", "1MEG"),
    R_(680, 480, 0, "RIN2", "10k"), R_(800, 480, 0, "RF2", "1MEG"), G(880, 480, 270),
    NET(420, 140, "IN-"), NET(400, 500, "IN+"), NET(920, 160, "OUT")
  ],
  wires: [
    // bridge
    W(180, 300, 180, 200), W(180, 200, 340, 200), W(260, 200, 260, 240), W(340, 200, 340, 240),
    W(260, 300, 260, 380), W(340, 300, 340, 380),
    W(180, 360, 180, 480), W(180, 480, 340, 480), W(260, 440, 260, 480), W(340, 440, 340, 480),
    // IN- to U1A's +, IN+ across the R2–R4 line (no junction) to U1B's +
    W(340, 320, 420, 320), W(420, 320, 420, 140), W(420, 140, 500, 140),
    W(260, 360, 400, 360), W(400, 360, 400, 500), W(400, 500, 500, 500),
    // U1A and the gain column
    W(540, 100, 540, 120), W(540, 200, 540, 220),
    W(580, 160, 640, 160), W(640, 160, 640, 200), W(640, 260, 640, 300),
    W(640, 280, 480, 280), W(480, 280, 480, 180), W(480, 180, 500, 180),
    W(640, 360, 640, 400), W(640, 380, 480, 380), W(480, 380, 480, 460), W(480, 460, 500, 460),
    W(640, 460, 640, 480), W(580, 480, 640, 480),
    W(540, 420, 540, 440), W(540, 520, 540, 540),
    // difference amplifier
    W(640, 160, 680, 160), W(740, 160, 800, 160), W(760, 160, 760, 300), W(760, 300, 800, 300),
    W(860, 160, 920, 160), W(920, 160, 920, 320), W(880, 320, 920, 320),
    W(640, 480, 680, 480), W(740, 480, 800, 480), W(860, 480, 880, 480),
    W(760, 480, 760, 340), W(760, 340, 800, 340),
    W(840, 260, 840, 280), W(840, 360, 840, 380)
  ],
  probes: []
});

const N_ = (x, y, label, mx = false) => P("NPN", x, y, 0, { label, model: "Q2N2222", ...(mx ? { mx: true } : {}) });
const J_ = (x, y, label, mx = false) => P("NJF", x, y, 0, { label, model: "J2N3819", ...(mx ? { mx: true } : {}) });
const D_ = (x, y, rot, label, model) => P("D", x, y, rot, { label, model });
const D14B = {
  comps: [
    PWR(620, 40, "vcc"), PWR(620, 720, "vee", 180),
    PWR(40, 300, "vin+", 270), PWR(40, 380, "vin-", 270), PWR(1200, 480, "vo", 90),
    R_(100, 100, 90, "R1", "15.3k"), D_(100, 500, 90, "D1", "D1N914"), D_(100, 680, 270, "D3", "D1N750"),
    N_(300, 440, "Q1"), R_(340, 560, 90, "R6", "4k"),
    J_(240, 300, "J1"), J_(440, 300, "J2", true),
    R_(280, 100, 90, "R2", "10k"), R_(400, 100, 90, "R3", "10k"),
    N_(560, 200, "Q2"), N_(720, 200, "Q3", true),
    R_(600, 80, 90, "R4", "10k"), R_(680, 80, 90, "R5", "10k"), R_(640, 560, 90, "R7", "14.3k"),
    N_(940, 140, "Q4"), R_(980, 240, 90, "R10", "3.6k"),
    R_(860, 300, 90, "R8", "14.3k"), D_(860, 500, 90, "D2", "D1N914"), R_(860, 600, 90, "R9", "5k"),
    N_(940, 440, "Q5"), R_(980, 560, 90, "R11", "5k"),
    N_(1100, 360, "Q6"), R_(1140, 560, 90, "R12", "10k")
  ],
  wires: [
    // rails
    W(100, 40, 1140, 40), W(100, 720, 1140, 720),
    W(100, 40, 100, 100), W(280, 40, 280, 100), W(400, 40, 400, 100),
    W(600, 40, 600, 80), W(680, 40, 680, 80), W(860, 40, 860, 300), W(980, 40, 980, 100), W(1140, 40, 1140, 320),
    // front end
    W(100, 160, 100, 440), W(100, 440, 100, 500), W(100, 440, 300, 440),
    W(100, 560, 100, 620), W(100, 680, 100, 720),
    W(340, 480, 340, 560), W(340, 620, 340, 720),
    W(40, 300, 240, 300),
    W(40, 380, 480, 380), W(480, 380, 480, 300), W(480, 300, 440, 300),
    W(280, 340, 280, 360), W(280, 360, 400, 360), W(400, 340, 400, 360), W(340, 360, 340, 400),
    W(280, 160, 280, 260), W(400, 160, 400, 260),
    // second stage
    W(400, 200, 560, 200),
    W(280, 220, 500, 220), W(500, 220, 500, 420), W(500, 420, 780, 420), W(780, 420, 780, 200), W(780, 200, 720, 200),
    W(600, 140, 600, 160), W(680, 140, 680, 160),
    W(600, 240, 600, 280), W(600, 280, 680, 280), W(680, 240, 680, 280), W(640, 280, 640, 560), W(640, 620, 640, 720),
    // output stages
    W(680, 140, 940, 140),
    W(980, 180, 980, 240), W(980, 300, 980, 400), W(980, 360, 1100, 360),
    W(860, 360, 860, 440), W(860, 440, 940, 440), W(860, 440, 860, 500),
    W(860, 560, 860, 600), W(860, 660, 860, 720),
    W(980, 480, 980, 560), W(980, 620, 980, 720),
    W(1140, 400, 1140, 560), W(1140, 620, 1140, 720), W(1140, 480, 1200, 480)
  ],
  probes: []
};

const DIAGRAMS = {
  "e101-04a": D04A, "e101-04b": D04B,
  "e101-05a": D05A, "e101-05b": D05B, "e101-05c": D05C,
  "e101-06a": D_SERIES, "e101-06b": D06B, "e101-06c": D06C,
  "e101-07a": D07A, "e101-07b": D07B, "e101-07c": D07C, "e101-07d": D07D,
  "e101-08a": D08A, "e101-08b": D08B, "e101-08c": D08C, "e101-08d": D08D,
  ...Object.fromEntries(PULSE_LABS.map((p) => [`e101-09${p.letter}`, D09(p)])),
  "e101-10a": D10_2("7432", "Q"), "e101-10b": D10_2("7402", "QBAR"),
  "e101-10c": D10_3("7411", "Q"), "e101-10d": D10_3("7410", "QBAR"), "e101-10e": D10E,
  "e101-11a": D11A, "e101-11b": D11B, "e101-11c": D11C, "e101-11d": D11D,
  "e101-12a": D12A, "e101-12b": D12B, "e101-12c": D12C, "e101-12d": D12D, "e101-12e": D12E,
  "e101-13a": D13A, "e101-13b": D13B, "e101-13c": D13C, "e101-14a": D14A, "e101-14b": D14B
};

export const DIAGRAM_CAPTIONS = {
  explore: "The starting circuit.",
  fix: "The corrected circuit: what the sheet should look like when you are done.",
  simulate: "The supplied circuit, with the markers the handout places.",
  draw: "Draw this circuit. Your layout can differ; the connections and values cannot."
};

/** The circuit a lab's Reference diagram draws. */
export function diagramFor(lab) {
  if (!lab) return null;
  return DIAGRAMS[lab.id] || lab.diagram || lab.circuit;
}

/* ------------------------------------------------------------ catalogue */

export const LAB_GROUPS = [
  { id: "explore", title: "Explorations" },
  { id: "e101-4", title: "ELEC 101 · Lab 4 — Fixing schematics" },
  { id: "e101-5", title: "ELEC 101 · Lab 5 — Simulation profiles" },
  { id: "e101-6", title: "ELEC 101 · Lab 6 — Drawing circuits" },
  { id: "e101-7", title: "ELEC 101 · Lab 7 — DC sweep" },
  { id: "e101-8", title: "ELEC 101 · Lab 8 — AC sweep" },
  { id: "e101-9", title: "ELEC 101 · Lab 9 — Transient analysis" },
  { id: "e101-10", title: "ELEC 101 · Lab 10 — Logic gates" },
  { id: "e101-11", title: "ELEC 101 · Lab 11 — Digital circuits" },
  { id: "e101-12", title: "ELEC 101 · Lab 12 — Transistor and op-amp amplifiers" },
  { id: "e101-13", title: "ELEC 101 · Lab 13 — Buses, multiplexers and counters" },
  { id: "e101-14", title: "ELEC 101 · Lab 14 — Instrumentation and operational amplifiers" }
];

export const LAB_KINDS = {
  explore: "Investigate",
  fix: "Find and fix the errors",
  simulate: "Set up the simulation",
  draw: "Draw it yourself"
};

export const LABS = [...EXPLORATIONS, ...ELEC101].map((l) => ({ kind: "explore", ...l }));

/* -------------------------------------------------------------- checking */

/**
 * Run a lab's checks against the current sheet.
 *
 * The simulation failing does not stop the marking: structural checks still
 * report, and the ones that need results say why they could not pass.
 * Returns { ok, results:[{label, pass, detail}], error, result }.
 */
export async function runChecks(lab, store, onProgress) {
  const state = store.state;
  const analysis = lab.useStudentAnalysis
    ? state.analysis
    : { ...state.analysis, paramOn: false, ...(lab.analysis || {}) };

  let result = null, error = null, ref = null;
  if (lab.simulate !== false) {
    try {
      result = await simulate(state, onProgress, analysis);
    } catch (e) {
      error = e.message || String(e);
    }
    if (lab.reference) {
      try {
        ref = await simulate(state, onProgress, { ...state.analysis, paramOn: false, ...lab.reference });
      } catch { ref = null; }
    }
  }

  const ctx = makeContext(state, result, ref || result);
  const checks = [...lab.checks, ...(lab.questions || []).map(answerCheck)];
  const results = checks.map((chk) => {
    if (chk.sim && !result) {
      return { label: chk.label, pass: false, answer: false,
        detail: "needs a simulation that runs. The error under Run simulation says what stopped it" };
    }
    try {
      const out = chk.test(ctx);
      return { label: chk.label, pass: !!out.pass, answer: !!chk.answer, detail: out.detail || "" };
    } catch (e) {
      return { label: chk.label, pass: false, answer: !!chk.answer, detail: `could not be evaluated: ${e.message}` };
    }
  });

  return { ok: !error && results.every((r) => r.pass), results, error, result };
}

export function labById(id) {
  return LABS.find((l) => l.id === id) || null;
}

export { PARTS, K, corners };
