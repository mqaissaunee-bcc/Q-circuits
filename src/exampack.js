/**
 * Exam packs.
 *
 * An exam written in the code needs a rebuild and a deploy. A pack is the
 * same exam as a file: the instructor loads it in the browser and it appears
 * beside the labs. Nothing is built, nothing is deployed, and nobody has to
 * edit JavaScript the week of a midterm.
 *
 * The parts of an exam that are already data — the tasks, the starting
 * circuit, the values that vary, the questions, the marks — come across as
 * they are. The checks cannot: they are functions, and a file must not carry
 * code to run. So a pack says *what* to check in a small vocabulary, and each
 * entry is turned into the check builder that already exists here.
 *
 * Expressions ("VS*R2/(R1+R2)") are read by the parser below, not by eval:
 * arithmetic over this student's own values, and nothing else.
 */

import { K, corners, variantFor } from "./labs.js";
import { parseValue, formatEng } from "./netlist.js";

/* --------------------------------------------------------- expressions */

/**
 * Arithmetic over the student's values. Numbers may carry SPICE suffixes,
 * names refer to the varied values, and the only functions are the few a
 * circuit answer needs. A recursive-descent parser rather than eval, because
 * a pack is a file from outside.
 */
export function evaluate(expr, vars = {}) {
  const text = String(expr ?? "").trim();
  if (!text) return NaN;
  let i = 0;

  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const eat = (token) => {
    ws();
    if (text.startsWith(token, i)) { i += token.length; return true; }
    return false;
  };

  const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max,
    log: Math.log10, ln: Math.log, exp: Math.exp, pow: Math.pow
  };
  const CONSTS = { pi: Math.PI, e: Math.E };

  function primary() {
    ws();
    if (eat("(")) {
      const v = sum();
      if (!eat(")")) throw new Error("a bracket is not closed");
      return v;
    }
    if (eat("-")) return -primary();
    if (eat("+")) return primary();

    const num = text.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*(?:meg|mil|[tgkmunpf\u00B5\u03BC])?/);
    if (num && num[0]) {
      i += num[0].length;
      return parseValue(num[0]);
    }
    const word = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!word) {
      throw new Error(i >= text.length
        ? `the expression "${text}" is incomplete`
        : `cannot read "${text.slice(i, i + 12)}" in "${text}"`);
    }
    i += word[0].length;
    const name = word[0];
    if (eat("(")) {
      const args = [];
      if (!eat(")")) {
        do { args.push(sum()); } while (eat(","));
        if (!eat(")")) throw new Error(`${name}( is not closed`);
      }
      const fn = FUNCS[name.toLowerCase()];
      if (!fn) throw new Error(`there is no function called ${name}`);
      return fn(...args);
    }
    const key = Object.keys(vars).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return parseValue(vars[key]);
    if (CONSTS[name.toLowerCase()] !== undefined) return CONSTS[name.toLowerCase()];
    throw new Error(`nothing is called ${name}; the values here are ${Object.keys(vars).join(", ") || "none"}`);
  }

  function power() {
    const base = primary();
    return eat("^") ? base ** power() : base;
  }
  function product() {
    let v = power();
    for (;;) {
      if (eat("*")) v *= power();
      else if (eat("/")) v /= power();
      else return v;
    }
  }
  function sum() {
    let v = product();
    for (;;) {
      if (eat("+")) v += product();
      else if (eat("-")) v -= product();
      else return v;
    }
  }

  const value = sum();
  ws();
  if (i < text.length) throw new Error(`"${text.slice(i)}" is left over at the end`);
  return value;
}

/** Fill placeholders anywhere in a value: strings, arrays, objects. */
function fillDeep(value, vars) {
  if (typeof value === "string") {
    const filled = fill(value, vars);
    // A value written as a placeholder should come back as a number when it
    // is one, so { "dc": "{VS}" } means the same as { "dc": 12 }.
    const asNumber = parseValue(filled);
    return /^\{\w+\}$/.test(value.trim()) && isFinite(asNumber) ? asNumber : filled;
  }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars)]));
  }
  return value;
}

/** Fill {NAME} placeholders in a string with the student's values. */
const fill = (text, vars) =>
  String(text ?? "").replace(/\{(\w+)\}/g, (whole, name) => {
    const key = Object.keys(vars).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : vars[key];
  });

/* ------------------------------------------------------------- checks */

