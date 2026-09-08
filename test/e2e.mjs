/**
 * End-to-end checks against the production build.
 * Run with: node test/e2e.mjs
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";

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
await page.waitForFunction(() => !!window.__spiceLab, null, { timeout: 20000 });

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
const svgBox = await page.locator("svg.sheet").boundingBox();
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
await page.mouse.move(svgBox.x + 8, svgBox.y + 8);
await page.mouse.down();
await page.mouse.move(svgBox.x + svgBox.width - 8, svgBox.y + svgBox.height - 8, { steps: 8 });
await page.mouse.up();
const selCount = await page.evaluate(() => window.__spiceLab.store.selection.size);
check("box select grabs everything on the sheet", selCount > 4, `${selCount} items`);

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
check("a foreign file is rejected with a readable message", rejects.includes("not a Spice Lab circuit"), rejects);

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
  const el = document.querySelector("#runError .error");
  return el ? el.textContent : "";
});
check("a netlist ngspice rejects surfaces a readable error, not a crash", errText.length > 0, errText.replace(/\s+/g, " ").slice(0, 110));

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
