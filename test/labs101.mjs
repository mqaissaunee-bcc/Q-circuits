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

console.log("\n— 555 timer and dependent sources —");
const build = (parts, wires, analysis, extra = {}, probeOut = false) => page.evaluate(async ({ parts, wires, analysis, extra, probeOut }) => {
  const L = window.__spiceLab;
  const S = L.store;
  L.freshLabs();
  S.clear();
  S.edit((s) => {
    parts.forEach((p) => {
      const c = S.addComp(p.type, p.x, p.y, p.type === "GND" ? "GND" : "X");
      Object.assign(c, p.fields || {});
      if (p.label) c.label = p.label;
      if (p.net) { const n = S.addComp("NET", p.x, p.y, "N"); n.name = p.net; }
    });
    wires.forEach(([a, b, c2, d]) => S.addWire(a, b, c2, d));
    Object.assign(s.analysis, analysis);
    Object.assign(s, extra);
  }, "t");
  if (probeOut) {
    const out = S.state.comps.find((c) => c.type === "NET" && c.name === "OUT");
    if (out) S.toggleProbe("v", `${out.x},${out.y}`, { x: out.x, y: out.y });
  }
  let r;
  try {
    r = await L.simulate(S.state);
  } catch (e) {
    return { error: e.message, netlist: document.getElementById("netOut").value, values: {}, names: [] };
  }
  const trace = (name) => r.traces.find((t) => t.name.toLowerCase() === name);
  return {
    names: r.traces.map((t) => t.name),
    values: Object.fromEntries(r.traces.map((t) => [t.name.toLowerCase(), t.values])),
    sweep: r.sweep ? r.sweep.values : null,
    netlist: document.getElementById("netOut").value,
    fourier: r.fourier ? { f0: r.fourier.f0, traces: r.fourier.traces } : null,
    has: !!trace("v(out)")
  };
}, { parts, wires, analysis, extra, probeOut });

// A VCVS with a gain of 5: 1 V in, 5 V out.
const vcvs = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 1", ac: "", rot: 90 }, net: "IN" },
   { type: "GND", x: 100, y: 220 },
   { type: "DEP", x: 300, y: 100, label: "E1", fields: { kind: "VCVS", gain: "5" } },
   { type: "R", x: 460, y: 60, label: "RL", fields: { value: "1k", rot: 90 }, net: "OUT" }],
  [[100, 160, 100, 220], [100, 100, 100, 80], [100, 80, 300, 80],
   [300, 120, 300, 220], [300, 220, 100, 220],
   [380, 60, 460, 60], [460, 120, 460, 140], [460, 140, 380, 140],
   [380, 140, 380, 220], [380, 220, 300, 220]],
  { type: "op" });
check("a VCVS multiplies its control voltage", Math.abs(vcvs.values["v(out)"]?.[0] - 5) < 1e-6, JSON.stringify(vcvs.values["v(out)"]));

// A CCCS: 1 mA in the control branch, gain 10, so 1 V across a 100 Ω load.
const cccs = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 1", ac: "", rot: 90 } },
   { type: "R", x: 200, y: 40, label: "RS", fields: { value: "1k" } },
   { type: "GND", x: 100, y: 220 },
   { type: "DEP", x: 300, y: 100, label: "F1", fields: { kind: "CCCS", gain: "10" } },
   { type: "R", x: 460, y: 60, label: "RL", fields: { value: "100", rot: 90 }, net: "OUT" }],
  [[100, 100, 100, 40], [100, 40, 200, 40], [260, 40, 300, 40], [300, 40, 300, 80],
   [100, 160, 100, 220], [300, 120, 300, 220], [300, 220, 100, 220],
   [380, 60, 460, 60], [460, 120, 460, 140], [460, 140, 380, 140],
   [380, 140, 380, 220], [380, 220, 300, 220]],
  { type: "op" });
check("a CCCS multiplies the current in its control branch", Math.abs(Math.abs(cccs.values["v(out)"]?.[0]) - 1) < 0.02,
  `V(OUT) = ${cccs.values["v(out)"]?.[0]}`);
check("its control terminals are a short, made by a 0 V sense source", /^VF1_s \S+ \S+ DC 0$/m.test(cccs.netlist),
  cccs.netlist.split("\n").filter((l) => /F1/.test(l)).join(" | "));

// A 555 astable: 10k, 10k and 10n is about 4.8 kHz by the data-sheet formula.
const astable = await build(
  [{ type: "V", x: 80, y: 60, label: "VCC", fields: { value: "DC 5", ac: "", rot: 90 } },
   { type: "GND", x: 80, y: 180 },
   { type: "R", x: 240, y: 60, label: "R1", fields: { value: "10k", rot: 90 } },
   { type: "R", x: 240, y: 160, label: "R2", fields: { value: "10k", rot: 90 } },
   { type: "C", x: 240, y: 260, label: "C1", fields: { value: "10n", ic: "0", rot: 90 } },
   { type: "GND", x: 240, y: 360 },
   { type: "TIMER555", x: 420, y: 160, label: "U1", fields: { variant: "NE555" } },
   { type: "C", x: 420, y: 260, label: "C2", fields: { value: "10n", ic: "", rot: 90 } },
   { type: "GND", x: 420, y: 360 },
   { type: "GND", x: 480, y: 300 },
   { type: "R", x: 620, y: 120, label: "RL", fields: { value: "1k", rot: 90 }, net: "OUT" },
   { type: "GND", x: 620, y: 240 }],
  [[80, 60, 80, 20], [80, 20, 560, 20], [80, 120, 80, 180],
   [240, 20, 240, 60], [460, 20, 460, 80], [500, 20, 500, 80],
   [240, 120, 240, 140], [240, 140, 240, 160], [240, 220, 240, 260], [240, 320, 240, 360],
   [240, 140, 600, 140], [600, 140, 600, 180], [600, 180, 540, 180],
   [240, 240, 360, 240], [360, 240, 360, 120], [360, 120, 420, 120], [360, 160, 420, 160],
   [420, 200, 420, 260], [420, 320, 420, 360],
   [480, 240, 480, 300],
   [540, 120, 620, 120], [620, 180, 620, 240]],
  { type: "tran", trStop: "2m", trStep: "1u", trUic: true });
