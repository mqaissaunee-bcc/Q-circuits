/**
 * Digital logic for an analog simulator.
 *
 * This ngspice build has no XSPICE, so there are no event-driven digital
 * devices: an `A` line is an unknown device, and a `POLY` source exits the
 * engine outright. Logic is therefore built from behavioural sources, the way
 * a TTL part looks from outside: 0 V is a 0, 5 V is a 1, and the threshold
 * sits at 2.5 V.
 *
 * Each gate is a smooth function of its inputs, `s(v) = ½(1 + tanh(4(v − 2.5)))`,
 * combined with ordinary algebra (AND is a product, OR is 1 − ∏(1 − s), and so
 * on). Smooth rather than stepped, because Newton iterations need a slope to
 * follow. The result drives the output pin through 1 kΩ into 10 pF, a 10 ns
 * propagation delay, which is what lets a latch built from two gates settle
 * one way or the other instead of fighting itself.
 *
 * Every input has a 1 MΩ pull-up to a 5 V rail, as a floating TTL input reads
 * high. That also keeps an unconnected input from being a node with no path
 * to ground, which SPICE cannot solve.
 */

export const LOGIC_HIGH = 5;
export const RAIL = "dig_rail";
export const RAIL_CARD = `V_DIG_RAIL ${RAIL} 0 DC ${LOGIC_HIGH}`;

const num = (x) => String(+Number(x).toPrecision(9));
const volt = (n) => (n === 0 || n === "0" ? "0" : `V(${n})`);
// Soft enough to converge, with stimulus edges fast against the 10 ns gate
// delay. Slow edges leave a master–slave flip-flop's two latches half open
// at once, and the data races straight through on the wrong clock edge.
export const tuning = { gain: 4, edge: 1e-8 };
const s = (n) => `(0.5+0.5*tanh(${tuning.gain}*(${volt(n)}-2.5)))`;

/** Logic functions over the smoothed inputs, as expressions from 0 to 1. */
const FN = {
  and: (ins) => ins.map(s).join("*"),
  nand: (ins) => `(1-${ins.map(s).join("*")})`,
  or: (ins) => `(1-${ins.map((n) => `(1-${s(n)})`).join("*")})`,
  nor: (ins) => ins.map((n) => `(1-${s(n)})`).join("*"),
  xor: ([a, b]) => `(${s(a)}+${s(b)}-2*${s(a)}*${s(b)})`,
  not: ([a]) => `(1-${s(a)})`,
  buf: ([a]) => s(a)
};

/**
 * No two real gates are equally fast. Identical delays let a cross-coupled
 * latch that is released from its forbidden state ring forever; a spread of a
 * few percent, fixed per gate name, lets it settle the way hardware does.
 */
function delayCap(name) {
  let h = 2166136261;
  for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `${(10 * (1 + (h % 1000) / 10000)).toFixed(3)}p`;
}

/**
 * Netlist lines for one gate. `name` must be unique in the netlist; `ins`
 * are input nodes, `out` the output node.
 */
export function gateLines(name, fn, ins, out, { pullups = true, rout = 1000 } = {}) {
  const lines = [
    `B${name} ${name}_o 0 V = ${LOGIC_HIGH}*${FN[fn](ins)}`,
    `R${name}_d ${name}_o ${out} ${rout}`,
    `C${name}_d ${out} 0 ${delayCap(name)}`
  ];
  if (pullups) {
    ins.forEach((n, i) => {
      if (n !== 0 && n !== "0") lines.push(`R${name}_pu${i} ${n} ${RAIL} 1meg`);
    });
  }
  return lines;
}

/** The smoothed logic level of a node, as an expression from 0 to 1. */
export const logicOf = (n) => s(n);

/**
 * A logic element with an arbitrary expression (0 to 1) over smoothed
 * inputs, for parts too wide to build gate by gate. `ins` get pull-ups.
 */
export function logicLines(name, expr, ins, out, { rout = 1000 } = {}) {
  const lines = [
    `B${name} ${name}_o 0 V = ${LOGIC_HIGH}*(${expr})`,
    `R${name}_d ${name}_o ${out} ${rout}`,
    `C${name}_d ${out} 0 ${delayCap(name)}`
  ];
  ins.forEach((n, i) => {
    if (n !== 0 && n !== "0") lines.push(`R${name}_pu${i} ${n} ${RAIL} 1meg`);
  });
  return lines;
}

