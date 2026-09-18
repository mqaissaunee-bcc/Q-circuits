/**
 * Part library.
 *
 * Every part is described in local coordinates with the anchor at (0,0).
 * Pins sit on multiples of GRID so that rotating by 90 degrees keeps them on
 * the grid. `emit` turns a placed part plus its resolved node numbers into
 * netlist lines; `models` names any .model cards those lines depend on.
 */

import { gateLines, logicLines, logicOf, jkffLines, dffLines, decoder7447Lines, SEGMENT_DIGITS, timer555Lines, parseStimulus, stimulusSource, clockSource, RAIL, RAIL_CARD } from "./digital.js";

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
  if (isBusName(n)) return null;     // a bus label names a bus, not a net
  return n || null;
};

/** PSpice bus names look like D[0:15]. */
export const isBusName = (n) => /^[A-Za-z_]\w*\[\d+\s*:\s*\d+\]$/.test(String(n || "").trim());

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

/*
 * The PSpice LM324 macromodel the ELEC 101 Lab 12 handout lists, line for
 * line, with its two POLY sources rewritten as behavioural sources:
 *
 *   EGND 99 0 POLY(2) (3,0) (4,0) 0 .5 .5
 *   FB 7 99 POLY(5) VB VC VE VLP VLN 0 42.44E6 -40E6 40E6 40E6 -40E6
 *
 * POLY needs XSPICE, which this ngspice build lacks, and asking for it exits
 * the engine fatally. The rewritten lines are the same polynomials.
 * Pins: 1 in+, 2 in−, 3 V+, 4 V−, 5 out.
 */
MODEL_CARDS.LM324 = `.subckt LM324 1 2 3 4 5
C1 11 12 0.8000E-12
C2 6 7 0.800E-12
DC 5 53 DX
DE 54 5 DX
DLP 90 91 DX
DLN 92 90 DX
DP 4 3 DX
BEGND 99 0 V = 0.5*V(3) + 0.5*V(4)
BFB 7 99 I = 42.44E6*I(VB) - 40E6*I(VC) + 40E6*I(VE) + 40E6*I(VLP) - 40E6*I(VLN)
GA 6 0 11 12 188.5E-6
GCM 0 6 10 99 3.352E-9
IEE 10 4 DC 15.14E-6
HLIM 90 0 VLIM 1K
Q1 11 2 13 QX
Q2 12 1 14 QX
R2 6 9 100.0E3
RC1 3 11 5.305E3
RC2 3 12 5.305E3
RE1 13 10 1.839E3
RE2 14 10 1.839E3
REE 10 99 13.21E6
RO1 8 5 50
RO2 7 99 25
RP 3 4 16.81E3
VB 9 0 DC 0
VC 3 53 DC 2.600
VE 54 4 DC 2.600
VLIM 7 8 DC 0
VLP 91 0 DC 25
VLN 0 92 DC 25
.MODEL DX D(IS=800.0E-18)
.MODEL QX NPN(IS=800.0E-18 BF=250)
.ends`;

/*
 * J2N3819 from the PSpice library, trimmed: its Betatce, Vtotc, Isr, N, Nr,
 * Xti, Alpha, Vk and M parameters make this ngspice build exit fatally. The
 * DC behaviour (Beta, Vto, Lambda, Is, Rd, Rs) and capacitances are kept.
 */
MODEL_CARDS.J2N3819 = ".model J2N3819 NJF(Beta=1.304m Rd=1 Rs=1 Lambda=2.25m Vto=-3 Is=33.57f Cgd=1.6p Pb=1 Fc=.5 Cgs=2.414p Kf=9.882E-18 Af=1)";
// 1N4001 rectifier, trimmed like the other library cards.
MODEL_CARDS.D1N4001 = ".model D1N4001 D(Is=14.11n N=1.984 Rs=33.89m Xti=3 Eg=1.11 Cjo=25.89p M=.44 Vj=.3245 Fc=.5 Bv=400 Ibv=10u)";
MODEL_CARDS.D1N5817 = ".model D1N5817 D(Is=2.5e-5 N=1.05 Rs=0.02 Cjo=200p M=0.5 Vj=0.4 Bv=25 Ibv=1m)";
MODEL_CARDS.D1N4733 = ".model D1N4733 D(Is=1e-14 N=1 Rs=1 Cjo=100p M=.3 Vj=.75 Bv=5.1 Ibv=49m)";
MODEL_CARDS.JPFET = ".model JPFET PJF(Beta=1m Vto=-3 Lambda=2m Rd=1 Rs=1 Is=33f Cgs=2.4p Cgd=1.6p)";
MODEL_CARDS.D1N914 = ".model D1N914 D(Is=168.1E-21 N=1 Rs=.1 Ikf=0 Xti=3 Eg=1.11 Cjo=4p M=.3333 Vj=.75 Fc=.5 Isr=100p Nr=2 Bv=100 Ibv=100u Tt=11.54n)";

// The rail every digital input is pulled up to, and $D_HI connects to.
MODEL_CARDS.DIGRAIL = RAIL_CARD;

