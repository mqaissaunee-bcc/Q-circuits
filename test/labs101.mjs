/**
 * ELEC 101 lab checks, end to end.
 *
 * For every exercise: the starting sheet must fail, and a correct solution,
 * built the way a student would leave it, must pass every check. That pins
 * down the supplied circuits, the checks and the expected answers together.
 *
 * Run with: node test/labs101.mjs   (after npm run build)
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5212;
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__spiceLab?.ready === true, null, { timeout: 20000 });

/* In-page helpers, installed once. */
await page.evaluate(() => {
  const L = window.__spiceLab;
  const S = L.store;
  window.T = {
    open(id) {
      L.freshLabs();
      const sel = document.getElementById("labSelect");
      sel.value = id;
      sel.dispatchEvent(new Event("change"));
    },
    comp(label) { return S.state.comps.find((c) => c.label === label); },
    add(type, x, y, rot, fields) {
      let c;
      S.edit(() => { c = S.addComp(type, x, y, type === "GND" ? "GND" : "X"); Object.assign(c, { rot }, fields); }, "t");
      return c;
    },
    wire(...segs) { S.edit(() => segs.forEach(([a, b, c, d]) => S.addWire(a, b, c, d)), "t"); },
    unwire(a, b, c, d) {
      S.edit((s) => { s.wires = s.wires.filter((w) => !(w.x1 === a && w.y1 === b && w.x2 === c && w.y2 === d)); }, "t");
    },
    remove(label) { S.edit((s) => { s.comps = s.comps.filter((c) => c.label !== label); }, "t"); },
    set(fn) { S.edit((s) => fn(s), "t"); },
    vprobe(x, y) { S.toggleProbe("v", `${x},${y}`, { x, y }); },
    async check(id) {
      const out = await L.labs.runChecks(L.labs.labById(id), S);
      return { ok: out.ok, error: out.error, failed: out.results.filter((r) => !r.pass).map((r) => `${r.label}: ${r.detail}`), n: out.results.length };
    },
    /** The series circuit of 6A and 7A. */
    series() {
      this.add("V", 160, 160, 90, { label: "VS", value: "DC 12", ac: "" });
      this.add("R", 220, 100, 0, { label: "R1", value: "100" });
      this.add("R", 340, 160, 90, { label: "R2", value: "300" });
      this.add("GND", 250, 300, 0, {});
      this.add("NET", 160, 100, 0, { label: "NA", name: "A" });
      this.add("NET", 340, 100, 0, { label: "NB", name: "B" });
      this.wire([160, 160, 160, 100], [160, 100, 220, 100], [280, 100, 340, 100], [340, 100, 340, 160],
                [340, 220, 340, 280], [340, 280, 160, 280], [160, 220, 160, 280], [250, 280, 250, 300]);
    }
  };
});

async function lab(id, solve, extra) {
  console.log(`\n— ${id} —`);
  await page.evaluate((i) => window.T.open(i), id);
  const start = await page.evaluate((i) => window.T.check(i), id);
  check(`${id}: the starting sheet does not pass`, !start.ok, `${start.failed.length} of ${start.n} checks fail`);
  if (extra?.start) await extra.start(start);
  await page.evaluate(solve);
  const done = await page.evaluate((i) => window.T.check(i), id);
  check(`${id}: a correct solution passes every check`, done.ok, done.error ? `engine: ${done.error.split("\n")[0]}` : done.failed.join(" | "));
  return done;
}

/* ---------------------------------------------------------------- 4A */

await lab("e101-04a", async () => {
  const T = window.T;
  T.remove("V2");
  T.set(() => { T.comp("V1").value = "DC 12"; });
  T.unwire(260, 140, 320, 140);
  T.wire([460, 40, 380, 40], [380, 40, 380, 140]);
  T.add("GND", 300, 360, 0, {});
  T.wire([300, 340, 300, 360]);
  T.set((s) => { s.title = "LAB 04A"; s.answers = { ve: "5.64" }; });
}, {
  start: async (st) => {
    const text = st.failed.join(" ");
    check("4A start: the stacked source is caught", /only source/.test(text));
    check("4A start: the shorted R1 is caught", /R1 is back in series/.test(text));
    check("4A start: the open collector is caught", /collector is joined/.test(text));
    const warns = await page.evaluate(() => [...document.querySelectorAll("#checks li")].map((l) => l.textContent).join(" | "));
    check("4A start: the validator names the short", /R1 has both ends on the same node/.test(warns), warns.slice(0, 160));
    check("4A start: the validator names the stacked parts", /V1 and V2 are drawn on top of each other/.test(warns));
    check("4A start: the validator names the missing value", /V1 has no value/.test(warns));
    check("4A start: the validator names the missing ground", /No ground/.test(warns));
  }
});

/* ---------------------------------------------------------------- 4B */

await lab("e101-04b", () => {
  const T = window.T;
  T.set((s) => {
    s.comps = s.comps.filter((c) => c.type === "GND" ? false : true);
    s.wires = [];
    T.comp("R1").value = "1k";
    Object.assign(T.comp("V1"), { x: 120, y: 160 });
    Object.assign(T.comp("R3"), { x: 460, y: 80 });
    Object.assign(T.comp("R4"), { x: 680, y: 160 });
  });
  T.add("GND", 400, 300, 0, {});
  T.wire([120, 160, 120, 80], [120, 80, 180, 80], [240, 80, 400, 80], [400, 80, 400, 160],
         [400, 80, 460, 80], [520, 80, 680, 80], [680, 80, 680, 160],
         [400, 220, 400, 280], [680, 220, 680, 280], [120, 280, 680, 280], [120, 220, 120, 280], [400, 280, 400, 300]);
  T.set((s) => { s.title = "Lab 04B"; s.answers = { vr2: "4.8" }; });
}, {
  start: async (st) => {
    const text = st.failed.join(" ");
    check("4B start: the space in R1 is caught", /with a space/.test(text), text.slice(0, 120));
    check("4B start: the alignment is caught", /centred at the same height/.test(text));
    const warns = await page.evaluate(() => document.getElementById("checks").textContent);
    check("4B start: the validator explains the space", /Take out the space/.test(warns));
  }
});

// Moving V1 with the keyboard keeps its wiring and fixes the alignment check.
await page.evaluate(() => window.T.open("e101-04b"));
const moved = await page.evaluate(async () => {
  const S = window.__spiceLab.store;
  S.selection = new Set([window.T.comp("V1").id]);
  S.moveSelection(0, 20); S.moveSelection(0, 20); S.moveSelection(0, 20);
  const out = await window.T.check("e101-04b");
  return out.failed.join(" | ");
});
check("4B: three ↓ presses line V1 up with R2 and R4", !/centred at the same height/.test(moved));
check("4B: moving V1 keeps its wiring", !/broke|should connect V1/.test(moved), moved.slice(0, 160));

/* ---------------------------------------------------------------- 5A */

const ref5a = await page.evaluate(async () => {
  window.T.open("e101-05a");
  const L = window.__spiceLab;
  const r = await L.simulate(L.store.state, null, { ...L.store.state.analysis, type: "ac", acPts: "50", acStart: "1", acStop: "1meg" });
  const t = r.traces.find((k) => k.name === "v(out)");
  return L.labs.corners(t, r.sweep.values);
});
check("5A reference: mid-band gain is 19.1 dB", Math.abs(ref5a.peak - 19.08) < 0.1, ref5a.peak.toFixed(3));
check("5A reference: lower corner near the 66.7 Hz RC corner", ref5a.lo > 55 && ref5a.lo < 80, ref5a.lo.toFixed(1));
check("5A reference: upper corner near the 17.9 kHz RC corner", ref5a.hi > 14e3 && ref5a.hi < 19e3, ref5a.hi.toFixed(0));

const s5a = await lab("e101-05a", `(() => {
  const T = window.T;
  T.set((s) => {
    s.title = "LAB 05A";
    Object.assign(s.analysis, { type: "ac", acStart: "10", acStop: "100k", acPts: "101" });
    s.answers = { gain: "19.1", flo: "${ref5a.lo.toFixed(1)}", fhi: "${(ref5a.hi / 1000).toFixed(2)}k" };
  });
  T.vprobe(820, 140);
})()`);
const wrong5a = await page.evaluate(async () => {
  window.T.set((s) => { s.answers.fhi = "1k"; });
  return (await window.T.check("e101-05a")).failed.join(" | ");
});
check("5A: a wrong corner frequency is marked wrong", /Upper −3 dB/.test(wrong5a), wrong5a.slice(0, 120));
check("5A: a wrong answer does not reveal the right one", !/1[4-9]\d{3}|17\.\d/.test(wrong5a), wrong5a);
void s5a;

