/**
 * Imported lab files, end to end.
 *
 * Four existing labs are rewritten as lab files here. Each must pass against
 * the sheet its built-in twin passes against, and fail when that sheet is
 * broken — otherwise a lab file that "passes" means nothing. Bad files must be
 * refused with a message that says what is wrong.
 *
 * Run with: node test/labfile.mjs   (after npm run build)
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5219;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = join(ROOT, normalize(rel === "/" ? "/index.html" : rel));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

// PW_CHROME lets the suite run against a Chromium that is already on the
// machine, instead of the one Playwright downloads.
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__spiceLab?.ready === true, null, { timeout: 20000 });

/* The lab files under test: the same work as the built-in labs they mirror. */
const FILES = {
  "file-07a": {
    format: "q-circuits-lab", version: 1,
    id: "file-07a", code: "T7A", group: "Test labs", kind: "draw",
    title: "T7A · DC sweep", summary: "A lab file version of 7A.",
    tasks: ["Draw the series circuit.", "Sweep VS from -12 to 12."],
    useStudentAnalysis: true,
    checks: [
      { title: "T7A" },
      { parts: { VS: { dc: 12, type: "V" }, R1: "100", R2: "300" } },
      { wiring: [["VS", ["A", "0"], true], ["R1", ["A", "B"]], ["R2", ["B", "0"]]] },
      { noOpenEnds: true },
      { analysis: { dc: { src: "VS", start: -12, stop: 12, step: 0.1 } } },
      { probe: { at: "B" } },
      { expect: { value: "v(B) @ 12", is: 9, tol: 0.02, label: "V(B) reaches 9 V" } }
    ],
    questions: [
      { id: "vhi", prompt: "V(B) when VS = 12, in volts", value: "v(B) @ 12", abs: 0.05 },
      { id: "vlo", prompt: "V(B) when VS = -12, in volts", value: "v(B) @ -12", abs: 0.05 },
      { id: "nodes", prompt: "Nodes above ground", value: "nodes()", abs: 0 }
    ]
  },
  "file-08a": {
    format: "q-circuits-lab", version: 1,
    id: "file-08a", code: "T8A", group: "Test labs", kind: "draw",
    title: "T8A · AC sweep", summary: "A lab file version of 8A.",
    tasks: ["Draw the RC circuit and sweep it."],
    useStudentAnalysis: true,
    reference: { type: "ac", acPts: "50", acStart: "1", acStop: "100k" },
    checks: [
      { parts: { VS: { dc: 0, ac: 1, type: "V" }, R1: "1k", C1: "1u" } },
      { analysis: { ac: { start: 1, stop: "100k", pts: 201 } } },
      { probe: { at: "B" } },
      { dbMode: true },
      { axis: { xMin: 1, xMax: "10k", yMin: -20, yMax: 0 } }
    ],
    questions: [
      { id: "fc", prompt: "Critical frequency, in Hz", value: "corner(B, upper)", rel: 0.05 },
      { id: "flat", prompt: "Mid-band level, in dB", value: "peak(B)", abs: 0.3 }
    ]
  },
  "file-09a": {
    format: "q-circuits-lab", version: 1,
    id: "file-09a", code: "T9A", group: "Test labs", kind: "draw",
    title: "T9A · Transient", summary: "A lab file version of 9A.",
    tasks: ["Draw the pulse circuit."],
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "1.2n", trStop: "1.2u" },
    checks: [
      { analysis: { tran: { stop: "1.2u", maxStep: "1.2n" } } },
      { diffProbe: { plus: "IN", minus: "OUT" } }
    ],
    questions: [
      { id: "dmax", prompt: "Most positive V(IN,OUT)", value: "max(v(IN,OUT))", rel: 0.05 },
      { id: "dmin", prompt: "Most negative V(IN,OUT)", value: "min(v(IN,OUT))", rel: 0.05, abs: 0.02 },
      { id: "late", prompt: "V(OUT) at 1 microsecond", value: "v(OUT) @ 1u", abs: 0.05 }
    ]
  },
  "file-10a": {
    format: "q-circuits-lab", version: 1,
    id: "file-10a", code: "T10A", group: "Test labs", kind: "draw",
    title: "T10A · OR gate", summary: "A lab file version of 10A.",
    tasks: ["Draw the gate and its stimuli."],
    useStudentAnalysis: true,
    reference: { type: "tran", trStep: "0.05m", trStop: "8m" },
    checks: [
      { parts: { U1A: { type: "GATE2", fields: { device: "7432" } } } },
      { gate: { part: "U1A", inputs: ["A", "B"], out: "Q" } },
      { analysis: { tran: { stop: "8m", maxStep: "0.8m" } } },
      { probeOrder: ["A", "B", "Q"] },
      { stim: { part: "DSTM1", commands: "0s 0; 1m 1; 2m 0; 3m 1; 4m 0; 5m 1; 6m 0; 7m 1", until: "8m" } }
    ],
    questions: [
      { id: "tt00", prompt: "Q when A = 0, B = 0", value: "logicWhile(Q, A=0, B=0)", abs: 0 },
      { id: "tt01", prompt: "Q when A = 0, B = 1", value: "logicWhile(Q, A=0, B=1)", abs: 0 },
      { id: "tt11", prompt: "Q when A = 1, B = 1", value: "logicWhile(Q, A=1, B=1)", abs: 0 }
    ]
  }
};

