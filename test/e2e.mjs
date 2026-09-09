/**
 * End-to-end checks against the production build.
 * Run with: node test/e2e.mjs
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";

/** Double-click an element, keeping it clear of the sticky toolbar. */
async function dblclickCentered(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(120);
  await locator.dblclick();
}

/** Scroll a locator to the top of the viewport and return a fresh box. */
async function boxOf(page, selector) {
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollIntoView({ block: "center", behavior: "instant" });
  }, selector);
  await page.waitForTimeout(120);
  return page.locator(selector).boundingBox();
}

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5211;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  let file = join(ROOT, normalize(rel === "/" ? "/index.html" : rel));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}
function near(a, b, tol) { return isFinite(a) && Math.abs(a - b) <= tol; }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());

await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => !!window.__spiceLab && window.__spiceLab.ready === true, null, { timeout: 20000 });

/* ---------------------------------------------------------------- boot */

console.log("\n— boot —");
const bootNetlist = await page.inputValue("#netOut");
check("boots with the divider lab", bootNetlist.includes("R1 1 2 6.8k") && bootNetlist.includes("V1 1 0 DC 10"),
  bootNetlist.split("\n").filter((l) => l && !l.startsWith("*")).join(" | "));
check("no ground error on the starter circuit", !(await page.textContent("#checks")).includes("No ground"));

/* ------------------------------------------------------- run a real sim */

console.log("\n— ngspice runs —");
const t0 = Date.now();
await page.click("#btnRun");
await page.waitForFunction(() => window.__spiceLab.getResult() !== null, null, { timeout: 90000 });
console.log(`  (first run including engine download: ${Date.now() - t0} ms)`);

let r = await page.evaluate(() => {
  const res = window.__spiceLab.getResult();
  return { kind: res.kind, sweep: res.sweep?.type ?? null, traces: res.traces.map((t) => ({ n: t.name, v: t.values[t.values.length - 1] })) };
});
const vmid = r.traces.find((t) => t.n === "v(2)")?.v;
check("operating point solves the divider", near(vmid, 3.26733, 1e-4), `v(2) = ${vmid}`);
check("op result has no sweep vector", r.sweep === null);

/* ------------------------------------------------- lab checks: divider */

console.log("\n— lab: voltage divider —");
await page.click("#btnCheck");
await page.waitForFunction(() => document.querySelectorAll("#checkResults .check-list li").length > 0, null, { timeout: 60000 });
let checks = await page.$$eval("#checkResults .check-list li", (els) => els.map((e) => e.className));
check("divider check fails before the student fixes R1", checks[0].includes("fail"), checks.join(","));

// set R1 so the midpoint reaches 4.00 V: 10 * 3300 / (R1 + 3300) = 4  ->  R1 = 4950
await page.evaluate(() => {
  const s = window.__spiceLab.store;
  const r1 = s.state.comps.find((c) => c.label === "R1");
  s.edit(() => { r1.value = "4.95k"; }, "test");
});
await page.click("#btnCheck");
await page.waitForFunction(
  () => [...document.querySelectorAll("#checkResults .check-list li")].every((e) => e.className.includes("pass")),
  null, { timeout: 60000 }
);
const detail = await page.textContent("#checkResults .check-detail");
check("divider check passes once R1 = 4.95k", true, detail.trim());

/* ------------------------------------------------------- lab: RC filter */

console.log("\n— lab: RC low-pass (AC sweep) —");
await page.selectOption("#labSelect", "rc-lowpass");
await page.click("#btnCheck");
await page.waitForFunction(() => document.querySelectorAll("#checkResults .check-list li").length > 0, null, { timeout: 60000 });
const rcPass = await page.$eval("#checkResults .check-list li", (e) => e.className.includes("pass"));
const rcDetail = (await page.textContent("#checkResults .check-detail")).trim();
check("AC sweep finds the corner near 1 kHz", rcPass, rcDetail);

r = await page.evaluate(() => {
  const res = window.__spiceLab.getResult();
  return { kind: res.kind, sweep: res.sweep?.type, n: res.numPoints, complex: res.traces[0]?.complex };
});
check("AC returns complex data on a frequency axis", r.kind === "complex" && r.sweep === "frequency" && r.complex === true,
  `${r.n} points`);
check("magnitude/phase switch is shown for AC", !(await page.getAttribute("#acModes", "hidden") === ""));

/* ------------------------------------------------------ lab: rectifier */

console.log("\n— lab: half-wave rectifier (transient) —");
await page.selectOption("#labSelect", "rectifier");
await page.click("#btnCheck");
await page.waitForFunction(() => document.querySelectorAll("#checkResults .check-list li").length >= 2, null, { timeout: 60000 });
const rect = await page.$$eval("#checkResults .check-list li", (els) =>
  els.map((e) => ({ pass: e.className.includes("pass"), text: e.textContent })));
check("rectifier peak is a diode drop below the source", rect[0].pass, rect[0].text.replace(/\s+/g, " ").trim());
check("rectifier blocks the negative half cycle", rect[1].pass, rect[1].text.replace(/\s+/g, " ").trim());

r = await page.evaluate(() => {
  const res = window.__spiceLab.getResult();
  return { sweep: res.sweep?.type, n: res.numPoints, traces: res.traces.map((t) => t.name) };
});
check("transient returns a time axis", r.sweep === "time" && r.n > 100, `${r.n} points, ${r.traces.join(",")}`);
check("probes narrowed the plot to the two probed nodes",
  await page.evaluate(() => window.__spiceLab.scope.hasWaveform()));

/* ------------------------------------------------- lab: transistor bias */

console.log("\n— lab: common-emitter bias —");
await page.selectOption("#labSelect", "common-emitter");
await page.click("#btnCheck");
await page.waitForFunction(() => document.querySelectorAll("#checkResults .check-list li").length >= 2, null, { timeout: 60000 });
const ce = await page.$$eval("#checkResults .check-list li", (els) =>
  els.map((e) => ({ pass: e.className.includes("pass"), text: e.textContent.replace(/\s+/g, " ").trim() })));
check("collector current lands near 2 mA", ce[0].pass, ce[0].text);
check("transistor is in the active region", ce[1].pass, ce[1].text);

