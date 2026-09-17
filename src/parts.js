/**
 * Part library.
 *
 * Every part is described in local coordinates with the anchor at (0,0).
 * Pins sit on multiples of GRID so that rotating by 90 degrees keeps them on
 * the grid. `emit` turns a placed part plus its resolved node numbers into
 * netlist lines; `models` names any .model cards those lines depend on.
 */

export const GRID = 20;

const MULT = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, mil: 25.4e-6, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
function parseValue(s) {
  const m = String(s ?? "").trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(meg|mil|[tgkmunpf])?/i);
  if (!m) return NaN;
  const suf = (m[2] || "").toLowerCase();
  return parseFloat(m[1]) * (suf ? MULT[suf] : 1);
}

/** True for parts that draw on the sheet but are not circuit elements. */
export const isVirtual = (c) => !!PARTS[c.type]?.virtual || c.type === "GND";

/** The net name a part imposes on its pin, if it is an alias or power symbol. */
export const netNameOf = (c) => {
  const f = PARTS[c.type]?.netName;
  const n = f ? String(f(c) ?? "").trim() : "";
  return n || null;
};

/* ------------------------------------------------------------------ models */

export const MODEL_CARDS = {
  Dgen: ".model Dgen D(IS=1e-14 N=1.0 RS=0.1)",
  D1N4148: ".model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100)",
  DLED: ".model DLED D(IS=1e-19 N=1.9 RS=2.4 BV=5)",
  DZ5V1: ".model DZ5V1 D(IS=1e-14 N=1.0 RS=1 BV=5.1 IBV=20m)",
  /*
   * D1N750 is the 4.7 V zener from the PSpice EVAL library, trimmed. The full
   * card carries Nbv, Ibvl and Nbvl, and one of those makes this ngspice build
   * exit fatally rather than report an error, which takes the engine down for
   * the rest of the session. Without them the breakdown knee is slightly
   * sharper; the 4.7 V breakdown and the forward behaviour are unchanged.
   */
  D1N750: ".model D1N750 D(Is=880.5E-18 Rs=.25 N=1 Xti=3 Eg=1.11 Cjo=175p M=.5516 Vj=.75 Fc=.5 Isr=1.859n Nr=2 Bv=4.7 Ibv=20.245m)",
  QNPN: ".model QNPN NPN(IS=1e-14 BF=200 VAF=100 RB=10 RC=1 CJE=8p CJC=4p TF=0.3n)",
  // Q2N2222 is the card the ELEC 101 Lab 6 handout has students type in.
  Q2N2222: ".model Q2N2222 NPN(Is=35f Xti=3 Eg=1.11 Vaf=100 Bf=250 Ne=1.5 Ise=1.2f Ikf=.1 Xtb=2 Br=6 Nc=2 Isc=.1f Ikr=1000 Rc=20 Cjc=20p Mjc=.33 Vjc=.75 Fc=.5 Cje=35p Mje=.33 Vje=.75 Tr=13n Tf=530p Itf=.6 Vtf=1.7 Xtf=3 Rb=100)",
  Q2N3904: ".model Q2N3904 NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)",
  Q2N3906: ".model Q2N3906 PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10)",
  QPNP: ".model QPNP PNP(IS=1e-14 BF=150 VAF=80 RB=10 RC=1 CJE=8p CJC=4p TF=0.6n)",
  MNMOS: ".model MNMOS NMOS(VTO=2.0 KP=0.5 LAMBDA=0.01 RD=1 RS=0.5)",
  MPMOS: ".model MPMOS PMOS(VTO=-2.0 KP=0.25 LAMBDA=0.01 RD=2 RS=1)"
};

const DIODE_MODELS = ["Dgen", "D1N4148", "D1N750", "DLED", "DZ5V1"];
const NPN_MODELS = ["QNPN", "Q2N2222", "Q2N3904"];
const PNP_MODELS = ["QPNP", "Q2N3906"];

/* ------------------------------------------------------------------ shapes */