const tolerance = (spec, want) => {
  const t = String(spec ?? "2%").trim();
  return t.endsWith("%") ? Math.abs(want) * (parseFloat(t) / 100) : parseValue(t);
};

/**
 * Each entry a pack may use, and what it becomes. Adding to this list is how
 * the vocabulary grows; nothing else in a pack can reach the code.
 */
const CHECKS = {
  title: (c, vars) => K.title(fill(c.title, vars)),

  parts: (c, vars) => K.parts(
    Object.fromEntries(Object.entries(c.expect || {}).map(([label, want]) => [label, fillDeep(want, vars)])),
    c.label
  ),

  wiring: (c, vars) => K.wiring(fillDeep(c.rows || [], vars), c.label),

  pins: (c, vars) => K.pins(c.part, fillDeep(c.expect || {}, vars), c.label || `${c.part} is wired as the paper shows`),

  gate: (c, vars) => K.gate(c.part, (c.inputs || []).map((n) => fill(n, vars)), fill(c.output, vars)),

  noOpenEnds: () => K.noOpenEnds(),

  probe: (c, vars) => K.probe(fill(c.node, vars), fill(c.node, vars)),

  probeOrder: (c, vars) => K.probeOrder((c.nodes || []).map((n) => fill(n, vars))),

  analysis: (c, vars) => {
    const num = (v) => evaluate(fill(v, vars), vars);
    if (c.type === "op") return K.op();
    if (c.type === "dc") return K.dc(c.source, num(c.start), num(c.stop), num(c.step));
    if (c.type === "ac") return K.ac(num(c.start), num(c.stop), num(c.pointsPerDecade ?? c.perDecade ?? c.points));
    if (c.type === "tran") return K.tran(num(c.stop), num(c.step));
    throw new Error(`"${c.type}" is not an analysis: use op, dc, ac or tran`);
  },

  diffProbe: (c, vars) => K.diff(fill(c.plus, vars), fill(c.minus, vars)),

  /** A current probe on a part, as PSpice's I probe. */
  currentProbe: (c, vars) => {
    const part = fill(c.part, vars);
    return {
      label: c.label || `A current probe sits on ${part}`,
      test: (ctx) => ({ pass: ctx.currentProbe(part), detail: ctx.currentProbe(part) ? "" : `no current probe on ${part} yet: click the part itself, not a wire` })
    };
  },

  /** The largest or smallest a probed trace gets over the whole run. */
  extreme: (c, vars) => {
    const want = evaluate(c.expect, vars);
    const tol = tolerance(c.within, want);
    const which = c.which === "min" ? "min" : "max";
    return K.sim(c.label || `the ${which === "max" ? "peak" : "lowest"} reading is about ${formatEng(want, 4)}`, (ctx) => {
      const trace = c.part
        ? ctx.result?.traces.find((t) => t.type === "current" && new RegExp(fill(c.part, vars), "i").test(t.name))
        : ctx.nodeTrace(fill(c.node, vars));
      if (!trace) return { pass: false, detail: "that quantity was not probed, so there is nothing to read" };
      const got = which === "max" ? Math.max(...trace.values) : Math.min(...trace.values);
      return { pass: Math.abs(got - want) <= tol, detail: `it reaches ${formatEng(got, 4)}` };
    });
  },

  aliasOn: (c, vars) => K.aliasOn(fill(c.name, vars), fillDeep(c.on, vars), c.label || `${c.name} names the right node`),

  dbMode: () => K.dbMode(),

  axis: (c, vars) => K.axis(Object.fromEntries(Object.entries(c.expect || {}).map(([k, v]) => [k, evaluate(fill(String(v), vars), vars)]))),

  /** A parametric sweep, as PSpice's .step: from, to, by. */
  parametric: (c, vars) => {
    const num = (v) => evaluate(fill(v, vars), vars);
    const values = Array.isArray(c.values)
      ? c.values.map(num)
      : (() => {
        const out = [];
        const step = num(c.by);
        if (!(step > 0)) throw new Error("a parametric sweep needs a positive \"by\"");
        for (let v = num(c.from); v <= num(c.to) + step / 1e6; v += step) out.push(v);
        return out;
      })();
    if (!values.length || values.some((v) => !isFinite(v))) throw new Error("the parametric sweep values do not work out");
    return K.param(fill(c.name, vars), values);
  },

  /**
   * A trace's value at one point of the sweep: the voltage at a particular
   * step of a DC sweep, or the output at a moment of a transient.
   */
  valueAt: (c, vars) => {
    const want = evaluate(c.expect, vars);
    const at = evaluate(c.at, vars);
    const tol = tolerance(c.within, want);
    const node = fill(c.node, vars);
    const label = c.label || `${node} reads about ${formatEng(want, 4)} where the sweep is ${formatEng(at, 4)}`;
    const minus = c.minus ? fill(c.minus, vars) : null;
    return K.sim(label, (ctx) => {
      // A differential reading is the difference of the two node traces,
      // which is what the diff probe plots.
      const read = (where) => {
        const trace = ctx.nodeTrace(where);
        return trace ? ctx.at(trace, at) : NaN;
      };
      const got = minus ? read(node) - read(minus) : read(node);
      return {
        pass: Math.abs(got - want) <= tol,
        detail: isFinite(got) ? `it reads ${formatEng(got, 4)} there` : `no result for ${minus ? `${node} against ${minus}` : node}`
      };
    });
  },

  /** A node's operating-point voltage against an expression. */
  nodeVoltage: (c, vars) => {
    const want = evaluate(c.expect, vars);
    const tol = tolerance(c.within, want);
    return K.sim(c.label || `${c.node} sits at about ${formatEng(want, 4)} V`, (ctx) => {
      const got = ctx.vn(fill(c.node, vars));
      return { pass: Math.abs(got - want) <= tol, detail: isFinite(got) ? `${c.node} is at ${formatEng(got, 4)} V` : `no result at ${c.node}` };
    });
  },

  /** Mid-band gain in dB, for an AC sweep. */
  gain: (c, vars) => {
    const want = evaluate(c.expect, vars);
    const tol = tolerance(c.within, want);
    return K.sim(c.label || `${c.node} has about ${formatEng(want, 4)} dB of gain`, (ctx) => {
      const got = corners(ctx.nodeTrace(fill(c.node, vars)), ctx.result?.sweep?.values).peak;
      return { pass: Math.abs(got - want) <= tol, detail: isFinite(got) ? `it peaks at ${formatEng(got, 4)} dB` : "no AC result there" };
    });
  },

  /** The −3 dB corner of an AC sweep, high or low. */
  corner: (c, vars) => {
    const want = evaluate(c.expect, vars);
    const tol = tolerance(c.within, want);
    const side = c.side === "low" ? "lo" : "hi";
    return K.sim(c.label || `the corner is near ${formatEng(want, 4)} Hz`, (ctx) => {
      const got = corners(ctx.nodeTrace(fill(c.node, vars)), ctx.result?.sweep?.values)[side];
      return { pass: Math.abs(got - want) <= tol, detail: isFinite(got) ? `the corner is at ${formatEng(got, 4)} Hz` : "no −3 dB point in the sweep" };
    });
  }
};