/* ---------------------------------------------------------- the editor */

console.log("\n— editor —");
await page.selectOption("#labSelect", "divider");
const before = await page.evaluate(() => window.__spiceLab.store.state.comps.length);

// place a resistor by clicking the sheet
await page.click('#partTools button[data-tool="R"]');
const svgBox = await boxOf(page, "svg.sheet");
await page.mouse.click(svgBox.x + svgBox.width * 0.75, svgBox.y + svgBox.height * 0.25);
let after = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
check("clicking the sheet places a part", after === before + 1, `${before} → ${after}`);

await page.click("#btnUndo");
after = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
check("undo removes it", after === before);

await page.click("#btnRedo");
after = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
check("redo puts it back", after === before + 1);

// copy / paste the selection
const pasted = await page.evaluate(() => {
  const s = window.__spiceLab.store;
  const r2 = s.state.comps.find((c) => c.label === "R2");
  s.selection = new Set([r2.id]);
  s.copySelection();
  s.paste();
  return s.state.comps.length;
});
check("copy and paste duplicates the selection", pasted === before + 2, `${pasted} parts`);
const labels = await page.evaluate(() => window.__spiceLab.store.state.comps.map((c) => c.label));
check("pasted part gets a fresh designator", new Set(labels).size === labels.length, labels.join(","));

// rotation changes pin geometry
const rotated = await page.evaluate(() => {
  const s = window.__spiceLab.store;
  const r1 = s.state.comps.find((c) => c.label === "R1");
  s.selection = new Set([r1.id]);
  const before = JSON.stringify(window.__spiceLab.canvas.lastNet ? null : null);
  s.rotateSelection();
  return r1.rot;
});
check("rotate advances the angle", rotated === 180, `rot = ${rotated}`);

// box select
await page.click('#modeTools button[data-tool="select"]');
const bandBox = await boxOf(page, "svg.sheet");
await page.mouse.move(bandBox.x + 8, bandBox.y + 8);
await page.mouse.down();
await page.mouse.move(bandBox.x + bandBox.width - 8, bandBox.y + bandBox.height - 8, { steps: 8 });
await page.mouse.up();
const selCount = await page.evaluate(() => window.__spiceLab.store.selection.size);
check("box select grabs everything on the sheet", selCount > 4, `${selCount} items`);

/* --------------------------------------------------------- measurements */

console.log("\n— measurements —");
const sine = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  S.clear();
  S.edit(() => {
    const v = S.addComp("V", 200, 180, "V"); v.rot = 90; v.value = "SIN(0 10 60)";
    const r = S.addComp("R", 460, 180, "R"); r.rot = 90; r.value = "1k";
    S.addComp("GND", 200, 400, "GND");
    S.addWire(200, 180, 460, 180);
    S.addWire(460, 240, 460, 400);
    S.addWire(460, 400, 200, 400);
    S.addWire(200, 240, 200, 400);
    Object.assign(S.state.analysis, { type: "tran", trStep: "20u", trStop: "50m" });
  }, "t");
  await window.__spiceLab.run();

  const res = window.__spiceLab.getResult();
  const xs = res.sweep.values;
  const ys = res.traces.find((t) => t.name === "v(1)").values;
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  let sq = 0;
  for (const v of ys) sq += v * v;

  return {
    m: window.__spiceLab.scope.measurements().find((x) => x.name === "v(1)"),
    naiveRms: Math.sqrt(sq / ys.length),
    stepRatio: Math.max(...gaps) / Math.min(...gaps),
    headers: [...document.querySelectorAll("#measureHost thead th")].map((th) => th.textContent)
  };
});

const RMS = 10 / Math.SQRT2;
check("peak of a 10 V sine", near(sine.m.max, 10, 1e-5), `${sine.m.max}`);
check("peak-to-peak", near(sine.m.pp, 20, 1e-5), `${sine.m.pp}`);
check("mean of a full-cycle sine is zero", Math.abs(sine.m.mean) < 1e-8, `${sine.m.mean}`);
check("RMS matches Vp/√2", near(sine.m.rms, RMS, 1e-6), `${sine.m.rms} vs ${RMS}`);
check("frequency recovered as 60 Hz", near(sine.m.freq, 60, 1e-5), `${sine.m.freq}`);
check("ngspice really did use a variable timestep", sine.stepRatio > 10, `${sine.stepRatio.toFixed(0)}× spread`);
check("time-weighting beats sample-averaging",
  Math.abs(sine.m.rms - RMS) < Math.abs(sine.naiveRms - RMS) / 1000,
  `weighted ${Math.abs(sine.m.rms - RMS).toExponential(1)} vs naive ${Math.abs(sine.naiveRms - RMS).toExponential(1)}`);
check("transient shows all six measurement columns",
  sine.headers.join(",") === "Trace,Min,Max,Pk-Pk,Mean,RMS,Freq", sine.headers.join(","));

// drag across the plot to narrow the measurement window.
// The scope sits below the fold at this viewport, so scroll it into view first
// or the synthetic mouse events land outside the canvas.
const scopeBox = await boxOf(page, ".scope-canvas");
await page.mouse.move(scopeBox.x + scopeBox.width * 0.45, scopeBox.y + scopeBox.height * 0.5);
await page.mouse.down();
await page.mouse.move(scopeBox.x + scopeBox.width * 0.75, scopeBox.y + scopeBox.height * 0.5, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);

const narrowed = await page.evaluate(() => ({
  region: window.__spiceLab.scope.getRegion(),
  label: document.querySelector(".measure-scope").textContent,
  hasClear: !!document.querySelector(".measure-head button")
}));
check("dragging the plot narrows the measurement window", !!narrowed.region && narrowed.hasClear, narrowed.label);

await page.click(".measure-head button");
await page.waitForTimeout(150);
const restored = await page.evaluate(() => ({
  region: window.__spiceLab.scope.getRegion(),
  rms: window.__spiceLab.scope.measurements().find((x) => x.name === "v(1)").rms
}));
check("clearing returns to the whole sweep", restored.region === null && near(restored.rms, RMS, 1e-6), `${restored.rms}`);

