/**
 * Waveform viewer.
 *
 * Drawn on a 2D canvas rather than SVG because a transient run can return
 * thousands of points per trace and the DOM node count stops being free.
 * Colours are read from CSS custom properties so the plot follows the theme.
 */

import { formatEng } from "./netlist.js";

const PAD = { left: 62, right: 14, top: 14, bottom: 34 };
const TRACE_VARS = ["--trace-0", "--trace-1", "--trace-2", "--trace-3", "--trace-4", "--trace-5"];

function niceTicks(min, max, target = 6) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

function decadeTicks(min, max) {
  const out = [];
  const lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
  for (let d = lo; d <= hi; d++) {
    const base = Math.pow(10, d);
    if (base >= min * 0.999 && base <= max * 1.001) out.push(base);
  }
  return out;
}

export function createScope({ host, onStatus }) {
  const canvas = document.createElement("canvas");
  canvas.className = "scope-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Waveform plot. A numeric summary is listed under the plot.");
  host.appendChild(canvas);

  const readout = document.createElement("div");
  readout.className = "scope-readout";
  readout.setAttribute("aria-live", "off");
  host.appendChild(readout);

  let result = null;
  let mode = "value";        // value | db | phase
  let hidden = new Set();
  let cursor = null;
  let layout = null;

  function colors() {
    const cs = getComputedStyle(canvas);
    return {
      ink: cs.getPropertyValue("--ink").trim(),
      soft: cs.getPropertyValue("--ink-soft").trim(),
      rule: cs.getPropertyValue("--rule").trim(),
      grid: cs.getPropertyValue("--scope-grid").trim(),
      bg: cs.getPropertyValue("--scope-bg").trim(),
      traces: TRACE_VARS.map((v) => cs.getPropertyValue(v).trim())
    };
  }

  function visibleTraces() {
    if (!result) return [];
    return result.traces.filter((t) => !hidden.has(t.name));
  }

  function seriesOf(t) {
    if (!t.complex) return t.values;
    if (mode === "phase") return t.phase;
    if (mode === "db") return t.db;
    return t.mag;
  }

  function unitOf(t) {
    if (t.complex) return mode === "phase" ? "°" : mode === "db" ? "dB" : (t.type === "current" ? "A" : "V");
    return t.type === "current" ? "A" : "V";
  }

  function logX() {
    return !!result && result.sweep?.type === "frequency";
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, rect.width);
    const h = Math.max(220, Math.min(420, rect.width * 0.42));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, ctx };
  }

  function draw() {
    const { w, h, ctx } = resize();
    const c = colors();
    ctx.clearRect(0, 0, w, h);

    const plot = {
      x: PAD.left, y: PAD.top,
      w: Math.max(20, w - PAD.left - PAD.right),
      h: Math.max(20, h - PAD.top - PAD.bottom)
    };

    ctx.fillStyle = c.bg;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    if (!result || !result.sweep) {
      ctx.fillStyle = c.soft;
      ctx.font = '13px "IBM Plex Sans", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(result ? "No waveform for this analysis." : "Run a simulation to see waveforms.",
                   plot.x + plot.w / 2, plot.y + plot.h / 2);
      layout = null;
      renderReadout(null);
      return;
    }

    const xs = result.sweep.values;
    const traces = visibleTraces();
    const useLog = logX();

    let xmin = xs[0], xmax = xs[xs.length - 1];
    if (useLog) { xmin = Math.max(xmin, 1e-12); xmax = Math.max(xmax, xmin * 10); }

    let ymin = Infinity, ymax = -Infinity;
    traces.forEach((t) => {
      const s = seriesOf(t);
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        if (!isFinite(v)) continue;
        if (v < ymin) ymin = v;
        if (v > ymax) ymax = v;
      }
    });
    if (!isFinite(ymin) || !isFinite(ymax)) { ymin = -1; ymax = 1; }
    if (ymin === ymax) { ymin -= 0.5; ymax += 0.5; }
    const padY = (ymax - ymin) * 0.08;
    ymin -= padY; ymax += padY;

    const sx = (v) => useLog
      ? plot.x + ((Math.log10(Math.max(v, xmin)) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * plot.w
      : plot.x + ((v - xmin) / (xmax - xmin || 1)) * plot.w;
    const sy = (v) => plot.y + plot.h - ((v - ymin) / (ymax - ymin)) * plot.h;

    // grid
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = c.soft;
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';

    const yTicks = niceTicks(ymin, ymax, 5);
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    yTicks.forEach((v) => {
      const y = sy(v);
      if (y < plot.y - 1 || y > plot.y + plot.h + 1) return;
      ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
      ctx.fillText(formatEng(v, 3), plot.x - 8, y);
    });

    const xTicks = useLog ? decadeTicks(xmin, xmax) : niceTicks(xmin, xmax, 6);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    xTicks.forEach((v) => {
      const x = sx(v);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) return;
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
      ctx.fillText(formatEng(v, 3), x, plot.y + plot.h + 7);
    });

    // zero line
    if (ymin < 0 && ymax > 0) {
      ctx.strokeStyle = c.rule;
      ctx.beginPath(); ctx.moveTo(plot.x, sy(0)); ctx.lineTo(plot.x + plot.w, sy(0)); ctx.stroke();
    }

    // frame
    ctx.strokeStyle = c.rule;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);

    // traces
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    traces.forEach((t, i) => {
      const s = seriesOf(t);
      ctx.strokeStyle = c.traces[result.traces.indexOf(t) % c.traces.length];
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < s.length && k < xs.length; k++) {
        const v = s[k];
        if (!isFinite(v)) { started = false; continue; }
        const px = sx(xs[k]), py = sy(v);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });

    // axis titles
    ctx.fillStyle = c.soft;
    ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(sweepLabel(), plot.x + plot.w / 2, h - 2);

    layout = { plot, sx, sy, xmin, xmax, ymin, ymax, xs, useLog };

    if (cursor) drawCursor(ctx, c);
    renderReadout(cursor ? cursorIndex() : null);
  }

  function sweepLabel() {
    if (!result?.sweep) return "";
    if (result.sweep.type === "time") return "time (s)";
    if (result.sweep.type === "frequency") return "frequency (Hz)";
    return result.sweep.name;
  }

  function cursorIndex() {
    if (!layout || !cursor) return null;
    const { xs } = layout;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(layout.sx(xs[i]) - cursor.x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function drawCursor(ctx, c) {
    const i = cursorIndex();
    if (i === null) return;
    const x = layout.sx(layout.xs[i]);
    ctx.save();
    ctx.strokeStyle = c.soft;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, layout.plot.y);
    ctx.lineTo(x, layout.plot.y + layout.plot.h);
    ctx.stroke();
    ctx.setLineDash([]);
    visibleTraces().forEach((t) => {
      const v = seriesOf(t)[i];
      if (!isFinite(v)) return;
      ctx.fillStyle = c.traces[result.traces.indexOf(t) % c.traces.length];
      ctx.beginPath();
      ctx.arc(x, layout.sy(v), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function renderReadout(index) {
    while (readout.firstChild) readout.removeChild(readout.firstChild);
    if (!result) return;

    const list = document.createElement("ul");
    list.className = "legend";

    const at = index === null || index === undefined ? null : index;
    if (at !== null && result.sweep) {
      const li = document.createElement("li");
      li.className = "legend-sweep";
      li.textContent = `${sweepLabel().replace(/\s*\(.*\)/, "")} = ${formatEng(result.sweep.values[at], 4)}`;
      list.appendChild(li);
    }

    result.traces.forEach((t, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "legend-item" + (hidden.has(t.name) ? " is-off" : "");
      btn.setAttribute("aria-pressed", hidden.has(t.name) ? "false" : "true");

      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = `var(${TRACE_VARS[i % TRACE_VARS.length]})`;
      btn.appendChild(sw);

      const name = document.createElement("span");
      name.className = "legend-name";
      name.textContent = t.name;
      btn.appendChild(name);

      const val = document.createElement("span");
      val.className = "legend-value";
      if (at !== null) {
        const v = seriesOf(t)[at];
        val.textContent = isFinite(v) ? `${formatEng(v, 4)} ${unitOf(t)}` : "—";
      } else {
        const s = seriesOf(t);
        let mn = Infinity, mx = -Infinity;
        for (const v of s) { if (!isFinite(v)) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
        val.textContent = isFinite(mn) ? `${formatEng(mn, 3)} … ${formatEng(mx, 3)} ${unitOf(t)}` : "—";
      }
      btn.appendChild(val);

      btn.addEventListener("click", () => {
        if (hidden.has(t.name)) hidden.delete(t.name); else hidden.add(t.name);
        onStatus?.(`${t.name} ${hidden.has(t.name) ? "hidden" : "shown"}.`);
        draw();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });

    readout.appendChild(list);
  }

  canvas.addEventListener("pointermove", (evt) => {
    if (!layout) return;
    const r = canvas.getBoundingClientRect();
    const x = evt.clientX - r.left;
    if (x < layout.plot.x || x > layout.plot.x + layout.plot.w) { cursor = null; draw(); return; }
    cursor = { x };
    draw();
  });
  canvas.addEventListener("pointerleave", () => { cursor = null; draw(); });

  const ro = new ResizeObserver(() => draw());
  ro.observe(host);

  return {
    setResult(r) {
      result = r;
      hidden = new Set();
      cursor = null;
      if (r && r.kind === "complex") mode = "db";
      else mode = "value";
      draw();
      return mode;
    },
    setMode(m) { mode = m; draw(); },
    getMode: () => mode,
    isComplex: () => !!result && result.kind === "complex",
    hasWaveform: () => !!result && !!result.sweep,
    redraw: draw,
    toCSV() {
      if (!result) return "";
      const cols = [];
      if (result.sweep) cols.push({ name: result.sweep.name, values: result.sweep.values });
      result.traces.forEach((t) => {
        if (t.complex) {
          cols.push({ name: `${t.name}_mag`, values: t.mag });
          cols.push({ name: `${t.name}_deg`, values: t.phase });
        } else {
          cols.push({ name: t.name, values: t.values });
        }
      });
      const rows = [cols.map((c) => c.name).join(",")];
      const n = Math.max(...cols.map((c) => c.values.length));
      for (let i = 0; i < n; i++) rows.push(cols.map((c) => c.values[i] ?? "").join(","));
      return rows.join("\n");
    }
  };
}