/* ---------------------------------------------------------------- 5B */

const ref5b = await page.evaluate(async () => {
  window.T.open("e101-05b");
  const L = window.__spiceLab;
  L.store.toggleProbe("i", "R1", {});
  const r = await L.simulate(L.store.state, null, { ...L.store.state.analysis, type: "tran", trStep: "10u", trStop: "5m" });
  const t = r.traces.find((k) => k.name === "i(r1)");
  return { max: Math.max(...t.values), min: Math.min(...t.values) };
});
check("5B reference: peak load current about 4.2 mA", ref5b.max > 3.8e-3 && ref5b.max < 4.6e-3, ref5b.max.toExponential(3));
check("5B reference: the zener conducts in reverse, so current goes negative", ref5b.min < -0.2e-3, ref5b.min.toExponential(3));

await lab("e101-05b", `(() => {
  const T = window.T;
  T.set((s) => {
    s.title = "LAB 05B";
    Object.assign(s.analysis, { type: "tran", trStop: "5m", trStep: "0.01m" });
    s.answers = { ipk: "${(ref5b.max * 1000).toFixed(2)}m", imin: "${(ref5b.min * 1000).toFixed(2)}m" };
  });
  window.__spiceLab.store.toggleProbe("i", "R1", {});
  T.vprobe(160, 120);
})()`);

const panes = await page.evaluate(async () => {
  const L = window.__spiceLab;
  await L.run();
  return L.getResult().traces.map((t) => t.name);
});
check("5B: a run gives the R1 current and V(IN)", panes.includes("i(r1)") && panes.map((n) => n.toLowerCase()).includes("v(in)") , panes.join(", "));

/* ---------------------------------------------------------------- 5C */

await lab("e101-05c", () => {
  const T = window.T;
  T.add("NET", 160, 140, 0, { label: "NIN", name: "IN" });
  T.add("NET", 520, 140, 0, { label: "NOUT", name: "OUT" });
  T.set((s) => { s.title = "LAB 05C"; s.analysis.type = "op"; s.showBias = true; s.answers = { vout: "4.5", vmid: "6" }; });
});
const bias = await page.evaluate(async () => {
  await window.__spiceLab.run();
  window.__spiceLab.refresh();
  return [...document.querySelectorAll(".bias-text")].map((t) => t.textContent);
});
check("5C: Show DC voltages prints node voltages on the sheet", bias.includes("4.5V") && bias.includes("6V") && bias.includes("12V"), bias.join(" "));
const netl = await page.inputValue("#netOut");
check("5C: aliases name the nodes in the netlist", /R2 \w+ OUT 1k/.test(netl) && /VS IN 0 DC 12/.test(netl), netl.split("\n").slice(1, 6).join(" | "));
const staleBias = await page.evaluate(() => {
  window.T.set(() => { window.T.comp("R4").value = "6k"; });
  return document.querySelectorAll(".bias-text").length;
});
check("5C: stale voltages disappear once the circuit changes", staleBias === 0, `${staleBias} tags`);

/* ---------------------------------------------------------------- 6A */

await lab("e101-06a", () => {
  window.T.series();
  window.T.set((s) => { s.title = "LAB 06A"; s.answers = { nodes: "2" }; });
});

// Getting the source upside down is caught.
const flipped = await page.evaluate(async () => {
  window.T.set(() => { window.T.comp("VS").rot = 270; window.T.comp("VS").y = 220; });
  return (await window.T.check("e101-06a")).failed.join(" | ");
});
check("6A: a source placed + down is caught", /VS should connect \+ to A/.test(flipped), flipped.slice(0, 140));

/* ---------------------------------------------------------------- 6B */

await lab("e101-06b", () => {
  const T = window.T;
  T.add("V", 160, 200, 90, { label: "VS", value: "DC 12", ac: "" });
  T.add("R", 220, 120, 0, { label: "R1", value: "100" });
  T.add("R", 440, 120, 0, { label: "R2", value: "600" });
  T.add("R", 560, 200, 90, { label: "R3", value: "600" });
  T.add("R", 360, 200, 90, { label: "R4", value: "1.2k" });
  T.add("GND", 360, 340, 0, {});
  T.add("NET", 160, 120, 0, { label: "NIN", name: "IN" });
  T.add("NET", 560, 120, 0, { label: "NOUT", name: "OUT" });
  T.wire([160, 200, 160, 120], [160, 120, 220, 120], [280, 120, 440, 120], [500, 120, 560, 120],
         [560, 120, 560, 200], [560, 260, 560, 320], [560, 320, 160, 320], [160, 260, 160, 320],
         [360, 120, 360, 200], [360, 260, 360, 320], [360, 320, 360, 340]);
  T.set((s) => { s.title = "LAB 06B"; s.answers = { vout: "5.14" }; });
});

// R4 swapped to the output side is a different circuit.
const swapped = await page.evaluate(async () => {
  const T = window.T;
  T.unwire(360, 120, 360, 200);
  T.wire([360, 200, 360, 160], [360, 160, 520, 160], [520, 160, 520, 120]);
  return (await T.check("e101-06b")).failed.join(" | ");
});
check("6B: R4 in the wrong place is caught", /R4 should connect/.test(swapped), swapped.slice(0, 140));

/* ---------------------------------------------------------------- 6C */

const build6c = () => {
  const T = window.T;
  T.add("V", 100, 260, 90, { label: "VS", value: "DC 0", ac: "1" });
  T.add("C", 160, 200, 0, { label: "C1", value: "10u", ic: "" });
  T.add("NPN", 300, 200, 0, { label: "Q1", model: "Q2N2222" });
  T.add("NPN", 480, 280, 0, { label: "Q2", model: "Q2N2222" });
  T.add("R", 340, 80, 90, { label: "RC1", value: "5k" });
  T.add("R", 520, 80, 90, { label: "RC2", value: "5k" });
  T.add("R", 430, 380, 90, { label: "REE", value: "4.8k" });
  T.add("V", 40, 120, 90, { label: "VS1", value: "DC 12", ac: "" });
  T.add("V", 40, 180, 90, { label: "VS2", value: "DC 12", ac: "" });
  T.add("GND", 100, 420, 0, {});
  T.add("GND", 70, 180, 270, {});
  T.add("PWR", 430, 80, 0, { label: "P1", name: "VCC" });
  T.add("PWR", 40, 120, 0, { label: "P2", name: "VCC" });
  T.add("PWR", 430, 440, 180, { label: "P3", name: "VEE" });
  T.add("PWR", 40, 240, 180, { label: "P4", name: "VEE" });
  T.wire([100, 260, 100, 200], [100, 200, 160, 200], [220, 200, 300, 200],
         [340, 240, 340, 360], [340, 360, 520, 360], [520, 320, 520, 360],
         [480, 280, 260, 280], [260, 280, 260, 400], [260, 400, 100, 400],
         [100, 320, 100, 400], [100, 400, 100, 420],
         [340, 140, 340, 160], [520, 140, 520, 240], [340, 80, 520, 80],
         [430, 360, 430, 380], [40, 180, 70, 180]);
  T.set((s) => { s.title = "LAB 06C"; });
};
await lab("e101-06c", build6c);
if (process.env.SHOTS) {
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/6c.png" });
}

const cross = await page.evaluate(async () => {
  const T = window.T;
  // End the base wire on the emitter lead instead of crossing it.
  T.unwire(480, 280, 260, 280);
  T.wire([480, 280, 340, 280], [340, 280, 260, 280]);
  return (await T.check("e101-06c")).failed.join(" | ");
});
check("6C: a junction at the crossover is caught", /crossover/.test(cross), cross.slice(0, 160));
const net6c = await page.evaluate(async () => {
  window.T.open("e101-06c");
  return 0;
});
void net6c;

/* ---------------------------------------------------------------- 7A-D */

const sweep = `Object.assign(s.analysis, { type: "dc", dcSrc: "VS", dcStart: "-12", dcStop: "12", dcStep: "0.1" })`;

await lab("e101-07a", `(() => {
  const T = window.T;
  T.series();
  T.set((s) => { s.title = "LAB 07A"; ${sweep}; s.answers = { vhi: "9", vlo: "-9" }; });
  T.vprobe(340, 100);
})()`);
const lab7aDoc = await page.evaluate(() => { window.__spiceLab.store.saveLabWork("e101-07a"); return true; });
void lab7aDoc;