// half-wave rectified sine: mean and RMS sit just under the ideal-diode values
const rect2 = await page.evaluate(async () => {
  document.getElementById("labSelect").value = "rectifier";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  await window.__spiceLab.run();
  return window.__spiceLab.scope.measurements().find((m) => m.name === "v(2)");
});
check("rectifier mean is just under Vp/π", rect2.mean < rect2.max / Math.PI && rect2.mean > rect2.max / Math.PI - 0.2,
  `mean ${rect2.mean.toFixed(4)} vs ideal ${(rect2.max / Math.PI).toFixed(4)}`);
check("rectifier RMS is just under Vp/2", rect2.rms < rect2.max / 2 && rect2.rms > rect2.max / 2 - 0.2,
  `rms ${rect2.rms.toFixed(4)} vs ideal ${(rect2.max / 2).toFixed(4)}`);

const acCols = await page.evaluate(async () => {
  document.getElementById("labSelect").value = "rc-lowpass";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  await window.__spiceLab.run();
  return [...document.querySelectorAll("#measureHost thead th")].map((th) => th.textContent);
});
check("AC sweep drops the time-only columns", acCols.join(",") === "Trace,Min,Max,Pk-Pk", acCols.join(","));

/* -------------------------------------------------------------- ammeter */

console.log("\n— ammeter —");
const am = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  S.clear();
  S.edit(() => {
    const v  = S.addComp("V",  200, 180, "V");  v.rot = 90; v.value = "DC 10";
    S.addComp("AM", 280, 180, "AM");
    const r  = S.addComp("R",  460, 180, "R");  r.rot = 90; r.value = "1k";
    S.addComp("GND", 200, 400, "GND");
    S.addWire(200, 180, 280, 180);
    S.addWire(340, 180, 460, 180);
    S.addWire(460, 240, 460, 400);
    S.addWire(460, 400, 200, 400);
    S.addWire(200, 240, 200, 400);
    S.state.analysis.type = "op";
  }, "test");
  const netlist = document.getElementById("netOut").value;
  S.toggleProbe("i", "VAM1", {});
  await window.__spiceLab.run();
  const res = window.__spiceLab.getResult();
  const t = (n) => res.traces.find((x) => x.name === n)?.values.at(-1);
  return {
    netlist,
    current: t("i(vam1)"),
    vIn: t("v(1)"), vOut: t("v(2)"),
    plotted: [...document.querySelectorAll(".legend-name")].map((e) => e.textContent)
  };
});
check("ammeter emits a zero-volt source", am.netlist.includes("VAM1 1 2 DC 0"),
  am.netlist.split("\n").filter((l) => l && !l.startsWith("*")).join(" | "));
check("ammeter measures 10 mA through 1k from 10 V", near(am.current, 0.01, 1e-9), `i(vam1) = ${am.current}`);
check("ammeter reads positive from + to −", am.current > 0);
check("ammeter drops no voltage", near(am.vIn - am.vOut, 0, 1e-12), `${am.vIn} V → ${am.vOut} V`);
check("current probe narrows the plot to the ammeter", am.plotted.length === 1 && am.plotted[0] === "i(vam1)",
  am.plotted.join(","));

/* --------------------------------------------------------------- op-amp */

console.log("\n— op-amp supply rails —");
const opamp = await page.evaluate(async () => {
  document.getElementById("labSelect").value = "inverting-amp";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  await window.__spiceLab.run();
  const netlist = document.getElementById("netOut").value;
  const linear = window.__spiceLab.scope.measurements();

  const S = window.__spiceLab.store;
  S.edit(() => { S.state.comps.find((c) => c.label === "V1").value = "SIN(0 2 1k)"; }, "t");
  await window.__spiceLab.run();
  const clipped = window.__spiceLab.scope.measurements();

  S.edit(() => {
    const u = S.state.comps.find((c) => c.label === "U1");
    u.vpos = "5"; u.vneg = "-5";
  }, "t");
  await window.__spiceLab.run();
  const tight = window.__spiceLab.scope.measurements();

  return { netlist, linear, clipped, tight };
});

check("op-amp emits a clamped behavioural source",
  /^BU1 3 0 V = max\(-15, min\(15, 200k\*\(0 - V\(2\)\)\)\)$/m.test(opamp.netlist),
  opamp.netlist.split("\n").find((l) => l.startsWith("BU1")));
check("a grounded input is written as 0, not V(0)", !opamp.netlist.includes("V(0)"));

const gain = opamp.linear[1].max / opamp.linear[0].max;
check("closed-loop gain matches Rf/Rin", near(gain, 10, 0.01), `measured ${gain.toFixed(4)}`);
check("finite open-loop gain shows up as slight droop", gain < 10,
  `${gain.toFixed(5)}, theory 10/(1+11/200k) = ${(10 / (1 + 11 / 200000)).toFixed(5)}`);

check("overdriving clips exactly at the ±15 rails",
  near(opamp.clipped[1].max, 15, 1e-3) && near(opamp.clipped[1].min, -15, 1e-3),
  `${opamp.clipped[1].min.toFixed(4)} .. ${opamp.clipped[1].max.toFixed(4)} V`);
check("narrowing the rails narrows the clipping",
  near(opamp.tight[1].max, 5, 1e-3) && near(opamp.tight[1].min, -5, 1e-3),
  `${opamp.tight[1].min.toFixed(4)} .. ${opamp.tight[1].max.toFixed(4)} V`);

await page.click("#btnCheck");
await page.waitForFunction(() => document.querySelectorAll("#checkResults .check-list li").length >= 2, null, { timeout: 60000 });
const ampChecks = await page.$$eval("#checkResults .check-list li", (els) =>
  els.map((e) => ({ pass: e.className.includes("pass"), text: e.textContent.replace(/\s+/g, " ").trim() })));
check("lab detects the inversion", ampChecks[0].pass, ampChecks[0].text);
check("lab detects clipping against whatever the rails are set to", ampChecks[1].pass, ampChecks[1].text);

/* --------------------------------------------- wire stretch and duplicate */

console.log("\n— moving parts, stretching wires —");
await page.evaluate(() => {
  document.getElementById("labSelect").value = "divider";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
});
await page.waitForTimeout(200);

