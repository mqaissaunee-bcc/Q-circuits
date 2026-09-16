/**
 * ELEC 101 lab exercises.
 *
 * Ported from the OrCAD Capture / PSpice originals. What carries over is the
 * electronics: find the wiring faults, fix a value, set up the right analysis,
 * read the operating point. What does not carry over is the OrCAD procedure —
 * title blocks, USER.OLB, ZIP disks, Design Templates — which taught a
 * particular Windows program rather than circuits, and has no counterpart here.
 *
 * Three exercise shapes:
 *   fix       the circuit is handed over broken; find and repair the faults
 *   simulate  the circuit is correct; set up the analysis and read the result
 *   build     the student draws it from scratch (later labs)
 */

import { formatEng, parseValue } from "./netlist.js";

const P = (type, x, y, rot, fields) => ({ type, x, y, rot, ...fields });
const W = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

const near = (a, b, tol) => isFinite(a) && Math.abs(a - b) <= tol;

/** dB magnitude of a trace, and the frequency where it first falls `drop` dB. */
function cornerBelowPeak(ctx, traceName, drop, fromEnd) {
  const t = ctx.trace(traceName);
  if (!t || !t.db) return { peak: NaN, corner: NaN };
  const peak = Math.max(...t.db);
  const freqs = ctx.result.sweep.values;
  const order = fromEnd
    ? [...t.db.keys()].reverse()
    : [...t.db.keys()];
  let corner = NaN;
  for (const i of order) {
    if (t.db[i] >= peak - drop) { corner = freqs[i]; break; }
  }
  return { peak, corner };
}