const DIODE_MODELS = ["Dgen", "D1N4148", "D1N914", "D1N750", "DLED", "DZ5V1"];
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
  // Gates: inputs at x=0, output at x=80, body between.
  AND: ["M0 -20H15", "M0 20H15", "M15 -30H35A30 30 0 0 1 35 30H15Z", "M65 0H80"],
  NAND: ["M0 -20H15", "M0 20H15", "M15 -30H35A30 30 0 0 1 35 30H15Z",
         "M65 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M73 0H80"],
  OR: ["M0 -20H22", "M0 20H22", "M12 -30Q27 0 12 30Q45 30 70 0Q45 -30 12 -30Z", "M70 0H80"],
  NOR: ["M0 -20H22", "M0 20H22", "M12 -30Q27 0 12 30Q42 30 64 0Q42 -30 12 -30Z",
        "M64 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M72 0H80"],
  XOR: ["M0 -20H22", "M0 20H22", "M16 -30Q31 0 16 30Q47 30 70 0Q47 -30 16 -30Z",
        "M8 -30Q23 0 8 30", "M70 0H80"],
  NOT: ["M0 0H15", "M15 -18L15 18L58 0Z", "M58 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M66 0H80"],
  JKFF: ["M20 -60H60V60H20Z", "M0 -40H20", "M0 0H12", "M12 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
         "M20 -6L28 0L20 6", "M0 40H20", "M60 -40H80", "M60 40H64", "M64 40a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
         "M72 40H80", "M40 60V64", "M36 68a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M40 72V80"],
  NJF: ["M0 0H24", "M24 -18V18", "M24 -12H40V-40", "M24 12H40V40", "M16 -4L24 0L16 4Z"],
  MUX: ["M20 -110H80V150H20Z", "M0 -100H12", "M12 -100a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
        "M0 -80H20", "M0 -60H20", "M0 -40H20", "M0 -20H20", "M0 0H20", "M0 20H20", "M0 40H20", "M0 60H20",
        "M0 100H20", "M0 120H20", "M0 140H20",
        "M80 -60H100", "M80 -20H84", "M84 -20a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M92 -20H100"],
  DEC: ["M20 -170H80V170H20Z", "M0 -100H20", "M0 -80H20", "M0 -60H20", "M0 -40H20",
        "M0 40H12", "M12 40a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M0 60H12", "M12 60a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
        ...Array.from({ length: 16 }, (_, k) => `M80 ${150 - 20 * k}h4a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M92 ${150 - 20 * k}H100`)],
  BUSENTRY: ["M0 0L-20 20"],
  DFF: ["M20 -60H80V60H20Z", "M0 -40H20", "M0 0H12", "M12 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M20 -6L28 0L20 6",
        "M0 40H20", "M80 -40H100", "M80 40H100", "M50 -60V-72", "M46 -76a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M50 -80V-88",
        "M50 60V72", "M46 76a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M50 80V88"],
  SIPO: ["M20 -100H100V100H20Z", "M0 -80H20", "M0 -60H20", "M0 -20H12", "M12 -20a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
         "M20 -26L28 -20L20 -14", "M0 20H12", "M12 20a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
         ...Array.from({ length: 8 }, (_, k) => `M100 ${-70 + 20 * k}H120`)],
  DEC7447: ["M20 -80H100V80H20Z", "M0 -60H20", "M0 -40H20", "M0 -20H20", "M0 0H20", "M0 60H12",
            "M12 60a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
            ...Array.from({ length: 7 }, (_, k) => `M100 ${-60 + 20 * k}h4a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M112 ${-60 + 20 * k}H120`)],
  // Seven segments drawn as their own paths, so each can be lit on its own.
  // Segment order a, b, c, d, e, f, g, each its own path so it can be lit.
  SEG7: ["M20 -80H100V90H20Z",
         "M38 -62H74", "M78 -58V-6", "M78 6V58", "M38 62H74", "M34 6V58", "M34 -58V-6", "M38 0H74",
         ...Array.from({ length: 7 }, (_, k) => `M0 ${-60 + 20 * k}H20`), "M60 90V110"],
  ZENER: ["M0 0H22", "M22 -10V10", "M22 -10L38 0L22 10Z", "M38 -10H32M38 -10V10M38 10H44", "M38 0H60"],
  SCHOTTKY: ["M0 0H22", "M22 -10V10", "M22 -10L38 0L22 10Z",
             "M30 -10H38V10H46M30 -10V-4", "M46 10V4", "M38 0H60"],
  BRIDGE: ["M40 -40L80 0L40 40L0 0Z", "M40 -40V-60", "M40 40V60", "M0 0H-20", "M80 0H100",
           "M24 -20L36 -14M30 -23V-11", "M56 -20L44 -14M50 -23V-11",
           "M24 20L36 14M30 23V11", "M56 20L44 14M50 23V11"],
  PJF: ["M0 0H24", "M24 -18V18", "M24 -12H40V-40", "M24 12H40V40", "M32 -4L24 0L32 4Z"],
  REG: ["M10 -30H90V30H10Z", "M0 -10H10", "M90 -10H100", "M50 30V50"],
  CMP: ["M0 -20H20", "M0 20H20", "M20 -30L20 30L64 0Z", "M64 0H80",
        "M25 -20H31", "M25 20H31", "M28 17V23"],
  BATT: ["M0 0H22", "M22 -14V14", "M30 -7V7", "M38 -14V14", "M46 -7V7", "M46 0H60"],
  GND_EARTH: ["M0 0V10", "M-12 10H12", "M-8 16H8", "M-4 22H4"],
  GND_CHASSIS: ["M0 0V10", "M-12 10H12", "M-10 10L-16 22", "M0 10L-6 22", "M10 10L4 22"],
  TP: ["M0 0V-12", "M-6 -18a6 6 0 1 0 12 0a6 6 0 1 0 -12 0", "M-4 -22L4 -14M-4 -14L4 -22"],
  POT: ["M0 0H16", "M16 -10H64V10H16Z", "M64 0H80", "M40 -40V-18", "M34 -24L40 -16L46 -24Z"],
  ACSRC: ["M0 0H19", "M41 0H60", "M19 0a11 11 0 1 0 22 0a11 11 0 1 0 -22 0",
          "M24 2q4 -8 6 0t6 0", "M16 -12H22", "M19 -15V-9"],
  LED: ["M0 0H22", "M22 -10V10", "M22 -10L38 0L22 10Z", "M38 -10V10", "M38 0H60",
        "M30 -14L38 -24", "M34 -22L38 -24L37 -20", "M38 -14L46 -24", "M42 -22L46 -24L45 -20"],
  TIMER555: ["M20 -60H100V60H20Z", "M0 -40H20", "M0 0H20", "M0 40H20",
             "M100 -40H120", "M100 20H120", "M40 -80V-60", "M80 -80V-60", "M60 60V80"],
  // Dependent sources: control terminals on the left, the source in the
  // branch on the right. The mark inside says whether it makes volts or amps.
  DEP_V: ["M0 -20H18", "M0 20H18",
          "M18 -20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", "M18 20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
          "M80 -40V-20", "M80 20V40", "M80 -20L96 0L80 20L64 0Z",
          "M74 -8H86", "M80 -14V-2", "M74 8H86"],
  DEP_I: ["M0 -20H18", "M0 20H18",
          "M18 -20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", "M18 20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
          "M80 -40V-20", "M80 20V40", "M80 -20L96 0L80 20L64 0Z",
          "M80 9V-9", "M76 -3L80 -9L84 -3Z"],
  PORT: ["M0 0L12 -10H90V10H12Z"],
  // Digital sources: PSpice's arrow-shaped box, pin at the tip.
  DSRC: ["M-80 -10H-14L0 0L-14 10H-80Z"],
  DHI: ["M-40 -9H-12L0 0L-12 9H-40Z"],
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
const FILLED = { NPN: [4], PNP: [4], D: [2], I: [3], NMOS: [9], PMOS: [9], AM: [5], XFORM: [8, 9], NJF: [4], DEP_I: [8], LED: [3], POT: [4],
  ZENER: [2], SCHOTTKY: [2], PJF: [4], BATT: [] };

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

/** SPICE letter, control quantity and output quantity for each dependent source. */
const DEP_KINDS = {
  VCVS: { letter: "E", in: "v", out: "v", unit: " V/V" },
  VCCS: { letter: "G", in: "v", out: "i", unit: " S" },
  CCVS: { letter: "H", in: "i", out: "v", unit: " Ω" },
  CCCS: { letter: "F", in: "i", out: "i", unit: " A/A" }
};

/** E1 keeps its name; a source called AMP becomes E_AMP, as with V sources. */
function depName(c) {
  const letter = (DEP_KINDS[c.kind] || DEP_KINDS.VCVS).letter;
  return new RegExp(`^${letter}`, "i").test(String(c.label)) ? c.label : `${letter}_${c.label}`;
}