const stretched = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  const r1 = S.state.comps.find((c) => c.label === "R1");
  const before = JSON.parse(JSON.stringify(S.state.wires));
  const wiresBefore = S.state.wires.length;
  S.selection = new Set([r1.id]);
  S.moveSelection(60, 0);
  const netlist = () => {
    const n = window.__spiceLab.refresh();
    return document.getElementById("netOut").value;
  };
  return {
    wiresBefore, wiresAfter: S.state.wires.length,
    moved: before.filter((w, i) => JSON.stringify(w) !== JSON.stringify(S.state.wires[i])).length,
    netlist: netlist(),
    checks: document.getElementById("checks").textContent
  };
});
check("the attached wire ends followed the part", stretched.moved >= 1, `${stretched.moved} wires changed`);
check("stretched wires are squared into elbows, never left diagonal",
  await page.evaluate(() => window.__spiceLab.store.state.wires.every((w) => w.x1 === w.x2 || w.y1 === w.y2)),
  `${stretched.wiresBefore} → ${stretched.wiresAfter} wires`);
check("connectivity survives the move", stretched.netlist.includes("R1 1 2 6.8k"),
  stretched.netlist.split("\n").filter((l) => l && !l.startsWith("*")).join(" | "));
check("no node was orphaned by the move", !stretched.checks.includes("only one pin"),
  stretched.checks.replace(/\s+/g, " ").trim().slice(0, 90));

const detached = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  S.undo();
  const r1 = S.state.comps.find((c) => c.label === "R1");
  // A wire that is itself selected travels whole rather than stretching.
  S.selection = new Set([r1.id, S.state.wires[0].id]);
  const w0 = { ...S.state.wires[0] };
  S.moveSelection(0, 40);
  const now = S.state.wires[0];
  return { dx1: now.x1 - w0.x1, dy1: now.y1 - w0.y1, dx2: now.x2 - w0.x2, dy2: now.y2 - w0.y2 };
});
check("a selected wire moves whole instead of stretching",
  detached.dy1 === 40 && detached.dy2 === 40, JSON.stringify(detached));
await page.evaluate(() => window.__spiceLab.store.undo());

// Cmd/Ctrl-drag slides a part without disturbing the wiring
const slid = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  const r1 = S.state.comps.find((c) => c.label === "R1");
  const wiresBefore = JSON.parse(JSON.stringify(S.state.wires));
  S.selection = new Set([r1.id]);
  S.moveSelection(-80, 0, { detach: true });
  window.__spiceLab.refresh();
  return {
    wiresUnchanged: JSON.stringify(wiresBefore) === JSON.stringify(S.state.wires),
    wireCount: S.state.wires.length,
    netlist: document.getElementById("netOut").value,
    warnings: [...document.querySelectorAll("#checks li")].map((li) => li.textContent.trim())
  };
});
check("a detached move leaves every wire exactly where it was", slid.wiresUnchanged);
check("a detached move adds no elbow segments", slid.wireCount === 5, `${slid.wireCount} wires`);
// Sliding along a wire keeps the pin sitting on it connected — the top pin
// stays on node 1 — but a pin that leaves its wire genuinely comes off, and
// that has to be visible rather than silent.
check("a pin still sitting on a wire keeps its node", /R1 1 /.test(slid.netlist),
  slid.netlist.split("\n").filter((l) => l && !l.startsWith("*")).join(" | "));
check("a pin pulled off its wire is reported as dangling",
  slid.warnings.filter((w) => w.includes("only one pin")).length === 2,
  slid.warnings.join(" / ").slice(0, 120));
await page.evaluate(() => window.__spiceLab.store.undo());

// Alt-drag leaves a copy behind
await page.evaluate(() => {
  const S = window.__spiceLab.store;
  S.selection = new Set([S.state.comps.find((c) => c.label === "R2").id]);
});
const dupBox = await boxOf(page, "svg.sheet");
const dupBefore = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
const r2pos = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  const r2 = S.state.comps.find((c) => c.label === "R2");
  const vb = document.querySelector("svg.sheet").getAttribute("viewBox").split(" ").map(Number);
  return { x: r2.x, y: r2.y, vb };
});
const toScreen = (sx, sy) => ({
  x: dupBox.x + ((sx - r2pos.vb[0]) / r2pos.vb[2]) * dupBox.width,
  y: dupBox.y + ((sy - r2pos.vb[1]) / r2pos.vb[3]) * dupBox.height
});
const from = toScreen(r2pos.x, r2pos.y + 30);
await page.keyboard.down("Alt");
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x + 90, from.y + 60, { steps: 8 });
await page.mouse.up();
await page.keyboard.up("Alt");
await page.waitForTimeout(200);
const dupAfter = await page.evaluate(() => ({
  count: window.__spiceLab.store.state.comps.length,
  labels: window.__spiceLab.store.state.comps.map((c) => c.label)
}));
check("Alt-drag leaves a copy behind", dupAfter.count === dupBefore + 1,
  `${dupBefore} → ${dupAfter.count}`);
check("the copy gets its own designator", new Set(dupAfter.labels).size === dupAfter.labels.length,
  dupAfter.labels.join(","));

// Shift must mean one thing: add to the selection. Overloading it meant a
// shift-drag on an unselected part silently dragged everything selected.
const shiftBehaviour = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  document.getElementById("labSelect").value = "divider";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  const [a, b] = S.state.comps;
  S.selection = new Set([a.id]);
  return { start: S.selection.size, aId: a.id, bId: b.id };
});
const shiftBox = await boxOf(page, "svg.sheet");
const posOf = await page.evaluate((id) => {
  const S = window.__spiceLab.store;
  const c = S.state.comps.find((k) => k.id === id);
  const vb = document.querySelector("svg.sheet").getAttribute("viewBox").split(" ").map(Number);
  return { x: c.x, y: c.y, vb, wires: JSON.parse(JSON.stringify(S.state.wires)) };
}, shiftBehaviour.bId);
const pt = {
  x: shiftBox.x + ((posOf.x - posOf.vb[0]) / posOf.vb[2]) * shiftBox.width,
  y: shiftBox.y + ((posOf.y + 30 - posOf.vb[1]) / posOf.vb[3]) * shiftBox.height
};
await page.keyboard.down("Shift");
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
await page.mouse.move(pt.x + 60, pt.y + 40, { steps: 6 });
await page.mouse.up();
await page.keyboard.up("Shift");
await page.waitForTimeout(200);
const afterShift = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  return { selected: S.selection.size, wires: JSON.stringify(S.state.wires) };
});
check("shift-drag adds to the selection rather than detaching",
  afterShift.selected === 2, `${afterShift.selected} selected`);