/**
 * A 7473: negative-edge (pulse-triggered, master–slave) JK flip-flop with an
 * active-low clear, built from nine gates the way the chip is.
 *
 *   master:  m1 = NAND(J, CLK, Q̄, CLR̄)   m2 = NAND(K, CLK, Q)
 *            Y  = NAND(m1, Ȳ)             Ȳ  = NAND(m2, Y, CLR̄)
 *   slave:   s1 = NAND(Y, CLK̄)           s2 = NAND(Ȳ, CLK̄)
 *            Q  = NAND(s1, Q̄)             Q̄  = NAND(s2, Q, CLR̄)
 *
 * The master follows J and K while the clock is high; the slave copies it
 * when the clock falls, which is why the output changes on the falling edge.
 * Clear low forces Ȳ and Q̄ high, so Y and Q go low.
 *
 * `init` is PSpice's "initialize all flip-flops to": "0", "1" or "X". For 0
 * and 1 it adds .ic cards on both latches; X leaves the start to the solver.
 */
export function jkffLines(name, { j, clk, k, clr, q, qb }, init = "0") {
  const n = (x) => `${name}_${x}`;
  const lines = [
    ...gateLines(n("cn"), "not", [clk], n("clkn")),
    ...gateLines(n("m1"), "nand", [j, clk, qb, clr], n("a")),
    ...gateLines(n("m2"), "nand", [k, clk, q], n("b"), { pullups: false }),
    ...gateLines(n("ly"), "nand", [n("a"), n("yb")], n("y"), { pullups: false }),
    ...gateLines(n("lyb"), "nand", [n("b"), n("y"), clr], n("yb"), { pullups: false }),
    ...gateLines(n("s1"), "nand", [n("y"), n("clkn")], n("c"), { pullups: false }),
    ...gateLines(n("s2"), "nand", [n("yb"), n("clkn")], n("d"), { pullups: false }),
    ...gateLines(n("lq"), "nand", [n("c"), qb], q, { pullups: false }),
    ...gateLines(n("lqb"), "nand", [n("d"), q, clr], qb, { pullups: false })
  ];
  // K is the only input the master's second gate does not already pull up.
  if (k !== 0 && k !== "0") lines.push(`R${name}_puk ${k} ${RAIL} 1meg`);
  if (init === "0" || init === "1") {
    const hi = init === "1";
    const set = [[q, hi], [qb, !hi], [n("y"), hi], [n("yb"), !hi]]
      .filter(([node]) => node !== 0 && node !== "0")
      .map(([node, v]) => `V(${node})=${v ? LOGIC_HIGH : 0}`);
    if (set.length) lines.push(`.ic ${set.join(" ")}`);
  }
  return lines;
}

/**
 * A 555 timer, built the way the chip is: three 5 kΩ resistors dividing the
 * supply, two comparators against ⅔ and ⅓ of it, an SR latch, an output
 * stage and a discharge transistor.
 *
 * The comparators and the latch work at fixed 0/5 V levels internally, which
 * keeps them independent of the supply the student chooses; only the output
 * and discharge stages refer to VCC and GND. The latch is given a starting
 * state, since a cross-coupled pair with no history sits balanced in the
 * middle and never starts.
 *
 * `drop` is how far the output stays below VCC: about 1.7 V for a bipolar
 * NE555, a fraction of that for a CMOS 7555.
 */