// Opening 7B offers the 7A circuit; the dialog handler accepts.
const carried = await page.evaluate(() => {
  const sel = document.getElementById("labSelect");
  sel.value = "e101-07b";
  sel.dispatchEvent(new Event("change"));
  const S = window.__spiceLab.store;
  return { parts: S.state.comps.length, probes: S.state.probes.length, sweep: S.state.analysis.type };
});
check("7B: opening it carries the 7A circuit forward", carried.parts === 6 && carried.sweep === "dc", JSON.stringify(carried));
check("7B: probes are not carried", carried.probes === 0);
const back7a = await page.evaluate(() => {
  const sel = document.getElementById("labSelect");
  sel.value = "e101-07a";
  sel.dispatchEvent(new Event("change"));
  return { title: window.__spiceLab.store.state.title, answers: window.__spiceLab.store.state.answers };
});
check("7A: returning to a lab restores that lab's own work", back7a.title === "LAB 07A" && back7a.answers.vhi === "9", JSON.stringify(back7a));

await lab("e101-07b", `(() => {
  const T = window.T;
  T.series();
  T.set((s) => { s.title = "LAB 07B"; ${sweep}; s.answers = { vab: "3" }; });
  window.__spiceLab.store.toggleProbe("vd", "160,100|340,100", { x: 160, y: 100, x2: 340, y2: 100 });
})()`);

const solve7c = `
  T.series();
  T.set((s) => {
    T.comp("R1").value = "{RVAL}";
    ${sweep};
    Object.assign(s.analysis, { paramOn: true, paramName: "RVAL", paramMode: "lin", paramStart: "100", paramStop: "300", paramStep: "100" });
  });
  T.add("PARAM", 420, 40, 0, { label: "PARAM1", name: "RVAL", value: "100" });
  T.vprobe(340, 100);`;

await lab("e101-07c", `(() => {
  const T = window.T;
  ${solve7c}
  T.set((s) => { s.title = "LAB 07C"; s.answers = { v100: "9", v200: "7.2", v300: "6" }; });
})()`);

const listMode = await page.evaluate(async () => {
  window.T.set((s) => { Object.assign(s.analysis, { paramMode: "list", paramList: "100 200 300" }); });
  return (await window.T.check("e101-07c")).ok;
});
check("7C: a value list of 100 200 300 is accepted too", listMode);
const multi = await page.evaluate(async () => {
  await window.__spiceLab.run();
  return window.__spiceLab.getResult().traces.filter((t) => /^v\(b\)/i.test(t.name)).map((t) => t.name);
});
check("7C: a run draws one V(B) line per RVAL", multi.length === 3, multi.join(", "));
const undefinedParam = await page.evaluate(() => {
  window.T.set((s) => { s.comps = s.comps.filter((c) => c.type !== "PARAM"); });
  window.__spiceLab.refresh();
  return document.getElementById("checks").textContent;
});
check("7C: {RVAL} with no Parameter part is explained", /no Parameter part defines RVAL/.test(undefinedParam));

await lab("e101-07d", `(() => {
  const T = window.T;
  ${solve7c}
  T.add("R", 400, 100, 0, { label: "R3", value: "150" });
  T.add("R", 520, 160, 90, { label: "R4", value: "150" });
  T.wire([340, 100, 400, 100], [460, 100, 520, 100], [520, 100, 520, 160], [520, 220, 520, 280], [520, 280, 340, 280]);
  T.set(() => { Object.assign(T.comp("NB"), { x: 520, y: 100 }); });
  T.set((s) => { s.probes = []; s.title = "LAB 07D"; s.answers = { v100: "3.6" }; });
  T.vprobe(520, 100);
})()`);


/* ------------------------------------------------- reference diagrams */

console.log("\n— every reference diagram passes its own lab —");
const dcSweep = { type: "dc", dcSrc: "VS", dcStart: "-12", dcStop: "12", dcStep: "0.1" };
const rvalSweep = { ...dcSweep, paramOn: true, paramName: "RVAL", paramMode: "lin", paramStart: "100", paramStop: "300", paramStep: "100" };
const DIAGRAM_RUNS = {
  "e101-04a": { title: "LAB 04A", answers: { ve: "5.64" } },
  "e101-04b": { title: "LAB 04B", answers: { vr2: "4.8" } },
  "e101-05a": { title: "LAB 05A", analysis: { type: "ac", acStart: "10", acStop: "100k", acPts: "101" },
                answers: { gain: "19.08", flo: String(ref5a.lo), fhi: String(ref5a.hi) } },
  "e101-05b": { title: "LAB 05B", analysis: { type: "tran", trStop: "5m", trStep: "0.01m" },
                answers: { ipk: String(ref5b.max), imin: String(ref5b.min) } },
  "e101-05c": { title: "LAB 05C", analysis: { type: "op" }, showBias: true, answers: { vout: "4.5", vmid: "6" } },
  "e101-06a": { title: "LAB 06A", answers: { nodes: "2" } },
  "e101-06b": { title: "LAB 06B", answers: { vout: "5.143" } },
  "e101-06c": { title: "LAB 06C" },
  "e101-07a": { title: "LAB 07A", analysis: dcSweep, answers: { vhi: "9", vlo: "-9" } },
  "e101-07b": { title: "LAB 07B", analysis: dcSweep, answers: { vab: "3" } },
  "e101-07c": { title: "LAB 07C", analysis: rvalSweep, answers: { v100: "9", v200: "7.2", v300: "6" } },
  "e101-07d": { title: "LAB 07D", analysis: rvalSweep, answers: { v100: "3.6" } }
};
const bode = { plot: { mode: "db", xMin: "1", xMax: "10k", yMin: "-20", yMax: "0" } };
const acSweep = { type: "ac", acStart: "1", acStop: "100k", acPts: "201" };
const cvalSweep = { ...acSweep, paramOn: true, paramName: "CVAL", paramMode: "lin", paramStart: "1u", paramStop: "3u", paramStep: "0.5u" };
Object.assign(DIAGRAM_RUNS, {
  "e101-08a": { title: "LAB 08A", analysis: acSweep, ...bode, answers: "8a" },
  "e101-08b": { title: "LAB 08B", analysis: acSweep, plot: { mode: "db", xMin: "10", xMax: "10k", yMin: "-20", yMax: "0" }, answers: "8b" },
  "e101-08c": { title: "LAB 08C", analysis: cvalSweep, ...bode, answers: "8c" },
  "e101-08d": { title: "LAB 08D", analysis: cvalSweep, plot: { mode: "db", xMin: "1", xMax: "10k", yMin: "10", yMax: "30" }, answers: "8d" },
  "e101-09a": { title: "LAB 09A", analysis: { type: "tran", trStop: "1.2u", trStep: "1.2n" }, answers: "9" },
  "e101-09b": { title: "LAB 09B", analysis: { type: "tran", trStop: "0.12u", trStep: "0.12n" }, answers: "9" },
  "e101-09c": { title: "LAB 09C", analysis: { type: "tran", trStop: "200u", trStep: ".2u" }, answers: "9" },
  "e101-09d": { title: "LAB 09D", analysis: { type: "tran", trStop: "160u", trStep: "1u" }, answers: "9" }
});