/* Import each file, then mark it against the twin lab's reference drawing. */
await page.evaluate((files) => { window.__files = files; }, FILES);

async function importFile(key) {
  return page.evaluate((k) => {
    const lab = window.__spiceLab.labs.acceptLab(window.__files[k]);
    return lab ? { id: lab.id, title: lab.title, checks: lab.checks.length, questions: lab.questions.length } : null;
  }, key);
}

async function markAgainst(fileId, twinId, answers, title) {
  return page.evaluate(async ({ fileId, twinId, answers, title }) => {
    const L = window.__spiceLab;
    const lab = L.labs.labById(fileId);
    const twin = L.labs.labById(twinId);
    L.store.loadCircuit({ ...L.labs.diagramFor(twin), title });
    L.store.edit((s) => {
      Object.assign(s.analysis, twin.reference || {}, lab.source.analysisOverride || {});
      if (twin.id === "e101-08a") Object.assign(s.analysis, { type: "ac", acStart: "1", acStop: "100k", acPts: "201" });
      if (twin.id === "e101-07a") Object.assign(s.analysis, { type: "dc", dcSrc: "VS", dcStart: "-12", dcStop: "12", dcStep: "0.1" });
      if (twin.id === "e101-09a") Object.assign(s.analysis, { type: "tran", trStop: "1.2u", trStep: "1.2n" });
      if (twin.id === "e101-10a") Object.assign(s.analysis, { type: "tran", trStop: "8m", trStep: "0.8m" });
      if (twin.id === "e101-08a") Object.assign(s.plot, { mode: "db", xMin: "1", xMax: "10k", yMin: "-20", yMax: "0" });
      s.answers = {};
    }, "t");
    const first = await L.labs.runChecks(lab, L.store);
    // Fill the answers the lab asks for, from the same simulation.
    const wanted = {};
    first.results.filter((r) => r.answer).forEach((r) => { /* prompts only */ void r; });
    L.store.edit((s) => { s.answers = answers; }, "t");
    const out = await L.labs.runChecks(lab, L.store);
    return { ok: out.ok, failed: out.results.filter((r) => !r.pass).map((r) => `${r.label}: ${r.detail}`), n: out.results.length, error: out.error };
  }, { fileId, twinId, answers, title });
}

console.log("\n— importing —");
for (const key of Object.keys(FILES)) {
  const got = await importFile(key);
  check(`${key}: compiles and registers`, !!got, got ? `${got.checks} checks, ${got.questions} answers` : "rejected");
}
const listed = await page.evaluate(() => [...document.querySelectorAll("#labSelect optgroup")].map((g) => g.label));
check("imported labs appear in their own group", listed.includes("Test labs"), listed.join(" | "));

console.log("\n— marking against the reference drawings —");
const r7 = await markAgainst("file-07a", "e101-07a", { vhi: "9", vlo: "-9", nodes: "2" }, "LAB T7A");
check("file-07a: passes every check", r7.ok, r7.error || r7.failed.join(" | "));