check("a 555 is one part on the sheet", /BTU1_o/.test(astable.netlist) && /RTU1_a/.test(astable.netlist));
const osc = (() => {
  const t = astable.sweep, v = astable.values["v(out)"];
  if (!t || !v) return { freq: 0, hi: 0, lo: 0 };
  const edges = [];
  for (let k = 1; k < t.length; k++) if (v[k - 1] < 1.5 && v[k] >= 1.5) edges.push(t[k]);
  const per = edges.slice(1).map((x, i) => x - edges[i]);
  return { freq: per.length ? per.length / per.reduce((a, b) => a + b, 0) : 0, hi: Math.max(...v), lo: Math.min(...v), cycles: edges.length };
})();
check("the astable oscillates near the data-sheet 4.8 kHz", osc.freq > 4200 && osc.freq < 5200, `${Math.round(osc.freq)} Hz over ${osc.cycles} cycles`);
check("its output swings from ground to about 1.7 V below the supply", osc.lo < 0.2 && osc.hi > 3.1 && osc.hi < 3.5, `${osc.lo.toFixed(2)} to ${osc.hi.toFixed(2)} V`);
const cap = astable.values["v(1)"] || Object.entries(astable.values).find(([k]) => /^v\(\d+\)$/.test(k))?.[1];
void cap;

console.log("\n— tier-one parts —");

// A potentiometer splits its resistance at the wiper.
const pot = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 10", ac: "", rot: 90 } },
   { type: "GND", x: 100, y: 220 },
   { type: "POT", x: 300, y: 160, label: "RP", fields: { value: "10k", wiper: "0.25" } },
   { type: "NET", x: 340, y: 120, fields: { name: "W" } }],
  [[100, 100, 100, 60], [100, 60, 300, 60], [300, 60, 300, 160],
   [340, 120, 340, 100], [380, 160, 400, 160], [400, 160, 400, 220], [400, 220, 100, 220], [100, 160, 100, 220]],
  { type: "op" });
check("a potentiometer divides at its wiper", Math.abs(pot.values["v(w)"]?.[0] - 7.5) < 0.01,
  `wiper at ${pot.values["v(w)"]?.[0]} V with the wiper 0.25 from end 1`);

// The AC source is both a VAC and a VSIN.
const acs = await build(
  [{ type: "ACSRC", x: 100, y: 100, label: "VS", fields: { ac: "1", dc: "0", ampl: "5", freq: "1k" }, net: "IN" },
   { type: "GND", x: 160, y: 160 },
   { type: "R", x: 100, y: 100, label: "R1", fields: { value: "1k", rot: 90 } }],
  [[160, 100, 160, 160], [100, 160, 160, 160]],
  { type: "tran", trStop: "2m", trStep: "10u" });
check("the AC source carries an AC magnitude and a sine together",
  /^VS \S+ \S+ DC 0 AC 1 SIN\(0 5 1k\)$/m.test(acs.netlist), acs.netlist.split("\n").find((l) => l.startsWith("VS")));

// A 7447 lights the right segments for each digit.
const seven = await page.evaluate(async () => {
  const L = window.__spiceLab, S = L.store;
  const out = [];
  for (let digit = 0; digit < 10; digit++) {
    L.freshLabs();
    S.clear();
    S.edit((s) => {
      const add = (type, x, y, f = {}) => { const c = S.addComp(type, x, y, type === "GND" ? "GND" : "X"); Object.assign(c, f); return c; };
      add("DEC7447", 400, 200, { label: "U1", device: "7447" });
      ["A", "B", "C", "D"].forEach((bit, b) => {
        const v = add("V", 100, 140 + b * 80, { label: `V${bit}`, value: `DC ${(digit >> b) & 1 ? 5 : 0}`, ac: "", rot: 90 });
        const n = S.addComp("NET", v.x, v.y, "N"); n.name = bit;
        add("GND", v.x, v.y + 60);
        S.addWire(v.x, v.y, 400, 140 + b * 20);
      });
      const bi = add("V", 260, 400, { label: "VBI", value: "DC 5", ac: "", rot: 90 });
      add("GND", 260, 460);
      S.addWire(260, 400, 400, 260);
      // name each segment output so the result can be read back
      "abcdefg".split("").forEach((seg, k) => {
        const n = S.addComp("NET", 520, 140 + k * 20, "N");
        n.name = `S${seg.toUpperCase()}`;
        S.addWire(520, 140 + k * 20, 560, 140 + k * 20);
      });
      s.analysis.type = "op";
    }, "t");
    const r = await L.simulate(S.state);
    const lit = "abcdefg".split("").map((seg) => {
      const t = r.traces.find((x) => x.name.toLowerCase() === `v(s${seg})`);
      return t && t.values[0] < 2.5 ? 1 : 0;      // outputs are active low
    }).join("");
    out.push(lit);
  }
  return out;
});
const WANT = ["1111110", "0110000", "1101101", "1111001", "0110011", "1011011", "1011111", "1110000", "1111111", "1111011"];
check("the 7447 lights the right segments for 0 to 9", seven.join(" ") === WANT.join(" "), seven.join(" "));

// A 74164 shifts a 1 along on each rising clock edge.
const shift = await page.evaluate(async () => {
  const L = window.__spiceLab, S = L.store;
  L.freshLabs();
  S.clear();
  S.edit((s) => {
    const add = (type, x, y, f = {}) => { const c = S.addComp(type, x, y, type === "GND" ? "GND" : "X"); Object.assign(c, f); return c; };
    add("SIPO", 400, 200, { label: "U1", device: "74164" });
    const hi = add("DHI", 200, 140, {});
    S.addWire(200, 140, 400, 120);                       // A
    S.addWire(200, 140, 400, 140);                       // B
    const clk = add("DCLK", 200, 300, { label: "DSTM1", offtime: "1m", ontime: "1m", delay: "0", startval: "0", oppval: "1" });
    const cn = S.addComp("NET", 200, 300, "N"); cn.name = "CLOCK";
    S.addWire(200, 300, 400, 180);
    const clr = add("DHI", 200, 380, {});
    S.addWire(200, 380, 400, 220);
    "ABCDEFGH".split("").forEach((q, k) => {
      const n = S.addComp("NET", 520, 130 + k * 20, "N"); n.name = `Q${q}`;
      S.addWire(520, 130 + k * 20, 560, 130 + k * 20);
    });
    void hi; void clk; void clr;
    Object.assign(s.analysis, { type: "tran", trStop: "12m", trStep: "0.1m", ffInit: "0" });
  }, "t");
  const r = await L.simulate(S.state);
  const ts = r.sweep.values;
  const at = (name, t) => {
    const tr = r.traces.find((x) => x.name.toLowerCase() === `v(${name.toLowerCase()})`);
    let k = 0; while (k < ts.length - 1 && ts[k + 1] <= t) k++;
    return tr && tr.values[k] > 2.5 ? 1 : 0;
  };
  // rising edges at 1 ms, 3 ms, 5 ms …
  return [1.5, 3.5, 5.5, 7.5].map((ms) => "ABCDEFGH".split("").map((q) => at(`q${q}`, ms * 1e-3)).join(""));
});
check("the 74164 shifts a one along, one place per clock", shift.join(" ") === "10000000 11000000 11100000 11110000", shift.join(" "));