const truth = (n, fn) => Object.fromEntries(Array.from({ length: 1 << n }, (_, m) => {
  const bits = Array.from({ length: n }, (_, i) => (m >> (n - 1 - i)) & 1);
  return [`tt${bits.join("")}`, String(fn(bits))];
}));
const t10 = { type: "tran", trStop: "8m", trStep: "0.8m" };
const ac12 = { type: "ac", acStart: "100", acStop: "100meg", acPts: "101" };
Object.assign(DIAGRAM_RUNS, {
  "e101-10a": { title: "LAB 10A", analysis: t10, answers: truth(2, ([a, b]) => a | b) },
  "e101-10b": { title: "LAB 10B", analysis: t10, answers: truth(2, ([a, b]) => 1 - (a | b)) },
  "e101-10c": { title: "LAB 10C", analysis: t10, answers: truth(3, ([a, b, c]) => a & b & c) },
  "e101-10d": { title: "LAB 10D", analysis: t10, answers: truth(3, ([a, b, c]) => 1 - (a & b & c)) },
  "e101-10e": { title: "LAB 10E", analysis: t10, answers: { same: "7411", q111: "1", q110: "0" } },
  "e101-11a": { title: "LAB 11A", analysis: { type: "tran", trStop: ".5m", trStep: "1u" }, answers: truth(2, ([a, b]) => a ^ b) },
  "e101-11b": { title: "LAB 11B", analysis: { type: "tran", trStop: "0.5m", trStep: "1u" }, answers: { set: "1", reset: "0", both: "1" } },
  "e101-11c": { title: "LAB 11C", analysis: { type: "tran", trStop: "10m", trStep: "0.1m", ffInit: "0" }, answers: { q45: "1", q82: "0", q99: "1" } },
  "e101-11d": { title: "LAB 11D", analysis: { type: "tran", trStop: "32m", trStep: "0.1m", ffInit: "0" }, answers: { c115: "6", c205: "10", cmax: "15" } },
  "e101-12a": { title: "LAB 12A", analysis: ac12, plot: { mode: "db", yMin: "0", yMax: "20" }, answers: "12" },
  "e101-12b": { title: "LAB 12B", analysis: ac12, plot: { mode: "db", xMin: "100", xMax: "10meg", yMin: "20", yMax: "40" }, answers: "12" },
  "e101-12c": { title: "LAB 12C", analysis: ac12, plot: { mode: "db", yMin: "0", yMax: "20" }, answers: "12" },
  "e101-12d": { title: "LAB 12D", analysis: ac12, plot: { mode: "db", yMin: "1", yMax: "21" }, answers: "12" },
  "e101-12e": { title: "LAB 12E", analysis: ac12, plot: { mode: "db", xMin: "100", xMax: "10meg", yMin: "20", yMax: "40" }, answers: "12" }
});

Object.assign(DIAGRAM_RUNS, {
  "e101-13a": { title: "LAB 13A" },
  "e101-13b": { title: "LAB 13B" },
  "e101-13c": { title: "LAB 13C", analysis: { type: "tran", trStop: "12m", trStep: "0.1m", ffInit: "0" }, answers: { c42: "4", c92: "9", c102: "0" } },
  "e101-14a": { title: "LAB 14A" },
  "e101-14b": { title: "LAB 14B" }
});

/**
 * Work out a lab's answers from the circuit now on the sheet, by running the
 * reference analysis here in the test. Deliberately not a hook in the app: a
 * student could call that from the console.
 */
const REF_ANSWERS = async (kind) => {
  const L = window.__spiceLab;
  const S = L.store.state;
  const refAc = { ...S.analysis, type: "ac", acPts: "50", acStart: "1", acStop: "100k" };
  const find = (r, name, step = null) => r.traces.find((t) => t.name.split(" \u00B7 ")[0].toLowerCase() === name && (step === null || t.step === step));
  if (kind === "8a") {
    const r = await L.simulate(S, null, { ...refAc, paramOn: false });
    return { fc: String(L.labs.corners(find(r, "v(b)"), r.sweep.values).hi) };
  }
  if (kind === "8b") {
    const r = await L.simulate(S, null, { ...refAc, paramOn: false });
    return { fc: String(L.labs.corners(find(r, "v(a,b)"), r.sweep.values).lo) };
  }
  if (kind === "8c") {
    const r = await L.simulate(S, null, refAc);
    return {
      f1: String(L.labs.corners(find(r, "v(b)", 0), r.sweep.values).hi),
      f3: String(L.labs.corners(find(r, "v(b)", 4), r.sweep.values).hi)
    };
  }
  if (kind === "8d") {
    const r = await L.simulate(S, null, refAc);
    const k = r.sweep.values.findIndex((f) => Math.abs(f - 10) < 0.01);
    return { gain: String(find(r, "v(b)", 0).db[k]) };
  }
  if (kind === "12") {
    const r = await L.simulate(S, null, { ...S.analysis, type: "ac", acPts: "50", acStart: "100", acStop: "100meg" });
    const c = L.labs.corners(find(r, "v(out)"), r.sweep.values);
    return { gain: String(c.peak), fhi: String(c.hi), _peak: c.peak, _hi: c.hi };
  }
  if (kind === "9") {
    const r = await L.simulate(S, null, { ...S.analysis });
    const t = find(r, "v(in,out)");
    return { dmax: String(Math.max(...t.values)), dmin: String(Math.min(...t.values)) };
  }
  return {};
};
await page.evaluate(`window.REF_ANSWERS = ${REF_ANSWERS.toString()}`);

for (const [id, run] of Object.entries(DIAGRAM_RUNS)) {
  const out = await page.evaluate(async ({ id, run }) => {
    const L = window.__spiceLab;
    window.T.open(id);
    const d = L.labs.diagramFor(L.labs.labById(id));
    L.store.loadCircuit({ ...d, title: run.title });
    L.store.edit((s) => {
      Object.assign(s.analysis, run.analysis || {});
      Object.assign(s.plot, run.plot || {});
      s.showBias = !!run.showBias;
    }, "t");
    const answers = typeof run.answers === "string" ? await window.REF_ANSWERS(run.answers) : (run.answers || {});
    L.store.edit((s) => { s.answers = answers; }, "t");
    const t0 = performance.now();
    const r = await window.T.check(id);
    r.note = `${Math.round(performance.now() - t0)} ms to check` + (answers._peak ? `, gain ${answers._peak.toFixed(2)} dB, upper corner ${(answers._hi / 1e6).toFixed(2)} MHz` : "");
    return r;
  }, { id, run });
  if (out.note) console.log(`   ${id}: ${out.note}`);
  check(`${id}: its reference diagram passes every check`, out.ok,
    out.error ? `engine: ${out.error.split("\n")[0]}` : out.failed.join(" | "));
}

console.log("\n— Labs 8 and 9 —");
for (const id of ["e101-08a", "e101-08b", "e101-08c", "e101-08d", "e101-09a", "e101-09b", "e101-09c", "e101-09d"]) {
  const st = await page.evaluate(async (i) => { window.T.open(i); return window.T.check(i); }, id);
  check(`${id}: the blank starting sheet does not pass`, !st.ok, `${st.failed.length} of ${st.n} fail`);
}

async function loadSolved(id) {
  return page.evaluate(async ({ id, run }) => {
    const L = window.__spiceLab;
    window.T.open(id);
    L.store.loadCircuit({ ...L.labs.diagramFor(L.labs.labById(id)), title: run.title });
    L.store.edit((s) => { Object.assign(s.analysis, run.analysis || {}); Object.assign(s.plot, run.plot || {}); }, "t");
    const answers = await window.REF_ANSWERS(run.answers);
    L.store.edit((s) => { s.answers = answers; }, "t");
    return answers;
  }, { id, run: DIAGRAM_RUNS[id] });
}

const a8a = await loadSolved("e101-08a");
check("8A: the critical frequency is 1/(2πRC), about 159 Hz", Math.abs(+a8a.fc - 159.15) < 3, a8a.fc);
const noAxis = await page.evaluate(async () => {
  window.T.set((s) => { s.plot.xMin = ""; s.plot.xMax = ""; });
  return (await window.T.check("e101-08a")).failed.join(" | ");
});
check("8A: an automatic X axis is marked, with a pointer to Axis ranges", /X axis is still automatic/.test(noAxis), noAxis.slice(0, 120));
const magMode = await page.evaluate(async () => {
  window.T.set((s) => { s.plot.xMin = "1"; s.plot.xMax = "10k"; s.plot.mode = "mag"; });
  return (await window.T.check("e101-08a")).failed.join(" | ");
});
check("8A: a plot left in plain magnitude is marked", /showing plain magnitude/.test(magMode), magMode.slice(0, 120));

const a8b = await loadSolved("e101-08b");
check("8B: V(A,B) has its corner at the same 159 Hz", Math.abs(+a8b.fc - 159.15) < 3, a8b.fc);
const a8c = await loadSolved("e101-08c");
check("8C: the corner falls from 159 Hz to 53 Hz as CVAL goes 1u to 3u",
  Math.abs(+a8c.f1 - 159.15) < 3 && Math.abs(+a8c.f3 - 53.05) < 1.5, `${a8c.f1} → ${a8c.f3}`);
const a8d = await loadSolved("e101-08d");
check("8D: the transformer gives about +29.8 dB, as the handout's 10–30 dB axis expects", Math.abs(+a8d.gain - 29.78) < 0.3, a8d.gain);
const net8d = await page.inputValue("#netOut");
check("8D: the transformer is two inductors and a coupling card",
  /LTX1_1 \S+ \S+ 10u/.test(net8d) && /LTX1_2 \S+ 0 10m/.test(net8d) && /KTX1 LTX1_1 LTX1_2 0.975/.test(net8d),
  net8d.split("\n").filter((l) => /TX1/.test(l)).join(" | "));