const S = {
  R: ["M0 0H15 L18 -7 L24 7 L30 -7 L36 7 L42 -7 L45 0 H60"],
  C: ["M0 0H26", "M34 0H60", "M26 -10V10", "M34 -10V10"],
  L: ["M0 0H15", "M15 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0", "M45 0H60"],
  V: ["M0 0H19", "M41 0H60", "M19 0 a11 11 0 1 0 22 0 a11 11 0 1 0 -22 0",
      "M24 -4V4", "M20 0H28", "M32 0H40"],
  I: ["M0 0H19", "M41 0H60", "M19 0 a11 11 0 1 0 22 0 a11 11 0 1 0 -22 0",
      "M23 0H37", "M33 -4L37 0L33 4"],
  D: ["M0 0H22", "M38 0H60", "M22 -9L38 0L22 9Z", "M38 -9V9"],
  GND: ["M0 0V10", "M-11 10H11", "M-6.5 15H6.5", "M-2.5 20H2.5"],
  SW_OPEN: ["M0 0H16", "M44 0H60", "M16 0 L41 -13"],
  SW_CLOSED: ["M0 0H16", "M44 0H60", "M16 0 L44 -4"],
  NPN: ["M0 0H20", "M20 -18V18", "M20 -10 L40 -24 V-40", "M20 10 L40 24 V40",
        "M36 21.2 L28.3 19.5 L31.7 14.5 Z"],
  PNP: ["M0 0H20", "M20 -18V18", "M20 -10 L40 -24 V-40", "M20 10 L40 24 V40",
        "M25 13.5 L30.3 20.9 L33.7 15.9 Z"],
  NMOS: ["M0 0H16", "M16 -18V18", "M24 -18V-8", "M24 -4V4", "M24 8V18",
         "M24 -13 H40 V-40", "M24 13 H40 V40", "M24 0H40", "M40 0V13",
         "M32 0 L37 -3.5 L37 3.5 Z"],
  PMOS: ["M0 0H16", "M16 -18V18", "M24 -18V-8", "M24 -4V4", "M24 8V18",
         "M24 -13 H40 V-40", "M24 13 H40 V40", "M24 0H40", "M40 0V13",
         "M37 0 L32 -3.5 L32 3.5 Z"],
  OPAMP: ["M0 -20H20", "M0 20H20", "M20 -34 L20 34 L64 0 Z", "M64 0H80",
          "M25 -20H31", "M28 -23V-17", "M25 20H31"],
  OPAMP5: ["M0 -20H20", "M0 20H20", "M20 -34 L20 34 L64 0 Z", "M64 0H80",
           "M40 -18.5V-40", "M40 18.5V40",
           "M25 -20H31", "M25 20H31", "M28 17V23",
           "M44 -30H50", "M47 -33V-27", "M44 30H50"],
  PWR: ["M0 0V-14", "M-12 -14H12"],
  VPULSE: ["M0 0H19", "M41 0H60", "M19 0 a11 11 0 1 0 22 0 a11 11 0 1 0 -22 0",
           "M23 4H27L28 -4H32L33 4H37", "M16 -12H22", "M19 -15V-9"],
  // Primary on the left (pins at x=0), secondary on the right (x=60);
  // dots mark the pins that are in phase.
  XFORM: ["M0 0H20V6", "M20 6 a5 5 0 0 1 0 10 a5 5 0 0 1 0 10 a5 5 0 0 1 0 10 a5 5 0 0 1 0 10", "M20 46V60H0",
          "M60 0H40V6", "M40 6 a5 5 0 0 0 0 10 a5 5 0 0 0 0 10 a5 5 0 0 0 0 10 a5 5 0 0 0 0 10", "M40 46V60H60",
          "M28 4V56", "M32 4V56",
          "M13 4 a1.8 1.8 0 1 0 0.01 0Z", "M47 4 a1.8 1.8 0 1 0 0.01 0Z"],
  NET: ["M0 0V-5", "M-3 -5H3"],
  PARAM: ["M0 -12H96"],
  AM: ["M0 0H19", "M41 0H60", "M19 0 a11 11 0 1 0 22 0 a11 11 0 1 0 -22 0",
       "M25.5 5 L30 -6 L34.5 5", "M27.2 1.5 H32.8", "M46 -3.5 L51.5 0 L46 3.5 Z"]
};