check("shift-drag still drags the wiring along",
  afterShift.wires !== JSON.stringify(posOf.wires));
await page.evaluate(() => { while (window.__spiceLab.store.canUndo()) window.__spiceLab.store.undo(); });

/* --------------------------------------------- traces, help, progress ---- */

console.log("\n— accessibility and progress —");
const dashes = await page.evaluate(async () => {
  document.getElementById("labSelect").value = "rectifier";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  await window.__spiceLab.run();
  return [...document.querySelectorAll(".legend-item .swatch line")]
    .map((l) => ({ stroke: l.getAttribute("stroke"), dash: l.getAttribute("stroke-dasharray") }));
});
check("each trace has its own line pattern, not just a colour",
  dashes.length >= 2 && dashes[0].dash !== dashes[1].dash,
  dashes.map((d) => d.dash || "solid").join(" / "));

await page.click("#btnHelp");
await page.waitForTimeout(200);
const help = await page.evaluate(() => {
  const d = document.getElementById("helpDialog");
  return { open: d.open, entries: d.querySelectorAll("dl.shortcuts dt").length,
           focusInside: d.contains(document.activeElement) };
});
check("the shortcuts dialog opens", help.open);
check("it lists the shortcuts", help.entries > 20, `${help.entries} entries`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Escape closes it", !(await page.evaluate(() => document.getElementById("helpDialog").open)));

// keyboard placement
await page.click('#partTools button[data-tool="R"]');
const kbBefore = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowDown");
const caretShown = await page.evaluate(() => !!document.querySelector("svg.sheet .caret"));
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const kbAfter = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
check("arrow keys show a placement cursor", caretShown);
check("Enter places a part without the mouse", kbAfter === kbBefore + 1, `${kbBefore} → ${kbAfter}`);
await page.keyboard.press("Escape");

// lab progress is recorded on a full pass
const progress = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  S.clearProgress();
  document.getElementById("labSelect").value = "rectifier";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  const before = S.labPassed("rectifier");
  document.getElementById("btnCheck").click();
  await new Promise((r) => setTimeout(r, 6000));
  return {
    before,
    after: S.labPassed("rectifier"),
    option: [...document.querySelectorAll("#labSelect option")].find((o) => o.value === "rectifier").textContent,
    banner: document.getElementById("labProgress").hidden ? "" : document.getElementById("labProgress").textContent,
    tally: document.getElementById("labTally").textContent
  };
});
check("a lab is not marked passed before it is checked", progress.before === false);
check("passing every check records the lab", progress.after === true);
check("the passed lab is ticked in the list", progress.option.includes("\u2713"), progress.option);
check("the lab panel shows when it was passed", /Passed on/.test(progress.banner), progress.banner);
check("the tally counts passed labs", /1 of 5 passed/.test(progress.tally), progress.tally);

// Broken connections have to be visible on the drawing, not only in the text
console.log("\n— showing broken connections —");
const openMarkers = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  document.getElementById("labSelect").value = "divider";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  const clean = {
    pins: document.querySelectorAll("svg.sheet .pin.is-open").length,
    ends: document.querySelectorAll("svg.sheet .wire-open").length
  };
  const r1 = S.state.comps.find((c) => c.label === "R1");
  S.selection = new Set([r1.id]);
  S.moveSelection(-80, 0, { detach: true });
  window.__spiceLab.refresh();
  return {
    clean,
    broken: {
      pins: document.querySelectorAll("svg.sheet .pin.is-open").length,
      ends: document.querySelectorAll("svg.sheet .wire-open").length
    }
  };
});
check("a correctly wired circuit shows no broken-connection markers",
  openMarkers.clean.pins === 0 && openMarkers.clean.ends === 0, JSON.stringify(openMarkers.clean));
check("pins left unconnected are marked on the sheet", openMarkers.broken.pins >= 2,
  `${openMarkers.broken.pins} open pins`);
check("wire ends touching nothing are marked on the sheet", openMarkers.broken.ends >= 1,
  `${openMarkers.broken.ends} open wire ends`);
await page.evaluate(() => window.__spiceLab.store.undo());

/* ------------------------------------------------- pan, zoom area, text */

console.log("\n— navigation and annotation tools —");
await page.evaluate(() => {
  document.getElementById("labSelect").value = "divider";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
});
await page.waitForTimeout(200);
const navBox = await boxOf(page, "svg.sheet");

const viewOf = () => page.evaluate(() => {
  const vb = document.querySelector("svg.sheet").getAttribute("viewBox").split(" ").map(Number);
  return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
});

