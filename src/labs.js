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
import { PARTS, pinsOf, netNameOf } from "./parts.js";
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
    if (typeof spec === "string") return spec;
    if (Array.isArray(spec)) {
      const c = part(spec[0]);
      const pin = c ? PARTS[c.type].pinNames[spec[1]] : spec[1];
      return `${spec[0]} ${pin}`;
    }
    if (spec && spec.other) return `the far end of ${spec.other}`;
    return "?";
  };
  const describeNode = (n) => (n === 0 ? "ground" : n === undefined ? "nothing" : typeof n === "string" ? n : `node ${n}`);

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
      label: `A parametric sweep steps ${name} through ${values.join(", ")}`,
      test: (ctx) => {
        const a = ctx.analysis;
        if (!a.paramOn) return { pass: false, detail: "the parametric sweep is not turned on" };
        if (lc(a.paramName) !== lc(name)) return { pass: false, detail: `the sweep varies ${a.paramName || "nothing"}` };
        const got = paramValues(a) || [];
        const ok = got.length === values.length && values.every((v, k) => sameNum(got[k], v));
        return { pass: ok, detail: ok ? "" : got.length ? `it steps through ${got.join(", ")}` : "the sweep values could not be read; check start, stop and increment" };
      }
    };
  },

  probe(spec, where) {
    return {
      label: `A voltage probe sits on ${where}`,
      test: (ctx) => ({ pass: ctx.probeOn(spec), detail: ctx.probeOn(spec) ? "" : `no voltage probe on ${where} yet` })
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
    P("OPAMP5", 400, 300, 0, { label: "U1", gain: "100k", gbw: "1meg", headroom: "1.5" }),
    PWR(440, 240, "VCC"), PWR(440, 360, "VEE", 180),

    P("R", 540, 300, 0, { label: "R2", value: "15.9k" }),
    P("C", 640, 340, 90, { label: "C2", value: ".56n", ic: "" }),
    G(640, 420),

    G(560, 140, 90),
    P("R", 580, 140, 0, { label: "RIN2", value: "10k" }),
    P("R", 720, 140, 0, { label: "RF2", value: "20k" }),
    P("OPAMP5", 700, 280, 0, { label: "U2", gain: "100k", gbw: "1meg", headroom: "1.5" }),
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
      "Open the Netlist panel: the nodes are now called A and B instead of numbers. Enter how many nodes there are above ground."
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
  }
];


/* ------------------------------------------------------------ catalogue */

export const LAB_GROUPS = [
  { id: "explore", title: "Explorations" },
  { id: "e101-4", title: "ELEC 101 · Lab 4 — Fixing schematics" },
  { id: "e101-5", title: "ELEC 101 · Lab 5 — Simulation profiles" },
  { id: "e101-6", title: "ELEC 101 · Lab 6 — Drawing circuits" },
  { id: "e101-7", title: "ELEC 101 · Lab 7 — DC sweep" }
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