export const ELEC101_LABS = [
  /* ------------------------------------------------------------------ 4A */
  {
    id: "elec101-4a",
    title: "Lab 4A — Find the wiring faults",
    kind: "fix",
    summary: "This circuit was drawn with three faults in it. Track them down and repair them.",
    tasks: [
      "Three things are wrong with this schematic. Two you can see; one is a connection that was never made.",
      "The circuit should be driven by a single 12 V source.",
      "R1 should actually carry the base current, not be bypassed.",
      "The collector has to go somewhere. Wire it to the same node as the base.",
      "Use Check my work as you go — it lists the faults still outstanding."
    ],
    circuit: {
      title: "Lab 4A — wiring faults",
      analysis: { type: "op" },
      comps: [
        P("V", 160, 140, 90, { label: "V1", value: "DC 12", ac: "" }),
        P("V", 100, 140, 90, { label: "V2", value: "DC 12", ac: "" }),
        P("R", 260, 140, 0, { label: "R1", value: "1k" }),
        P("NPN", 400, 200, 0, { label: "Q1", model: "QNPN" }),
        P("R", 440, 280, 90, { label: "R2", value: "1k" }),
        P("GND", 160, 400, 0, { label: "GND" })
      ],
      wires: [
        W(100, 140, 160, 140), W(100, 200, 160, 200),
        W(160, 140, 260, 140),
        W(260, 140, 320, 140),                       // the wire shorting R1
        W(320, 140, 320, 200), W(320, 200, 400, 200),
        W(440, 240, 440, 280),
        W(440, 340, 440, 400), W(440, 400, 160, 400),
        W(160, 200, 160, 400)
      ],
      seq: { R: 2, V: 2, Q: 1 },
      probes: []
    },
    analysis: { type: "op" },
    checks: [
      {
        label: "A single source drives the circuit",
        needsSim: false,
        test: (ctx) => {
          const n = ctx.count("V");
          return { pass: n === 1, detail: `${n} voltage source${n === 1 ? "" : "s"} on the sheet` };
        }
      },
      {
        label: "R1 is no longer shorted out",
        needsSim: false,
        test: (ctx) => {
          const a = ctx.node("R1", 0), b = ctx.node("R1", 1);
          return {
            pass: a !== null && b !== null && a !== b,
            detail: a === b ? `both ends of R1 sit on node ${a}` : `R1 spans nodes ${a} and ${b}`
          };
        }
      },
      {
        label: "The collector is connected to the base node",
        needsSim: false,
        test: (ctx) => {
          const base = ctx.node("Q1", 0), collector = ctx.node("Q1", 1);
          if (ctx.pinCount("Q1", 1) < 2) {
            return { pass: false, detail: "the collector is not wired to anything" };
          }
          return {
            pass: base === collector,
            detail: base === collector
              ? `collector and base share node ${base}`
              : `collector is on node ${collector}, base on node ${base}`
          };
        }
      },
      {
        label: "The repaired circuit has a sensible operating point",
        test: (ctx) => {
          const ve = ctx.v("R2", 0);
          return {
            pass: ve > 3 && ve < 9,
            detail: `emitter sits at ${formatEng(ve, 4)} V`
          };
        }
      }
    ]
  },

  /* ------------------------------------------------------------------ 4B */
  {
    id: "elec101-4b",
    title: "Lab 4B — Fix the value and tidy the layout",
    kind: "fix",
    summary: "One part value will not parse, and the drawing is untidy. Repair both.",
    tasks: [
      "Run it first. The error message names the part that is wrong.",
      "A SPICE value cannot contain a space: 1 k is not the same as 1k.",
      "Line up R2 and R4 so the ladder reads cleanly. Select a part and use the arrow keys.",
      "The junction between R1, R2 and R3 should settle at 4.8 V."
    ],
    circuit: {
      title: "Lab 4B — value and layout",
      analysis: { type: "op" },
      comps: [
        P("V", 120, 140, 90, { label: "V1", value: "DC 12", ac: "" }),
        P("R", 200, 140, 0, { label: "R1", value: "1 k" }),
        P("R", 340, 180, 90, { label: "R2", value: "1k" }),
        P("R", 400, 140, 0, { label: "R3", value: "1k" }),
        P("R", 540, 200, 90, { label: "R4", value: "1k" }),
        P("GND", 340, 360, 0, { label: "GND" })
      ],
      wires: [
        W(120, 140, 200, 140), W(260, 140, 340, 140),
        W(340, 140, 340, 180), W(340, 140, 400, 140),
        W(460, 140, 540, 140), W(540, 140, 540, 200),
        W(340, 240, 340, 360), W(540, 260, 540, 360),
        W(540, 360, 120, 360), W(120, 200, 120, 360)
      ],
      seq: { R: 4, V: 1 },
      probes: []
    },
    analysis: { type: "op" },
    checks: [
      {
        label: "R1's value parses as 1 kilohm",
        needsSim: false,
        test: (ctx) => {
          const r1 = ctx.part("R1");
          const raw = String(r1?.value ?? "");
          return {
            pass: !/\s/.test(raw) && near(parseValue(raw), 1000, 0.5),
            detail: `R1 reads "${raw}"`
          };
        }
      },
      {
        label: "R2 and R4 line up with each other",
        needsSim: false,
        test: (ctx) => {
          const r2 = ctx.part("R2"), r4 = ctx.part("R4");
          if (!r2 || !r4) return { pass: false, detail: "R2 or R4 is missing" };
          return {
            pass: r2.y === r4.y,
            detail: `R2 top at y=${r2.y}, R4 top at y=${r4.y}`
          };
        }
      },
      {
        label: "The junction settles at 4.8 V",
        test: (ctx) => {
          const v = ctx.v("R2", 0);
          return { pass: near(v, 4.8, 0.05), detail: `junction is ${formatEng(v, 4)} V` };
        }
      }
    ]
  },

  /* ------------------------------------------------------------------ 5A */
  {
    id: "elec101-5a",
    title: "Lab 5A — Set up an AC sweep",
    kind: "simulate",
    summary: "The two-stage amplifier is already drawn. Configure the frequency sweep and find its passband.",
    tasks: [
      "Set the analysis to an AC sweep, 10 Hz to 100 kHz, at 101 points per decade.",
      "Run it and switch the plot to magnitude in dB.",
      "Read the midband gain, then find the two frequencies where the response has fallen 3 dB below it.",
      "Check those corners against 1 / (2πRC) for each stage."
    ],
    circuit: {
      title: "Lab 5A — two-stage bandpass",
      analysis: { type: "op" },
      comps: [
        P("V", 120, 220, 90, { label: "VIN", value: "SIN(0 1 1k)", ac: "1" }),
        P("C", 180, 220, 0, { label: "C1", value: ".15u", ic: "" }),
        P("R", 280, 240, 90, { label: "R1", value: "15.9k" }),
        P("OPAMP", 360, 240, 0, { label: "U1", gain: "200k", vpos: "15", vneg: "-15" }),
        P("R", 300, 280, 90, { label: "RIN1", value: "10k" }),
        P("R", 300, 160, 0, { label: "RF1", value: "20k" }),
        P("R", 500, 240, 0, { label: "R2", value: "15.9k" }),
        P("C", 600, 260, 90, { label: "C2", value: ".56n", ic: "" }),
        P("OPAMP", 680, 260, 0, { label: "U2", gain: "200k", vpos: "15", vneg: "-15" }),
        P("R", 620, 300, 90, { label: "RIN2", value: "10k" }),
        P("R", 620, 180, 0, { label: "RF2", value: "20k" }),
        P("NET", 790, 260, 0, { label: "N1", netname: "OUT" }),
        P("GND", 120, 400, 0, { label: "GND" })
      ],
      wires: [
        W(120, 220, 180, 220), W(240, 220, 360, 220),
        W(280, 220, 280, 240),
        W(360, 260, 300, 260), W(300, 260, 300, 280),
        W(300, 260, 300, 160), W(360, 160, 470, 160),
        W(470, 160, 470, 240), W(440, 240, 470, 240),
        W(470, 240, 500, 240),
        W(560, 240, 600, 240), W(600, 240, 600, 260), W(600, 240, 680, 240),
        W(680, 280, 620, 280), W(620, 280, 620, 300),
        W(620, 280, 620, 180), W(680, 180, 790, 180),
        W(790, 180, 790, 260), W(760, 260, 790, 260),
        W(120, 280, 120, 400),
        W(280, 300, 280, 400), W(300, 340, 300, 400),
        W(600, 320, 600, 400), W(620, 360, 620, 400),
        W(120, 400, 620, 400)
      ],
      seq: { R: 2, C: 2, V: 1, U: 2, N: 1 },
      probes: [{ kind: "v", ref: "790,260", x: 790, y: 260 }]
    },
    checks: [
      {
        label: "The analysis is an AC sweep from 10 Hz to 100 kHz",
        needsSim: false,
        test: (ctx) => {
          const a = ctx.analysis;
          const ok = a.type === "ac" &&
            near(parseValue(a.acStart), 10, 0.1) &&
            near(parseValue(a.acStop), 100e3, 1) &&
            parseValue(a.acPts) >= 50;
          return {
            pass: ok,
            detail: a.type === "ac"
              ? `${a.acStart} Hz to ${a.acStop} at ${a.acPts} points/decade`
              : `analysis is currently ${a.type}`
          };
        }
      },
      {
        label: "Midband gain is about 19 dB",
        test: (ctx) => {
          const { peak } = cornerBelowPeak(ctx, "v(out)", 3, false);
          return { pass: near(peak, 19.08, 0.6), detail: `peak is ${peak.toFixed(2)} dB` };
        }
      },
      {
        label: "The lower −3 dB corner is near 67 Hz",
        test: (ctx) => {
          const { corner } = cornerBelowPeak(ctx, "v(out)", 3, false);
          return { pass: near(corner, 67, 20), detail: `lower corner at ${formatEng(corner, 3)} Hz` };
        }
      },
      {
        label: "The upper −3 dB corner is near 18 kHz",
        test: (ctx) => {
          const { corner } = cornerBelowPeak(ctx, "v(out)", 3, true);
          return { pass: near(corner, 17870, 4000), detail: `upper corner at ${formatEng(corner, 3)} Hz` };
        }
      }
    ]
  },

  /* ------------------------------------------------------------------ 5B */
  {
    id: "elec101-5b",
    title: "Lab 5B — Transient run with a current probe",
    kind: "simulate",
    summary: "Set up a transient analysis and measure the current through the load, not just the voltage across it.",
    tasks: [
      "Set the analysis to a transient run, 5 ms stop time.",
      "Drop an Ammeter into the wire above R1 so the load current can be measured, then probe it.",
      "Run it and compare the load current against the source voltage.",
      "Work out the diode's forward drop from the peak current and the 1 kΩ load."
    ],
    circuit: {
      title: "Lab 5B — half-wave rectifier",
      analysis: { type: "op" },
      comps: [
        P("V", 160, 180, 90, { label: "VS", value: "SIN(0 5 1k)", ac: "" }),
        P("NET", 200, 180, 0, { label: "N1", netname: "IN" }),
        P("D", 240, 180, 0, { label: "D1", model: "D1N750" }),
        P("NET", 360, 180, 0, { label: "N2", netname: "OUT" }),
        P("R", 420, 260, 90, { label: "R1", value: "1k" }),
        P("GND", 160, 400, 0, { label: "GND" })
      ],
      wires: [
        W(160, 180, 240, 180), W(300, 180, 420, 180),
        W(420, 180, 420, 260),
        W(420, 320, 420, 400), W(420, 400, 160, 400),
        W(160, 240, 160, 400)
      ],
      seq: { R: 1, D: 1, V: 1, N: 2 },
      probes: []
    },
    checks: [
      {
        label: "The analysis is a transient run to 5 ms",
        needsSim: false,
        test: (ctx) => {
          const a = ctx.analysis;
          return {
            pass: a.type === "tran" && near(parseValue(a.trStop), 5e-3, 1e-6),
            detail: a.type === "tran" ? `stop time is ${a.trStop}` : `analysis is currently ${a.type}`
          };
        }
      },
      {
        label: "An ammeter is in series with R1",
        needsSim: false,
        test: (ctx) => {
          const meters = ctx.parts("AM");
          if (!meters.length) return { pass: false, detail: "no ammeter on the sheet" };
          const top = ctx.node("R1", 0);
          const inSeries = meters.some((m) => {
            const a = ctx.node(m.label, 0), b = ctx.node(m.label, 1);
            return a === top || b === top;
          });
          return {
            pass: inSeries && ctx.pinCount("R1", 0) === 2,
            detail: inSeries
              ? `${meters.length} ammeter(s), sharing node ${top} with R1`
              : "the ammeter is not on the same node as the top of R1"
          };
        }
      },
      {
        label: "Peak load current is about 4.3 mA",
        test: (ctx) => {
          const meter = ctx.parts("AM")[0];
          if (!meter) return { pass: false, detail: "no ammeter to read" };
          const t = ctx.trace(`i(v${meter.label.toLowerCase()})`);
          if (!t) return { pass: false, detail: "the ammeter was not probed" };
          const peak = Math.max(...t.values.map(Math.abs));
          return { pass: near(peak, 4.3e-3, 0.5e-3), detail: `peak current is ${formatEng(peak, 3)} A` };
        }
      }
    ]
  },

  /* ------------------------------------------------------------------ 5C */
  {
    id: "elec101-5c",
    title: "Lab 5C — Bias point and net labels",
    kind: "simulate",
    summary: "Name the nodes that matter, then read the operating point off the schematic.",
    tasks: [
      "Place a net label reading IN on the wire between VS and R1.",
      "Place a second reading OUT on the wire between R2 and R4.",
      "Set the analysis to an operating point and run it.",
      "Turn on Node voltages to read the results straight off the schematic.",
      "Check the two divider stages by hand against what the solver reports."
    ],
    circuit: {
      title: "Lab 5C — bias point",
      analysis: { type: "op" },
      comps: [
        P("V", 160, 180, 90, { label: "VS", value: "DC 12", ac: "" }),
        P("R", 240, 180, 0, { label: "R1", value: "2k" }),
        P("R", 380, 220, 90, { label: "R3", value: "4k" }),
        P("R", 440, 180, 0, { label: "R2", value: "1k" }),
        P("R", 580, 220, 90, { label: "R4", value: "3k" }),
        P("GND", 380, 360, 0, { label: "GND" })
      ],
      wires: [
        W(160, 180, 240, 180), W(300, 180, 380, 180),
        W(380, 180, 380, 220), W(380, 180, 440, 180),
        W(500, 180, 580, 180), W(580, 180, 580, 220),
        W(380, 280, 380, 360), W(580, 280, 580, 360),
        W(580, 360, 160, 360), W(160, 240, 160, 360)
      ],
      seq: { R: 4, V: 1 },
      probes: []
    },
    analysis: { type: "op" },
    checks: [
      {
        label: "A net called IN names the source node",
        needsSim: false,
        test: (ctx) => {
          const node = ctx.node("R1", 0);
          return { pass: node === "IN", detail: `the top of R1 is on node ${node}` };
        }
      },
      {
        label: "A net called OUT names the node between R2 and R4",
        needsSim: false,
        test: (ctx) => {
          const node = ctx.node("R4", 0);
          return { pass: node === "OUT", detail: `the top of R4 is on node ${node}` };
        }
      },
      {
        label: "IN measures 12.00 V",
        test: (ctx) => {
          const v = ctx.v("R1", 0);
          return { pass: near(v, 12, 0.01), detail: `${formatEng(v, 4)} V` };
        }
      },
      {
        label: "The junction measures 6.000 V",
        test: (ctx) => {
          const v = ctx.v("R3", 0);
          return { pass: near(v, 6, 0.01), detail: `${formatEng(v, 4)} V` };
        }
      },
      {
        label: "OUT measures 4.500 V",
        test: (ctx) => {
          const v = ctx.v("R4", 0);
          return { pass: near(v, 4.5, 0.01), detail: `${formatEng(v, 4)} V` };
        }
      }
    ]
  }
];