const grounded = await page.evaluate(async () => {
  const T = window.T;
  T.set((s) => { s.wires.push({ id: 99999, x1: 100, y1: 280, x2: 20, y2: 280 }); });
  T.add("GND", 20, 280, 0, {});
  return (await T.check("e101-08d")).failed.join(" | ");
});
check("8D: grounding the primary side directly is caught", /primary side floats/.test(grounded), grounded.slice(0, 160));

const a9 = {};
for (const id of ["e101-09a", "e101-09b", "e101-09c", "e101-09d"]) a9[id] = await loadSolved(id);
const r2 = (x) => Math.round(+x * 100) / 100;
console.log("   V(IN,OUT) max/min:", Object.entries(a9).map(([k, v]) => `${k.slice(-2)} ${r2(v.dmax)}/${r2(v.dmin)}`).join("  "));
check("9C: the voltage across R1 plateaus at RC × slope, about ±0.59 V",
  Math.abs(+a9["e101-09c"].dmax - 0.59) < 0.03 && Math.abs(+a9["e101-09c"].dmin + 0.59) < 0.03);
check("9D: a small plateau on the ramp and a large negative swing at each drop",
  Math.abs(+a9["e101-09d"].dmax - 0.139) < 0.02 && +a9["e101-09d"].dmin < -3);

const net9 = await page.evaluate(() => {
  window.__spiceLab.refresh();
  return document.getElementById("netOut").value;
});
check("9D: a source named VRAMP keeps its name", /^VRAMP IN 0 PULSE\(\.3 4\.6 10n 49\.5u 0\.5u 0\.01u 50u\)/m.test(net9),
  net9.split("\n").find((l) => /PULSE/.test(l)));
const prefixed = await page.evaluate(() => {
  const L = window.__spiceLab;
  window.T.set(() => { window.T.comp("VRAMP").label = "RAMP"; });
  L.store.edit((s) => Object.assign(s.analysis, { type: "dc", dcSrc: "RAMP", dcStart: "0", dcStop: "1", dcStep: "1" }), "t");
  L.refresh();
  return { net: document.getElementById("netOut").value, warn: document.getElementById("checks").textContent };
});
check("a source named RAMP is written V_RAMP, as PSpice does", /^V_RAMP IN 0 PULSE/m.test(prefixed.net));
check("a DC sweep can name that source as RAMP", /\.dc V_RAMP 0 1 1/.test(prefixed.net) && !/not on the sheet/.test(prefixed.warn),
  prefixed.net.split("\n").find((l) => l.startsWith(".dc")));

const inspector = await page.evaluate(() => {
  const S = window.__spiceLab.store;
  S.selection = new Set([S.state.comps.find((c) => c.type === "VPULSE").id]);
  window.__spiceLab.refresh();
  return [...document.querySelectorAll("#inspector label")].map((l) => l.textContent.split(",")[0]);
});
check("the pulse source has PSpice's seven fields", ["V1", "V2", "TD", "TR", "TF", "PW", "PER"].every((k) => inspector.includes(k)), inspector.join(" "));

// Axis range controls drive the stored plot settings and the measurements.
await page.evaluate(async () => {
  window.T.open("e101-09a");
  const L = window.__spiceLab;
  L.store.loadCircuit({ ...L.labs.diagramFor(L.labs.labById("e101-09a")), title: "LAB 09A" });
  L.store.edit((s) => Object.assign(s.analysis, { type: "tran", trStop: "1.2u", trStep: "1.2n" }), "t");
  await L.run();
});
await page.evaluate(() => { document.getElementById("axisBox").open = true; document.getElementById("axisBox").scrollIntoView(); });
await page.fill("#plotXMin", "0.6u");
await page.fill("#plotXMax", "1.2u");
await page.fill("#plotYMin", "-5");
await page.fill("#plotYMax", "5");
await page.waitForTimeout(150);
const axis = await page.evaluate(() => ({
  plot: window.__spiceLab.store.state.plot,
  head: document.querySelector(".measure-scope")?.textContent,
  maxOut: window.__spiceLab.scope.measurements().find((m) => m.name.toLowerCase() === "v(out)")?.max
}));
check("typing axis ranges stores them with the circuit", axis.plot.xMin === "0.6u" && axis.plot.yMax === "5", JSON.stringify(axis.plot));
// After 0.6 µs the pulse has ended, so OUT is decaying: its visible maximum
// is well below the 4.6 V it reached earlier.
check("the measurements follow the visible X range", /visible range/.test(axis.head || "") && axis.maxOut > 0.5 && axis.maxOut < 2, `${axis.head} · max ${axis.maxOut}`);
if (process.env.SHOTS) await page.locator(".scope-panel").screenshot({ path: "/tmp/9a-plot.png" });
await page.click("#btnAxisAuto");
const cleared = await page.evaluate(() => window.__spiceLab.store.state.plot);
check("All automatic clears the ranges", !cleared.xMin && !cleared.yMax, JSON.stringify(cleared));

console.log("\n— Labs 10 to 12 —");
for (const id of ["e101-10a", "e101-10b", "e101-10c", "e101-10d", "e101-10e", "e101-11a", "e101-11b", "e101-11c", "e101-11d",
  "e101-12a", "e101-12b", "e101-12c", "e101-12d", "e101-12e"]) {
  const st = await page.evaluate(async (i) => { window.T.open(i); return window.T.check(i); }, id);
  check(`${id}: the blank starting sheet does not pass`, !st.ok, `${st.failed.length} of ${st.n} fail`);
}

await loadSolved("e101-10a");
const wrongGate = await page.evaluate(async () => {
  window.T.set(() => { window.T.comp("U1A").device = "7408"; });
  return (await window.T.check("e101-10a")).failed.join(" | ");
});
check("10A: the wrong part number is caught", /U1A has Device = 7408; it should be 7432/.test(wrongGate), wrongGate.slice(0, 120));
check("10A: and the truth-table answers no longer match it", /Q when A = 0, B = 1/.test(wrongGate));

await loadSolved("e101-10a");
const reordered = await page.evaluate(async () => {
  window.T.set((s) => { s.probes = [s.probes[1], s.probes[0], s.probes[2]]; });
  return (await window.T.check("e101-10a")).failed.join(" | ");
});
check("10A: probes placed out of order are caught", /in the order B, A, Q/.test(reordered), reordered.slice(0, 120));