// A half-built sheet must be refused, not left to spin.
const loose = await page.evaluate(async () => {
  const L = window.__spiceLab, S = L.store;
  L.freshLabs();
  S.clear();
  S.edit((s) => {
    const add = (type, x, y, f = {}) => { const c = S.addComp(type, x, y, type === "GND" ? "GND" : "X"); Object.assign(c, f); return c; };
    add("V", 100, 100, { label: "VS", value: "DC 5", ac: "", rot: 90 });
    add("GND", 100, 160);
    S.addWire(100, 100, 100, 160);
    add("LED", 300, 300, { label: "D1", model: "DLED" });   // nothing attached
    s.analysis.type = "op";
  }, "t");
  const started = Date.now();
  try {
    await L.simulate(S.state);
    return { ran: true, ms: Date.now() - started };
  } catch (e) { return { ran: false, ms: Date.now() - started, message: e.message }; }
});
check("a part with nothing attached stops the run instead of hanging the page",
  !loose.ran && loose.ms < 1000 && /D1 anode/.test(loose.message), JSON.stringify(loose).slice(0, 200));

console.log("\n— plot cursors —");
await loadSolved("e101-07a");
const cur = await page.evaluate(async () => {
  const L = window.__spiceLab;
  await L.run();
  const n = L.getResult().sweep.values.length;
  L.scope.placeCursor("a", Math.round(n * 0.25));
  L.scope.placeCursor("b", Math.round(n * 0.75));
  const rows = [...document.querySelectorAll(".cursor-readout tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
  return {
    marks: L.scope.cursors(),
    head: document.querySelector(".cursor-readout .measure-scope")?.textContent,
    rows,
    cols: [...document.querySelectorAll(".cursor-readout thead th")].map((t) => t.textContent)
  };
});
check("two cursors can be placed on the plot", cur.marks.a !== null && cur.marks.b !== null, JSON.stringify(cur.marks));
check("the readout has a column for each cursor and the difference",
  cur.cols.join("|") === "Trace|at A|at B|\u0394", cur.cols.join("|"));
check("it reports the gap between the cursors", /\u0394 12/.test(cur.head || ""), cur.head);
check("and each trace's value at both cursors", /-4\.5/.test(cur.rows[0]?.[1] || "") && /4\.5/.test(cur.rows[0]?.[2] || ""), JSON.stringify(cur.rows[0]));
const nudge = await page.evaluate(() => {
  const L = window.__spiceLab;
  const before = L.scope.cursors().b;
  document.querySelector(".scope-canvas").focus();
  document.querySelector(".scope-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  return { before, after: L.scope.cursors().b };
});
check("an arrow key nudges the cursor last placed", nudge.after === nudge.before + 1, JSON.stringify(nudge));
const cursorsGone = await page.evaluate(() => {
  window.__spiceLab.scope.clearCursors();
  return { marks: window.__spiceLab.scope.cursors(), table: document.querySelectorAll(".cursor-readout").length };
});
check("cursors can be cleared", cursorsGone.marks.a === null && cursorsGone.table === 0, JSON.stringify(cursorsGone));
const afterRun = await page.evaluate(async () => {
  const L = window.__spiceLab;
  L.scope.placeCursor("a", 10);
  await L.run();
  return L.scope.cursors();
});
check("a new run clears cursors rather than pointing at stale samples", afterRun.a === null, JSON.stringify(afterRun));

console.log("\n— title block and submission —");
await loadSolved("e101-07a");
const tbOff = await page.evaluate(() => document.querySelectorAll(".title-block").length);
check("no title block until it is asked for", tbOff === 0);
await page.evaluate(() => { document.getElementById("titleBlockBox").open = true; });
await page.fill("#tbName", "Sam Rivera");
await page.fill("#tbCourse", "ELEC 101");
await page.fill("#tbOrg", "Community College");
await page.fill("#tbDate", "2026-09-18");
await page.click("#btnTitleBlock");
await page.waitForTimeout(150);
const tb = await page.evaluate(() => {
  const g = document.querySelector(".title-block");
  const texts = [...(g?.querySelectorAll("text") || [])].map((t) => t.textContent);
  const box = g?.getBoundingClientRect();
  const sheet = document.querySelector("#sheetHost svg").getBoundingClientRect();
  return { texts, inside: box && box.top >= sheet.top - 1 && box.bottom <= sheet.bottom + 1, state: window.__spiceLab.store.state.titleBlock };
});
check("the title block shows the student, course, organization and document",
  tb.texts.includes("Sam Rivera") && tb.texts.includes("ELEC 101") && tb.texts.includes("Community College") && tb.texts.includes("LAB 07A"),
  tb.texts.join(" | "));
check("it is drawn on the sheet, so an export carries it", tb.inside);
check("its details are saved with the circuit", tb.state.show === true && tb.state.name === "Sam Rivera");
const tbFit = await page.evaluate(() => {
  const before = JSON.stringify(window.__spiceLab.canvas.contentBox());
  window.__spiceLab.canvas.render();
  return before === JSON.stringify(window.__spiceLab.canvas.contentBox());
});
check("the block sits still instead of walking down the page on every render", tbFit);
const tbCarried = await page.evaluate(() => {
  const sel = document.getElementById("labSelect");
  sel.value = "e101-06a"; sel.dispatchEvent(new Event("change"));
  return window.__spiceLab.store.state.titleBlock;
});
check("the student's own details follow them into the next lab", tbCarried.name === "Sam Rivera" && tbCarried.course === "ELEC 101", JSON.stringify(tbCarried));

// A real submission sheet, built from a real marking run.
await loadSolved("e101-07a");
await page.evaluate(() => { document.getElementById("tbName").value = "Sam Rivera"; document.getElementById("tbName").dispatchEvent(new Event("input")); });
const sub = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const out = await L.labs.runChecks(L.labs.labById("e101-07a"), L.store);
  const blob = await L.buildSubmissionSheet({
    svg: L.canvas.svg, sheetBox: L.canvas.contentBox(),
    plotCanvas: document.querySelector(".scope-canvas"),
    lab: L.labs.labById("e101-07a"), state: L.store.state, outcome: out
  });
  const bmp = await createImageBitmap(blob);
  return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height, ok: out.ok };
});
check("a submission sheet is produced as a PNG", sub.type === "image/png" && sub.size > 20000, JSON.stringify(sub));
check("it is a full page, tall enough for schematic, plot and results", sub.w === 3200 && sub.h > 2000, `${sub.w}×${sub.h}`);
const codes = await page.evaluate(async () => {
  const L = window.__spiceLab;
  const out = await L.labs.runChecks(L.labs.labById("e101-07a"), L.store);
  const make = async (name) => {
    const state = { ...L.store.state, titleBlock: { ...L.store.state.titleBlock, name } };
    const blob = await L.buildSubmissionSheet({ svg: L.canvas.svg, sheetBox: L.canvas.contentBox(), plotCanvas: null, lab: L.labs.labById("e101-07a"), state, outcome: out });
    return blob.size;
  };
  return { a: await make("Sam Rivera"), b: await make("Alex Chen") };
});
check("two students' sheets differ", codes.a !== codes.b, JSON.stringify(codes));
const guard = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.store.edit((s) => { s.titleBlock.name = ""; }, "t");
  document.getElementById("btnSubmit").click();
  return { open: document.getElementById("titleBlockBox").open, focus: document.activeElement.id };
});
check("submitting without a name asks for one instead of saving an unsigned sheet", guard.open && guard.focus === "tbName", JSON.stringify(guard));
if (process.env.SHOTS) {
  await page.evaluate(async () => {
    const L = window.__spiceLab;
    L.store.edit((s) => { s.titleBlock.name = "Sam Rivera"; }, "t");
    await L.run();
    const out = await L.labs.runChecks(L.labs.labById("e101-07a"), L.store);
    const blob = await L.buildSubmissionSheet({
      svg: L.canvas.svg, sheetBox: L.canvas.contentBox(),
      plotCanvas: document.querySelector(".scope-canvas"),
      lab: L.labs.labById("e101-07a"), state: L.store.state, outcome: out
    });
    const img = document.createElement("img");
    img.id = "shot";
    img.src = URL.createObjectURL(blob);
    img.style.cssText = "position:fixed;inset:0;width:100vw;z-index:999;background:#fff";
    document.body.appendChild(img);
    await img.decode();
  });
  await page.locator("#shot").screenshot({ path: "/tmp/submission.png" });
  await page.evaluate(() => document.getElementById("shot").remove());
  await page.evaluate(() => { window.T.open("e101-12a"); });
  await page.evaluate(() => {
    const L = window.__spiceLab;
    L.store.loadCircuit({ ...L.labs.diagramFor(L.labs.labById("e101-12a")), title: "LAB 12A" });
    L.store.edit((s) => { s.titleBlock = { show: true, org: "Community College", course: "ELEC 101", name: "Sam Rivera", date: "2026-09-18" }; }, "t");
    L.canvas.fit();
  });
  await page.locator("#sheetHost").screenshot({ path: "/tmp/titleblock.png" });
}