// --- hand tool drags the view without touching the circuit
await page.click('#viewTools button[data-tool="pan"]');
const beforePan = await viewOf();
const partsBeforePan = await page.evaluate(() => window.__spiceLab.store.state.comps.length);
await page.mouse.move(navBox.x + navBox.width * 0.5, navBox.y + navBox.height * 0.5);
await page.mouse.down();
await page.mouse.move(navBox.x + navBox.width * 0.5 - 160, navBox.y + navBox.height * 0.5 - 90, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
const afterPan = await viewOf();
check("the hand tool moves the view", Math.abs(afterPan.x - beforePan.x) > 20,
  `x ${beforePan.x.toFixed(0)} → ${afterPan.x.toFixed(0)}`);
check("panning does not resize the view", Math.abs(afterPan.w - beforePan.w) < 1);
check("panning changes nothing on the sheet",
  (await page.evaluate(() => window.__spiceLab.store.state.comps.length)) === partsBeforePan);
check("panning is not undoable clutter", !(await page.evaluate(() => window.__spiceLab.store.canUndo() &&
  window.__spiceLab.store.state.comps.length !== 4)));

// --- zoom area frames the dragged rectangle
await page.click('#viewTools button[data-tool="zoomrect"]');
const beforeZoom = await viewOf();
await page.mouse.move(navBox.x + navBox.width * 0.3, navBox.y + navBox.height * 0.3);
await page.mouse.down();
await page.mouse.move(navBox.x + navBox.width * 0.6, navBox.y + navBox.height * 0.65, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
const afterZoom = await viewOf();
check("dragging with the zoom tool zooms in", afterZoom.w < beforeZoom.w * 0.8,
  `width ${beforeZoom.w.toFixed(0)} → ${afterZoom.w.toFixed(0)}`);
check("the zoomed view keeps the sheet's aspect ratio",
  Math.abs(afterZoom.w / afterZoom.h - 1400 / 900) < 0.01,
  (afterZoom.w / afterZoom.h).toFixed(4));
check("zooming leaves the circuit untouched",
  (await page.evaluate(() => window.__spiceLab.store.state.comps.length)) === 4);

await page.click("#btnFit");
await page.waitForTimeout(150);

// --- text tool places an annotation and opens an editor straight away
await page.click('#modeTools button[data-tool="text"]');
const textBox = await boxOf(page, "svg.sheet");
await page.mouse.click(textBox.x + textBox.width * 0.6, textBox.y + textBox.height * 0.3);
await page.waitForTimeout(200);
const noteEditor = await page.evaluate(() => ({
  editorOpen: !!document.querySelector(".inline-edit"),
  notes: window.__spiceLab.store.state.notes.length
}));
check("the text tool places an annotation and opens an editor", noteEditor.editorOpen && noteEditor.notes === 1,
  JSON.stringify(noteEditor));

await page.keyboard.type("Divider output taken here");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const noteSaved = await page.evaluate(() => ({
  notes: window.__spiceLab.store.state.notes.map((n) => n.text),
  onSheet: [...document.querySelectorAll('svg.sheet [data-edit="note"]')].map((n) => n.textContent),
  netlist: document.getElementById("netOut").value
}));
check("the annotation text is stored", noteSaved.notes[0] === "Divider output taken here", noteSaved.notes.join("|"));
check("the annotation is drawn on the sheet", noteSaved.onSheet.includes("Divider output taken here"));
check("annotations never reach the netlist", !noteSaved.netlist.includes("Divider"),
  noteSaved.netlist.split("\n").filter((l) => l && !l.startsWith("*")).join(" | "));
check("annotations do not become circuit nodes",
  !(await page.textContent("#checks")).includes("only one pin"));

// an annotation left empty removes itself
await page.click('#modeTools button[data-tool="text"]');
const emptyBox = await boxOf(page, "svg.sheet");
await page.mouse.click(emptyBox.x + emptyBox.width * 0.3, emptyBox.y + emptyBox.height * 0.75);
await page.waitForTimeout(200);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("an annotation left blank removes itself",
  (await page.evaluate(() => window.__spiceLab.store.state.notes.length)) === 1);

// annotations survive a save and a link
const notesRoundTrip = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  const doc = S.toDocument();
  const url = await window.__spiceLab.shareUrl(S.state);
  const viaLink = await window.__spiceLab.decodeCircuit(new URL(url).hash);
  S.clear();
  S.loadDocument(doc);
  return { viaFile: S.state.notes.map((n) => n.text), viaLink: viaLink.notes.map((n) => n.text) };
});
check("annotations survive save and open", notesRoundTrip.viaFile[0] === "Divider output taken here",
  notesRoundTrip.viaFile.join("|"));
check("annotations survive a shared link", notesRoundTrip.viaLink[0] === "Divider output taken here",
  notesRoundTrip.viaLink.join("|"));

await page.click('#modeTools button[data-tool="select"]');

/* --------------------------------------------------------- inline editing */

console.log("\n— inline editing —");
await page.evaluate(() => {
  document.getElementById("labSelect").value = "divider";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
});
await page.waitForTimeout(200);
await page.click('#modeTools button[data-tool="select"]');
await boxOf(page, "svg.sheet");

// Address R1 specifically: the first value text on the sheet belongs to V1.
const r1Id = await page.evaluate(() =>
  window.__spiceLab.store.state.comps.find((c) => c.label === "R1").id);
const valueText = page.locator(`svg.sheet [data-edit="value"][data-id="${r1Id}"]`);
await dblclickCentered(page, valueText);
const editorOpen = await page.evaluate(() => {
  const i = document.querySelector(".inline-edit");
  return i ? { value: i.value, selected: i.selectionEnd - i.selectionStart === i.value.length } : null;
});
check("double-clicking a value opens an editor on the sheet", !!editorOpen, editorOpen?.value);
check("the existing value is preselected for overtyping", !!editorOpen?.selected);

await page.keyboard.type("2.7k");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const committed = await page.evaluate(() => ({
  values: window.__spiceLab.store.state.comps.filter((c) => c.type === "R").map((c) => c.value),
  netlist: document.getElementById("netOut").value,
  editorGone: !document.querySelector(".inline-edit")
}));
check("Enter commits the new value", committed.values.includes("2.7k"), committed.values.join(","));
check("the netlist picks the change up immediately", committed.netlist.includes("2.7k"));
check("the editor closes after committing", committed.editorGone);

// Escape must abandon the edit
await dblclickCentered(page, valueText);
await page.keyboard.type("999");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const cancelled = await page.evaluate(() => ({
  values: window.__spiceLab.store.state.comps.filter((c) => c.type === "R").map((c) => c.value),
  editorGone: !document.querySelector(".inline-edit")
}));
check("Escape abandons the edit", !cancelled.values.includes("999") && cancelled.values.includes("2.7k"),
  cancelled.values.join(","));
check("the editor closes after cancelling", cancelled.editorGone);

// the label is editable the same way
const labelText = page.locator(`svg.sheet [data-edit="label"][data-id="${r1Id}"]`);
await dblclickCentered(page, labelText);
await page.keyboard.type("Rtop");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const relabelled = await page.evaluate(() => ({
  labels: window.__spiceLab.store.state.comps.map((c) => c.label),
  netlist: document.getElementById("netOut").value
}));
check("labels can be renamed in place", relabelled.labels.includes("Rtop"), relabelled.labels.join(","));
check("the old designator is gone", !relabelled.labels.includes("R1"), relabelled.labels.join(","));
check("the renamed part appears in the netlist", /^Rtop /m.test(relabelled.netlist));

