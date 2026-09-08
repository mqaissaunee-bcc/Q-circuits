// Serve dist/ under /spice-lab/ the way GitHub Pages serves a project site.
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";
import { gzipSync } from "zlib";

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PREFIX = "/spice-lab";
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css" };

const srv = createServer((q, s) => {
  let url = decodeURIComponent(q.url.split("?")[0]);
  if (!url.startsWith(PREFIX)) { s.writeHead(404); return s.end("outside project path"); }
  url = url.slice(PREFIX.length) || "/";
  const f = join(ROOT, normalize(url === "/" ? "/index.html" : url));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { s.writeHead(404); return s.end("nf"); }
  s.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
  s.end(readFileSync(f));
});
await new Promise(r => srv.listen(5215, r));

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const bad = [];
p.on("requestfailed", r => bad.push(`FAILED ${r.url()}`));
p.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
p.on("pageerror", e => bad.push("pageerror: " + e.message));

await p.goto("http://localhost:5215/spice-lab/");
await p.waitForFunction(() => !!window.__spiceLab, null, { timeout: 20000 });
await p.click("#btnRun");
await p.waitForFunction(() => window.__spiceLab.getResult() !== null, null, { timeout: 90000 });

const v = await p.evaluate(() => {
  const t = window.__spiceLab.getResult().traces.find(t => t.name === "v(2)");
  return t.values[t.values.length - 1];
});
console.log("served from /spice-lab/ subpath");
console.log("  simulation result v(2) =", v);
console.log("  absolute-path requests or 404s:", bad.length ? bad : "none");

// what the browser actually pulls down
const js = readFileSync(join(ROOT, "assets", (await import("fs")).readdirSync(join(ROOT,"assets")).find(f => f.startsWith("ngspice"))));
console.log(`  engine chunk: ${(js.length/1048576).toFixed(1)} MB raw, ${(gzipSync(js).length/1048576).toFixed(1)} MB gzipped`);

await b.close(); srv.close();