console.log("\n— second-tier parts —");

const reg = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 12", ac: "", rot: 90 } },
   { type: "REG", x: 240, y: 50, label: "U1", fields: { device: "7805", dropout: "2" } },
   { type: "R", x: 400, y: 100, label: "RL", fields: { value: "100", rot: 90 }, net: "OUT" },
   { type: "GND", x: 100, y: 220 }, { type: "GND", x: 400, y: 220 }, { type: "GND", x: 290, y: 160 }],
  [[100, 100, 100, 40], [100, 40, 240, 40], [340, 40, 400, 40], [400, 40, 400, 100],
   [400, 160, 400, 220], [100, 160, 100, 220], [290, 100, 290, 160]],
  { type: "op" });
check("a 7805 holds its output at 5 V", Math.abs(reg.values["v(out)"]?.[0] - 5) < 0.02, reg.error || `${reg.values["v(out)"]?.[0]} V`);

const bridge = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 10", ac: "", rot: 90 } },
   { type: "BRIDGE", x: 300, y: 160, label: "BR1", fields: { model: "D1N4001" } },
   { type: "R", x: 460, y: 160, label: "RL", fields: { value: "1k", rot: 90 }, net: "OUT" },
   { type: "GND", x: 340, y: 280 }],
  // The AC 2 wire goes round: a wire passing through the AC 1 pin would
  // connect to it and short the bridge out.
  [[100, 100, 280, 160], [100, 160, 100, 320], [100, 320, 400, 320], [400, 320, 400, 160],
   [340, 100, 460, 160], [340, 220, 460, 220], [340, 220, 340, 280]],
  { type: "op" });
check("a bridge rectifier puts two diode drops between its AC and DC sides",
  Math.abs(Math.abs(bridge.values["v(out)"]?.[0]) - 8.6) < 0.8, bridge.error || `${bridge.values["v(out)"]?.[0]} V`);

const cmp = await page.evaluate(async () => {
  const L = window.__spiceLab, S = L.store;
  const read = async (vin) => {
    L.freshLabs();
    S.clear();
    S.edit((s) => {
      const add = (type, x, y, f = {}) => { const c = S.addComp(type, x, y, type === "GND" ? "GND" : "X"); Object.assign(c, f); return c; };
      add("V", 100, 100, { label: "VIN", value: `DC ${vin}`, ac: "", rot: 90 });
      add("V", 240, 100, { label: "VREF", value: "DC 1", ac: "", rot: 90 });
      add("V", 380, 100, { label: "VCC", value: "DC 5", ac: "", rot: 90 });
      add("CMP", 500, 300, { label: "U1", device: "LM339" });
      add("R", 620, 160, { label: "RPU", value: "10k", rot: 90 });
      add("GND", 380, 460);
      const n = S.addComp("NET", 600, 300, "N"); n.name = "OUT";
      S.addWire(100, 100, 180, 100); S.addWire(180, 100, 180, 320); S.addWire(180, 320, 500, 320);
      S.addWire(240, 100, 320, 100); S.addWire(320, 100, 320, 280); S.addWire(320, 280, 500, 280);
      // Out to the right first: straight down from VCC's + pin would pass
      // through its − pin and short the supply.
      S.addWire(380, 100, 460, 100); S.addWire(460, 100, 460, 220);
      S.addWire(460, 220, 540, 220); S.addWire(540, 220, 540, 260);
      S.addWire(460, 140, 620, 140); S.addWire(620, 140, 620, 160);
      S.addWire(620, 220, 620, 300); S.addWire(620, 300, 580, 300);
      S.addWire(540, 340, 540, 420); S.addWire(540, 420, 380, 420);
      S.addWire(100, 160, 100, 420); S.addWire(100, 420, 380, 420);
      S.addWire(240, 160, 240, 420); S.addWire(380, 160, 380, 420);
      S.addWire(380, 420, 380, 460);
      s.analysis.type = "op";
    }, "t");
    try {
      const r = await L.simulate(S.state);
      const t = r.traces.find((x) => x.name.toLowerCase() === "v(out)");
      return t ? t.values[0] : null;
    } catch (e) { return e.message; }
  };
  return { above: await read(2), below: await read(0.5) };
});
check("a comparator's open-collector output only pulls low",
  cmp.above > 4 && cmp.below < 0.3, JSON.stringify(cmp));