/* -------------------------------------------------------------- packs */

/** Everything wrong with a pack, in one go, so it can be fixed in one pass. */
class PackError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * Read a pack. Returns { id, title, labs } ready to sit beside the built-in
 * labs, or throws a PackError listing what is wrong with it.
 */
export function parsePack(source) {
  let pack;
  try {
    pack = typeof source === "string" ? JSON.parse(source) : source;
  } catch (e) {
    throw new PackError([`The file is not valid JSON: ${e.message}`]);
  }
  const problems = [];
  if (!isObject(pack)) throw new PackError(["The file should hold one object, with a title and a list of items."]);
  if (!pack.title) problems.push("The pack needs a title, which is what the group is called in the lab list.");
  if (!Array.isArray(pack.items) || !pack.items.length) problems.push("The pack needs an items array with at least one exam item.");

  const packId = `pack-${String(pack.id || pack.title || "exam").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const labs = [];

  (pack.items || []).forEach((item, n) => {
    const where = `Item ${n + 1}${item?.code ? ` (${item.code})` : ""}`;
    if (!isObject(item)) { problems.push(`${where}: should be an object.`); return; }
    if (!item.title) problems.push(`${where}: needs a title.`);
    if (!Array.isArray(item.tasks) || !item.tasks.length) problems.push(`${where}: needs a tasks list, the instructions the student reads.`);
    if (item.vary && !isObject(item.vary)) problems.push(`${where}: vary should be an object of name to list of values.`);
    Object.entries(item.vary || {}).forEach(([name, options]) => {
      if (!Array.isArray(options) || !options.length) problems.push(`${where}: vary.${name} should be a list of values to choose from.`);
    });
    (item.checks || []).forEach((c, k) => {
      if (!isObject(c) || !c.check) problems.push(`${where}, check ${k + 1}: needs a "check" naming what to test.`);
      else if (!CHECKS[c.check]) {
        problems.push(`${where}, check ${k + 1}: there is no check called "${c.check}". The ones there are: ${Object.keys(CHECKS).join(", ")}.`);
      }
    });
    (item.questions || []).forEach((q, k) => {
      if (!q.prompt) problems.push(`${where}, question ${k + 1}: needs a prompt.`);
      if (!q.expect) problems.push(`${where}, question ${k + 1}: needs an expect expression, such as "VS*R2/(R1+R2)".`);
    });

    // Build the item, and try its expressions on a sample student, so a
    // typo in a formula is found now rather than in the exam.
    const lab = {
      id: `${packId}-${item.code ? String(item.code).toLowerCase() : n + 1}`,
      group: packId,
      code: item.code || String(n + 1),
      kind: item.kind === "fix" ? "fix" : "draw",
      exam: true,
      title: item.title || `${pack.title} ${n + 1}`,
      summary: item.summary || "",
      vary: item.vary || null,
      useStudentAnalysis: item.useStudentAnalysis !== false,
      analysis: item.analysis || undefined,
      reference: item.reference || undefined,
      simulate: item.simulate,
      tasks: (vars) => (item.tasks || []).map((t) => fill(t, vars)),
      circuit: (vars) => startingCircuit(item, vars),
      questions: (vars) => (item.questions || []).map((q, k) => ({
        id: q.id || `q${k + 1}`,
        prompt: fill(q.prompt, vars),
        points: q.points,
        ...(q.within && String(q.within).endsWith("%")
          ? { rel: parseFloat(q.within) / 100 }
          : { abs: q.within === undefined ? 0.02 : parseValue(q.within) }),
        expect: () => evaluate(q.expect, vars)
      })),
      checks: (vars) => (item.checks || []).map((c) => {
        const make = CHECKS[c.check];
        // Reported already by the loader; here it must not stop the rest.
        const built = make
          ? make(c, vars)
          : { label: `Unknown check "${c.check}"`, test: () => ({ pass: false, detail: "this pack asks for a check that does not exist" }) };
        return c.points === undefined ? built : { ...built, points: c.points };
      })
    };

    // Try every expression on a sample student, and report all of them: a
    // pack with two typos should not need two goes to fix.
    const sample = variantFor(lab, "Sample Student");
    (item.checks || []).forEach((c, k) => {
      if (!CHECKS[c.check]) return;                     // already reported
      try {
        CHECKS[c.check](c, sample);
      } catch (e) {
        problems.push(`${where}, check ${k + 1} (${c.check}): ${e.message}`);
      }
    });
    (item.questions || []).forEach((q, k) => {
      if (!q.expect) return;
      try {
        const v = evaluate(q.expect, sample);
        if (!isFinite(v)) problems.push(`${where}, question ${k + 1}: "${q.expect}" does not work out to a number.`);
      } catch (e) {
        problems.push(`${where}, question ${k + 1}: ${e.message}`);
      }
    });
    try {
      lab.tasks(sample);
      lab.circuit(sample);
    } catch (e) {
      problems.push(`${where}: ${e.message}`);
    }

    labs.push(lab);
  });

  if (problems.length) throw new PackError(problems);
  return { id: packId, title: pack.title, labs };
}

/**
 * A fix-it item starts from a sheet the instructor drew (copied out of the
 * sheet with Copy as lab diagram); a draw-it item starts from nothing.
 */
function startingCircuit(item, vars) {
  const blank = { title: "Untitled circuit", comps: [], wires: [], probes: [], notes: [], seq: {} };
  if (!item.circuit) return blank;
  const src = item.circuit;
  return {
    ...blank,
    ...src,
    title: "Untitled circuit",
    comps: (src.comps || []).map((c) => {
      const copy = { ...c };
      Object.keys(copy).forEach((k) => {
        if (typeof copy[k] === "string") copy[k] = fill(copy[k], vars);
      });
      return copy;
    })
  };
}

export { PackError };