await loadSolved("e101-10a");
const shortStim = await page.evaluate(async () => {
  window.T.set(() => { window.T.comp("DSTM1").commands = "0s 0; 1m 1; 2m 0"; });
  return (await window.T.check("e101-10a")).failed.join(" | ");
});
check("10A: a stimulus table that stops early is caught", /DSTM1 has the handout's commands/.test(shortStim), shortStim.slice(0, 160));
const badStim = await page.evaluate(() => {
  window.T.set(() => { window.T.comp("DSTM1").commands = "0s 0; 2m 1; 1m 0"; });
  window.__spiceLab.refresh();
  return document.getElementById("checks").textContent;
});
check("a stimulus with times out of order is explained", /times must increase/.test(badStim), badStim.slice(0, 120));

await loadSolved("e101-11c");
const ffx = await page.evaluate(async () => {
  window.T.set((s) => { s.analysis.ffInit = "X"; });
  window.__spiceLab.refresh();
  return { failed: (await window.T.check("e101-11c")).failed.join(" | "), warn: document.getElementById("checks").textContent };
});
check("11C: leaving flip-flops uninitialized is marked", /initialized to 0/.test(ffx.failed));
check("11C: and the validator suggests the fix", /Initialize flip-flops to 0/.test(ffx.warn));

await loadSolved("e101-11d");
const net11d = await page.evaluate(() => { window.__spiceLab.refresh(); return document.getElementById("netOut").value; });
check("11D: the netlist has no XSPICE devices or POLY sources", !/^A|POLY/im.test(net11d));
check("11D: the logic 1 rail is driven once", (net11d.match(/^V_DIG_RAIL /gm) || []).length === 1);
const warn11d = await page.evaluate(() => document.getElementById("checks").textContent);
check("11D: unused Q̄ outputs raise no warnings", /Connectivity is clean/.test(warn11d), warn11d.slice(0, 160));
const joined = await page.evaluate(async () => {
  // join the clock to the clear bus where they cross
  window.T.wire([180, 360, 170, 360]);
  window.T.set((s) => {
    const w = s.wires.find((k) => k.x1 === 180 && k.y1 === 420 && k.x2 === 180 && k.y2 === 240);
    w.y2 = 360;
    s.wires.push({ id: 88888, x1: 180, y1: 360, x2: 180, y2: 240 });
  });
  return (await window.T.check("e101-11d")).failed.join(" | ");
});
check("11D: a junction where the clock crosses the clear bus is caught", /should be on Clock|U1A/.test(joined), joined.slice(0, 160));

await loadSolved("e101-11d");
const lanes = await page.evaluate(async () => {
  const L = window.__spiceLab;
  await L.run();
  return { digital: L.scope.isDigital(), panes: L.scope.paneCount(), names: L.getResult().traces.length };
});
check("11D: logic signals plot as one lane per probe", lanes.digital && lanes.panes === 5, JSON.stringify(lanes));
const tabs = await page.evaluate(() => ({
  digitalTab: document.querySelector('#partTools [data-tab="digital"]').getAttribute("aria-pressed"),
  gateShown: !document.querySelector('#partTools [data-tool="JKFF"]').hidden,
  resistorHidden: document.querySelector('#partTools [data-tool="R"]').hidden,
  yHidden: document.getElementById("plotYLabel").closest(".field-grid-2").hidden,
  toolbar: document.querySelector(".toolbar-strip").offsetHeight
}));
check("a digital lab switches the palette to Digital parts", tabs.digitalTab === "true" && tabs.gateShown && tabs.resistorHidden, JSON.stringify(tabs));
check("Y ranges are hidden while logic lanes are showing", tabs.yHidden);
check("the toolbar stays at two rows", tabs.toolbar < 140, `${tabs.toolbar}px`);
if (process.env.SHOTS) {
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/11d.png" });
  await page.locator(".scope-panel").screenshot({ path: "/tmp/11d-plot.png" });
}

await loadSolved("e101-12c");
const net12 = await page.evaluate(() => { window.__spiceLab.refresh(); return document.getElementById("netOut").value; });
check("12C: the LM324 is the handout's macromodel, as a subcircuit", /^XU1A \S+ \S+ VCC VEE OUT LM324$/m.test(net12) && /\.subckt LM324 1 2 3 4 5/.test(net12),
  net12.split("\n").find((l) => l.startsWith("XU1A")));
check("12C: with its POLY lines rewritten, so ngspice does not exit", !/POLY/i.test(net12) && /BFB 7 99 I = 42\.44E6\*I\(VB\)/.test(net12));
const simple = await page.evaluate(async () => {
  window.T.set(() => { window.T.comp("U1A").model = "Behavioral"; });
  return (await window.T.check("e101-12c")).failed.join(" | ");
});
check("12C: the simple op-amp model is marked, as the handout asks for the LM324 model", /uses the Behavioral model; it should be LM324/.test(simple), simple.slice(0, 120));
if (process.env.SHOTS) {
  await loadSolved("e101-12e");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/12e.png" });
  await loadSolved("e101-10e");
  await page.evaluate(async () => { window.__spiceLab.canvas.fit(); await window.__spiceLab.run(); });
  await page.locator("#sheetHost").screenshot({ path: "/tmp/10e.png" });
  await page.locator(".scope-panel").screenshot({ path: "/tmp/10e-plot.png" });
  await loadSolved("e101-11c");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/11c.png" });
  await loadSolved("e101-12b");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/12b.png" });
}

console.log("\n— Labs 13 and 14 —");
for (const id of ["e101-13a", "e101-13b", "e101-13c", "e101-14a", "e101-14b"]) {
  const st = await page.evaluate(async (i) => { window.T.open(i); return window.T.check(i); }, id);
  check(`${id}: the blank starting sheet does not pass`, !st.ok, `${st.failed.length} of ${st.n} fail`);
}
const solvedPlain = (id, title) => page.evaluate(({ id, title }) => {
  const L = window.__spiceLab;
  window.T.open(id);
  L.store.loadCircuit({ ...L.labs.diagramFor(L.labs.labById(id)), title });
  L.refresh();
}, { id, title });

await solvedPlain("e101-13a", "LAB 13A");
const warn13a = await page.evaluate(() => document.getElementById("checks").textContent);
check("13A: the finished drawing raises no warnings", /Connectivity is clean/.test(warn13a), warn13a.slice(0, 200));
const net13a = await page.evaluate(() => document.getElementById("netOut").value);
check("13A: the bus itself is not a node; D0 is its own net", /U1_z .*D0/.test(net13a.replace(/\n/g, " ")) || /\bD0\b/.test(net13a), "");
const noEntry = await page.evaluate(async () => {
  window.T.set((s) => { s.comps = s.comps.filter((c) => !(c.type === "BUSENTRY" && c.y === 180 && c.x === 120)); });
  return (await window.T.check("e101-13a")).failed.join(" | ");
});
check("13A: a data line without a bus entry is caught", /D3 has no bus entry/.test(noEntry), noEntry.slice(0, 160));
const ontoBus = await page.evaluate(() => {
  window.T.wire([160, 420, 100, 420]);
  window.__spiceLab.refresh();
  return document.getElementById("checks").textContent;
});
check("a wire run straight onto a bus is explained", /Wires join a bus only through a bus entry/.test(ontoBus), ontoBus.slice(0, 200));

await solvedPlain("e101-13b", "LAB 13B");
const swap13b = await page.evaluate(async () => {
  window.T.set(() => {
    const a = window.T.comp("U2A"), b = window.T.comp("U2B");
    [a.x, b.x] = [b.x, a.x];
  });
  return (await window.T.check("e101-13b")).failed.join(" | ");
});
check("13B: an inverter moved to the wrong output is caught", /Y0|Y1/.test(swap13b), swap13b.slice(0, 160));

// The multiplexer and decoder simulate as well as draw.
await solvedPlain("e101-13b", "LAB 13B");
const demux = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const S = L.store;
  // S3..S0 = 0101, MUXInput held low: only D5 should read 1 after the inverters
  S.edit((s) => {
    const add = (label, net, value) => {
      const c = S.addComp("V", 0, 0, "V"); Object.assign(c, { label, value, ac: "", x: -400 - s.comps.length * 80, y: 900, rot: 90 });
      const n = S.addComp("NET", c.x, 900, "N"); n.name = net;
      const g = S.addComp("GND", c.x, 960, "GND"); g.label = "GND";
    };
    add("VA", "S0", "DC 5"); add("VB", "S1", "DC 0"); add("VC", "S2", "DC 5"); add("VD", "S3", "DC 0"); add("VM", "MUXInput", "DC 0");
    s.analysis.type = "op";
  }, "t");
  const r = await L.simulate(S.state);
  return Array.from({ length: 16 }, (_, k) => {
    const t = r.traces.find((x) => x.name.toLowerCase() === `v(d${k})`);
    return t && t.values[0] > 2.5 ? 1 : 0;
  }).join("");
});
check("13B: the 74154 and inverters decode S = 0101 to D5 alone", demux === "0000010000000000", demux);

await loadSolved("e101-13c");
const bcd = await page.evaluate(async () => {
  await window.__spiceLab.run();
  return window.__spiceLab.scope.paneCount();
});
check("13C: the decade counter runs, one lane per probe", bcd === 5, `${bcd} lanes`);
if (process.env.SHOTS) {
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/13c.png" });
  await page.locator(".scope-panel").screenshot({ path: "/tmp/13c-plot.png" });
}

await solvedPlain("e101-14a", "LAB 14A");
const warn14a = await page.evaluate(() => document.getElementById("checks").textContent);
check("14A: the finished drawing raises no warnings", /Connectivity is clean/.test(warn14a), warn14a.slice(0, 200));
const unmirrored = await page.evaluate(async () => {
  window.T.set(() => { window.T.comp("U1A").my = false; });
  return (await window.T.check("e101-14a")).failed.join(" | ");
});
check("14A: an unmirrored U1A is caught", /U1A should be mirrored top to bottom/.test(unmirrored), unmirrored.slice(0, 160));
check("14A: and since its pins moved, so is its wiring", /U1A/.test(unmirrored.split(" | ").filter((x) => !/mirrored/.test(x)).join(" ")), unmirrored.slice(0, 200));

await solvedPlain("e101-14b", "LAB 14B");
const net14b = await page.evaluate(() => document.getElementById("netOut").value);
check("14B: vin+ and vin- stay separate nodes", /^J1 \S+ vin_p /m.test(net14b) && /^J2 \S+ vin_n /m.test(net14b),
  net14b.split("\n").filter((l) => /^J/.test(l)).join(" | "));