// a part whose only setting is a dropdown routes to the inspector instead
const dropdownOnly = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  S.clear();
  S.edit(() => { S.addComp("D", 200, 200, "D"); S.addComp("GND", 400, 200, "GND"); }, "t");
  return S.state.comps[0].id;
});
await page.waitForTimeout(150);
await dblclickCentered(page, page.locator('svg.sheet [data-edit="value"][data-id]').first());
await page.waitForTimeout(150);
const routed = await page.evaluate(() => ({
  noEditor: !document.querySelector(".inline-edit"),
  selected: window.__spiceLab.store.selection.size === 1,
  focusInPanel: !!document.getElementById("inspector").contains(document.activeElement)
}));
check("a dropdown-only part opens the inspector instead of a text box",
  routed.noEditor && routed.selected, JSON.stringify(routed));

/* -------------------------------------------------------------- PNG export */

console.log("\n— PNG export —");
await page.evaluate(() => {
  document.getElementById("labSelect").value = "rectifier";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
});
await page.waitForTimeout(200);
await page.evaluate(async () => { await window.__spiceLab.run(); });
await page.waitForTimeout(400);

async function grabDownload(selector) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click(selector)
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  // PNG signature, then IHDR carries the dimensions
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { name: download.suggestedFilename(), bytes: buf.length, isPng,
           width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const sheetPng = await grabDownload("#btnPngSheet");
check("the schematic exports a real PNG", sheetPng.isPng, `${sheetPng.bytes} bytes`);
check("the schematic PNG is exported at print resolution", sheetPng.width > 2000,
  `${sheetPng.width}×${sheetPng.height}`);
check("the schematic filename comes from the circuit name",
  sheetPng.name === "half-wave-rectifier-schematic.png", sheetPng.name);

const plotPng = await grabDownload("#btnPngPlot");
check("the waveform plot exports a real PNG", plotPng.isPng, `${plotPng.bytes} bytes`);
check("the plot PNG has sensible dimensions", plotPng.width > 400 && plotPng.height > 200,
  `${plotPng.width}×${plotPng.height}`);
check("the plot filename comes from the circuit name",
  plotPng.name === "half-wave-rectifier-waveforms.png", plotPng.name);

/* ----------------------------------------------------- unsaved-work guard */

console.log("\n— unsaved work —");
const guard = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  S.loadCircuit({ title: "Guard test", comps: [], wires: [], analysis: {} });
  const cleanAfterLoad = !S.isDirty();
  S.edit(() => S.addComp("R", 100, 100, "R"), "t");
  return { cleanAfterLoad, dirtyAfterEdit: S.isDirty() };
});
check("a freshly loaded circuit is not marked as changed", guard.cleanAfterLoad);
check("editing marks the sheet as changed", guard.dirtyAfterEdit);

// with unsaved work, switching labs must ask before replacing it
let asked = null;
const labBeforeGuard = await page.evaluate(() => document.getElementById("labSelect").value);
page.removeAllListeners("dialog");
page.on("dialog", (d) => { asked = d.message(); d.dismiss(); });
await page.selectOption("#labSelect", "rc-lowpass");
await page.waitForTimeout(250);
const afterDismiss = await page.evaluate(() => ({
  parts: window.__spiceLab.store.state.comps.length,
  selectValue: document.getElementById("labSelect").value
}));
check("switching labs with unsaved work asks first", !!asked && /unsaved|not saved/i.test(asked),
  (asked || "no dialog").split("\n")[0]);
check("declining keeps the circuit on the sheet", afterDismiss.parts === 1, `${afterDismiss.parts} parts`);
check("declining reverts the dropdown to the lab already open",
  afterDismiss.selectValue === labBeforeGuard, `"${afterDismiss.selectValue}" (was "${labBeforeGuard}")`);

page.removeAllListeners("dialog");
page.on("dialog", (d) => d.accept());

/* --------------------------------------------------------- circuit links */

console.log("\n— shareable links —");
const link = await page.evaluate(async () => {
  const { shareUrl, decodeCircuit } = await import("./assets/" +
    [...document.querySelectorAll("script[type=module]")].map((s) => s.src.split("/").pop())[0]);
  return null;
}).catch(() => null);

const roundTripLink = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  document.getElementById("labSelect").value = "rectifier";
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  const before = { title: S.state.title, comps: S.state.comps.length, wires: S.state.wires.length, probes: S.state.probes.length };
  const url = await window.__spiceLab.shareUrl(S.state);
  const decoded = await window.__spiceLab.decodeCircuit(new URL(url).hash);
  return { before, len: url.length, hash: new URL(url).hash.slice(0, 3),
           after: { title: decoded.title, comps: decoded.comps.length, wires: decoded.wires.length, probes: decoded.probes.length } };
});
check("a circuit survives a round trip through a URL",
  JSON.stringify(roundTripLink.before) === JSON.stringify(roundTripLink.after),
  JSON.stringify(roundTripLink.after));
check("the link is compressed", roundTripLink.hash === "#c=", roundTripLink.hash);
check("the link is short enough to paste anywhere", roundTripLink.len < 2000, `${roundTripLink.len} characters`);

const damaged = await page.evaluate(async () => {
  try {
    await window.__spiceLab.decodeCircuit("#c=thisIsNotValidPayload");
    return "accepted";
  } catch (e) { return e.message; }
});
check("a truncated link gives a readable explanation", /cut short/i.test(damaged), damaged.slice(0, 80));

// open a link in a fresh page and confirm it simulates
const sharedUrl = await page.evaluate(async () => window.__spiceLab.shareUrl(window.__spiceLab.store.state));
const page2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page2.on("dialog", (d) => d.accept());
await page2.goto(sharedUrl);
await page2.waitForFunction(() => !!window.__spiceLab && window.__spiceLab.ready === true, null, { timeout: 20000 });
const opened = await page2.evaluate(async () => {
  const S = window.__spiceLab.store;
  await window.__spiceLab.run();
  const r = window.__spiceLab.getResult();
  return { title: S.state.title, parts: S.state.comps.length,
           hash: window.location.hash, points: r ? r.numPoints : 0 };
});
check("following a link opens that circuit", opened.title === "Half-wave rectifier" && opened.parts === 4,
  `${opened.title}, ${opened.parts} parts`);