/** The logic function and symbol for each 7400-series part number. */
const GATE_FN = {
  7400: { fn: "nand", shape: "NAND" }, 7402: { fn: "nor", shape: "NOR" },
  7408: { fn: "and", shape: "AND" }, 7432: { fn: "or", shape: "OR" },
  7486: { fn: "xor", shape: "XOR" },
  7410: { fn: "nand", shape: "NAND" }, 7411: { fn: "and", shape: "AND" },
  7427: { fn: "nor", shape: "NOR" }
};

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
      { x: 30, y: 72, text: `L1 ${c.l1}`, cls: "part-value", field: "l1", anchor: "middle" },
      { x: 30, y: 85, text: `L2 ${c.l2}`, cls: "part-value", field: "l2", anchor: "middle" },
      { x: 30, y: 98, text: `k ${c.k}`, cls: "part-value", field: "k", anchor: "middle" }
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
    shapeFor: (c) => (c.style === "earth" ? S.GND_EARTH : c.style === "chassis" ? S.GND_CHASSIS : S.GND),
    pins: [[0, 0]], pinNames: ["0"],
    box: [-13, -6, 13, 24],
    fields: [{ k: "style", label: "Symbol", def: "signal", optional: true, options: ["signal", "earth", "chassis"],
               labels: { signal: "Signal ground", earth: "Earth", chassis: "Chassis" },
               hint: "All three are node 0: the symbol says what kind of ground it stands for" }], emit: () => [], models: () => [], noLabel: true
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
      { k: "model", label: "Model", def: "LM324", options: ["LM324", "Behavioral"],
        labels: { LM324: "LM324 (PSpice macromodel)", Behavioral: "Behavioral (simple)" },
        hint: "The macromodel is the one in the Lab 12 handout. Gain, bandwidth and headroom below apply to Behavioral only" },
      { k: "gain", label: "Open-loop gain", def: "100k",
        hint: "An LM324 is about 100 dB, which is 100k" },
      { k: "gbw", label: "Gain-bandwidth (Hz)", def: "1meg",
        hint: "Sets where the open-loop gain starts to fall. The LM324 is about 1 MHz" },
      { k: "headroom", label: "Output headroom (V)", def: "1.5",
        hint: "How far short of each supply pin the output stops" }
    ],
    emit: (c, n) => {
      if (c.model === "LM324") return [`X${c.label} ${n[1]} ${n[0]} ${n[3]} ${n[4]} ${n[2]} LM324`];
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
    summary: (c) => (c.model === "LM324" ? "LM324" : "LM324 (simple)"),
    netlistName: (c) => (c.model === "LM324" ? `X${c.label}` : `B${c.label}`),
    models: (c) => (c.model === "LM324" ? ["LM324"] : [])
  },


  /* ------------------------------------------------------------ digital */

  GATE2: {
    key: "GATE2", name: "2-input gate", prefix: "U", shape: S.OR,
    shapeFor: (c) => S[GATE_FN[c.device]?.shape || "AND"],
    pins: [[0, -20], [0, 20], [80, 0]], pinNames: ["input A", "input B", "output"],
    box: [-4, -34, 84, 34],
    digital: true, optionalPins: [2],
    fields: [{ k: "device", label: "Device", def: "7400", options: ["7400", "7402", "7408", "7432", "7486"],
               labels: { 7400: "7400 NAND", 7402: "7402 NOR", 7408: "7408 AND", 7432: "7432 OR", 7486: "7486 XOR" },
               hint: "TTL levels: 0 V is a 0, 5 V is a 1" }],
    emit: (c, n) => gateLines(`G${c.label}`, GATE_FN[c.device].fn, [n[0], n[1]], n[2]),
    summary: (c) => c.device,
    netlistName: (c) => `BG${c.label}`,
    models: () => ["DIGRAIL"]
  },

  GATE3: {
    key: "GATE3", name: "3-input gate", prefix: "U", shape: S.AND,
    shapeFor: (c) => [...S[GATE_FN[c.device]?.shape || "AND"], "M0 0H" + (GATE_FN[c.device]?.shape === "AND" || GATE_FN[c.device]?.shape === "NAND" ? 15 : 20)],
    pins: [[0, -20], [0, 0], [0, 20], [80, 0]], pinNames: ["input A", "input B", "input C", "output"],
    box: [-4, -34, 84, 34],
    digital: true, optionalPins: [3],
    fields: [{ k: "device", label: "Device", def: "7410", options: ["7410", "7411", "7427"],
               labels: { 7410: "7410 NAND", 7411: "7411 AND", 7427: "7427 NOR" },
               hint: "TTL levels: 0 V is a 0, 5 V is a 1" }],
    emit: (c, n) => gateLines(`G${c.label}`, GATE_FN[c.device].fn, [n[0], n[1], n[2]], n[3]),
    summary: (c) => c.device,
    netlistName: (c) => `BG${c.label}`,
    models: () => ["DIGRAIL"]
  },

  INV: {
    key: "INV", name: "Inverter", prefix: "U", shape: S.NOT,
    pins: [[0, 0], [80, 0]], pinNames: ["input", "output"],
    box: [-4, -22, 84, 22],
    digital: true, optionalPins: [1],
    fields: [{ k: "device", label: "Device", def: "7404", options: ["7404"], labels: { 7404: "7404 NOT" }, hint: "" }],
    emit: (c, n) => gateLines(`G${c.label}`, "not", [n[0]], n[1]),
    summary: () => "7404",
    netlistName: (c) => `BG${c.label}`,
    models: () => ["DIGRAIL"]
  },

  /**
   * 7473 JK flip-flop: falling-edge output, active-low clear. Its power-up
   * state comes from the analysis panel, as PSpice's "Initialize all
   * flip-flops to" does.
   */
  JKFF: {
    key: "JKFF", name: "JK flip-flop", prefix: "U", shape: S.JKFF,
    pins: [[0, -40], [0, 0], [0, 40], [40, 80], [80, -40], [80, 40]],
    pinNames: ["J", "CLK", "K", "CLR", "Q", "Q̄"],
    box: [-4, -64, 84, 84],
    digital: true, optionalPins: [4, 5],
    fields: [{ k: "device", label: "Device", def: "7473", options: ["7473"], labels: { 7473: "7473 JK" },
               hint: "The output changes when CLK falls. CLR low forces Q to 0" }],
    texts: () => [
      { x: 26, y: -40, text: "J", cls: "pin-name", anchor: "start" },
      { x: 30, y: 0, text: "CLK", cls: "pin-name", anchor: "start" },
      { x: 26, y: 40, text: "K", cls: "pin-name", anchor: "start" },
      { x: 54, y: -40, text: "Q", cls: "pin-name", anchor: "end" },
      { x: 54, y: 40, text: "Q̄", cls: "pin-name", anchor: "end" },
      { x: 40, y: 50, text: "CLR", cls: "pin-name", anchor: "middle" }
    ],
    emit: (c, n, ctx) => jkffLines(`F${c.label}`,
      { j: n[0], clk: n[1], k: n[2], clr: n[3], q: n[4], qb: n[5] }, ctx?.analysis?.ffInit ?? "X"),
    summary: () => "7473",
    netlistName: (c) => `BF${c.label}_cn`,
    models: () => ["DIGRAIL"]
  },


  /** N-channel JFET. */
  NJF: {
    key: "NJF", name: "N-channel JFET", prefix: "J", shape: S.NJF,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["gate", "drain", "source"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "J2N3819", options: ["J2N3819"],
               hint: "The PSpice library J2N3819, with the parameters this ngspice build accepts" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  /**
   * 74151A 8-to-1 multiplexer: Z is the input S2 S1 S0 selects, while Ē is
   * low. Pins as the Lab 13 handout draws them.
   */
  MUX151: {
    key: "MUX151", name: "74151A multiplexer", prefix: "U", shape: S.MUX,
    pins: [[0, -100], ...Array.from({ length: 8 }, (_, k) => [0, -80 + 20 * k]), [0, 100], [0, 120], [0, 140], [100, -60], [100, -20]],
    pinNames: ["Ē", "I0", "I1", "I2", "I3", "I4", "I5", "I6", "I7", "S0", "S1", "S2", "Z", "Z̄"],
    box: [-4, -114, 104, 154],
    digital: true, optionalPins: [12, 13],
    fields: [{ k: "device", label: "Device", def: "74151A", options: ["74151A"], hint: "8-line to 1-line data selector" }],
    texts: () => [
      { x: 26, y: -100, text: "E̅", cls: "pin-name" },
      ...Array.from({ length: 8 }, (_, k) => ({ x: 26, y: -80 + 20 * k, text: `I${k}`, cls: "pin-name" })),
      { x: 26, y: 100, text: "S0", cls: "pin-name" }, { x: 26, y: 120, text: "S1", cls: "pin-name" },
      { x: 26, y: 140, text: "S2", cls: "pin-name" },
      { x: 74, y: -60, text: "Z", cls: "pin-name", anchor: "end" }, { x: 74, y: -20, text: "Z̄", cls: "pin-name", anchor: "end" }
    ],
    emit: (c, n) => {
      const s = logicOf;
      const sel = (k) => [9, 10, 11].map((pin, b) => ((k >> b) & 1 ? s(n[pin]) : `(1-${s(n[pin])})`)).join("*");
      const expr = `(1-${s(n[0])})*(${Array.from({ length: 8 }, (_, k) => `${s(n[1 + k])}*${sel(k)}`).join("+")})`;
      return [
        ...logicLines(`G${c.label}_z`, expr, n.slice(0, 12), n[12]),
        ...logicLines(`G${c.label}_zb`, `(1-${expr})`, [], n[13])
      ];
    },
    summary: () => "74151A",
    netlistName: (c) => `BG${c.label}_z`,
    models: () => ["DIGRAIL"]
  },

  /**
   * 74154 4-to-16 decoder: output Yk goes low when D C B A = k and both
   * Ḡ1 and Ḡ2 are low; every other output is high.
   */
  DEC154: {
    key: "DEC154", name: "74154 decoder", prefix: "U", shape: S.DEC,
    pins: [[0, -40], [0, -60], [0, -80], [0, -100], [0, 60], [0, 40],
      ...Array.from({ length: 16 }, (_, k) => [100, 150 - 20 * k])],
    pinNames: ["A", "B", "C", "D", "Ḡ1", "Ḡ2", ...Array.from({ length: 16 }, (_, k) => `Y${k}`)],
    box: [-4, -174, 104, 174],
    digital: true, optionalPins: Array.from({ length: 16 }, (_, k) => 6 + k),
    fields: [{ k: "device", label: "Device", def: "74154", options: ["74154"], hint: "4-line to 16-line decoder, active-low outputs" }],
    texts: () => [
      ...["A", "B", "C", "D"].map((t, i) => ({ x: 26, y: -40 - 20 * i, text: t, cls: "pin-name" })),
      { x: 26, y: 60, text: "G̅1", cls: "pin-name" }, { x: 26, y: 40, text: "G̅2", cls: "pin-name" },
      ...Array.from({ length: 16 }, (_, k) => ({ x: 74, y: 150 - 20 * k, text: `Y${k}`, cls: "pin-name", anchor: "end" }))
    ],
    emit: (c, n) => {
      const s = logicOf;
      const en = `(1-${s(n[4])})*(1-${s(n[5])})`;
      return Array.from({ length: 16 }, (_, k) => {
        const match = [0, 1, 2, 3].map((b) => ((k >> b) & 1 ? s(n[b]) : `(1-${s(n[b])})`)).join("*");
        return logicLines(`G${c.label}_y${k}`, `(1-${en}*${match})`, k ? [] : n.slice(0, 6), n[6 + k]);
      }).flat();
    },
    summary: () => "74154",
    netlistName: (c) => `BG${c.label}_y0`,
    models: () => ["DIGRAIL"]
  },

  /**
   * Bus entry: the short diagonal that ties a wire to a bus. Only the wire
   * end is a connection; the signal reaches the bus by its net name.
   */
  BUSENTRY: {
    key: "BUSENTRY", name: "Bus entry", prefix: "BE", shape: S.BUSENTRY,
    pins: [[0, 0]], pinNames: ["wire"],
    virtual: true, noLabel: true, countsAsPin: true,
    box: [-22, -2, 2, 22],
    fields: [],
    busEnd: [-20, 20],
    emit: () => [], models: () => []
  },

  /** PSpice's PORTLEFT-L and PORTRIGHT-R: a named connection drawn as an arrow. */
  PORT: {
    key: "PORT", name: "Port", prefix: "PORT", shape: S.PORT,
    pins: [[0, 0]], pinNames: ["net"],
    virtual: true, noLabel: true, countsAsPin: true,
    box: [-2, -12, 92, 12],
    fields: [{ k: "name", label: "Port name", def: "OUT",
               hint: "Connects by name, like a net alias. Rotate it 180° for a PORTRIGHT" }],
    netName: (c) => c.name,
    texts: (c) => [{ x: 50, y: 0, text: c.name || "?", cls: "net-name", anchor: "middle", field: "name" }],
    emit: () => [], models: () => []
  },


  /**
   * 555 timer. The pins are laid out as the data sheet draws them: trigger,
   * threshold and control on the left, output and discharge on the right,
   * supply and reset on top, ground below.
   */
  TIMER555: {
    key: "TIMER555", name: "555 timer", prefix: "U", shape: S.TIMER555,
    pins: [[0, -40], [0, 0], [0, 40], [120, -40], [120, 20], [80, -80], [40, -80], [60, 80]],
    pinNames: ["TRIG", "THRESH", "CTRL", "OUT", "DISCH", "RESET", "VCC", "GND"],
    box: [-4, -84, 124, 84],
    optionalPins: [3, 4],
    fields: [{ k: "variant", label: "Device", def: "NE555", options: ["NE555", "7555"],
               labels: { NE555: "NE555 (bipolar)", "7555": "7555 (CMOS)" },
               hint: "The bipolar output stops about 1.7 V short of the supply; the CMOS one gets much closer" }],
    texts: () => [
      { x: 26, y: -40, text: "TRIG", cls: "pin-name" },
      { x: 26, y: 0, text: "THR", cls: "pin-name" },
      { x: 26, y: 40, text: "CTRL", cls: "pin-name" },
      { x: 94, y: -40, text: "OUT", cls: "pin-name", anchor: "end" },
      { x: 94, y: 20, text: "DIS", cls: "pin-name", anchor: "end" },
      { x: 82, y: -52, text: "RST", cls: "pin-name", anchor: "middle" },
      { x: 38, y: -52, text: "V+", cls: "pin-name", anchor: "middle" },
      { x: 60, y: 50, text: "GND", cls: "pin-name", anchor: "middle" },
      { x: 60, y: -14, text: "555", cls: "part-label", anchor: "middle" }
    ],
    emit: (c, n) => timer555Lines(`T${c.label}`, {
      trig: n[0], thresh: n[1], ctrl: n[2], out: n[3], disch: n[4], reset: n[5], vcc: n[6], gnd: n[7]
    }, c.variant === "7555" ? 0.2 : 1.7),
    summary: (c) => c.variant || "NE555",
    netlistName: (c) => `BT${c.label}_o`,
    models: () => []
  },

  /**
   * Dependent sources: the four of them, as PSpice's E, G, H and F. The
   * control terminals are on the left, the source itself in the branch on
   * the right. A current-controlled source needs a current to watch, so a
   * 0 V sense source sits across its control terminals, which is what makes
   * those terminals a short.
   */
  DEP: {
    key: "DEP", name: "Dependent source", prefix: "E", shape: S.DEP_V,
    shapeFor: (c) => (DEP_KINDS[c.kind]?.out === "i" ? S.DEP_I : S.DEP_V),
    pins: [[0, -20], [0, 20], [80, -40], [80, 40]],
    pinNames: ["control +", "control −", "out +", "out −"],
    box: [-4, -44, 100, 44],
    fields: [
      { k: "kind", label: "Kind", def: "VCVS", options: ["VCVS", "VCCS", "CCVS", "CCCS"],
        labels: {
          VCVS: "VCVS — voltage controlled voltage source (E)",
          VCCS: "VCCS — voltage controlled current source (G)",
          CCVS: "CCVS — current controlled voltage source (H)",
          CCCS: "CCCS — current controlled current source (F)"
        },
        hint: "The first two letters say what controls it; the last two what it produces" },
      { k: "gain", label: "Gain", def: "2",
        hint: "V/V for a VCVS, A/V (siemens) for a VCCS, V/A (ohms) for a CCVS, A/A for a CCCS" }
    ],
    emit: (c, n) => {
      const kind = DEP_KINDS[c.kind] || DEP_KINDS.VCVS;
      const name = depName(c);
      if (kind.in === "v") return [`${name} ${n[2]} ${n[3]} ${n[0]} ${n[1]} ${c.gain}`];
      // A current-controlled source watches the current in a named source.
      return [
        `V${name}_s ${n[0]} ${n[1]} DC 0`,
        `${name} ${n[2]} ${n[3]} V${name}_s ${c.gain}`
      ];
    },
    summary: (c) => `${c.kind} ${c.gain}${DEP_KINDS[c.kind]?.unit || ""}`,
    netlistName: depName,
    models: () => []
  },


  /** 7474 D flip-flop: output follows D on the rising clock edge. */
  DFF: {
    key: "DFF", name: "D flip-flop", prefix: "U", shape: S.DFF,
    pins: [[0, -40], [0, 0], [0, 40], [50, -88], [50, 88], [100, -40], [100, 40]],
    pinNames: ["D", "CLK", "—", "PRE", "CLR", "Q", "Q̄"],
    box: [-4, -92, 104, 92],
    digital: true, optionalPins: [2, 5, 6],
    fields: [{ k: "device", label: "Device", def: "7474", options: ["7474"], labels: { 7474: "7474 D" },
               hint: "Q takes the value of D when CLK rises. PRE and CLR are active low" }],
    texts: () => [
      { x: 26, y: -40, text: "D", cls: "pin-name" }, { x: 30, y: 0, text: "CLK", cls: "pin-name" },
      { x: 74, y: -40, text: "Q", cls: "pin-name", anchor: "end" }, { x: 74, y: 40, text: "Q̄", cls: "pin-name", anchor: "end" },
      { x: 50, y: -50, text: "PRE", cls: "pin-name", anchor: "middle" },
      { x: 50, y: 50, text: "CLR", cls: "pin-name", anchor: "middle" }
    ],
    emit: (c, n, ctx) => dffLines(`F${c.label}`,
      { d: n[0], clk: n[1], pre: n[3], clr: n[4], q: n[5], qb: n[6] }, ctx?.analysis?.ffInit ?? "X"),
    summary: () => "7474",
    netlistName: (c) => `BF${c.label}_cn`,
    models: () => ["DIGRAIL"]
  },

  /**
   * 74164 shift register: eight D flip-flops in a chain. The two serial
   * inputs are ANDed, so tie B high to use A alone.
   */
  SIPO: {
    key: "SIPO", name: "74164 shift register", prefix: "U", shape: S.SIPO,
    pins: [[0, -80], [0, -60], [0, -20], [0, 20], ...Array.from({ length: 8 }, (_, k) => [120, -70 + 20 * k])],
    pinNames: ["A", "B", "CLK", "CLR", "QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"],
    box: [-4, -104, 124, 104],
    digital: true, optionalPins: Array.from({ length: 8 }, (_, k) => 4 + k),
    fields: [{ k: "device", label: "Device", def: "74164", options: ["74164"], labels: { 74164: "74164 SIPO" },
               hint: "Serial in, parallel out. Each rising clock edge shifts A·B into QA and every output along one" }],
    texts: () => [
      { x: 26, y: -80, text: "A", cls: "pin-name" }, { x: 26, y: -60, text: "B", cls: "pin-name" },
      { x: 30, y: -20, text: "CLK", cls: "pin-name" }, { x: 26, y: 20, text: "CLR", cls: "pin-name" },
      ...Array.from({ length: 8 }, (_, k) => ({ x: 94, y: -70 + 20 * k, text: `Q${"ABCDEFGH"[k]}`, cls: "pin-name", anchor: "end" }))
    ],
    emit: (c, n, ctx) => {
      const init = ctx?.analysis?.ffInit ?? "X";
      const name = `S${c.label}`;
      const serial = `${name}_in`;
      return [
        ...gateLines(`${name}_and`, "and", [n[0], n[1]], serial),
        ...Array.from({ length: 8 }, (_, k) => dffLines(`${name}_${k}`, {
          d: k === 0 ? serial : n[4 + k - 1], clk: n[2], pre: null, clr: n[3], q: n[4 + k], qb: `${name}_${k}_qb`
        }, init)).flat()
      ];
    },
    summary: () => "74164",
    netlistName: (c) => `BS${c.label}_and`,
    models: () => ["DIGRAIL"]
  },

  /** 7447 BCD to seven-segment decoder, with active-low outputs. */
  DEC7447: {
    key: "DEC7447", name: "7447 seven-segment decoder", prefix: "U", shape: S.DEC7447,
    pins: [[0, -60], [0, -40], [0, -20], [0, 0], [0, 60], ...Array.from({ length: 7 }, (_, k) => [120, -60 + 20 * k])],
    pinNames: ["A", "B", "C", "D", "BI", "a", "b", "c", "d", "e", "f", "g"],
    box: [-4, -84, 124, 84],
    digital: true, optionalPins: Array.from({ length: 7 }, (_, k) => 5 + k),
    fields: [{ k: "device", label: "Device", def: "7447", options: ["7447"], labels: { 7447: "7447 BCD→7-seg" },
               hint: "A is the least significant bit. Outputs are active low, for a common-anode display. BI̅ low blanks it" }],
    texts: () => [
      ...["A", "B", "C", "D"].map((t, i) => ({ x: 26, y: -60 + 20 * i, text: t, cls: "pin-name" })),
      { x: 26, y: 60, text: "BI", cls: "pin-name" },
      ...Object.keys(SEGMENT_DIGITS).map((seg, k) => ({ x: 94, y: -60 + 20 * k, text: seg, cls: "pin-name", anchor: "end" }))
    ],
    emit: (c, n) => decoder7447Lines(`G${c.label}`, [n[0], n[1], n[2], n[3]], n.slice(5, 12), n[4]),
    summary: () => "7447",
    netlistName: (c) => `BG${c.label}_a`,
    models: () => ["DIGRAIL"]
  },

  /**
   * Seven-segment display. Each segment is an LED between its pin and the
   * common pin, and each lights on the sheet once a run says current is
   * flowing through it.
   */
  SEG7: {
    key: "SEG7", name: "Seven-segment display", prefix: "DS", shape: S.SEG7,
    pins: [...Array.from({ length: 7 }, (_, k) => [0, -60 + 20 * k]), [60, 110]],
    pinNames: [...Object.keys(SEGMENT_DIGITS), "common"],
    box: [-4, -84, 104, 114],
    // Path indices of the segments in the symbol, in order a…g.
    segmentPaths: [1, 2, 3, 4, 5, 6, 7],
    texts: () => Object.keys(SEGMENT_DIGITS).map((seg, k) => ({ x: 26, y: -60 + 20 * k, text: seg, cls: "pin-name" })),
    fields: [
      { k: "common", label: "Common", def: "anode", options: ["anode", "cathode"],
        labels: { anode: "Common anode (segments driven low)", cathode: "Common cathode (segments driven high)" },
        hint: "A 7447 drives a common-anode display" },
      { k: "rseries", label: "Segment resistance", def: "330", hint: "The resistor in series with each segment, in ohms" }
    ],
    emit: (c, n) => {
      const common = n[7];
      return n.slice(0, 7).flatMap((seg, k) => {
        const anode = c.common === "cathode" ? seg : common;
        const cathode = c.common === "cathode" ? common : seg;
        return [
          `R${c.label}_${k} ${anode} ${c.label}_m${k} ${c.rseries}`,
          `D${c.label}_${k} ${c.label}_m${k} ${cathode} DLED`
        ];
      });
    },
    summary: (c) => (c.common === "cathode" ? "common cathode" : "common anode"),
    netlistName: (c) => `D${c.label}_0`,
    models: () => ["DLED"]
  },

  /** Potentiometer: one resistance split by a wiper. */
  POT: {
    key: "POT", name: "Potentiometer", prefix: "R", shape: S.POT,
    pins: [[0, 0], [40, -40], [80, 0]],
    pinNames: ["end 1", "wiper", "end 2"],
    box: [-4, -44, 84, 14],
    fields: [
      { k: "value", label: "Resistance", def: "10k", hint: "End to end" },
      { k: "wiper", label: "Wiper position", def: "0.5",
        hint: "0 puts the wiper at end 1, 1 at end 2. The two halves always add up to the full resistance" }
    ],
    emit: (c, n) => {
      const total = parseValue(c.value);
      const frac = Math.min(0.999, Math.max(0.001, parseValue(c.wiper)));
      const lower = isFinite(total) ? total * frac : NaN;
      const upper = isFinite(total) ? total * (1 - frac) : NaN;
      return [
        `R${c.label}_a ${n[0]} ${n[1]} ${isFinite(lower) ? lower.toPrecision(6) : c.value}`,
        `R${c.label}_b ${n[1]} ${n[2]} ${isFinite(upper) ? upper.toPrecision(6) : c.value}`
      ];
    },
    summary: (c) => `${c.value}  wiper ${c.wiper}`,
    netlistName: (c) => `R${c.label}_a`,
    models: () => []
  },

  /** PSpice's VAC and VSIN in one part: a sine source with an AC magnitude. */
  ACSRC: withSourceName({
    key: "ACSRC", name: "AC source", prefix: "V", shape: S.ACSRC,
    pins: [[0, 0], [60, 0]], pinNames: ["+", "-"],
    box: [-4, -16, 64, 16],
    fields: [
      { k: "ac", label: "AC magnitude", def: "1", hint: "What an AC sweep uses. PSpice's VAC" },
      { k: "dc", label: "DC offset", def: "0", hint: "The level the sine sits on" },
      { k: "ampl", label: "Amplitude", def: "", hint: "Peak volts for a transient run. Leave blank for AC sweeps only" },
      { k: "freq", label: "Frequency", def: "1k", hint: "Hertz, for a transient run" }
    ],
    emit: (c, n) => {
      const sine = String(c.ampl ?? "").trim()
        ? ` SIN(${c.dc || 0} ${c.ampl} ${c.freq || "1k"})` : "";
      return [`${sourceName(c)} ${n[0]} ${n[1]} DC ${c.dc || 0} AC ${c.ac || 0}${sine}`];
    },
    summary: (c) => `${c.ac || 0}Vac${String(c.ampl ?? "").trim() ? `  ${c.ampl}V ${c.freq}` : ""}`,
    models: () => []
  }),

  /** LED: a diode drawn as one, which lights on the sheet when it conducts. */
  LED: {
    key: "LED", name: "LED", prefix: "D", shape: S.LED,
    pins: [[0, 0], [60, 0]], pinNames: ["anode", "cathode"],
    box: [-4, -26, 64, 14],
    lights: true,
    fields: [{ k: "model", label: "Model", def: "DLED", options: ["DLED"], hint: "A red LED, forward drop about 1.8 V" }],
    emit: (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.model}`],
    summary: () => "LED",
    models: (c) => [c.model]
  },


  /** Zener diode: drawn with its bent bar, and a breakdown voltage to pick. */
  ZENER: {
    key: "ZENER", name: "Zener diode", prefix: "D", shape: S.ZENER,
    pins: [[0, 0], [60, 0]], pinNames: ["anode", "cathode"],
    box: [-4, -14, 64, 14],
    fields: [{ k: "model", label: "Model", def: "D1N750", options: ["D1N750", "D1N4733"],
               labels: { D1N750: "1N750 — 4.7 V", D1N4733: "1N4733 — 5.1 V" },
               hint: "Wire it in reverse: the cathode goes to the more positive side" }],
    emit: (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.model}`],
    summary: (c) => c.model.replace(/^D/, ""),
    models: (c) => [c.model]
  },

  /** Schottky diode: a low forward drop, drawn with the S-shaped bar. */
  SCHOTTKY: {
    key: "SCHOTTKY", name: "Schottky diode", prefix: "D", shape: S.SCHOTTKY,
    pins: [[0, 0], [60, 0]], pinNames: ["anode", "cathode"],
    box: [-4, -14, 64, 14],
    fields: [{ k: "model", label: "Model", def: "D1N5817", options: ["D1N5817"],
               hint: "About 0.35 V forward, against 0.7 V for a silicon diode" }],
    emit: (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.model}`],
    summary: () => "1N5817",
    models: (c) => [c.model]
  },

  /** Bridge rectifier: four diodes in the usual diamond. */
  BRIDGE: {
    key: "BRIDGE", name: "Bridge rectifier", prefix: "BR", shape: S.BRIDGE,
    pins: [[40, -60], [40, 60], [-20, 0], [100, 0]],
    pinNames: ["+ out", "− out", "AC 1", "AC 2"],
    box: [-24, -64, 104, 64],
    fields: [{ k: "model", label: "Diode model", def: "D1N4001", options: ["D1N4001", "D1N4148"],
               hint: "Four of these, wired so either AC polarity reaches the same output pins" }],
    texts: () => [
      { x: 40, y: -46, text: "+", cls: "pin-name", anchor: "middle" },
      { x: 40, y: 48, text: "−", cls: "pin-name", anchor: "middle" }
    ],
    emit: (c, n) => {
      const [plus, minus, ac1, ac2] = n;
      // SPICE reads the first letter as the device type, so these are named
      // D…: a diode called BR1_1 would be taken for a behavioural source.
      return [
        `D${c.label}_1 ${ac1} ${plus} ${c.model}`,
        `D${c.label}_2 ${ac2} ${plus} ${c.model}`,
        `D${c.label}_3 ${minus} ${ac1} ${c.model}`,
        `D${c.label}_4 ${minus} ${ac2} ${c.model}`
      ];
    },
    summary: (c) => c.model.replace(/^D/, ""),
    netlistName: (c) => `D${c.label}_1`,
    models: (c) => [c.model]
  },

  /** P-channel JFET. */
  PJF: {
    key: "PJF", name: "P-channel JFET", prefix: "J", shape: S.PJF,
    pins: [[0, 0], [40, -40], [40, 40]], pinNames: ["gate", "drain", "source"],
    box: [-4, -44, 46, 44],
    fields: [{ k: "model", label: "Model", def: "JPFET", options: ["JPFET"], hint: "A generic P-channel JFET" }],
    emit: (c, n) => [`${c.label} ${n[1]} ${n[0]} ${n[2]} ${c.model}`],
    models: (c) => [c.model]
  },

  /**
   * Three-terminal voltage regulator. Behavioural: the output follows the
   * set voltage until the input gets within the dropout of it, after which
   * it follows the input down. An LM317 sets its voltage 1.25 V above the
   * adjust pin, so the usual two-resistor divider works as it does in life.
   */
  REG: {
    key: "REG", name: "Voltage regulator", prefix: "U", shape: S.REG,
    pins: [[0, -10], [100, -10], [50, 50]], pinNames: ["in", "out", "gnd / adj"],
    box: [-4, -34, 104, 54],
    fields: [
      { k: "device", label: "Device", def: "7805", options: ["7805", "7812", "LM317"],
        labels: { 7805: "7805 — 5 V fixed", 7812: "7812 — 12 V fixed", LM317: "LM317 — adjustable" },
        hint: "A fixed regulator holds out above its ground pin; the LM317 holds 1.25 V above its adjust pin" },
      { k: "dropout", label: "Dropout (V)", def: "2", hint: "How far above the output the input has to stay" }
    ],
    texts: (c) => [{ x: 50, y: 0, text: c.device || "7805", cls: "part-label", anchor: "middle" }],
    emit: (c, n) => {
      const [vin, vout, ref] = n;
      const at = (node) => (node === 0 ? "0" : `V(${node})`);
      const set = c.device === "LM317" ? 1.25 : c.device === "7812" ? 12 : 5;
      const ideal = `${at(ref)}+${set}`;
      return [
        `B${c.label} ${c.label}_o 0 V = min(${ideal}, ${at(vin)}-${c.dropout})`,
        `R${c.label}_o ${c.label}_o ${vout} 0.1`,
        // The adjust pin draws a little current, as the real part does.
        `I${c.label}_adj ${ref} 0 50u`
      ];
    },
    summary: (c) => c.device || "7805",
    netlistName: (c) => `B${c.label}`,
    models: () => []
  },

  /**
   * Comparator with an open-collector output, like an LM339: it pulls the
   * output down when the inverting input is higher, and otherwise lets go,
   * so the circuit needs a pull-up resistor.
   */
  CMP: {
    key: "CMP", name: "Comparator", prefix: "U", shape: S.CMP,
    pins: [[0, -20], [0, 20], [80, 0], [40, -40], [40, 40]],
    pinNames: ["in−", "in+", "out", "V+", "V−"],
    box: [-4, -44, 84, 44],
    optionalPins: [2],
    fields: [{ k: "device", label: "Device", def: "LM339", options: ["LM339"],
               hint: "Open collector: the output only pulls low, so give it a pull-up resistor" }],
    texts: () => [
      { x: 58, y: -26, text: "LM339", cls: "part-value", anchor: "start" }
    ],
    emit: (c, n) => {
      const at = (node) => (node === 0 ? "0" : `V(${node})`);
      const [inm, inp, out, , vneg] = n;
      // Conducting when in− is the higher of the two, over a millivolt or so.
      const on = `(0.5+0.5*tanh(2000*(${at(inm)}-${at(inp)})))`;
      return [`B${c.label} ${out} ${vneg} I = (${at(out)}-${at(vneg)})*(${on}/60 + 1e-9)`];
    },
    summary: () => "LM339",
    netlistName: (c) => `B${c.label}`,
    models: () => []
  },

  /** Battery: a stack of cells rather than a circle, and a DC value. */
  BATT: withSourceName({
    key: "BATT", name: "Battery", prefix: "V", shape: S.BATT,
    pins: [[0, 0], [60, 0]], pinNames: ["+", "-"],
    box: [-4, -18, 64, 18],
    fields: [{ k: "value", label: "Voltage", def: "9", hint: "Volts. The long bar is the positive terminal" }],
    emit: (c, n) => [`${sourceName(c)} ${n[0]} ${n[1]} DC ${c.value}`],
    summary: (c) => `${c.value} V`,
    models: () => []
  }),

  /** Test point: a named place to probe, drawn as a ringed cross. */
  TP: {
    key: "TP", name: "Test point", prefix: "TP", shape: S.TP,
    pins: [[0, 0]], pinNames: ["net"],
    virtual: true, noLabel: true, countsAsPin: true, upright: true,
    boxFor: (c) => [-14, -46, Math.max(14, 9 * String(c.name || "?").length + 6), 4],
    fields: [{ k: "name", label: "Name", def: "TP1", hint: "Names the node, like a net alias, and marks it as somewhere to measure" }],
    netName: (c) => c.name,
    texts: (c) => [{ x: 10, y: -30, text: c.name || "?", cls: "net-name", field: "name" }],
    emit: () => [], models: () => []
  },

  /** STIM1: a digital input described by time/value commands. */
  STIM: withSourceName({
    key: "STIM", name: "Digital stimulus", prefix: "DSTM", shape: S.DSRC,
    pins: [[0, 0]], pinNames: ["out"],
    box: [-84, -14, 4, 14],
    digital: true,
    fields: [{ k: "commands", label: "Commands", def: "0s 0; 1m 1; 2m 0",
               hint: "PSpice's COMMAND1, COMMAND2 … in order: a time and a 0 or 1, separated by semicolons. 0s 0; 1m 1; 2m 0" }],
    texts: () => [{ x: -74, y: 0, text: "S1 ⎍", cls: "pin-name", anchor: "start" }],
    emit: (c, n) => {
      const { points, error } = parseStimulus(c.commands, parseValue);
      if (error) return [`* ${c.label}: ${error}`, `${sourceName(c)} ${n[0]} 0 DC 0`];
      return [stimulusSource(sourceName(c), n[0], points)];
    },
    summary: () => "",
    models: () => []
  }),

  /** DigClock: a periodic digital input. */
  DCLK: withSourceName({
    key: "DCLK", name: "Digital clock", prefix: "DSTM", shape: S.DSRC,
    pins: [[0, 0]], pinNames: ["out"],
    box: [-84, -14, 4, 14],
    digital: true,
    fields: [
      { k: "offtime", label: "OFFTIME", def: "0.5m", hint: "Time at STARTVAL each cycle" },
      { k: "ontime", label: "ONTIME", def: "0.5m", hint: "Time at OPPVAL each cycle. The period is ONTIME + OFFTIME" },
      { k: "delay", label: "DELAY", def: "0", hint: "Extra time at STARTVAL before the first cycle" },
      { k: "startval", label: "STARTVAL", def: "0", options: ["0", "1"], hint: "The level it starts at" },
      { k: "oppval", label: "OPPVAL", def: "1", options: ["0", "1"], hint: "The other level" }
    ],
    texts: () => [{ x: -74, y: 0, text: "CLK ⎍", cls: "pin-name", anchor: "start" }],
    emit: (c, n) => [clockSource(sourceName(c), n[0], {
      delay: parseValue(c.delay) || 0, ontime: parseValue(c.ontime), offtime: parseValue(c.offtime),
      startval: Number(c.startval), oppval: Number(c.oppval)
    })],
    summary: (c) => `${c.offtime}/${c.ontime}`,
    models: () => []
  }),

  /** $D_HI: ties a digital input to logic 1. */
  DHI: {
    key: "DHI", name: "Logic 1 ($D_HI)", prefix: "HI", shape: S.DHI,
    pins: [[0, 0]], pinNames: ["net"],
    virtual: true, noLabel: true, digital: true, countsAsPin: true,
    box: [-44, -12, 4, 12],
    fields: [],
    netName: () => RAIL,
    texts: () => [{ x: -34, y: 0, text: "HI", cls: "pin-name", anchor: "start" }],
    emit: () => [], models: () => ["DIGRAIL"]
  },

  /**
   * Net alias, as PSpice calls it. Every alias with the same name is the same
   * node, and that name becomes the node's name in the netlist, so a probe on
   * it reads v(out) rather than whatever number the connectivity pass chose.
   */
  NET: {
    key: "NET", name: "Net alias", prefix: "NET", shape: S.NET,
    pins: [[0, 0]], pinNames: ["net"],
    upright: true, virtual: true, noLabel: true, countsAsPin: true,
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
    virtual: true, noLabel: true, countsAsPin: true,
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

/** The palette's two tabs. Ground and net aliases belong to both. */
export const PALETTE_TABS = {
  analog: ["R", "POT", "C", "L", "V", "ACSRC", "VPULSE", "BATT", "I", "D", "ZENER", "SCHOTTKY", "LED", "BRIDGE",
    "SW", "AM", "XFORM", "DEP", "GND", "NET", "PWR", "PORT", "TP",
    "NPN", "PNP", "NJF", "PJF", "NMOS", "PMOS", "OPAMP", "OPAMP5", "CMP", "REG", "TIMER555", "PARAM"],
  digital: ["GATE2", "GATE3", "INV", "JKFF", "DFF", "SIPO", "MUX151", "DEC154", "DEC7447", "SEG7", "TIMER555", "STIM", "DCLK", "DHI", "BUSENTRY", "PORT", "NET", "GND"]
};

/** Order the palette is presented in. */
export const PALETTE = ["R", "C", "L", "V", "VPULSE", "I", "D", "SW", "AM", "XFORM", "DEP", "POT", "ACSRC", "BATT", "LED", "ZENER", "SCHOTTKY", "BRIDGE", "REG", "CMP", "GND", "NET", "PWR", "PORT", "TP", "NPN", "PNP", "NJF", "NMOS", "PMOS", "OPAMP", "OPAMP5", "TIMER555", "PARAM",
  "GATE2", "GATE3", "INV", "JKFF", "DFF", "SIPO", "MUX151", "DEC154", "DEC7447", "SEG7", "STIM", "DCLK", "DHI", "BUSENTRY"];


/**
 * Palette icons.
 *
 * Most parts draw their own symbol on the button, which keeps the picture
 * and the part in step for free. These are the exceptions: chips whose full
 * symbol is far taller than a toolbar row and would shrink to a sliver, and
 * label-like parts whose real symbol is mostly text. Drawn in a 56 × 44 box.
 */
export const PART_ICONS = {
  JKFF: { box: [0, 0, 56, 44], paths: ["M14 6H42V38H14Z", "M2 14H14", "M2 30H14", "M42 14H54", "M14 26L21 30L14 34"] },
  MUX151: { box: [0, 0, 56, 44], paths: ["M16 6L44 16V30L16 40Z", "M2 12H16", "M2 22H16", "M2 32H16", "M44 23H54"] },
  DEC154: { box: [0, 0, 56, 44], paths: ["M14 4H40V40H14Z", "M2 12H14", "M2 28H14", "M40 10H54", "M40 18H54", "M40 26H54", "M40 34H54"] },
  XFORM: {
    box: [0, 0, 56, 44],
    paths: ["M4 10H18", "M4 34H18", "M38 10H52", "M38 34H52",
      "M18 10a5 5 0 0 1 0 8a5 5 0 0 1 0 8a5 5 0 0 1 0 8", "M38 10a5 5 0 0 0 0 8a5 5 0 0 0 0 8a5 5 0 0 0 0 8",
      "M25 8V36", "M31 8V36"]
  },
  STIM: { box: [0, 0, 56, 44], paths: ["M4 10H38L48 22L38 34H4Z", "M10 29V19H20V29H30V19H34"] },
  DCLK: { box: [0, 0, 56, 44], paths: ["M4 10H38L48 22L38 34H4Z", "M9 29V19H15V29H21V19H27V29H33V19H36"] },
  DHI: { box: [0, 0, 56, 44], paths: ["M4 10H38L48 22L38 34H4Z", "M16 16V28", "M26 16V28M22 19L26 16"] },
  NET: { box: [0, 0, 56, 44], paths: ["M2 34H54", "M18 34V16", "M18 16H46V27H18"] },
  DFF: { box: [0, 0, 56, 44], paths: ["M14 6H42V38H14Z", "M2 14H14", "M2 30H14", "M42 14H54", "M14 26L21 30L14 34"] },
  SIPO: { box: [0, 0, 56, 44], paths: ["M12 4H38V40H12Z", "M2 12H12", "M2 30H12", "M38 10H52", "M38 18H52", "M38 26H52", "M38 34H52"] },
  DEC7447: { box: [0, 0, 56, 44], paths: ["M12 6H38V38H12Z", "M2 14H12", "M2 30H12", "M38 12H52", "M38 22H52", "M38 32H52"] },
  SEG7: { box: [0, 0, 56, 44], paths: ["M14 4H44V40H14Z", "M22 10H36", "M38 13V20", "M38 24V31", "M22 34H36", "M20 24V31", "M20 13V20", "M22 22H36"] },
  TIMER555: { box: [0, 0, 56, 44], paths: ["M12 8H44V36H12Z", "M2 14H12", "M2 30H12", "M44 22H54", "M28 4V8", "M28 36V40"] },
  PARAM: {
    box: [0, 0, 56, 44],
    paths: ["M24 10c-8 0-4 10-12 12c8 2 4 12 12 12", "M32 10c8 0 4 10 12 12c-8 2-4 12-12 12", "M10 22h4"]
  }
};

/** Parts that make a circuit digital, for the plot's logic lanes. */
export const isDigital = (c) => !!PARTS[c.type]?.digital;

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

/**
 * Mirror a local point, as PSpice's Mirror Horizontally (mx, left–right) and
 * Mirror Vertically (my, top–bottom) do. Mirroring happens before rotation.
 */
export function mirrorPoint(px, py, comp) {
  return [comp.mx ? -px : px, comp.my ? -py : py];
}

/** Local point to world offset: mirror, then rotate. */
export function placePoint(px, py, comp, rot = comp.rot || 0) {
  const [mx, my] = mirrorPoint(px, py, comp);
  return rotatePoint(mx, my, rot);
}

/** World-space pin coordinates for a placed part. */
export function pinsOf(comp) {
  const def = PARTS[comp.type];
  return def.pins.map(([px, py]) => {
    const [rx, ry] = placePoint(px, py, comp);
    return { x: comp.x + rx, y: comp.y + ry };
  });
}

/** World-space bounding box, padded for comfortable hit testing. */
export function boxOf(comp, pad = 2) {
  const def = PARTS[comp.type];
  const [x0, y0, x1, y1] = def.boxFor ? def.boxFor(comp) : def.box;
  const rot = def.upright ? 0 : comp.rot || 0;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    .map(([px, py]) => (def.upright ? [px, py] : placePoint(px, py, comp, rot)));
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