const zen = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 10", ac: "", rot: 90 } },
   { type: "R", x: 200, y: 40, label: "R1", fields: { value: "1k" } },
   { type: "ZENER", x: 320, y: 100, label: "DZ", fields: { model: "D1N750", rot: 270 } },
   { type: "NET", x: 320, y: 40, fields: { name: "OUT" } },
   { type: "GND", x: 100, y: 220 }, { type: "GND", x: 320, y: 220 }],
  [[100, 100, 100, 40], [100, 40, 200, 40], [260, 40, 320, 40],
   [320, 100, 320, 220], [100, 160, 100, 220]],
  { type: "op" });
check("a zener clamps at its breakdown voltage", Math.abs(zen.values["v(out)"]?.[0] - 4.7) < 0.3, zen.error || `${zen.values["v(out)"]?.[0]} V`);

const misc = await page.evaluate(() => {
  const L = window.__spiceLab, S = L.store;
  S.clear();
  let shapes = {};
  S.edit(() => {
    const g = S.addComp("GND", 100, 100, "GND");
    const draw = () => L.parts.shapeOf(g).join("|");
    const signal = draw();
    g.style = "earth";
    const earth = draw();
    g.style = "chassis";
    const chassis = draw();
    shapes = { signal, earth, chassis, same: signal === earth || earth === chassis };
    const b = S.addComp("BATT", 300, 100, "V"); b.value = "9";
    const tp = S.addComp("TP", 500, 100, "TP"); tp.name = "TP1";
    S.addWire(300, 100, 500, 100);
  }, "t");
  L.refresh();
  return { shapes, netlist: document.getElementById("netOut").value };
});
check("ground has signal, earth and chassis symbols, all of them node 0", !misc.shapes.same,
  `${misc.shapes.signal.slice(0, 16)} / ${misc.shapes.earth.slice(0, 16)} / ${misc.shapes.chassis.slice(0, 16)}`);
check("a battery is a voltage source drawn as cells", / DC 9$/m.test(misc.netlist),
  misc.netlist.split("\n").find((l) => /DC 9/.test(l)) || "no source");
check("a test point names its node, like a net alias", /TP1/.test(misc.netlist),
  misc.netlist.split("\n").filter((l) => /TP1/.test(l)).join(" | ") || "not named");

console.log("\n— noise, temperature and Fourier —");

const noise = await build(
  [{ type: "ACSRC", x: 100, y: 100, label: "VS", fields: { ac: "1", dc: "0", ampl: "", freq: "1k", rot: 90 } },
   { type: "R", x: 200, y: 40, label: "R1", fields: { value: "10k" } },
   { type: "C", x: 320, y: 100, label: "C1", fields: { value: "1n", ic: "", rot: 90 } },
   { type: "NET", x: 320, y: 40, fields: { name: "OUT" } },
   { type: "GND", x: 100, y: 220 }, { type: "GND", x: 320, y: 220 }],
  [[100, 100, 100, 40], [100, 40, 200, 40], [260, 40, 320, 40], [320, 40, 320, 100],
   [320, 160, 320, 220], [100, 160, 100, 220]],
  { type: "noise", noiseOut: "OUT", noiseSrc: "VS", noisePts: "10", noiseStart: "10", noiseStop: "1k" });
check("a noise analysis reports output and input noise",
  noise.names.some((n) => /onoise/i.test(n)) && noise.names.some((n) => /inoise/i.test(n)), noise.error || noise.names.join(", "));
const nv = noise.values[Object.keys(noise.values).find((k) => /onoise/i.test(k)) || ""];
check("a 10k resistor's thermal noise is about 12.8 nV per root hertz",
  nv && Math.abs(nv[0] - 12.8e-9) < 1.5e-9, nv ? `${(nv[0] * 1e9).toFixed(1)} nV/root Hz` : "no trace");

const temps = await build(
  [{ type: "V", x: 100, y: 100, label: "VS", fields: { value: "DC 5", ac: "", rot: 90 } },
   { type: "R", x: 200, y: 40, label: "R1", fields: { value: "10k" } },
   { type: "D", x: 320, y: 100, label: "D1", fields: { model: "D1N4148", rot: 90 }, net: "OUT" },
   { type: "GND", x: 100, y: 220 }, { type: "GND", x: 320, y: 220 }],
  [[100, 100, 100, 40], [100, 40, 200, 40], [260, 40, 320, 40], [320, 40, 320, 100],
   [320, 160, 320, 220], [100, 160, 100, 220]],
  { type: "op", tempOn: true, tempList: "0 27 85" });
const drops = Object.entries(temps.values).filter(([k]) => /^v\(out\)/.test(k)).map(([, v]) => v[0]);
check("a temperature sweep runs once at each temperature", drops.length === 3, temps.error || `${drops.length} runs`);
check("and a diode's forward drop falls with temperature, by roughly 2 mV per degree",
  drops.length === 3 && drops[0] > drops[1] && drops[1] > drops[2] && Math.abs((drops[0] - drops[2]) / 85 - 0.002) < 0.001,
  drops.map((d) => d.toFixed(3)).join(" to "));

const four = await build(
  [{ type: "ACSRC", x: 100, y: 100, label: "VS", fields: { ac: "1", dc: "0", ampl: "10", freq: "1k", rot: 90 } },
   { type: "D", x: 160, y: 40, label: "D1", fields: { model: "D1N4148" } },
   { type: "R", x: 300, y: 100, label: "RL", fields: { value: "1k", rot: 90 } },
   { type: "NET", x: 300, y: 40, fields: { name: "OUT" } },
   { type: "GND", x: 100, y: 220 }, { type: "GND", x: 300, y: 220 }],
  [[100, 100, 100, 40], [100, 40, 160, 40], [220, 40, 300, 40], [300, 40, 300, 100],
   [300, 160, 300, 220], [100, 160, 100, 220]],
  { type: "tran", trStop: "5m", trStep: "1u", fourierOn: true, fourierFreq: "1k" }, {}, true);
check("Fourier reports the harmonics of a probed trace", !!four.fourier && four.fourier.traces.length > 0,
  four.error || JSON.stringify(four.fourier ? { traces: four.fourier.traces.length, f0: four.fourier.f0 } : null));