export function timer555Lines(name, pins, drop = 1.7) {
  const { trig, thresh, ctrl, out, disch, reset, vcc, gnd } = pins;
  const at = (x) => (x === 0 || x === "0" ? "0" : `V(${x})`);
  const n = (x) => `${name}_${x}`;
  const q = n("q"), qb = n("qb");
  const high = `(0.5+0.5*tanh(4*(${at(q)}-2.5)))`;
  const comparator = (tag, expr) => [
    `B${n(tag)} ${n(tag)}_raw 0 V = 5*(${expr})`,
    `R${n(tag)}_d ${n(tag)}_raw ${n(tag)} 1k`,
    `C${n(tag)}_d ${n(tag)} 0 10p`
  ];
  return [
    `R${n("a")} ${vcc} ${ctrl} 5k`, `R${n("b")} ${ctrl} ${n("lo")} 5k`, `R${n("c")} ${n("lo")} ${gnd} 5k`,
    // An unconnected input would otherwise be a node SPICE cannot solve.
    `R${n("pt")} ${trig} ${gnd} 1G`, `R${n("ph")} ${thresh} ${gnd} 1G`, `R${n("pr")} ${reset} ${vcc} 1G`,
    ...comparator("s", `0.5+0.5*tanh(50*(${at(n("lo"))}-${at(trig)}))`),
    ...comparator("r", `0.5+0.5*tanh(50*(${at(thresh)}-${at(ctrl)}))`),
    ...comparator("rs", `0.5+0.5*tanh(20*(${at(reset)}-${at(gnd)}-0.8))`),
    ...gateLines(n("g1"), "not", [n("s")], n("sbar"), { pullups: false }),
    ...gateLines(n("g2"), "not", [n("rs")], n("rsact"), { pullups: false }),
    ...gateLines(n("g3"), "nor", [n("r"), n("rsact")], n("rbar"), { pullups: false }),
    ...gateLines(n("g4"), "nand", [n("sbar"), qb], q, { pullups: false }),
    ...gateLines(n("g5"), "nand", [n("rbar"), q], qb, { pullups: false }),
    `.ic V(${q})=0 V(${qb})=5`,
    `B${n("o")} ${n("oraw")} 0 V = ${at(gnd)} + ${high}*max(${at(vcc)}-${at(gnd)}-${drop},0)`,
    `R${n("o")} ${n("oraw")} ${out} 10`,
    `B${n("d")} ${disch} ${gnd} I = (${at(disch)}-${at(gnd)})*((1-${high})/12 + 1e-9)`
  ];
}

/**
 * A positive-edge D flip-flop (a 7474 cell), as a master–slave pair of D
 * latches: the master follows D while the clock is low, the slave copies it
 * when the clock rises. PRE̅ and CLR̅ are active low and act at once.
 */
export function dffLines(name, { d, clk, pre, clr, q, qb }, init = "0") {
  const n = (x) => `${name}_${x}`;
  // A part without a preset or clear pin passes null. A pin wired to ground
  // is a different thing: that asserts it, as a real 7474's would.
  const has = (pin) => pin !== null && pin !== undefined;
  const latch = (tag, dIn, en, outQ, outQb, withSet) => [
    ...gateLines(n(`${tag}s`), "nand", [dIn, en], n(`${tag}sn`), { pullups: false }),
    ...gateLines(n(`${tag}i`), "not", [dIn], n(`${tag}dn`), { pullups: false }),
    ...gateLines(n(`${tag}r`), "nand", [n(`${tag}dn`), en], n(`${tag}rn`), { pullups: false }),
    ...gateLines(n(`${tag}q`), "nand", withSet && has(pre) ? [n(`${tag}sn`), outQb, pre] : [n(`${tag}sn`), outQb], outQ, { pullups: false }),
    ...gateLines(n(`${tag}qb`), "nand", withSet && has(clr) ? [n(`${tag}rn`), outQ, clr] : [n(`${tag}rn`), outQ], outQb, { pullups: false })
  ];
  const lines = [
    ...gateLines(n("cn"), "not", [clk], n("clkn")),
    ...latch("m", d, n("clkn"), n("my"), n("myb"), false),
    ...latch("s", n("my"), clk, q, qb, true)
  ];
  [pre, clr].forEach((pin, i) => {
    if (has(pin) && pin !== 0 && pin !== "0") lines.push(`R${name}_pu${i} ${pin} ${RAIL} 1meg`);
  });
  if (init === "0" || init === "1") {
    const hi = init === "1";
    const set = [[q, hi], [qb, !hi], [n("my"), hi], [n("myb"), !hi]]
      .filter(([node]) => node !== 0 && node !== "0")
      .map(([node, v]) => `V(${node})=${v ? LOGIC_HIGH : 0}`);
    if (set.length) lines.push(`.ic ${set.join(" ")}`);
  }
  return lines;
}