const r8 = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const lab = L.labs.labById("file-08a"), twin = L.labs.labById("e101-08a");
  L.store.loadCircuit({ ...L.labs.diagramFor(twin), title: "LAB T8A" });
  L.store.edit((s) => {
    Object.assign(s.analysis, { type: "ac", acStart: "1", acStop: "100k", acPts: "201" });
    Object.assign(s.plot, { mode: "db", xMin: "1", xMax: "10k", yMin: "-20", yMax: "0" });
  }, "t");
  const dry = await L.labs.runChecks(lab, L.store);
  // Read the two answers out of the reference run, as a student would read the plot.
  const ref = await L.simulate(L.store.state, null, { ...L.store.state.analysis, acPts: "50" });
  const trace = ref.traces.find((t) => t.name.toLowerCase().startsWith("v(b)"));
  const c = L.labs.corners(trace, ref.sweep.values);
  L.store.edit((s) => { s.answers = { fc: String(c.hi), flat: String(c.peak) }; }, "t");
  const out = await L.labs.runChecks(lab, L.store);
  return { ok: out.ok, failed: out.results.filter((r) => !r.pass).map((r) => `${r.label}: ${r.detail}`), fc: c.hi, peak: c.peak, dry: dry.results.filter((r) => !r.pass).length };
});
check("file-08a: passes every check", r8.ok, r8.failed.join(" | "));
check("file-08a: corner() reads the 159 Hz corner", Math.abs(r8.fc - 159.15) < 5, String(r8.fc));
check("file-08a: peak() reads the flat level", Math.abs(r8.peak) < 0.2, String(r8.peak));
check("file-08a: the answers are not free", r8.dry > 0, `${r8.dry} checks fail before the answers are entered`);

const r9 = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const lab = L.labs.labById("file-09a"), twin = L.labs.labById("e101-09a");
  L.store.loadCircuit({ ...L.labs.diagramFor(twin), title: "LAB T9A" });
  L.store.edit((s) => { Object.assign(s.analysis, { type: "tran", trStop: "1.2u", trStep: "1.2n" }); }, "t");
  const ref = await L.simulate(L.store.state, null, { ...L.store.state.analysis });
  const t = ref.traces.find((x) => x.name.toLowerCase() === "v(in,out)");
  const out0 = ref.traces.find((x) => x.name.toLowerCase() === "v(out)");
  const ts = ref.sweep.values;
  let k = 0; while (k < ts.length - 1 && ts[k + 1] <= 1e-6) k++;
  const answers = { dmax: String(Math.max(...t.values)), dmin: String(Math.min(...t.values)), late: String(out0.values[k]) };
  L.store.edit((s) => { s.answers = answers; }, "t");
  const outc = await L.labs.runChecks(lab, L.store);
  return { ok: outc.ok, failed: outc.results.filter((r) => !r.pass).map((r) => `${r.label}: ${r.detail}`), answers };
});
check("file-09a: max(), min() and a timed reading all mark correctly", r9.ok, r9.failed.join(" | "));
check("file-09a: max(v(IN,OUT)) is the 4.27 V spike", Math.abs(+r9.answers.dmax - 4.27) < 0.15, r9.answers.dmax);

const r10 = await markAgainst("file-10a", "e101-10a", { tt00: "0", tt01: "1", tt11: "1" }, "LAB T10A");
check("file-10a: logicWhile() builds the OR truth table", r10.ok, r10.error || r10.failed.join(" | "));
const r10bad = await page.evaluate(async () => {
  const L = window.__spiceLab;
  L.store.edit((s) => { s.answers = { tt00: "1", tt01: "1", tt11: "1" }; }, "t");
  const out = await L.labs.runChecks(L.labs.labById("file-10a"), L.store);
  return out.results.filter((r) => !r.pass).map((r) => `${r.label}: ${r.detail}`).join(" | ");
});
check("file-10a: a wrong truth-table row is marked wrong", /A = 0, B = 0/.test(r10bad), r10bad.slice(0, 120));
check("file-10a: and the right answer is not revealed", !/should be|expected 0\b/.test(r10bad), r10bad.slice(0, 160));

console.log("\n— the checks really check —");
const broken = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const twin = L.labs.labById("e101-07a");
  L.store.loadCircuit({ ...L.labs.diagramFor(twin), title: "LAB T7A" });
  L.store.edit((s) => {
    Object.assign(s.analysis, { type: "dc", dcSrc: "VS", dcStart: "-12", dcStop: "12", dcStep: "0.1" });
    s.answers = { vhi: "9", vlo: "-9", nodes: "2" };
    const r = s.comps.find((c) => c.label === "R2");
    r.value = "600";                       // a wrong value the file must catch
  }, "t");
  const out = await L.labs.runChecks(L.labs.labById("file-07a"), L.store);
  return out.results.filter((r) => !r.pass).map((r) => `${r.label}: ${r.detail}`).join(" | ");
});
check("a wrong part value fails the parts rule", /R2 is 600/.test(broken), broken.slice(0, 120));
check("and the simulated expectation fails too", /9 V|comes out at/.test(broken), broken.slice(0, 200));