check("the link payload is cleared from the address bar", opened.hash === "", `"${opened.hash}"`);
check("a shared circuit simulates in the new tab", opened.points > 100, `${opened.points} points`);
await page2.close();

/* ---------------------------------------------------- save / open cycle */

console.log("\n— documents —");
const roundTrip = await page.evaluate(() => {
  const s = window.__spiceLab.store;
  const doc = s.toDocument();
  const partsBefore = s.state.comps.length;
  s.clear();
  s.loadDocument(doc);
  return { partsBefore, partsAfter: s.state.comps.length, title: s.state.title };
});
check("save then open restores the circuit",
  roundTrip.partsBefore === roundTrip.partsAfter && roundTrip.partsAfter > 0,
  `${roundTrip.partsBefore} → ${roundTrip.partsAfter}`);

const rejects = await page.evaluate(() => {
  try { window.__spiceLab.store.loadDocument('{"format":"something-else"}'); return "accepted"; }
  catch (e) { return e.message; }
});
check("a foreign file is rejected with a readable message", rejects.includes("not a Q Circuits circuit"), rejects);

/* ------------------------------------------------------ error handling */

console.log("\n— error handling —");
// Everything after this point deliberately provokes ngspice, which writes its
// own diagnostics to the console. Snapshot the count so the clean-run
// assertion below only covers normal operation.
const errorsBeforeProvoking = consoleErrors.length;
const dangling = await page.evaluate(() => {
  const s = window.__spiceLab.store;
  s.clear();
  s.edit(() => s.addComp("R", 100, 100, "R"), "test");
  return document.querySelector("#checks").textContent;
});
check("validator warns about a dangling node before ngspice is ever asked",
  dangling.includes("only one pin") && dangling.includes("No ground"), dangling.replace(/\s+/g, " ").trim().slice(0, 110));

const errText = await page.evaluate(async () => {
  const s = window.__spiceLab.store;
  s.clear();
  s.edit(() => {
    const r = s.addComp("R", 100, 100, "R");
    r.value = "not-a-resistance";
    s.addComp("GND", 100, 100, "GND");
  }, "test");
  await window.__spiceLab.run();
  const box = document.querySelector("#runError .engine-error");
  return {
    title: box?.querySelector("h3")?.textContent || "",
    fix: box?.querySelector("p")?.textContent || "",
    culprit: box?.querySelector(".culprit")?.textContent || "",
    rawHidden: !!box?.querySelector("details pre")
  };
});
check("a rejected netlist gets a plain-language explanation", errText.title.length > 0 && errText.fix.length > 0, errText.title);
check("the explanation says what to do about it", /suffix|number/i.test(errText.fix), errText.fix.slice(0, 80));
check("the offending netlist line is quoted back", errText.culprit.includes("not-a-resistance"), errText.culprit);
check("the raw ngspice text is still available", errText.rawHidden);

// every translation pattern should match the message it was written for
const translations = await page.evaluate(() => {
  const cases = {
    "singular matrix": "Fatal error: singular matrix: check nodes 3 and 0",
    "convergence": "doAnalyses: iteration limit reached",
    "timestep": "Timestep too small; time = 1.2e-09",
    "missing model": "warning, can't find model 'blah' from line",
    "bad value": "unknown parameter (not)",
    "dangling node": "less than two connections at node 4",
    "unparsed": "Error: circuit not parsed."
  };
  const out = {};
  for (const [name, msg] of Object.entries(cases)) {
    const e = window.__spiceLab.explainEngineError(msg, "");
    out[name] = { recognised: e.recognised, title: e.title };
  }
  return out;
});
const unrecognised = Object.entries(translations).filter(([, v]) => !v.recognised).map(([k]) => k);
check("every common ngspice failure is translated", unrecognised.length === 0,
  unrecognised.length ? `missed: ${unrecognised.join(", ")}` : Object.keys(translations).length + " patterns");
check("an unknown message still gets a usable message",
  await page.evaluate(() => {
    const e = window.__spiceLab.explainEngineError("something nobody has seen before", "");
    return e.title.length > 0 && e.fix.length > 0 && e.recognised === false;
  }));

/* ------------------------------------------------------------- a11y */

console.log("\n— accessibility —");
const a11y = await page.evaluate(() => ({
  skip: !!document.querySelector(".skip-link"),
  live: document.getElementById("status")?.getAttribute("aria-live"),
  orphanLabels: [...document.querySelectorAll("label[for]")].filter((l) => !document.getElementById(l.htmlFor)).map((l) => l.htmlFor),
  namelessButtons: [...document.querySelectorAll("button")].filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label")).length,
  landmarks: ["header", "main", "footer"].filter((t) => !!document.querySelector(t))
}));
check("skip link present", a11y.skip);
check("status region is polite", a11y.live === "polite");
check("every label points at a real control", a11y.orphanLabels.length === 0, a11y.orphanLabels.join(","));
check("every button has an accessible name", a11y.namelessButtons === 0);
check("landmarks present", a11y.landmarks.length === 3, a11y.landmarks.join(","));

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("no horizontal overflow at 1440px", overflow <= 0, `${overflow}px`);

await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(300);
const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("no horizontal overflow at 390px", mobileOverflow <= 0, `${mobileOverflow}px`);

/* ------------------------------------------------------------- report */

check("no console errors during normal operation", errorsBeforeProvoking === 0, consoleErrors.slice(0, 4).join(" / "));
console.log("\n" + results.join("\n"));
if (errorsBeforeProvoking) console.log("\nunexpected console output:\n" + consoleErrors.slice(0, errorsBeforeProvoking).map(e => "  " + e).join("\n"));
console.log(`\n${pass} passed, ${fail} failed\n`);

await browser.close();
server.close();
process.exit(fail ? 1 : 0);