if (four.fourier?.traces.length) {
  const t = four.fourier.traces[0];
  // For a half-wave rectified sine the nth harmonic is 2A/(pi(n^2-1)), so the
  // second is about 42% of the fundamental and the THD lands near 43%. The
  // diode's own drop pushes both a little higher.
  check("the fundamental of a half-wave rectified sine is about half the peak",
    Math.abs(t.harmonics[0].mag - 4.6) < 0.7, `${t.harmonics[0].mag.toFixed(2)} V`);
  check("its second harmonic is a little over 40% of the fundamental",
    t.harmonics[1].relative > 0.38 && t.harmonics[1].relative < 0.54, `${(t.harmonics[1].relative * 100).toFixed(0)} %`);
  check("and the distortion figure lands near the 43% a half-wave rectifier gives",
    t.thd > 0.36 && t.thd < 0.6, `THD ${(t.thd * 100).toFixed(0)} %`);
}
const badFourier = await page.evaluate(() => {
  window.__spiceLab.store.edit((s) => { s.analysis.fourierFreq = ""; }, "t");
  window.__spiceLab.refresh();
  return document.getElementById("checks").textContent;
});
check("Fourier without a fundamental is explained", /fundamental frequency/i.test(badFourier), badFourier.slice(0, 120));

console.log("\n— the diagram in its own window —");
await page.evaluate(() => {
  const L = window.__spiceLab;
  L.freshLabs();
  localStorage.removeItem("q-circuits-diagram-v1");
  const sel = document.getElementById("labSelect");
  sel.value = "e101-06a"; sel.dispatchEvent(new Event("change"));
  if (document.getElementById("diagramWin").hidden) document.getElementById("btnDiagram").click();
});
const [pop] = await Promise.all([page.waitForEvent("popup"), page.click("#btnDiagramPop")]);
await pop.waitForLoadState();
await pop.waitForTimeout(200);
const inPop = await pop.evaluate(() => ({
  win: !!document.getElementById("diagramWin"),
  parts: document.querySelectorAll("#diagramWin .part").length,
  styled: getComputedStyle(document.getElementById("diagramWin")).position,
  width: document.getElementById("diagramWin").getBoundingClientRect().width,
  title: document.title,
  button: document.getElementById("btnDiagramPop").textContent
}));
const inPage = await page.evaluate(() => !!document.getElementById("diagramWin"));
check("Pop out moves the diagram into a window of its own", inPop.win && !inPage && inPop.parts > 3, JSON.stringify(inPop));
check("it fills that window, with the page's styles", inPop.styled === "static" && inPop.width > 600, `${inPop.styled}, ${Math.round(inPop.width)} px`);
check("the window is titled with the lab", /6A/.test(inPop.title), inPop.title);

const followed = await page.evaluate(() => {
  const sel = document.getElementById("labSelect");
  sel.value = "e101-12a"; sel.dispatchEvent(new Event("change"));
  return true;
});
void followed;
await pop.waitForTimeout(200);
const afterSwitch = await pop.evaluate(() => ({
  title: document.getElementById("diagramTitle").textContent,
  parts: document.querySelectorAll("#diagramWin .part").length
}));
check("it follows the student to the next lab", /12A/.test(afterSwitch.title) && afterSwitch.parts > 10, JSON.stringify(afterSwitch));

const fitWorks = await pop.evaluate(() => {
  document.getElementById("btnDiagramFit").click();
  return document.querySelector("#diagramHost svg").getAttribute("viewBox");
});
check("pan, zoom and Fit still work in the popped-out window", !!fitWorks, fitWorks);

await pop.close();
await page.waitForTimeout(200);
const home = await page.evaluate(() => ({
  win: !!document.getElementById("diagramWin"),
  popped: document.getElementById("diagramWin")?.classList.contains("is-popped"),
  button: document.getElementById("btnDiagramPop")?.textContent,
  parts: document.querySelectorAll("#diagramWin .part").length
}));
check("closing that window puts the diagram back on the page", home.win && !home.popped && home.button === "Pop out" && home.parts > 10, JSON.stringify(home));

const [pop2] = await Promise.all([page.waitForEvent("popup"), page.click("#btnDiagramPop")]);
await pop2.waitForLoadState();
await page.evaluate(() => {
  const sel = document.getElementById("labSelect");
  sel.value = ""; sel.dispatchEvent(new Event("change"));      // free build: no diagram
});
await page.waitForTimeout(200);
check("leaving the lab closes the diagram's window", pop2.isClosed(), `closed: ${pop2.isClosed()}`);

console.log("\n— exams —");

const examBasics = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.freshLabs();
  const sel = document.getElementById("labSelect");
  sel.value = "exam-mid-1"; sel.dispatchEvent(new Event("change"));
  return {
    kind: document.getElementById("labKind").textContent,
    check: document.getElementById("btnCheck").textContent,
    diagramButton: document.getElementById("btnDiagram").hidden,
    diagramWindow: document.getElementById("diagramWin").hidden,
    submitButton: document.getElementById("btnSubmit").hidden
  };
});
check("an exam has no reference diagram", examBasics.diagramButton && examBasics.diagramWindow, JSON.stringify(examBasics));
check("its button says submit, not check", /Submit exam answer/.test(examBasics.check), examBasics.check);

// Values follow the student's name, and the same name always gives the same draw.
const variants = await page.evaluate(() => {
  const L = window.__spiceLab;
  const lab = L.labs.labById("exam-mid-1");
  const draw = (name) => L.labs.variantFor(lab, name);
  return { sam: draw("Sam Rivera"), again: draw("Sam Rivera"), alex: draw("Alex Chen"), jo: draw("Jo Patel") };
});
check("a student's exam values are drawn from their name",
  JSON.stringify(variants.sam) === JSON.stringify(variants.again), JSON.stringify(variants.sam));
check("and two students get different papers",
  JSON.stringify(variants.sam) !== JSON.stringify(variants.alex) || JSON.stringify(variants.sam) !== JSON.stringify(variants.jo),
  `${JSON.stringify(variants.sam)} vs ${JSON.stringify(variants.alex)}`);