console.log("\n— refusing bad files —");
const bad = await page.evaluate(() => {
  const L = window.__spiceLab;
  const tries = {
    notLab: { format: "something-else", id: "x", title: "x" },
    noId: { format: "q-circuits-lab", version: 1, title: "No id" },
    unknownRule: { format: "q-circuits-lab", version: 1, id: "b1", title: "b", checks: [{ shortCircuit: true }] },
    badExpr: { format: "q-circuits-lab", version: 1, id: "b2", title: "b", questions: [{ id: "q", prompt: "p", value: "fetch(x)" }] },
    badPart: { format: "q-circuits-lab", version: 1, id: "b3", title: "b", circuit: { comps: [{ type: "FLUX", x: 0, y: 0 }] } },
    newer: { format: "q-circuits-lab", version: 99, id: "b4", title: "b" },
    twoRules: { format: "q-circuits-lab", version: 1, id: "b5", title: "b", checks: [{ noOpenEnds: true, dbMode: true }] }
  };
  const out = {};
  Object.entries(tries).forEach(([k, doc]) => {
    const before = L.labs.allLabs().length;
    const lab = L.labs.acceptLab(doc, { store: false });
    out[k] = { rejected: !lab, registered: L.labs.allLabs().length - before,
      msg: document.getElementById("labImportMsg").textContent };
  });
  return out;
});
check("a file that is not a lab is refused", bad.notLab.rejected && /not a lab|says it is/.test(bad.notLab.msg), bad.notLab.msg.slice(0, 90));
check("a file with no id is refused", bad.noId.rejected);
check("an unknown rule is named in the message", bad.unknownRule.rejected && /no rule called "shortCircuit"/.test(bad.unknownRule.msg), bad.unknownRule.msg.slice(0, 120));
check("an expression that is not a reading is refused", bad.badExpr.rejected && /no reading called fetch/.test(bad.badExpr.msg), bad.badExpr.msg.slice(0, 120));
check("an unknown part type is refused", bad.badPart.rejected && /no part type called FLUX/.test(bad.badPart.msg), bad.badPart.msg.slice(0, 120));
check("a file from a newer version is refused", bad.newer.rejected && /newer version/.test(bad.newer.msg), bad.newer.msg.slice(0, 120));
check("two rules in one check are refused", bad.twoRules.rejected, bad.twoRules.msg.slice(0, 120));
check("nothing broken is ever registered", Object.values(bad).every((b) => b.registered === 0));

console.log("\n— keeping and sharing —");
const kept = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.labs.acceptLab(window.__files["file-07a"]);
  const stored = L.store.readImportedLabs();
  return { ids: Object.keys(stored), hasDoc: !!stored["file-07a"]?.doc?.checks };
});
check("an imported lab is stored for next time", kept.ids.includes("file-07a") && kept.hasDoc, kept.ids.join(", "));

await page.reload();
await page.waitForFunction(() => window.__spiceLab?.ready === true, null, { timeout: 20000 });
await page.evaluate((files) => { window.__files = files; }, FILES);
const afterReload = await page.evaluate(() => ({
  present: !!window.__spiceLab.labs.labById("file-07a"),
  listed: [...document.querySelectorAll("#labSelect optgroup")].map((g) => g.label).includes("Test labs")
}));
check("it is still there after a reload", afterReload.present && afterReload.listed, JSON.stringify(afterReload));

const link = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const url = await L.labUrl(window.__files ? window.__files["file-10a"] : null, "http://localhost:5219/");
  const back = await L.decodeLab(new URL(url).hash);
  return { length: url.length, id: back?.id, checks: back?.checks?.length };
});
check("a lab travels in a link and comes back whole", link.id === "file-10a" && link.checks === 5, JSON.stringify(link));

const removed = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.store.removeImportedLab("file-07a");
  return { stored: Object.keys(L.store.readImportedLabs()) };
});
check("removing an imported lab clears it from storage", !removed.stored.includes("file-07a"), removed.stored.join(", "));

check("no page errors", errors.length === 0, errors.join(" / "));

console.log(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