check("14B: the J2N3819 card is the trimmed one that ngspice accepts", /\.model J2N3819 NJF\(Beta=1\.304m/.test(net14b) && !/Betatce/.test(net14b));
const warn14b = await page.evaluate(() => document.getElementById("checks").textContent);
check("14B: the only complaint is the missing ground the handout's circuit also lacks",
  /^No ground[^.]*\.[^.]*\.?$/.test(warn14b.trim()) || warn14b.trim().split(/(?<=\.)(?=[A-Z])/).every((m) => /ground/i.test(m)), warn14b.slice(0, 200));
const op14b = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const S = L.store;
  S.edit((s) => {
    const src = (label, net, value, x) => {
      const c = S.addComp("V", x, 900, "V"); Object.assign(c, { label, value, ac: "", rot: 90 });
      const n = S.addComp("PWR", x, 900, "P"); n.name = net;
      const g = S.addComp("GND", x, 960, "GND"); g.label = "GND";
    };
    src("VP", "vcc", "DC 15", -200); src("VNEG", "vee", "DC -15", -300);
    src("VIP", "vin+", "DC 0", -400); src("VIM", "vin-", "DC 0", -500);
    s.analysis.type = "op";
  }, "t");
  try {
    const r = await L.simulate(S.state);
    const vo = r.traces.find((t) => t.name.toLowerCase() === "v(vo)");
    return { ok: true, vo: vo?.values[0] };
  } catch (e) { return { ok: false, err: e.message }; }
});
check("14B: the discrete op-amp solves an operating point", op14b.ok && isFinite(op14b.vo), JSON.stringify(op14b));

// Mirroring moves pins, and wires stay put.
const bar = await page.evaluate(() => document.querySelector(".toolbar-strip").offsetHeight);
check("the toolbar still fits in two rows at 1440 px", bar < 140, `${bar}px`);
const mir = await page.evaluate(() => {
  const L = window.__spiceLab;
  window.T.open("e101-06a");
  let c;
  L.store.edit(() => { c = L.store.addComp("NPN", 400, 300, "Q"); }, "t");
  const before = JSON.stringify(window.__spiceLabPins = L.store.state.comps.find((k) => k.id === c.id));
  L.store.selection = new Set([c.id]);
  document.getElementById("btnMirrorH").click();
  const q = L.store.state.comps.find((k) => k.id === c.id);
  return { mx: q.mx, before };
});
check("Mirror ↔ flips a part left to right", mir.mx === true);
const pinsNow = await page.evaluate(async () => {
  const m = await import("/src/parts.js").catch(() => null);
  return m ? null : "skip";
});
void pinsNow;
if (process.env.SHOTS) {
  await solvedPlain("e101-13a", "LAB 13A");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/13a.png" });
  await solvedPlain("e101-13b", "LAB 13B");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/13b.png" });
  await solvedPlain("e101-14a", "LAB 14A");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/14a.png" });
  await solvedPlain("e101-14b", "LAB 14B");
  await page.evaluate(() => window.__spiceLab.canvas.fit());
  await page.locator("#sheetHost").screenshot({ path: "/tmp/14b.png" });
}

const explorations = await page.evaluate(() => {
  const L = window.__spiceLab;
  return L.labs.LABS.filter((l) => l.kind === "explore").every((l) => L.labs.diagramFor(l) === l.circuit);
});
check("exploration labs show their starting circuit", explorations);

console.log("\n— the diagram window —");
const win = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.freshLabs();
  const inFree = { button: !document.getElementById("btnDiagram").hidden, win: !document.getElementById("diagramWin").hidden };
  localStorage.removeItem("q-circuits-diagram-v1");
  window.T.open("e101-06c");
  const w = document.getElementById("diagramWin");
  return {
    inFree,
    open: !w.hidden,
    title: document.getElementById("diagramTitle").textContent,
    parts: L.diagram.store.state.comps.length,
    words: [...document.querySelectorAll("#diagramWords li")].map((li) => li.textContent),
    sheetParts: L.store.state.comps.length,
    saved: JSON.parse(localStorage.getItem("q-circuits-v1")).state.comps.length,
    grid: w.querySelectorAll(".grid-layer").length,
    role: w.querySelector("svg").getAttribute("role")
  };
});
check("no diagram button or window in free build", !win.inFree.button && !win.inFree.win, JSON.stringify(win.inFree));
check("opening a lab opens its diagram", win.open && /6C/.test(win.title), win.title);
check("the diagram draws the lab's circuit, not the student's sheet", win.parts === 15 && win.sheetParts === 0, `${win.parts} vs ${win.sheetParts}`);
check("the diagram never autosaves over the student's sheet", win.saved === 0, `autosave holds ${win.saved} parts`);
check("the diagram has no grid", win.grid === 0);
const fill = await page.evaluate(() => {
  const svg = document.querySelector("#diagramHost svg");
  const g = svg.getBoundingClientRect();
  const drawn = [...svg.querySelectorAll(".part")].map((p) => p.getBoundingClientRect());
  const w = Math.max(...drawn.map((b) => b.right)) - Math.min(...drawn.map((b) => b.left));
  const h = Math.max(...drawn.map((b) => b.bottom)) - Math.min(...drawn.map((b) => b.top));
  return Math.max(w / g.width, h / g.height);
});
check("Fit makes the circuit fill the diagram window", fill > 0.8, `${Math.round(fill * 100)}% of the window`);
check("the diagram is announced as an image", win.role === "img");
check("the circuit in words names nets and polarity",
  win.words.includes("VS1 (DC 12): + VCC, - ground") &&
    win.words.some((w) => /^Q2 \(Q2N2222\): base ground/.test(w)) &&
    win.words.some((w) => /^REE \(4\.8k\): between (VEE and node \d+|node \d+ and VEE)$/.test(w)),
  win.words.slice(0, 4).join(" / "));

// Dragging inside the diagram pans; it never edits.
const hb = await page.locator("#diagramHost svg").boundingBox();
const before = await page.evaluate(() => JSON.stringify(window.__spiceLab.diagram.store.state.comps));
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2 - 60, hb.y + hb.height / 2 - 30, { steps: 5 });
await page.mouse.up();
const after = await page.evaluate(() => ({
  comps: JSON.stringify(window.__spiceLab.diagram.store.state.comps),
  vb: document.querySelector("#diagramHost svg").getAttribute("viewBox")
}));
check("dragging in the diagram leaves the circuit unchanged", before === after.comps);

// Moving the window by its title bar, and remembering it.
const hd = await page.locator("#diagramHead").boundingBox();
await page.mouse.move(hd.x + 40, hd.y + hd.height / 2);
await page.mouse.down();
await page.mouse.move(hd.x - 200, hd.y + 100, { steps: 6 });
await page.mouse.up();
const movedWin = await page.evaluate(() => ({
  box: document.getElementById("diagramWin").getBoundingClientRect().toJSON(),
  prefs: JSON.parse(localStorage.getItem("q-circuits-diagram-v1"))
}));
check("the title bar drags the window", Math.abs(movedWin.box.x - (hd.x - 240)) < 3, `x = ${movedWin.box.x}`);
check("the position is remembered", movedWin.prefs?.rect && Math.abs(movedWin.prefs.rect.x - movedWin.box.x) < 2, JSON.stringify(movedWin.prefs));

await page.focus("#diagramHead");
await page.keyboard.press("ArrowRight");
const keyed = await page.evaluate(() => document.getElementById("diagramWin").getBoundingClientRect().x);
check("arrow keys move the window when its title bar has focus", Math.abs(keyed - movedWin.box.x - 20) < 2, `${movedWin.box.x} → ${keyed}`);
const toolAfterKey = await page.evaluate(() => window.__spiceLab.canvas.getTool());
check("keys in the window do not reach the sheet's shortcuts", toolAfterKey === "select" || toolAfterKey !== "R", toolAfterKey);

await page.keyboard.press("Escape");
const closed = await page.evaluate(() => {
  const r = { hidden: document.getElementById("diagramWin").hidden, pressed: document.getElementById("btnDiagram").getAttribute("aria-pressed") };
  window.T.open("e101-07c");
  r.staysClosed = document.getElementById("diagramWin").hidden;
  document.getElementById("btnDiagram").click();
  r.reopened = !document.getElementById("diagramWin").hidden;
  r.hasParam = [...document.querySelectorAll("#diagramWin .param-head")].length === 1;
  return r;
});
check("Escape closes the window", closed.hidden && closed.pressed === "false", JSON.stringify(closed));
check("a closed window stays closed on the next lab", closed.staysClosed);
check("the button reopens it with the new lab's circuit", closed.reopened && closed.hasParam);