/** Which digits light each segment of a seven-segment display. */
export const SEGMENT_DIGITS = {
  a: [0, 2, 3, 5, 6, 7, 8, 9], b: [0, 1, 2, 3, 4, 7, 8, 9], c: [0, 1, 3, 4, 5, 6, 7, 8, 9],
  d: [0, 2, 3, 5, 6, 8, 9], e: [0, 2, 6, 8], f: [0, 4, 5, 6, 8, 9], g: [2, 3, 4, 5, 6, 8, 9]
};

/**
 * 7447 BCD to seven-segment decoder. Outputs are active low, because the
 * part is built to sink current from a common-anode display.
 */
export function decoder7447Lines(name, bcd, outs, blankInput) {
  const digit = (k) => bcd.map((pin, b) => (((k >> b) & 1) ? s(pin) : `(1-${s(pin)})`)).join("*");
  return Object.keys(SEGMENT_DIGITS).flatMap((seg, i) => {
    const on = SEGMENT_DIGITS[seg].map(digit).join("+");
    // Blanking input low turns every segment off.
    const lit = blankInput ? `(${on})*${s(blankInput)}` : `(${on})`;
    // A decoder drives a display, so its outputs are stiffer than a gate's:
    // 1 kΩ in series would sag to a few volts under an LED's current.
    return logicLines(`${name}_${seg}`, `1-${lit}`, i ? [] : [...bcd, ...(blankInput ? [blankInput] : [])], outs[i], { rout: 20 });
  });
}

/* ------------------------------------------------------------- sources */

/** Edge time for stimulus transitions: fast, but not so fast it stalls ngspice. */
function edgeFor(times) {
  let gap = Infinity;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
  return isFinite(gap) && gap > 0 ? Math.min(tuning.edge, gap / 100) : tuning.edge;
}

/**
 * Parse STIM1 commands: "0s 0; 1m 1; 2m 0". Separators may be semicolons,
 * commas or new lines; the s unit on a time is optional. Returns
 * { points: [[t, v]], error }.
 */
export function parseStimulus(text, parseValue) {
  const items = String(text || "").split(/[;,\n]+/).map((x) => x.trim()).filter(Boolean);
  const points = [];
  for (const item of items) {
    const m = item.match(/^(\S+?)s?\s+([01])$/i);
    if (!m) return { points, error: `"${item}" should be a time and a 0 or 1, like 2m 1` };
    const t = parseValue(m[1]);
    if (!isFinite(t) || t < 0) return { points, error: `"${m[1]}" is not a time` };
    if (points.length && t <= points[points.length - 1][0]) {
      return { points, error: `the times must increase; ${m[1]} comes after ${points[points.length - 1][2]}` };
    }
    points.push([t, Number(m[2]), m[1]]);
  }
  if (!points.length) return { points, error: "there are no commands" };
  return { points, error: null };
}

/** A PWL source for STIM1 commands. */
export function stimulusSource(name, node, points) {
  const edge = edgeFor(points.map((p) => p[0]));
  const pwl = [];
  let level = points[0][1];
  pwl.push(`0 ${level * LOGIC_HIGH}`);
  points.forEach(([t, v], i) => {
    if (i === 0 && t === 0) { level = v; pwl[0] = `0 ${v * LOGIC_HIGH}`; return; }
    if (v === level) return;
    pwl.push(`${num(t)} ${level * LOGIC_HIGH}`, `${num(t + edge)} ${v * LOGIC_HIGH}`);
    level = v;
  });
  return `${name} ${node} 0 PWL(${pwl.join(" ")})`;
}

/**
 * DigClock: STARTVAL until DELAY + OFFTIME, then OPPVAL for ONTIME, then
 * STARTVAL for OFFTIME, and so on.
 */
export function clockSource(name, node, { delay, ontime, offtime, startval, oppval }) {
  const edge = Math.min(tuning.edge, Math.min(ontime, offtime) / 100);
  const v1 = startval * LOGIC_HIGH, v2 = oppval * LOGIC_HIGH;
  const pw = Math.max(ontime - edge, edge);
  return `${name} ${node} 0 PULSE(${v1} ${v2} ${num(delay + offtime)} ${num(edge)} ${num(edge)} ${num(pw)} ${num(ontime + offtime)})`;
}

/** Read a logic level from a voltage, as the plot and the checks do. */
export const levelOf = (v) => (v > LOGIC_HIGH / 2 ? 1 : 0);
