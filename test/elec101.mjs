import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";
const ROOT=new URL("../dist/",import.meta.url).pathname;
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml"};
const srv=createServer((q,s)=>{const f=join(ROOT,normalize(q.url.split("?")[0]==="/"?"/index.html":q.url.split("?")[0]));
 if(!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);return s.end();}
 s.writeHead(200,{"Content-Type":MIME[extname(f)]||"application/octet-stream"});s.end(readFileSync(f));});
await new Promise(r=>srv.listen(5240,r));
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1500,height:1000}});
p.on("dialog",d=>d.accept()); p.on("pageerror",e=>console.log("PAGEERROR:",e.message));
await p.goto("http://localhost:5240/");
await p.waitForFunction(()=>!!window.__spiceLab && window.__spiceLab.ready===true);

const load = async (id) => p.evaluate((id)=>{
  document.getElementById("labSelect").value = id;
  document.getElementById("labSelect").dispatchEvent(new Event("change"));
  return document.getElementById("netOut").value;
}, id);

const check = async () => p.evaluate(async () => {
  document.getElementById("btnCheck").click();
  for (let i=0;i<120;i++){ await new Promise(r=>setTimeout(r,250));
    const li=document.querySelectorAll("#checkResults .check-list li");
    if (li.length) return [...li].map(e=>({pass:e.className.includes("pass"),
      text:e.textContent.replace(/\s+/g," ").trim()})); }
  return [{pass:false,text:"TIMED OUT"}];
});

for (const id of ["elec101-4a","elec101-4b","elec101-5a","elec101-5b","elec101-5c"]) {
  const netlist = await load(id);
  await p.waitForTimeout(250);
  console.log("\n════ " + id + " ════");
  console.log(netlist.split("\n").filter(l=>l&&!l.startsWith("*")).map(l=>"   "+l).join("\n"));
  const warn = await p.evaluate(()=>[...document.querySelectorAll("#checks li")].map(l=>l.className+": "+l.textContent.trim().slice(0,80)));
  warn.forEach(w=>console.log("   [" + w + "]"));
  const res = await check();
  console.log("   as delivered:");
  res.forEach(r=>console.log(`     ${r.pass?"PASS":"fail"}  ${r.text.slice(0,95)}`));
}
await b.close(); srv.close();