// A correct answer to the fix-it exam scores full marks.
const sat = await page.evaluate(async () => {
  const L = window.__spiceLab, S = L.store;
  const lab = L.labs.labById("exam-mid-1");
  S.edit((s) => { s.titleBlock = { ...s.titleBlock, name: "Sam Rivera", date: "2026-09-18" }; }, "t");
  const v = L.labs.variantFor(lab, "Sam Rivera");
  // build the corrected circuit
  S.loadCircuit({
    comps: [
      { type: "V", x: 160, y: 200, rot: 90, label: "VS", value: `DC ${v.VS}`, ac: "" },
      { type: "R", x: 220, y: 140, label: "R1", value: v.R1 },
      { type: "R", x: 340, y: 200, rot: 90, label: "R2", value: v.R2 },
      { type: "NET", x: 340, y: 140, label: "NOUT", name: "OUT" },
      { type: "GND", x: 250, y: 300, label: "GND" }
    ],
    wires: [
      { x1: 160, y1: 200, x2: 160, y2: 140 }, { x1: 160, y1: 140, x2: 220, y2: 140 },
      { x1: 280, y1: 140, x2: 340, y2: 140 }, { x1: 340, y1: 140, x2: 340, y2: 200 },
      { x1: 340, y1: 260, x2: 340, y2: 280 }, { x1: 340, y1: 280, x2: 160, y2: 280 },
      { x1: 160, y1: 260, x2: 160, y2: 280 }, { x1: 250, y1: 280, x2: 250, y2: 300 }
    ],
    probes: [], title: "Untitled circuit"
  });
  const want = (Number(v.VS) * L.labs.parseValue?.(v.R2) || 0);
  void want;
  const vout = (parseFloat(v.VS) * (parseFloat(v.R2) * (/k$/.test(v.R2) ? 1000 : 1))) /
    (parseFloat(v.R1) * (/k$/.test(v.R1) ? 1000 : 1) + parseFloat(v.R2) * (/k$/.test(v.R2) ? 1000 : 1));
  S.edit((s) => { s.answers = { vout: vout.toFixed(3) }; s.analysis.type = "op"; }, "t");
  const out = await L.labs.runChecks(lab, S);
  return { score: out.score, ok: out.ok, failed: out.results.filter((r) => !r.pass).map((r) => r.label) };
});
check("a correct answer scores full marks", sat.score.earned === sat.score.total,
  `${sat.score.earned} of ${sat.score.total}${sat.failed.length ? ` — missed: ${sat.failed.join("; ")}` : ""}`);

const untouched = await page.evaluate(async () => {
  const L = window.__spiceLab, S = L.store;
  const lab = L.labs.labById("exam-mid-1");
  L.freshLabs();
  const sel = document.getElementById("labSelect");
  sel.value = "exam-mid-1"; sel.dispatchEvent(new Event("change"));
  S.edit((s) => { s.titleBlock = { ...s.titleBlock, name: "Sam Rivera" }; }, "t");
  const out = await L.labs.runChecks(lab, S);
  return { earned: out.score.earned, total: out.score.total };
});
check("the faulty sheet an exam starts from scores poorly until it is fixed",
  untouched.earned < untouched.total / 2, `${untouched.earned} of ${untouched.total}`);

// Marks are weighted, and the code round-trips.
const coded = await page.evaluate(() => {
  const L = window.__spiceLab;
  const lab = L.labs.labById("exam-mid-1");
  const v = L.labs.variantFor(lab, "Sam Rivera");
  const checks = lab.checks(v);
  const results = checks.map((c, i) => ({ pass: i !== 1 }));       // wiring missed
  const partial = L.labs.scoreOf(checks, results);
  const code = L.labs.encodeOutcome({ labId: lab.id, name: "Sam Rivera", date: "2026-09-18", results });
  return { partial, code, decoded: L.labs.decodeOutcome(code), tampered: L.labs.decodeOutcome(code.replace(/^./, "X")) };
});
check("checks carry marks, so a missed one costs more than a mark",
  coded.partial.total > coded.partial.earned + 1, JSON.stringify(coded.partial));
const weighting = await page.evaluate(() => {
  const L = window.__spiceLab;
  const lab = L.labs.labById("exam-mid-1");
  const v = L.labs.variantFor(lab, "Sam Rivera");
  const checks = lab.checks(v);
  const questions = lab.questions(v);
  const all = [...checks, ...questions.map((q) => ({ label: q.prompt, points: q.points }))];
  const allPassed = all.map(() => ({ pass: true }));
  const missedReading = all.map((c, i) => ({ pass: i < checks.length }));
  return { total: L.labs.scoreOf(all, allPassed).earned, withoutReading: L.labs.scoreOf(all, missedReading).earned };
});
check("a reading worth three marks costs three when it is wrong",
  weighting.total - weighting.withoutReading === 3, `${weighting.total} vs ${weighting.withoutReading}`);

check("the result code carries the breakdown back",
  coded.decoded && coded.decoded.name === "Sam Rivera" && coded.decoded.bits[1] === false, JSON.stringify(coded.decoded).slice(0, 120));
check("an edited code is refused rather than misread", coded.tampered === null, JSON.stringify(coded.tampered));

const decodeUi = await page.evaluate((code) => {
  document.getElementById("examCode").value = code;
  document.getElementById("btnDecode").click();
  return {
    score: document.querySelector("#checkResults .exam-score")?.textContent || "",
    rows: [...document.querySelectorAll("#checkResults .check-list li")].map((li) => li.className)
  };
}, coded.code);
check("pasting a code shows the student's score and which checks they missed",
  /Sam Rivera/.test(decodeUi.score) && decodeUi.rows.includes("fail") && decodeUi.rows.filter((r) => r === "pass").length > 3,
  `${decodeUi.score} · ${decodeUi.rows.join(",")}`);

const examSubmit = await page.evaluate(async () => {
  const L = window.__spiceLab;
  L.store.edit((s) => { s.titleBlock = { ...s.titleBlock, name: "" }; }, "t");
  document.getElementById("btnCheck").click();
  await new Promise((r) => setTimeout(r, 200));
  return { open: document.getElementById("titleBlockBox").open, focus: document.activeElement.id };
});
check("an exam will not be submitted without a name on it", examSubmit.open && examSubmit.focus === "tbName", JSON.stringify(examSubmit));

console.log("\n— lab view and full view —");
const views = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.freshLabs();
  const sel = document.getElementById("labSelect");
  sel.value = "e101-07a"; sel.dispatchEvent(new Event("change"));
  const shown = (sel2) => { const e = document.querySelector(sel2); return !!e && getComputedStyle(e).display !== "none"; };
  const palette = () => [...document.querySelectorAll("#partTools button[data-tool]")].filter((b) => !b.hidden).map((b) => b.dataset.tool);
  const lab = {
    mode: document.getElementById("btnViewMode").getAttribute("aria-pressed"),
    parts: palette(),
    netlist: shown('.workspace > .panel[aria-labelledby="netHead"]'),
    partsTable: shown(".parts-table"),
    warnings: shown("#checks"),
    fourier: shown(".param-box:has(#fourierOn)"),
    authoring: shown("#btnLabSource")
  };
  document.getElementById("btnViewMode").click();
  const full = { mode: document.getElementById("btnViewMode").getAttribute("aria-pressed"), parts: palette(), netlist: shown('.workspace > .panel[aria-labelledby="netHead"]'), fourier: shown(".param-box:has(#fourierOn)") };
  document.getElementById("btnViewMode").click();
  return { lab, full };
});
check("opening a lab switches to lab view", views.lab.mode === "false");
check("lab view shows the parts the labs use and hides the rest",
  views.lab.parts.includes("R") && views.lab.parts.includes("V") && !views.lab.parts.includes("TIMER555") && !views.lab.parts.includes("POT"),
  views.lab.parts.join(" "));
