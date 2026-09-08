/**
 * Part library.
 *
 * Every part is described in local coordinates with the anchor at (0,0).
 * Pins sit on multiples of GRID so that rotating by 90 degrees keeps them on
 * the grid. `emit` turns a placed part plus its resolved node numbers into
 * netlist lines; `models` names any .model cards those lines depend on.
 */

export const GRID = 20;

/* ------------------------------------------------------------------ models */

export const MODEL_CARDS = {
  Dgen: ".model Dgen D(IS=1e-14 N=1.0 RS=0.1)",
  D1N4148: ".model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100)",
  DLED: ".model DLED D(IS=1e-19 N=1.9 RS=2.4 BV=5)",
  DZ5V1: ".model DZ5V1 D(IS=1e-14 N=1.0 RS=1 BV=5.1 IBV=20m)",
  QNPN: ".model QNPN NPN(IS=1e-14 BF=200 VAF=100 RB=10 RC=1 CJE=8p CJC=4p TF=0.3n)",
  QPNP: ".model QPNP PNP(IS=1e-14 BF=150 VAF=80 RB=10 RC=1 CJE=8p CJC=4p TF=0.6n)",
  MNMOS: ".model MNMOS NMOS(VTO=2.0 KP=0.5 LAMBDA=0.01 RD=1 RS=0.5)",
  MPMOS: ".model MPMOS PMOS(VTO=-2.0 KP=0.25 LAMBDA=0.01 RD=2 RS=1)"
};

const DIODE_MODELS = ["Dgen", "D1N4148", "DLED", "DZ5V1"];

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
          "M25 -20H31", "M28 -23V-17", "M25 20H31"]
};

/** Shapes whose closed subpaths should be filled rather than stroked. */
const FILLED = { NPN: [4], PNP: [4], D: [2], I: [3], NMOS: [9], PMOS: [9] };

/* ------------------------------------------------------------------- parts */

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

  V: twoPin("V", "Voltage source", "V", S.V,
    [{ k: "value", label: "Value", def: "DC 5", hint: "DC 5 · SIN(0 1 1k) · PULSE(0 5 0 1u 1u 1m 2m)" },
     { k: "ac", label: "AC magnitude (for .ac sweeps)", def: "", hint: "Usually 1. Leave blank outside AC analysis" }],
    (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.value}${c.ac ? ` AC ${c.ac}` : ""}`]),

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
    fields: [{ k: "model", label: "Model", def: "QNPN", options: ["QNPN"],
               hint: "Generic small-signal NPN, BF=200" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  PNP: {
    key: "PNP", name: "PNP transistor", prefix: "Q", shape: S.PNP,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["base", "collector", "emitter"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "QPNP", options: ["QPNP"], hint: "" }],
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

  OPAMP: {
    key: "OPAMP", name: "Op-amp (ideal)", prefix: "E", shape: S.OPAMP,
    pins: [[0, -20], [0, 20], [80, 0]], pinNames: ["in+", "in−", "out"],
    box: [-4, -38, 84, 38],
    fields: [{ k: "gain", label: "Open-loop gain", def: "200k",
               hint: "A voltage-controlled source referenced to ground. No supply rails, so it will not clip" }],
    emit: (c, n) => [`${c.label} ${n[2]} 0 ${n[0]} ${n[1]} ${c.gain}`],
    models: () => []
  }
};

/** Order the palette is presented in. */
export const PALETTE = ["R", "C", "L", "V", "I", "D", "SW", "GND", "NPN", "PNP", "NMOS", "PMOS", "OPAMP"];

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
  const [x0, y0, x1, y1] = def.box;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    .map(([px, py]) => rotatePoint(px, py, comp.rot || 0));
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
