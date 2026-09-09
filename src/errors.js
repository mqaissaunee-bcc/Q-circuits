/**
 * Turning ngspice's diagnostics into something a first-year student can act on.
 *
 * ngspice talks to circuit engineers. "Error on line 2 or its substitute" and
 * "singular matrix" are precise and completely opaque to someone three weeks
 * into a course. Each pattern below pairs the raw text with what actually went
 * wrong and what to do about it. The original message is always kept and shown
 * on request, because it matters to anyone who does read SPICE.
 */

const PATTERNS = [
  {
    match: /singular matrix|matrix is singular/i,
    title: "Part of the circuit has no path back to ground.",
    fix: "Every node needs a route to ground through components. Look for a section joined to the rest by only one wire, a capacitor with nothing on the far side, or a missing ground symbol."
  },
  {
    match: /check nodes?.*(floating|no dc path)|no dc path to ground/i,
    title: "A node is floating with no DC path to ground.",
    fix: "A node connected only through capacitors has no DC path. Add a resistor to ground, or place a ground symbol on that part of the circuit."
  },
  {
    // ngspice reports a bad value on a passive part as a missing model, because
    // an unrecognised third token is read as a model name. The message has to
    // cover that, or a student with a typo in a resistance is sent hunting for
    // a model they never touched.
    match: /can'?t find model|unknown model|no such model/i,
    title: "A part refers to something ngspice does not recognise.",
    fix: "Either a Model field names a device that is not in the list, or a value is not a number — ngspice reads an unrecognised value as a model name. Check the value on the part named in the line below: use plain numbers with SPICE suffixes such as 4.7k or 100n, with no units attached."
  },
  {
    match: /unknown parameter|syntax error|bad syntax|not a number/i,
    title: "A value could not be read.",
    fix: "One of your part values is not a number ngspice understands. Use plain numbers with SPICE suffixes: 4.7k, 100n, 2meg. Avoid units and spaces — write 4.7k, not 4.7 kΩ."
  },
  {
    match: /circuit not parsed/i,
    title: "The netlist could not be read at all.",
    fix: "Something in the circuit produced a line ngspice cannot parse. The netlist panel shows exactly what was sent; the error above usually names the line."
  },
  {
    match: /iteration limit reached|too many iterations|no convergence|convergence (problem|failure)/i,
    title: "The solver could not settle on an answer.",
    fix: "This usually means a component is being driven far outside its normal range, or a feedback loop has nothing to damp it. Try smaller source amplitudes, add a small series resistance, or give a transient run a smaller time step."
  },
  {
    match: /time ?step too small|timestep too small/i,
    title: "The transient run stalled: the solver kept shrinking the time step.",
    fix: "Something in the circuit is switching faster than the analysis can follow — often a diode or transistor with no series resistance. Add a small resistor in that branch, or lengthen the source's rise and fall times."
  },
  {
    match: /less than two connections|fewer than two connections/i,
    title: "A node has only one thing connected to it.",
    fix: "A dangling wire or an unconnected pin. The parts table below lists every pin and its node — look for a node number that appears only once."
  },
  {
    match: /source .* not (found|in circuit)|unknown source/i,
    title: "The analysis names a source that is not on the sheet.",
    fix: "Check the DC sweep settings. The source name has to match a part on the sheet exactly, such as V1."
  },
  {
    match: /out of memory|allocation failed/i,
    title: "The simulation ran out of memory.",
    fix: "Usually a transient with a very small time step over a long stop time. Increase the time step or shorten the run."
  }
];

/**
 * Pull "line N" out of ngspice's text and return that line of the netlist,
 * which is far more use than the number on its own.
 */
function offendingLine(raw, netlist) {
  const m = raw.match(/line\s+(\d+)/i);
  if (!m || !netlist) return null;
  const n = Number(m[1]);
  const lines = netlist.split("\n");
  const text = lines[n - 1];
  if (!text) return null;
  return { number: n, text: text.trim() };
}

/**
 * Explain a raw engine error.
 * Returns { title, fix, line, raw } — title and fix are always populated so the
 * UI never has to fall back to showing SPICE at a beginner.
 */
export function explainEngineError(raw, netlist) {
  const text = String(raw || "");
  const hit = PATTERNS.find((p) => p.match.test(text));

  const base = hit || {
    title: "The simulation did not complete.",
    fix: "Check that every part has a sensible value, that there is a ground symbol, and that nothing is left dangling. The parts table below lists every connection."
  };

  return {
    title: base.title,
    fix: base.fix,
    line: offendingLine(text, netlist),
    raw: text.trim(),
    recognised: !!hit
  };
}

/** Every pattern, so tests can prove each one still matches its own example. */
export const ERROR_PATTERNS = PATTERNS;