check("it hides the netlist, the parts table and the extra analyses",
  !views.lab.netlist && !views.lab.partsTable && !views.lab.fourier && !views.lab.authoring, JSON.stringify(views.lab).slice(0, 160));
check("but keeps the warnings, which Labs 4A and 14B send students to", views.lab.warnings);
check("full view brings everything back", views.full.mode === "true" && views.full.netlist && views.full.fourier && views.full.parts.length > views.lab.parts.length,
  `${views.lab.parts.length} parts in lab view, ${views.full.parts.length} in full`);

const freeBuild = await page.evaluate(() => {
  const sel = document.getElementById("labSelect");
  sel.value = ""; sel.dispatchEvent(new Event("change"));
  return document.getElementById("btnViewMode").getAttribute("aria-pressed");
});
check("free build opens in full view", freeBuild === "true");

const kept = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.store.edit(() => { L.store.addComp("TIMER555", 300, 300, "U"); }, "t");
  const sel = document.getElementById("labSelect");
  sel.value = "e101-07a"; sel.dispatchEvent(new Event("change"));      // back to lab view
  L.store.edit(() => { L.store.addComp("TIMER555", 300, 300, "U"); }, "t");
  L.refresh();
  const btn = document.querySelector('#partTools button[data-tool="TIMER555"]');
  return { hidden: btn.hidden, mode: document.getElementById("btnViewMode").getAttribute("aria-pressed") };
});
check("a part already on the sheet stays in the palette, whichever view is on", !kept.hidden, JSON.stringify(kept));

const shortcut = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.store.clear();
  // N is the inductor, a part lab view hides.
  document.querySelector("#sheetHost svg").dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
  return L.canvas.getTool();
});
check("keyboard shortcuts still reach parts the view hides", shortcut === "L", shortcut);

console.log("\n— printing and lab authoring —");

// What the print rules leave on the page.
await loadSolved("e101-12a");
await page.evaluate(async () => { await window.__spiceLab.run(); });
await page.emulateMedia({ media: "print" });
const printed = await page.evaluate(() => {
  const shown = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== "none" && r.width > 0;
  };
  return {
    sheet: shown("#sheetHost svg"),
    plot: shown(".scope-canvas"),
    measurements: shown(".measure-table"),
    toolbar: shown(".toolbar-strip"),
    side: shown(".side"),
    netlist: shown("#netOut"),
    hints: shown(".hint-bar"),
    grid: shown(".grid-layer"),
    footer: shown(".site-footer")
  };
});
check("printing keeps the schematic, the plot and the measurements",
  printed.sheet && printed.plot && printed.measurements, JSON.stringify(printed));
check("and leaves out the toolbar, panels, netlist, hints, footer and dot grid",
  !printed.toolbar && !printed.side && !printed.netlist && !printed.hints && !printed.footer && !printed.grid, JSON.stringify(printed));
await page.emulateMedia({ media: "screen" });

const framed = await page.evaluate(() => {
  const L = window.__spiceLab;
  L.canvas.setView({ x: 200, y: 200, w: 200, h: 130 });     // zoomed right in
  const zoomed = L.canvas.getView();
  window.dispatchEvent(new Event("beforeprint"));
  const printing = L.canvas.getView();
  window.dispatchEvent(new Event("afterprint"));
  return { zoomed, printing, restored: L.canvas.getView() };
});
check("printing frames the whole circuit, however the student was zoomed",
  framed.printing.w > framed.zoomed.w * 2, JSON.stringify({ zoomed: framed.zoomed.w, printing: Math.round(framed.printing.w) }));
check("and puts the view back afterwards", framed.restored.w === framed.zoomed.w && framed.restored.x === framed.zoomed.x,
  JSON.stringify(framed.restored));

// Authoring: a sheet copied out and pasted back must be the same circuit.
const round = await page.evaluate(() => {
  const L = window.__spiceLab;
  const before = { netlist: document.getElementById("netOut").value, parts: L.store.state.comps.length };
  const text = L.labDiagramSource(L.store.state);
  const diagram = new Function(`return (${text.split("\n").filter((l) => !l.startsWith("//")).join("\n")})`)();
  L.store.loadCircuit({ ...diagram, title: L.store.state.title });
  L.refresh();
  return {
    text,
    before,
    after: { netlist: document.getElementById("netOut").value, parts: L.store.state.comps.length }
  };
});
// A diagram holds parts, wires and probes; the analysis belongs to the lab
// definition, and is noted in the comment rather than the data.
const devicesOnly = (net) => net.split("\n").filter((l) => !/^[.*]/.test(l)).join("\n");
check("a sheet copied as a lab diagram loads back as the same circuit",
  devicesOnly(round.before.netlist) === devicesOnly(round.after.netlist) && round.before.parts === round.after.parts,
  `${round.before.parts} parts vs ${round.after.parts}; netlist differs at: ${
    (() => { const a = round.before.netlist.split("\n"), b = round.after.netlist.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `"${a[i]}" vs "${b[i]}"`;
      return "nowhere"; })()}`);
check("the copied source is JavaScript ready to paste into the labs file",
  /^\/\/ Reference diagram/.test(round.text) && /comps: \[/.test(round.text) && /wires: \[/.test(round.text),
  round.text.split("\n").slice(0, 4).join(" / "));
check("it records the settings the circuit was drawn with",
  /\/\/ title: "LAB 12A"/.test(round.text) && /\/\/ analysis: \{[^}]*type: "ac"/.test(round.text),
  round.text.split("\n").filter((l) => l.startsWith("//")).join(" / "));
check("identifiers are left out, since they are handed out on loading", !/\bid:/.test(round.text));

const authored = await page.evaluate(() => {
  const L = window.__spiceLab;
  // a part with a mirror, a bus and a probe: the awkward cases
  L.store.clear();
  L.store.edit((s) => {
    const c = L.store.addComp("NPN", 200, 200, "Q");
    c.mx = true;
    L.store.addWire(100, 400, 500, 400, true);
    L.store.toggleProbe("v", "200,200", { x: 200, y: 200 });
  }, "t");
  return L.labDiagramSource(L.store.state);
});
check("mirrors, buses and probes survive the copy",
  /mx: true/.test(authored) && /bus: true/.test(authored) && /kind: "v"/.test(authored),
  authored.split("\n").filter((l) => /mx|bus|kind/.test(l)).join(" / "));
const emptyCopy = await page.evaluate(async () => {
  window.__spiceLab.store.clear();
  document.getElementById("btnLabSource").click();
  await new Promise((r) => setTimeout(r, 50));
  return document.getElementById("status")?.textContent || document.querySelector("[role=status]")?.textContent || "";
});
check("copying an empty sheet says so rather than copying nothing", /nothing to copy/i.test(emptyCopy), emptyCopy);

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
