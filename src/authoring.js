/**
 * Lab authoring: the sheet as source you can paste into src/labs.js.
 *
 * A lab's reference diagram is data — parts, wires and probes — and typing
 * that by hand from a drawing is miserable and error-prone. Draw the circuit
 * instead, then copy it out of here.
 *
 * The output is JavaScript rather than JSON, because that is what the labs
 * file holds: unquoted keys, and the fields written in the order a person
 * reads them. Identifiers are dropped, since they are handed out afresh
 * whenever a circuit is loaded.
 */

import { PARTS } from "./parts.js";
import { DEFAULT_ANALYSIS, DEFAULT_PLOT } from "./store.js";

const q = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** One part, with the fields it actually carries. */
function compSource(c) {
  const def = PARTS[c.type];
  const bits = [`type: ${q(c.type)}`, `x: ${c.x}`, `y: ${c.y}`];
  if (c.rot) bits.push(`rot: ${c.rot}`);
  if (c.mx) bits.push("mx: true");
  if (c.my) bits.push("my: true");
  if (c.label) bits.push(`label: ${q(c.label)}`);
  def.fields.forEach((f) => {
    const v = c[f.k];
    if (v !== undefined && v !== "") bits.push(`${f.k}: ${q(v)}`);
  });
  return `{ ${bits.join(", ")} }`;
}

function wireSource(w) {
  return `{ x1: ${w.x1}, y1: ${w.y1}, x2: ${w.x2}, y2: ${w.y2}${w.bus ? ", bus: true" : ""} }`;
}

function probeSource(p) {
  const bits = [`kind: ${q(p.kind)}`, `ref: ${q(p.ref)}`];
  if (p.x !== undefined) bits.push(`x: ${p.x}`, `y: ${p.y}`);
  if (p.x2 !== undefined) bits.push(`x2: ${p.x2}`, `y2: ${p.y2}`);
  return `{ ${bits.join(", ")} }`;
}

/** Only the settings that differ from the defaults are worth writing down. */
function changed(current, defaults) {
  const out = {};
  Object.entries(current || {}).forEach(([k, v]) => {
    if (v !== defaults[k] && v !== "" && v !== false) out[k] = v;
  });
  return out;
}

function settingsComment(state) {
  const lines = [];
  lines.push(`// title: ${q(state.title || "Untitled circuit")}`);
  const analysis = changed(state.analysis, DEFAULT_ANALYSIS);
  if (Object.keys(analysis).length) {
    lines.push(`// analysis: { ${Object.entries(analysis).map(([k, v]) => `${k}: ${typeof v === "boolean" ? v : q(v)}`).join(", ")} }`);
  }
  const plot = changed(state.plot, DEFAULT_PLOT);
  if (Object.keys(plot).length) {
    lines.push(`// plot: { ${Object.entries(plot).map(([k, v]) => `${k}: ${q(v)}`).join(", ")} }`);
  }
  return lines;
}

/**
 * The whole sheet as a diagram literal, with the analysis and plot settings
 * noted above it so a lab definition can pick them up.
 */
export function labDiagramSource(state) {
  const list = (items, fn) => (items.length ? `\n    ${items.map(fn).join(",\n    ")}\n  ` : "");
  const notes = state.notes || [];
  return [
    "// Reference diagram copied from the sheet. Paste into DIAGRAMS in src/labs.js.",
    ...settingsComment(state),
    "{",
    `  comps: [${list(state.comps, compSource)}],`,
    `  wires: [${list(state.wires, wireSource)}],`,
    `  probes: [${list(state.probes, probeSource)}]${notes.length ? "," : ""}`,
    ...(notes.length ? [`  notes: [${list(notes, (n) => `{ x: ${n.x}, y: ${n.y}, text: ${q(n.text)} }`)}]`] : []),
    "}"
  ].join("\n");
}