/** Shapes whose closed subpaths should be filled rather than stroked. */
const FILLED = { NPN: [4], PNP: [4], D: [2], I: [3], NMOS: [9], PMOS: [9], AM: [5], XFORM: [8, 9] };

/* ------------------------------------------------------------------- parts */

/**
 * SPICE reads a part's type from its first letter, so a source called
 * RANDOM would be taken for a resistor. PSpice quietly writes V_RANDOM;
 * so does this. Names that already start with V are left alone, so VS stays
 * VS and a DC sweep of VS still finds it.
 */
export function sourceName(c) {
  return /^v/i.test(String(c.label)) ? c.label : `V_${c.label}`;
}

function withSourceName(def) {
  return { ...def, netlistName: sourceName };
}

function twoPin(key, name, prefix, shape, fields, emit, models) {
  return {
    key, name, prefix, shape,
    pins: [[0, 0], [60, 0]],
    pinNames: ["+", "-"],
    box: [-4, -16, 64, 16],
    fields, emit,
    models: models || (() => [])
  };
}

export const PARTS = {
  R: twoPin("R", "Resistor", "R", S.R,
    [{ k: "value", label: "Resistance", def: "1k", hint: "Ohms. SPICE suffixes: 1k, 4.7k, 2meg, 0.1" }],
    (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.value}`]),

  C: twoPin("C", "Capacitor", "C", S.C,
    [{ k: "value", label: "Capacitance", def: "100n", hint: "Farads. 100n, 4.7u, 22p" },
     { k: "ic", label: "Initial voltage (optional)", def: "", hint: "Used when the transient analysis starts from stored charge" }],
    (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.value}${c.ic ? ` IC=${c.ic}` : ""}`]),

  L: twoPin("L", "Inductor", "L", S.L,
    [{ k: "value", label: "Inductance", def: "10m", hint: "Henries. 10m is 10 millihenries" },
     { k: "ic", label: "Initial current (optional)", def: "", hint: "" }],
    (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.value}${c.ic ? ` IC=${c.ic}` : ""}`]),

  V: withSourceName(twoPin("V", "Voltage source", "V", S.V,
    [{ k: "value", label: "Value", def: "DC 5", hint: "DC 5 · SIN(0 1 1k) · PULSE(0 5 0 1u 1u 1m 2m)" },
     { k: "ac", label: "AC magnitude (for .ac sweeps)", def: "", hint: "Usually 1. Leave blank outside AC analysis" }],
    (c, n) => [`${sourceName(c)} ${n[0]} ${n[1]} ${c.value}${c.ac ? ` AC ${c.ac}` : ""}`])),

  /**
   * PSpice's VPULSE, with its seven parameters as separate fields so they
   * cannot be typed in the wrong order.
   */
  VPULSE: withSourceName({
    key: "VPULSE", name: "Pulse source", prefix: "V", shape: S.VPULSE,
    pins: [[0, 0], [60, 0]], pinNames: ["+", "-"],
    box: [-4, -16, 64, 16],
    fields: [
      { k: "v1", label: "V1, initial voltage", def: "0", hint: "The level before and between pulses" },
      { k: "v2", label: "V2, pulsed voltage", def: "5", hint: "The level during the pulse" },
      { k: "td", label: "TD, delay", def: "0", hint: "Time from 0 to the start of the first rise" },
      { k: "tr", label: "TR, rise time", def: "1n", hint: "Time to go from V1 to V2" },
      { k: "tf", label: "TF, fall time", def: "1n", hint: "Time to go from V2 back to V1" },
      { k: "pw", label: "PW, pulse width", def: "0.5m", hint: "Time spent at V2" },
      { k: "per", label: "PER, period", def: "1m", hint: "Time for one whole cycle" }
    ],
    emit: (c, n) => [`${sourceName(c)} ${n[0]} ${n[1]} PULSE(${c.v1} ${c.v2} ${c.td} ${c.tr} ${c.tf} ${c.pw} ${c.per})`],
    summary: (c) => `${c.v1}→${c.v2} V, PER ${c.per}`,
    models: () => []
  }),

  /**
   * PSpice's XFORM_LINEAR: two inductors and a coupling card. Pins 1–2 are
   * the primary, 3–4 the secondary, and the dotted ends are pins 1 and 3.
   */
  XFORM: {
    key: "XFORM", name: "Transformer", prefix: "TX", shape: S.XFORM,
    pins: [[0, 0], [0, 60], [60, 0], [60, 60]],
    pinNames: ["primary 1", "primary 2", "secondary 3", "secondary 4"],
    box: [-4, -4, 64, 64],
    fields: [
      { k: "l1", label: "L1_VALUE, primary inductance", def: "10m", hint: "Henries" },
      { k: "l2", label: "L2_VALUE, secondary inductance", def: "10m",
        hint: "A step-up transformer has L2 above L1. The voltage ratio is about √(L2/L1)" },
      { k: "k", label: "COUPLING", def: "0.99", hint: "Between 0 and 1. 1 would be a perfect transformer" }
    ],
    boxFor: () => [-4, -4, 64, 104],
    emit: (c, n) => [
      `L${c.label}_1 ${n[0]} ${n[1]} ${c.l1}`,
      `L${c.label}_2 ${n[2]} ${n[3]} ${c.l2}`,
      `K${c.label} L${c.label}_1 L${c.label}_2 ${c.k}`
    ],
    // Three short lines under the core, between the leads, as PSpice shows them.
    summary: () => "",
    texts: (c) => [
      { x: 30, y: 72, text: `L1 ${c.l1}`, cls: "part-value", field: "l1" },
      { x: 30, y: 85, text: `L2 ${c.l2}`, cls: "part-value", field: "l2" },
      { x: 30, y: 98, text: `k ${c.k}`, cls: "part-value", field: "k" }
    ],
    netlistName: (c) => `K${c.label}`,
    models: () => []
  },

  I: twoPin("I", "Current source", "I", S.I,
    [{ k: "value", label: "Value", def: "DC 1m", hint: "Current flows from + through the source to −" },
     { k: "ac", label: "AC magnitude (for .ac sweeps)", def: "", hint: "" }],
    (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.value}${c.ac ? ` AC ${c.ac}` : ""}`]),

  D: {
    key: "D", name: "Diode", prefix: "D", shape: S.D,
    pins: [[0, 0], [60, 0]], pinNames: ["anode", "cathode"],
    box: [-4, -14, 64, 14],
    fields: [{ k: "model", label: "Model", def: "Dgen", options: DIODE_MODELS,
               hint: "The matching .model card is added to the netlist automatically" }],
    emit: (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.model}`],
    models: (c) => [c.model]
  },

  SW: {
    key: "SW", name: "Switch", prefix: "SW", shape: S.SW_OPEN,
    shapeFor: (c) => (c.closed === true || c.closed === "true" ? S.SW_CLOSED : S.SW_OPEN),
    pins: [[0, 0], [60, 0]], pinNames: ["1", "2"],
    box: [-4, -20, 64, 12],
    fields: [{ k: "closed", label: "Contact", def: "false", options: ["false", "true"],
               labels: { false: "Open", true: "Closed" },
               hint: "Emitted as a resistor: 1 milliohm closed, 1 gigaohm open" }],
    emit: (c, n) => {
      const closed = c.closed === true || c.closed === "true";
      return [`R${c.label} ${n[0]} ${n[1]} ${closed ? "1m" : "1G"}`];
    },
    netlistName: (c) => `R${c.label}`,
    models: () => []
  },

  GND: {
    key: "GND", name: "Ground", prefix: "GND", shape: S.GND,
    pins: [[0, 0]], pinNames: ["0"],
    box: [-13, -6, 13, 24],
    fields: [], emit: () => [], models: () => [], noLabel: true
  },

  NPN: {
    key: "NPN", name: "NPN transistor", prefix: "Q", shape: S.NPN,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["base", "collector", "emitter"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "QNPN", options: NPN_MODELS,
               hint: "QNPN is a generic NPN with BF=200. Q2N2222 and Q2N3904 use the PSpice library cards" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  PNP: {
    key: "PNP", name: "PNP transistor", prefix: "Q", shape: S.PNP,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["base", "collector", "emitter"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "QPNP", options: PNP_MODELS, hint: "" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  NMOS: {
    key: "NMOS", name: "N-channel MOSFET", prefix: "M", shape: S.NMOS,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["gate", "drain", "source"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "MNMOS", options: ["MNMOS"],
               hint: "Level 1, threshold 2 V. Bulk is tied to the source" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  PMOS: {
    key: "PMOS", name: "P-channel MOSFET", prefix: "M", shape: S.PMOS,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["gate", "drain", "source"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "MPMOS", options: ["MPMOS"], hint: "" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  /**
   * Ammeter. ngspice only reports i(...) for voltage sources and inductors, so
   * measuring current anywhere else means putting a zero-volt source in the
   * branch. This wraps that trick in a part: it emits `V<label> n+ n- DC 0`,
   * which is a perfect wire electrically and an ammeter as far as the results
   * are concerned. Reads positive when conventional current flows from + to −.
   */
  AM: {
    key: "AM", name: "Ammeter", prefix: "AM", shape: S.AM,
    pins: [[0, 0], [60, 0]], pinNames: ["+", "−"],
    box: [-4, -16, 64, 16],
    fields: [],
    emit: (c, n) => [`V${c.label} ${n[0]} ${n[1]} DC 0`],
    netlistName: (c) => `V${c.label}`,
    models: () => []
  },

  /**
   * Op-amp with supply rails. Emitted as a behavioural source whose output is
   * clamped between the rails, so it saturates the way a real one does rather
   * than producing impossible output swings.
   *
   * Clamping is `max(vneg, min(vpos, ...))`. ngspice's own limit() function
   * looks like the obvious choice but is broken in this build: it silently
   * returns the gain constant instead of a clamped value, with no error.
   */
  OPAMP: {
    key: "OPAMP", name: "Op-amp", prefix: "U", shape: S.OPAMP,
    pins: [[0, -20], [0, 20], [80, 0]], pinNames: ["in+", "in−", "out"],
    box: [-4, -38, 84, 38],
    fields: [
      { k: "gain", label: "Open-loop gain", def: "200k",
        hint: "Differential gain before the rails take over" },
      { k: "vpos", label: "Positive rail (V)", def: "15",
        hint: "The output cannot rise above this" },
      { k: "vneg", label: "Negative rail (V)", def: "-15",
        hint: "The output cannot fall below this. Use 0 for a single-supply circuit" }
    ],
    emit: (c, n) => {
      // V(0) is not a legal reference, so a grounded input is written as 0.
      const at = (node) => (node === 0 ? "0" : `V(${node})`);
      const diff = `${at(n[0])} - ${at(n[1])}`;
      return [`B${c.label} ${n[2]} 0 V = max(${c.vneg}, min(${c.vpos}, ${c.gain}*(${diff})))`];
    },
    summary: (c) => `A=${c.gain}  ${c.vpos}/${c.vneg} V`,
    netlistName: (c) => `B${c.label}`,
    models: () => []
  },

  /**
   * Op-amp with real supply pins, drawn and pinned like the PSpice LM324:
   * inverting input on top, non-inverting below, V+ and V− on the body.
   *
   * Built in two stages rather than as one clamped expression. A behavioural
   * current into 1 kΩ gives the open-loop gain, and the capacitor across it
   * puts the dominant pole where a 1 MHz gain-bandwidth part has it. A second
   * source then clamps that to the supply pins less the headroom.
   *
   * The split is not cosmetic. With the clamp inside the gain expression,
   * ngspice's first Newton iteration sees both supplies at 0 V, so the clamp
   * is inverted, the loop gain is zero, and the operating point never
   * converges. With the gain stage standing on its own, its node stays solvable
   * while the supplies come up.
   */
  OPAMP5: {
    key: "OPAMP5", name: "LM324 op-amp", prefix: "U", shape: S.OPAMP5,
    pins: [[0, -20], [0, 20], [80, 0], [40, -40], [40, 40]],
    pinNames: ["in−", "in+", "out", "V+", "V−"],
    box: [-4, -42, 84, 42],
    fields: [
      { k: "gain", label: "Open-loop gain", def: "100k",
        hint: "An LM324 is about 100 dB, which is 100k" },
      { k: "gbw", label: "Gain-bandwidth (Hz)", def: "1meg",
        hint: "Sets where the open-loop gain starts to fall. The LM324 is about 1 MHz" },
      { k: "headroom", label: "Output headroom (V)", def: "1.5",
        hint: "How far short of each supply pin the output stops" }
    ],
    emit: (c, n) => {
      const at = (node) => (node === 0 ? "0" : `V(${node})`);
      const x = `${c.label}_x`;
      const a0 = parseValue(c.gain);
      const gbw = parseValue(c.gbw);
      // Dominant pole at GBW / A0, formed by 1k and C.
      const cap = isFinite(a0) && isFinite(gbw) && gbw > 0 && a0 > 0
        ? (a0 / (2 * Math.PI * 1000 * gbw)).toExponential(4)
        : "1e-6";
      return [
        `B${c.label}_g 0 ${x} I = ${c.gain}*(${at(n[1])} - ${at(n[0])})*1m`,
        `R${c.label}_p ${x} 0 1k`,
        `C${c.label}_p ${x} 0 ${cap}`,
        `B${c.label} ${n[2]} 0 V = max(${at(n[4])}+${c.headroom}, min(${at(n[3])}-${c.headroom}, V(${x})))`
      ];
    },
    summary: () => "LM324",
    netlistName: (c) => `B${c.label}`,
    models: () => []
  },

  /**
   * Net alias, as PSpice calls it. Every alias with the same name is the same
   * node, and that name becomes the node's name in the netlist, so a probe on
   * it reads v(out) rather than whatever number the connectivity pass chose.
   */
  NET: {
    key: "NET", name: "Net alias", prefix: "NET", shape: S.NET,
    pins: [[0, 0]], pinNames: ["net"],
    upright: true, virtual: true, noLabel: true,
    boxFor: (c) => [-6, -22, Math.max(14, 9 * String(c.name || "?").length + 6), 4],
    fields: [{ k: "name", label: "Net name", def: "",
               hint: "Every alias with this name is the same node. Letters, digits and _ only" }],
    netName: (c) => c.name,
    texts: (c) => [{ x: 2, y: -9, text: c.name || "?", cls: "net-name", field: "name" }],
    emit: () => [], models: () => []
  },

  /** Power symbol, the VCC_BAR of PSpice. A named net with a bar on it. */
  PWR: {
    key: "PWR", name: "Power symbol", prefix: "PWR", shape: S.PWR,
    pins: [[0, 0]], pinNames: ["net"],
    virtual: true, noLabel: true,
    box: [-16, -38, 16, 3],
    fields: [{ k: "name", label: "Net name", def: "VCC",
               hint: "Every power symbol and net alias with this name is the same node. Rotate to 180° for a VEE bar" }],
    netName: (c) => c.name,
    texts: (c) => [{ x: 0, y: -26, text: c.name || "?", cls: "net-name", anchor: "middle", field: "name" }],
    emit: () => [], models: () => []
  },

  /**
   * PARAMETERS block. Any value written as {NAME} picks this up, and a
   * parametric sweep overrides it run by run.
   */
  PARAM: {
    key: "PARAM", name: "Parameter", prefix: "PARAM", shape: S.PARAM,
    pins: [], pinNames: [],
    upright: true, virtual: true, noLabel: true,
    box: [-4, -28, 100, 10],
    fields: [
      { k: "name", label: "Parameter name", def: "RVAL",
        hint: "Use it in a part value as {RVAL}, curly braces included" },
      { k: "value", label: "Value", def: "100",
        hint: "Used on a normal run. A parametric sweep replaces it" }
    ],
    texts: (c) => [
      { x: 0, y: -16, text: "PARAMETERS:", cls: "param-head" },
      { x: 0, y: 4, text: `${c.name || "?"} = ${c.value || "?"}`, cls: "part-value", field: "value" }
    ],
    emit: (c, n, ctx) => {
      const name = String(c.name || "").trim();
      if (!name) return [];
      const over = ctx?.overrides?.[name.toLowerCase()];
      return [`.param ${name}=${over !== undefined ? over : c.value}`];
    },
    models: () => []
  }
};

/** Order the palette is presented in. */
export const PALETTE = ["R", "C", "L", "V", "VPULSE", "I", "D", "SW", "AM", "XFORM", "GND", "NET", "PWR", "NPN", "PNP", "NMOS", "PMOS", "OPAMP", "OPAMP5", "PARAM"];

/* --------------------------------------------------------------- geometry */

/** Rotate a local point by rot degrees (0/90/180/270) about the anchor. */
export function rotatePoint(px, py, rot) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [-py, px];
    case 180: return [-px, -py];
    case 270: return [py, -px];
    default: return [px, py];
  }
}

/** World-space pin coordinates for a placed part. */
export function pinsOf(comp) {
  const def = PARTS[comp.type];
  return def.pins.map(([px, py]) => {
    const [rx, ry] = rotatePoint(px, py, comp.rot || 0);
    return { x: comp.x + rx, y: comp.y + ry };
  });
}

/** World-space bounding box, padded for comfortable hit testing. */
export function boxOf(comp, pad = 2) {
  const def = PARTS[comp.type];
  const [x0, y0, x1, y1] = def.boxFor ? def.boxFor(comp) : def.box;
  const rot = def.upright ? 0 : comp.rot || 0;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    .map(([px, py]) => rotatePoint(px, py, rot));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return {
    x0: comp.x + Math.min(...xs) - pad,
    y0: comp.y + Math.min(...ys) - pad,
    x1: comp.x + Math.max(...xs) + pad,
    y1: comp.y + Math.max(...ys) + pad
  };
}

/** Paths to stroke, honouring any state-dependent shape override. */
export function shapeOf(comp) {
  const def = PARTS[comp.type];
  return def.shapeFor ? def.shapeFor(comp) : def.shape;
}

export function filledIndices(type) {
  return FILLED[type] || [];
}

/** The reference designator SPICE will see, which can differ from the label. */
export function netlistNameOf(comp) {
  const def = PARTS[comp.type];
  return def.netlistName ? def.netlistName(comp) : comp.label;
}

/** A fresh part instance with every field defaulted. */
export function makeComp(type, x, y, label) {
  const def = PARTS[type];
  const c = { type, x, y, rot: 0, label };
  def.fields.forEach((f) => { c[f.k] = f.def; });
  return c;
}

/** Where the label and value text sit, given the part's rotation. */
export function textAnchor(comp) {
  const rot = ((comp.rot % 360) + 360) % 360;
  // The 5-pin op-amp has supply leads through the middle of its top and
  // bottom edges, so its text goes beside the body instead.
  if (comp.type === "XFORM" && rot === 0) {
    return { lx: comp.x + 30, ly: comp.y - 10, vx: comp.x + 30, vy: comp.y + 78, anchor: "middle" };
  }
  if (comp.type === "OPAMP5" && rot === 0) {
    return { lx: comp.x + 58, ly: comp.y - 26, vx: comp.x + 58, vy: comp.y + 36, anchor: "start" };
  }
  const horizontal = rot === 0 || rot === 180;
  const b = boxOf(comp, 0);
  if (horizontal) {
    return {
      lx: (b.x0 + b.x1) / 2, ly: b.y0 - 6,
      vx: (b.x0 + b.x1) / 2, vy: b.y1 + 15,
      anchor: "middle"
    };
  }
  return {
    lx: b.x1 + 6, ly: (b.y0 + b.y1) / 2 - 2,
    vx: b.x1 + 6, vy: (b.y0 + b.y1) / 2 + 13,
    anchor: "start"
  };
}