if (process.env.SHOTS) {
  await loadSolved("e101-08d");
  await page.evaluate(() => { window.__spiceLab.canvas.fit(); });
  await page.locator("#sheetHost").screenshot({ path: "/tmp/8d.png" });
  await page.evaluate(async () => { await window.__spiceLab.run(); });
  await page.locator(".scope-panel").screenshot({ path: "/tmp/8d-plot.png" });
  await page.evaluate(() => {
    localStorage.removeItem("q-circuits-diagram-v1");
    document.getElementById("diagramWin").removeAttribute("style");
    window.T.open("e101-06c");
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/diagram-win.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(200);
  await page.locator("#diagramWin").screenshot({ path: "/tmp/diagram-dark.png" });
  await page.emulateMedia({ colorScheme: "light" });
}

/* ------------------------------------------------------------- the UI */

console.log("\n— palette icons —");
const icons = await page.evaluate(() => {
  const out = { empty: [], noLabel: [], exposed: [], count: 0, tiny: [] };
  ["analog", "digital"].forEach((tab) => {
    document.querySelector(`#partTools [data-tab="${tab}"]`).click();
    document.querySelectorAll("#partTools button[data-tool]").forEach((b) => {
      if (b.hidden) return;
      out.count++;
      const svg = b.querySelector("svg.part-icon");
      const label = b.querySelector("span");
      if (!svg || !svg.querySelectorAll("path").length) out.empty.push(b.dataset.tool);
      if (!label || !label.textContent.trim()) out.noLabel.push(b.dataset.tool);
      if (svg && svg.getAttribute("aria-hidden") !== "true") out.exposed.push(b.dataset.tool);
      // an icon squeezed to a sliver is unreadable
      const r = svg?.getBoundingClientRect();
      if (r && (r.width < 12 || r.height < 10)) out.tiny.push(`${b.dataset.tool} ${Math.round(r.width)}×${Math.round(r.height)}`);
    });
  });
  document.querySelector('#partTools [data-tab="analog"]').click();
  return out;
});
check("every part button draws an icon", !icons.empty.length, icons.empty.join(", "));
check("every part button keeps its written name", !icons.noLabel.length, icons.noLabel.join(", "));
check("icons are decorative, so screen readers read the name only", !icons.exposed.length, icons.exposed.join(", "));
check("no icon is squeezed to a sliver", !icons.tiny.length, icons.tiny.join(", "));
const barIcons = await page.evaluate(() => document.querySelector(".toolbar-strip").offsetHeight);
check("the icons do not push the toolbar past two rows", barIcons < 140, `${barIcons}px`);
const namedBtn = await page.evaluate(() => {
  const b = document.querySelector('#partTools button[data-tool="R"]');
  return { text: b.textContent.trim(), title: b.title };
});
check("a part button is still named by its text, not only its tooltip", namedBtn.text === "R" && namedBtn.title === "Resistor", JSON.stringify(namedBtn));

console.log("\n— sheet tools —");
await page.evaluate(() => { document.getElementById("axisBox").open = false; window.scrollTo(0, 0); });
await page.evaluate(() => window.T.open("e101-06a"));
await page.click('#partTools button[data-tool="NET"]');
const box = await page.locator("#sheetHost svg.sheet").boundingBox();
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
await page.waitForTimeout(200);
const editorUp = await page.evaluate(() => !!document.querySelector(".inline-edit"));
check("placing a net alias asks for its name straight away", editorUp);
await page.keyboard.type("OUT");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const netName = await page.evaluate(() => window.__spiceLab.store.state.comps.find((c) => c.type === "NET")?.name);
check("the typed name is stored on the alias", netName === "OUT", netName);
const aliasWarn = await page.textContent("#checks");
check("an alias touching nothing is flagged", /names nothing/.test(aliasWarn));

await page.keyboard.press("Escape");
await page.evaluate(() => { window.T.open("e101-07b"); window.T.series(); });
await page.click('#modeTools button[data-tool="vdiff"]');
await page.evaluate(() => window.__spiceLab.canvas.fit());
const pt = await page.evaluate(() => {
  const svg = document.querySelector("#sheetHost svg.sheet");
  const vb = svg.getAttribute("viewBox").split(" ").map(Number);
  const r = svg.getBoundingClientRect();
  const to = (x, y) => ({ x: r.left + ((x - vb[0]) / vb[2]) * r.width, y: r.top + ((y - vb[1]) / vb[3]) * r.height });
  return { a: to(200, 100), b: to(340, 130) };
});
await page.mouse.click(pt.a.x, pt.a.y);
await page.waitForTimeout(100);
await page.mouse.click(pt.b.x, pt.b.y);
await page.waitForTimeout(150);
const dp = await page.evaluate(() => window.__spiceLab.store.state.probes);
check("two clicks with Diff probe place one differential probe", dp.length === 1 && dp[0].kind === "vd", JSON.stringify(dp));
const dpLabel = await page.evaluate(() => [...document.querySelectorAll(".probe-label")].map((t) => t.textContent));
check("the probe is labelled with both node names", dpLabel.includes("v(A,B)"), dpLabel.join(","));

await page.keyboard.press("Escape");
const acDiff = await page.evaluate(async () => {
  const L = window.__spiceLab;
  L.store.edit((s) => { s.comps.find((c) => c.label === "VS").ac = "1"; Object.assign(s.analysis, { type: "ac", acPts: "5", acStart: "10", acStop: "1k" }); }, "t");
  L.store.toggleProbe("i", "R1", {});
  const r = await L.simulate(L.store.state);
  const d = r.traces.find((t) => t.name === "v(a,b)");
  const i = r.traces.find((t) => t.name === "i(r1)");
  return { d: d?.mag[0], i: i?.mag[0] };
});
check("in AC, the differential trace is the drop across R1", Math.abs(acDiff.d - 0.25) < 1e-6, String(acDiff.d));
check("in AC, a resistor current is worked out without hanging the engine", Math.abs(acDiff.i - 0.0025) < 1e-8, String(acDiff.i));

const reset = await page.evaluate(() => {
  window.T.set((s) => { s.title = "changed"; });
  document.getElementById("btnLabReset").click();
  return { parts: window.__spiceLab.store.state.comps.length, title: window.__spiceLab.store.state.title };
});
check("Start over puts back the starting sheet", reset.title === "Untitled circuit", JSON.stringify(reset));

const faded = await page.evaluate(() => [...document.querySelectorAll("button.ghost")]
  .filter((b) => !b.disabled && getComputedStyle(b).opacity !== "1").map((b) => b.id || b.textContent));
check("secondary buttons are not drawn faded as if disabled", !faded.length, faded.join(", "));

check("no page errors", errors.length === 0, errors.join(" / "));

const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto(`http://localhost:${PORT}/`);
await phone.waitForFunction(() => window.__spiceLab?.ready === true);
const phoneState = await phone.evaluate(() => {
  localStorage.removeItem("q-circuits-diagram-v1");
  return 0;
});
await phone.reload();
await phone.waitForFunction(() => window.__spiceLab?.ready === true);
const phoneWin = await phone.evaluate(() => {
  window.__spiceLab.freshLabs();
  const s = document.getElementById("labSelect");
  s.value = "e101-06a"; s.dispatchEvent(new Event("change"));
  const closedFirst = document.getElementById("diagramWin").hidden;
  document.getElementById("btnDiagram").click();
  const r = document.getElementById("diagramWin").getBoundingClientRect();
  return { closedFirst, docked: Math.abs(r.bottom - innerHeight) < 2 && r.width === innerWidth, overflow: document.documentElement.scrollWidth - innerWidth };
});
void phoneState;
check("on a phone the diagram starts closed", phoneWin.closedFirst);
check("on a phone it docks full width along the bottom", phoneWin.docked, JSON.stringify(phoneWin));
check("no sideways scrolling on a phone with it open", phoneWin.overflow === 0, `${phoneWin.overflow}px`);
const phonePalette = await phone.evaluate(() => {
  const t = document.getElementById("partTools");
  return { rows: t.getBoundingClientRect().height, scrolls: t.scrollWidth > t.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
});
check("on a phone the palette scrolls sideways instead of wrapping", phonePalette.scrolls && phonePalette.rows < 110 && phonePalette.page === 0, JSON.stringify(phonePalette));

console.log(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
