/**
 * Waveform viewer and measurements.
 *
 * Drawn on a 2D canvas rather than SVG because a transient run can return
 * thousands of points per trace and the DOM node count stops being free.
 * Colours are read from CSS custom properties so the plot follows the theme.
 *
 * Measurement note: ngspice chooses its own timestep, so transient samples are
 * unevenly spaced. Mean and RMS are therefore integrated over time with the
 * trapezoid rule rather than averaged over samples, which would silently
 * over-weight whatever region the solver happened to sample densely.
 */

import { formatEng } from "./netlist.js";

const PAD = { left: 62, right: 14, top: 14, bottom: 34 };
const TRACE_VARS = ["--trace-0", "--trace-1", "--trace-2", "--trace-3", "--trace-4", "--trace-5"];

/**
 * A dash pattern per trace, so traces stay distinguishable without relying on
 * colour. Solid first: the common single-trace case should look clean.
 */
export const TRACE_DASHES = [[], [8, 4], [2, 3], [11, 3, 2, 3], [5, 3, 1, 3], [1, 4]];

function niceTicks(min, max, target = 6) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

/** 2×, 3× … 9× each decade, for the faint minor grid on a log axis. */
function minorLogTicks(min, max) {
  const out = [];
  for (let d = Math.floor(Math.log10(min)); d <= Math.ceil(Math.log10(max)); d++) {
    const base = Math.pow(10, d);
    for (let m = 2; m <= 9; m++) {
      const v = base * m;
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

function decadeTicks(min, max) {
  const out = [];
  for (let d = Math.floor(Math.log10(min)); d <= Math.ceil(Math.log10(max)); d++) {
    const base = Math.pow(10, d);
    if (base >= min * 0.999 && base <= max * 1.001) out.push(base);
  }
  return out;
}

/* --------------------------------------------------------- measurements */

/**
 * Summarise one trace over the inclusive sample range [i0, i1].
 * `weighted` integrates against the sweep axis; pass false for a DC sweep,
 * where the x axis is a source voltage and a plain sample mean is what is meant.
 */
export function measure(xs, ys, i0, i1, weighted) {
  let min = Infinity, max = -Infinity, n = 0, sum = 0;
  for (let k = i0; k <= i1; k++) {
    const v = ys[k];
    if (!isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
  }
  if (!n) return null;

  const out = { min, max, pp: max - min, mean: sum / n, rms: NaN, freq: NaN };

  if (weighted && i1 > i0) {
    const span = xs[i1] - xs[i0];
    if (span > 0) {
      let area = 0, square = 0;
      for (let k = i0; k < i1; k++) {
        const dt = xs[k + 1] - xs[k];
        if (!(dt > 0)) continue;
        const a = ys[k], b = ys[k + 1];
        if (!isFinite(a) || !isFinite(b)) continue;
        area += 0.5 * (a + b) * dt;
        square += 0.5 * (a * a + b * b) * dt;
      }
      out.mean = area / span;
      out.rms = Math.sqrt(Math.max(0, square / span));
      out.freq = estimateFrequency(xs, ys, i0, i1, out.mean);
    }
  } else {
    let square = 0, m = 0;
    for (let k = i0; k <= i1; k++) {
      const v = ys[k];
      if (!isFinite(v)) continue;
      square += v * v; m++;
    }
    if (m) out.rms = Math.sqrt(square / m);
  }
  return out;
}

/**
 * Frequency from rising-edge crossings of the mean, interpolated between
 * samples. Returns NaN unless at least two clean crossings are found, so a DC
 * or monotonic signal reports nothing rather than a fabricated number.
 */
function estimateFrequency(xs, ys, i0, i1, level) {
  const crossings = [];
  for (let k = i0; k < i1; k++) {
    const a = ys[k], b = ys[k + 1];
    if (!isFinite(a) || !isFinite(b)) continue;
    if (a < level && b >= level) {
      const t = (level - a) / (b - a);
      crossings.push(xs[k] + t * (xs[k + 1] - xs[k]));
    }
  }
  if (crossings.length < 2) return NaN;
  const span = crossings[crossings.length - 1] - crossings[0];
  if (!(span > 0)) return NaN;
  return (crossings.length - 1) / span;
}

/* ------------------------------------------------------------------ view */

export function createScope({ host, measureHost, onStatus }) {
  const canvas = document.createElement("canvas");
  canvas.className = "scope-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Waveform plot. The measurements table below is the text equivalent.");
  host.appendChild(canvas);

  const readout = document.createElement("div");
  readout.className = "scope-readout";
  host.appendChild(readout);

  let result = null;
  let mode = "value";
  let hidden = new Set();
  let cursor = null;
  let layout = null;
  let region = null;      // {i0, i1} sample range measurements are limited to
  let dragging = null;    // {x0, x1} in canvas pixels, while the pointer is down
  let ranges = {};        // user axis ranges, numbers; missing means automatic

  const colors = () => {
    const cs = getComputedStyle(canvas);
    return {
      soft: cs.getPropertyValue("--ink-soft").trim(),
      rule: cs.getPropertyValue("--rule").trim(),
      grid: cs.getPropertyValue("--scope-grid").trim(),
      bg: cs.getPropertyValue("--scope-bg").trim(),
      band: cs.getPropertyValue("--accent-soft").trim(),
      accent: cs.getPropertyValue("--accent").trim(),
      traces: TRACE_VARS.map((v) => cs.getPropertyValue(v).trim())
    };
  };

  const visibleTraces = () => (result ? result.traces.filter((t) => !hidden.has(t.name)) : []);

  function seriesOf(t) {
    if (!t.complex) return t.values;
    return mode === "phase" ? t.phase : mode === "db" ? t.db : t.mag;
  }

  function unitOf(t) {
    if (t.complex) return mode === "phase" ? "\u00B0" : mode === "db" ? "dB" : t.type === "current" ? "A" : "V";
    return t.type === "current" ? "A" : "V";
  }

  const logX = () => !!result && result.sweep?.type === "frequency";
  const timeAxis = () => !!result && result.sweep?.type === "time";

  function resize() {
    const rect = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(300, rect.width);
    const h = Math.max(220, Math.min(420, rect.width * 0.42));
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
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
      renderMeasurements();
      return;
    }

    const xs = result.sweep.values;
    const traces = visibleTraces();
    const useLog = logX();

    let xmin = xs[0], xmax = xs[xs.length - 1];
    if (isFinite(ranges.xMin) && isFinite(ranges.xMax) && ranges.xMax > ranges.xMin &&
        (!useLog || ranges.xMin > 0)) {
      xmin = ranges.xMin; xmax = ranges.xMax;
    }
    if (useLog) { xmin = Math.max(xmin, 1e-12); xmax = Math.max(xmax, xmin * 10); }

    const sx = (v) => useLog
      ? plot.x + ((Math.log10(Math.max(v, xmin)) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * plot.w
      : plot.x + ((v - xmin) / (xmax - xmin || 1)) * plot.w;

    // Volts and amps never share an axis: a milliamp trace drawn against a
    // volts scale is a flat line. Each unit gets its own pane, stacked the way
    // PSpice's Add Plot to Window stacks them, sharing the x axis.
    const groups = [];
    const keyOf = (t) => `${t.type === "current" ? "current" : "voltage"}|${unitOf(t)}`;
    [...traces].sort((a, b) => (a.type === "current") - (b.type === "current")).forEach((t) => {
      const k = keyOf(t);
      let g = groups.find((q) => q.key === k);
      if (!g) { g = { key: k, unit: unitOf(t), traces: [] }; groups.push(g); }
      g.traces.push(t);
    });
    if (!groups.length) groups.push({ key: "none", unit: "", traces: [] });

    const GAP = 16;
    const paneH = (plot.h - GAP * (groups.length - 1)) / groups.length;
    const panes = groups.map((g, gi) => {
      let ymin = Infinity, ymax = -Infinity;
      g.traces.forEach((t) => {
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
      // A user range, like PSpice's User Defined data range, replaces the fit.
      const lo = gi === 0 ? ranges.yMin : ranges.y2Min;
      const hi = gi === 0 ? ranges.yMax : ranges.y2Max;
      if (isFinite(lo) && isFinite(hi) && hi > lo) { ymin = lo; ymax = hi; }
      const box = { x: plot.x, y: plot.y + gi * (paneH + GAP), w: plot.w, h: paneH };
      const sy = (v) => box.y + box.h - ((v - ymin) / (ymax - ymin)) * box.h;
      return { ...g, box, ymin, ymax, sy };
    });
    const paneOf = new Map();
    panes.forEach((pn) => pn.traces.forEach((t) => paneOf.set(t, pn)));

    layout = { plot, sx, sy: panes[0].sy, xs, useLog, panes, paneOf };

    ctx.fillStyle = c.bg;
    panes.forEach((pn) => ctx.fillRect(pn.box.x, pn.box.y, pn.box.w, pn.box.h));
    if (panes.length > 1) {
      // the gaps between panes belong to the page, not the plot
      ctx.clearRect(plot.x, plot.y, plot.w, plot.h);
      ctx.fillStyle = c.bg;
      panes.forEach((pn) => ctx.fillRect(pn.box.x, pn.box.y, pn.box.w, pn.box.h));
    }

    // measurement window, drawn under the grid
    const band = dragging
      ? { a: dragging.x0, b: dragging.x1 }
      : region ? { a: sx(xs[region.i0]), b: sx(xs[region.i1]) } : null;
    if (band) {
      panes.forEach((pn) => {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = c.band;
        ctx.fillRect(Math.min(band.a, band.b), pn.box.y, Math.abs(band.b - band.a), pn.box.h);
        ctx.restore();
        ctx.strokeStyle = c.accent;
        ctx.setLineDash([3, 3]);
        [band.a, band.b].forEach((x) => {
          ctx.beginPath(); ctx.moveTo(x, pn.box.y); ctx.lineTo(x, pn.box.y + pn.box.h); ctx.stroke();
        });
        ctx.setLineDash([]);
      });
    }

    const xTicks = useLog ? decadeTicks(xmin, xmax) : niceTicks(xmin, xmax, 6);
    const xMinor = useLog ? minorLogTicks(xmin, xmax) : [];

    panes.forEach((pn, pi) => {
      const { box, sy, ymin, ymax } = pn;
      ctx.lineWidth = 1;
      ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';

      // minor log gridlines first, fainter, so decades still read at a glance
      if (xMinor.length) {
        ctx.save();
        ctx.strokeStyle = c.grid;
        ctx.globalAlpha = 0.45;
        xMinor.forEach((v) => {
          const x = sx(v);
          if (x < box.x || x > box.x + box.w) return;
          ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke();
        });
        ctx.restore();
      }

      ctx.strokeStyle = c.grid;
      ctx.fillStyle = c.soft;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const yTicks = niceTicks(ymin, ymax, panes.length > 1 ? 4 : 5);
      yTicks.forEach((v) => {
        const y = sy(v);
        if (y < box.y - 1 || y > box.y + box.h + 1) return;
        ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke();
        ctx.fillText(formatEng(v, 3), box.x - 8, y);
      });

      xTicks.forEach((v) => {
        const x = sx(v);
        if (x < box.x - 1 || x > box.x + box.w + 1) return;
        ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke();
        if (pi === panes.length - 1) {
          ctx.textAlign = "center"; ctx.textBaseline = "top";
          ctx.fillText(formatEng(v, 3), x, box.y + box.h + 7);
        }
      });

      if (ymin < 0 && ymax > 0) {
        ctx.strokeStyle = c.rule;
        ctx.beginPath(); ctx.moveTo(box.x, sy(0)); ctx.lineTo(box.x + box.w, sy(0)); ctx.stroke();
      }
      ctx.strokeStyle = c.rule;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

      if (panes.length > 1 && pn.unit) {
        ctx.save();
        ctx.fillStyle = c.soft;
        ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(pn.unit === "A" ? "current (A)" : pn.unit === "V" ? "voltage (V)" : pn.unit, box.x + 6, box.y + 4);
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      pn.traces.forEach((t) => {
        const s = seriesOf(t);
        const idx = result.traces.indexOf(t);
        ctx.strokeStyle = c.traces[idx % c.traces.length];
        ctx.setLineDash(TRACE_DASHES[idx % TRACE_DASHES.length]);
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
      ctx.setLineDash([]);
      ctx.restore();
    });

    ctx.fillStyle = c.soft;
    ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(sweepLabel(), plot.x + plot.w / 2, h - 2);

    if (cursor && !dragging) drawCursor(ctx, c);
    renderReadout(cursor && !dragging ? cursorIndex() : null);
    renderMeasurements();
  }

  function sweepLabel() {
    if (!result?.sweep) return "";
    if (result.sweep.type === "time") return "time (s)";
    if (result.sweep.type === "frequency") return "frequency (Hz)";
    return result.sweep.name;
  }

  const sweepUnit = () => (timeAxis() ? "s" : logX() ? "Hz" : "");

  function indexAtPixel(px) {
    if (!layout) return 0;
    const { xs } = layout;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(layout.sx(xs[i]) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  const cursorIndex = () => (cursor ? indexAtPixel(cursor.x) : null);

  function drawCursor(ctx, c) {
    const i = cursorIndex();
    if (i === null) return;
    const x = layout.sx(layout.xs[i]);
    ctx.save();
    ctx.strokeStyle = c.soft;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    layout.panes.forEach((pn) => {
      ctx.beginPath(); ctx.moveTo(x, pn.box.y); ctx.lineTo(x, pn.box.y + pn.box.h); ctx.stroke();
    });
    ctx.setLineDash([]);
    visibleTraces().forEach((t) => {
      const v = seriesOf(t)[i];
      const pn = layout.paneOf.get(t);
      if (!isFinite(v) || !pn) return;
      ctx.fillStyle = c.traces[result.traces.indexOf(t) % c.traces.length];
      ctx.beginPath(); ctx.arc(x, pn.sy(v), 3.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
  }

  /* --------------------------------------------------------- the legend */

  function renderReadout(index) {
    readout.replaceChildren();
    if (!result) return;

    const list = document.createElement("ul");
    list.className = "legend";

    if (index !== null && index !== undefined && result.sweep) {
      const li = document.createElement("li");
      li.className = "legend-sweep";
      li.textContent = `${sweepLabel().replace(/\s*\(.*\)/, "")} = ${formatEng(result.sweep.values[index], 4)}`;
      list.appendChild(li);
    }

    result.traces.forEach((t, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "legend-item" + (hidden.has(t.name) ? " is-off" : "");
      btn.setAttribute("aria-pressed", hidden.has(t.name) ? "false" : "true");

      const sw = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sw.setAttribute("class", "swatch");
      sw.setAttribute("viewBox", "0 0 22 10");
      sw.setAttribute("aria-hidden", "true");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "1"); line.setAttribute("y1", "5");
      line.setAttribute("x2", "21"); line.setAttribute("y2", "5");
      line.setAttribute("stroke", `var(${TRACE_VARS[i % TRACE_VARS.length]})`);
      line.setAttribute("stroke-width", "2.5");
      const dash = TRACE_DASHES[i % TRACE_DASHES.length];
      if (dash.length) line.setAttribute("stroke-dasharray", dash.join(" "));
      sw.appendChild(line);
      btn.appendChild(sw);

      const name = document.createElement("span");
      name.className = "legend-name";
      name.textContent = t.name;
      btn.appendChild(name);

      if (index !== null && index !== undefined) {
        const val = document.createElement("span");
        val.className = "legend-value";
        const v = seriesOf(t)[index];
        val.textContent = isFinite(v) ? `${formatEng(v, 4)} ${unitOf(t)}` : "\u2014";
        btn.appendChild(val);
      }

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

  /* ---------------------------------------------------- the measurements */

  const COLUMN_LABELS = { min: "Min", max: "Max", pp: "Pk-Pk", mean: "Mean", rms: "RMS", freq: "Freq" };

  function columnsFor() {
    if (!result) return [];
    if (result.kind === "complex") return ["min", "max", "pp"];
    if (timeAxis()) return ["min", "max", "pp", "mean", "rms", "freq"];
    return ["min", "max", "pp", "mean"];
  }

  /** Sample range measured: the dragged region, else the visible x range. */
  function measuredRange() {
    const xs = result.sweep.values;
    if (region) return [region.i0, region.i1];
    if (isFinite(ranges.xMin) && isFinite(ranges.xMax) && ranges.xMax > ranges.xMin) {
      let a = xs.findIndex((x) => x >= ranges.xMin);
      let b = xs.length - 1;
      while (b > 0 && xs[b] > ranges.xMax) b--;
      if (a >= 0 && b > a) return [a, b];
    }
    return [0, xs.length - 1];
  }

  function renderMeasurements() {
    if (!measureHost) return;
    measureHost.replaceChildren();
    if (!result || !result.sweep) return;

    const xs = result.sweep.values;
    const [i0, i1] = measuredRange();
    const visible = !region && (i0 > 0 || i1 < xs.length - 1);
    const cols = columnsFor();

    const head = document.createElement("div");
    head.className = "measure-head";

    const title = document.createElement("span");
    title.className = "measure-scope";
    title.textContent = region
      ? `Measuring ${formatEng(xs[i0], 3)} to ${formatEng(xs[i1], 3)} ${sweepUnit()}`
      : visible
        ? `Measuring the visible range, ${formatEng(xs[i0], 3)} to ${formatEng(xs[i1], 3)} ${sweepUnit()}`
        : "Measuring the whole sweep \u2014 drag across the plot to narrow it";
    head.appendChild(title);

    if (region) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "ghost";
      clear.textContent = "Whole sweep";
      clear.addEventListener("click", () => {
        region = null;
        onStatus?.("Measuring the whole sweep.");
        draw();
      });
      head.appendChild(clear);
    }
    measureHost.appendChild(head);

    const table = document.createElement("table");
    table.className = "measure-table";
    const caption = document.createElement("caption");
    caption.textContent = timeAxis()
      ? "Mean and RMS are integrated over time, because ngspice does not sample at a fixed interval."
      : "Summary of each visible trace over the measured range.";
    table.appendChild(caption);

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Trace", ...cols.map((k) => COLUMN_LABELS[k])].forEach((label) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const shown = visibleTraces();
    if (!shown.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = cols.length + 1;
      td.textContent = "Every trace is hidden. Click a name in the legend to bring it back.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    shown.forEach((t) => {
      const stats = measure(xs, seriesOf(t), i0, i1, timeAxis());
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = t.name;
      tr.appendChild(th);

      // Floating-point residue on a symmetric waveform lands the mean around
      // 1e-11 rather than exactly zero. Reporting "60.86p V" for what is
      // plainly zero just puzzles students, so anything nine orders below the
      // trace's own amplitude reads as zero, the way a bench meter would.
      const scale = stats ? Math.max(Math.abs(stats.min), Math.abs(stats.max)) : 0;
      const show = (v, unit) => (Math.abs(v) < scale * 1e-9 ? `0 ${unit}` : `${formatEng(v, 4)} ${unit}`);

      cols.forEach((k) => {
        const td = document.createElement("td");
        if (!stats) { td.textContent = "\u2014"; tr.appendChild(td); return; }
        const v = stats[k];
        if (!isFinite(v)) td.textContent = "\u2014";
        else if (k === "freq") td.textContent = `${formatEng(v, 4)} Hz`;
        else td.textContent = show(v, unitOf(t));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    measureHost.appendChild(table);
  }

  /* ------------------------------------------------------------ pointer */

  const inPlot = (x) => layout && x >= layout.plot.x && x <= layout.plot.x + layout.plot.w;
  const localX = (evt) => evt.clientX - canvas.getBoundingClientRect().left;

  canvas.addEventListener("pointerdown", (evt) => {
    if (!layout || evt.button !== 0) return;
    const x = localX(evt);
    if (!inPlot(x)) return;
    dragging = { x0: x, x1: x };
    canvas.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  });

  canvas.addEventListener("pointermove", (evt) => {
    if (!layout) return;
    const x = localX(evt);
    if (dragging) { dragging.x1 = x; draw(); return; }
    cursor = inPlot(x) ? { x } : null;
    draw();
  });

  canvas.addEventListener("pointerup", (evt) => {
    try { canvas.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
    if (!dragging) return;
    const { x0, x1 } = dragging;
    dragging = null;
    if (Math.abs(x1 - x0) < 5) {
      // a click rather than a drag: go back to measuring everything
      if (region) { region = null; onStatus?.("Measuring the whole sweep."); }
    } else {
      const a = indexAtPixel(Math.min(x0, x1));
      const b = indexAtPixel(Math.max(x0, x1));
      if (b > a) {
        region = { i0: a, i1: b };
        const xs = result.sweep.values;
        onStatus?.(`Measuring ${formatEng(xs[a], 3)} to ${formatEng(xs[b], 3)} ${sweepUnit()}, ${b - a + 1} samples.`);
      }
    }
    draw();
  });

  canvas.addEventListener("pointerleave", () => {
    if (dragging) return;
    cursor = null;
    draw();
  });

  new ResizeObserver(() => draw()).observe(host);

  /* ------------------------------------------------------------- public */

  return {
    setResult(r) {
      result = r;
      hidden = new Set();
      cursor = null;
      region = null;
      dragging = null;
      mode = r && r.kind === "complex" ? "db" : "value";
      draw();
      return mode;
    },
    setMode(m) { mode = m; draw(); },
    /** Axis ranges as numbers; NaN or missing means automatic. */
    setRanges(r) { ranges = { ...r }; draw(); },
    paneCount: () => (layout?.panes?.length || 0),
    getMode: () => mode,
    isComplex: () => !!result && result.kind === "complex",
    hasWaveform: () => !!result && !!result.sweep,
    getRegion: () => (region ? { ...region } : null),
    redraw: draw,

    /** Measurements for every visible trace, matching the rendered table. */
    measurements() {
      if (!result || !result.sweep) return [];
      const xs = result.sweep.values;
      const [i0, i1] = measuredRange();
      return visibleTraces().map((t) => ({
        name: t.name,
        unit: unitOf(t),
        ...measure(xs, seriesOf(t), i0, i1, timeAxis())
      }));
    },

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
