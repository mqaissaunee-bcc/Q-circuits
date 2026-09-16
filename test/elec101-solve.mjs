import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { extname, join, normalize } from "path";
const ROOT=new URL("../dist/",import.meta.url).pathname;
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml"};
const srv=createServer((q,s)=>{const f=join(ROOT,normalize(q.url.split("?")[0]==="/"?"/index.html":q.url.split("?")[0]));
 if(!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);return s.end();}
 s.writeHead(200,{"Content-Type":MIME[extname(f)]||"application/octet-stream"});s.end(readFileSync(f));});
await new Promise(r=>srv.listen(5244,r));
const b=await chromium.launch();

// Each entry does what the lab asks a student to do.
const SOLUTIONS = {
  "elec101-4a": (S) => {
    S.edit((st) => {
      const v2 = st.comps.find(c => c.label === "V2");
      st.comps = st.comps.filter(c => c.id !== v2.id);
      // its two connecting wires, and the wire shorting R1
      const kill = (x1,y1,x2,y2) => { st.wires = st.wires.filter(w =>
        !(w.x1===x1&&w.y1===y1&&w.x2===x2&&w.y2===y2)); };
      kill(100,140,160,140); kill(100,200,160,200); kill(260,140,320,140);
      S.addWire(440,160,440,120); S.addWire(440,120,320,120); S.addWire(320,120,320,140);
    }, "solve");
  },
  "elec101-4b": (S) => {
    S.edit(() => { S.state.comps.find(c=>c.label==="R1").value = "1k"; }, "solve");
    S.selection = new Set([S.state.comps.find(c=>c.label==="R4").id]);
    S.moveSelection(0, -20);          // plain move: the wires stretch with it
    S.selection.clear();
  },
  "elec101-5a": (S) => {
    S.edit(() => { Object.assign(S.state.analysis,
      { type:"ac", acStart:"10", acStop:"100k", acPts:"101" }); }, "solve");
  },
  "elec101-5b": (S) => {
    S.edit((st) => {
      Object.assign(st.analysis, { type:"tran", trStep:"10u", trStop:"5m" });
      st.wires = st.wires.filter(w => !(w.x1===420&&w.y1===180&&w.x2===420&&w.y2===260));
      const am = S.addComp("AM", 420, 180, "AM"); am.rot = 90;
      S.addWire(420, 240, 420, 260);
    }, "solve");
    S.toggleProbe("i", "VAM1", {});
  },
  "elec101-5c": (S) => {
    S.edit(() => {
      const a = S.addComp("NET", 200, 180, "N"); a.netname = "IN";
      const c = S.addComp("NET", 540, 180, "N"); c.netname = "OUT";
    }, "solve");
  }
};

for (const [id, solve] of Object.entries(SOLUTIONS)) {
  const p = await b.newPage({ viewport:{width:1500,height:1000} });
  p.on("dialog", d=>d.accept());
  await p.goto("http://localhost:5244/");
  await p.waitForFunction(()=>!!window.__spiceLab && window.__spiceLab.ready===true);
  await p.evaluate((id)=>{ document.getElementById("labSelect").value=id;
    document.getElementById("labSelect").dispatchEvent(new Event("change")); }, id);
  await p.waitForTimeout(250);
  await p.evaluate(`(${solve.toString()})(window.__spiceLab.store)`);
  await p.waitForTimeout(250);

  const res = await Promise.race([
    p.evaluate(async () => {
      document.getElementById("btnCheck").click();
      for (let i=0;i<160;i++){ await new Promise(r=>setTimeout(r,250));
        const li=document.querySelectorAll("#checkResults .check-list li");
        if (li.length) return [...li].map(e=>({pass:e.className.includes("pass"),
          text:e.textContent.replace(/\s+/g," ").trim()})); }
      return [{pass:false,text:"TIMED OUT"}];
    }),
    new Promise(r=>setTimeout(()=>r([{pass:false,text:"HUNG"}]), 60000))
  ]);
  const all = res.every(r=>r.pass);
  console.log(`\n${id}  ${all ? "ALL CHECKS PASS" : "NOT COMPLETABLE"}`);
  res.forEach(r=>console.log(`   ${r.pass?"pass":"FAIL"}  ${r.text.slice(0,92)}`));
  await p.close().catch(()=>{});
}
await b.close().catch(()=>{}); srv.close(); process.exit(0);
