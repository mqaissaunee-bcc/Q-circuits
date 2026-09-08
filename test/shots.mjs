import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";
const ROOT = new URL("../dist/", import.meta.url).pathname;
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css"};
const srv=createServer((q,s)=>{const f=join(ROOT,normalize(q.url.split("?")[0]==="/"?"/index.html":q.url.split("?")[0]));
 if(!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);return s.end();}
 s.writeHead(200,{"Content-Type":MIME[extname(f)]||"application/octet-stream"});s.end(readFileSync(f));});
await new Promise(r=>srv.listen(5213,r));
const b=await chromium.launch();

async function shot(name, lab, scheme, vp, run=true) {
  const p = await b.newPage({viewport:vp, colorScheme:scheme, deviceScaleFactor:2});
  p.on("dialog",d=>d.accept());
  await p.goto("http://localhost:5213/");
  await p.waitForFunction(()=>!!window.__spiceLab);
  if (lab) { await p.selectOption("#labSelect", lab); await p.waitForTimeout(200); }
  if (run) {
    await p.click("#btnRun");
    await p.waitForFunction(()=>window.__spiceLab.getResult()!==null,null,{timeout:90000});
    await p.waitForTimeout(500);
  }
  await p.screenshot({path:`../shot-${name}.png`, fullPage: vp.width < 600});
  await p.close();
  console.log("shot", name);
}
await shot("app-tran","rectifier","light",{width:1440,height:1180});
await shot("app-ac","rc-lowpass","dark",{width:1440,height:1180});
await shot("app-mobile","divider","light",{width:390,height:844});
await b.close(); srv.close();
