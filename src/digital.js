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
export function gateLines(name, fn, ins, out, { pullups = true } = {}) {
  const lines = [
    `B${name} ${name}_o 0 V = ${LOGIC_HIGH}*${FN[fn](ins)}`,
    `R${name}_d ${name}_o ${out} 1k`,
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
export function logicLines(name, expr, ins, out) {
  const lines = [
    `B${name} ${name}_o 0 V = ${LOGIC_HIGH}*(${expr})`,
    `R${name}_d ${name}_o ${out} 1k`,
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
