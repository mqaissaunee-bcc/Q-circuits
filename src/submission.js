/**
 * The submission sheet.
 *
 * A lab is marked in the browser, which is fine for the student and no use
 * to whoever collects the work. This turns one attempt into a single PNG an
 * instructor can read at a glance and a student can upload anywhere: who did
 * it, which exercise, the schematic, the plot, every reading they entered,
 * and the result of every check.
 *
 * PNG rather than PDF because it needs no library, uploads everywhere, and
 * previews inline in the places work gets handed in.
 */

import { svgToPngBlob } from "./export-png.js";

const WIDTH = 1600;
const MARGIN = 48;

const loadImage = (blob) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("An image could not be read back.")); };
  img.src = url;
});

/**
 * A short code over the details of the attempt. It is a checksum, not a
 * signature: it catches a submission edited after the fact, and would not
 * stop anyone determined to forge one.
 */
async function checkCode(parts) {
  const text = parts.join("\u241F");
  if (!crypto?.subtle) {
    let h = 2166136261;
    for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h.toString(16).toUpperCase().padStart(8, "0");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Palette pulled from the page, so the sheet matches the theme in use. */
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: pick("--panel", "#ffffff"),
    ink: pick("--ink", "#171a1e"),
    soft: pick("--ink-soft", "#5b6472"),
    rule: pick("--rule", "#d9dee5"),
    ok: pick("--ok", "#1f7a45"),
    bad: pick("--danger", "#b3261e")
  };
}

/**
 * Build the submission sheet.
 *
 * `outcome` is what runChecks returned. Returns a PNG blob.
 */
export async function buildSubmissionSheet({ svg, sheetBox, plotCanvas, lab, state, outcome }) {
  const c = palette();
  const tb = state.titleBlock || {};
  const date = tb.date || new Date().toISOString().slice(0, 10);
  const passed = outcome.results.filter((r) => r.pass).length;
  const total = outcome.results.length;

  const schematic = await loadImage(await svgToPngBlob(svg, { background: c.bg, viewBox: sheetBox, omit: [".grid-layer"] }));
  let plot = null;
  if (plotCanvas && plotCanvas.width) {
    plot = await new Promise((resolve) => plotCanvas.toBlob(resolve, "image/png")).then((b) => (b ? loadImage(b) : null)).catch(() => null);
  }

  const code = await checkCode([lab?.id || "free", state.title || "", tb.name || "", tb.course || "", date, `${passed}/${total}`]);

  // Lay the page out first, so the canvas is made once at the right height.
  const inner = WIDTH - MARGIN * 2;
  const schematicH = Math.min(620, Math.round((schematic.height / schematic.width) * inner));
  const plotH = plot ? Math.min(460, Math.round((plot.height / plot.width) * inner)) : 0;
  const lineH = 30;
  const answers = (lab?.questions || []).map((q) => [q.prompt, String(state.answers?.[q.id] ?? "").trim() || "—"]);
  const bodyH = (answers.length ? 46 + answers.length * lineH : 0) +
    46 + outcome.results.reduce((h, r) => h + lineH + (r.detail ? 22 : 0), 0);
  const height = MARGIN + 150 + schematicH + 40 + (plot ? plotH + 40 : 0) + bodyH + MARGIN;

  const canvas = document.createElement("canvas");
  const dpr = 2;
  canvas.width = WIDTH * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  const sans = '"IBM Plex Sans", system-ui, sans-serif';
  const mono = '"IBM Plex Mono", ui-monospace, monospace';
  const text = (s, x, y, { font = `15px ${sans}`, color = c.ink, align = "left" } = {}) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  };
  const rule = (y) => {
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y + 0.5);
    ctx.lineTo(WIDTH - MARGIN, y + 0.5);
    ctx.stroke();
  };

  /* ------------------------------------------------------------- header */

  let y = MARGIN + 26;
  text(tb.org || "Lab submission", MARGIN, y, { font: `700 22px ${sans}` });
  text(lab ? lab.title : state.title || "Untitled circuit", WIDTH - MARGIN, y, { font: `18px ${mono}`, color: c.soft, align: "right" });
  y += 30;

  const cols = [
    ["Name", tb.name || "—"],
    ["Course", tb.course || "—"],
    ["Document", state.title || "Untitled circuit"],
    ["Date", date]
  ];
  cols.forEach(([label, value], i) => {
    const x = MARGIN + i * (inner / 4);
    text(label.toUpperCase(), x, y, { font: `10px ${sans}`, color: c.soft });
    text(value, x, y + 22, { font: `16px ${mono}` });
  });
  y += 44;

  const verdict = outcome.ok ? `Passed all ${total} checks` : `${passed} of ${total} checks passed`;
  text(verdict, MARGIN, y + 20, { font: `700 18px ${sans}`, color: outcome.ok ? c.ok : c.bad });
  text(`Check code ${code}`, WIDTH - MARGIN, y + 20, { font: `14px ${mono}`, color: c.soft, align: "right" });
  y += 34;
  rule(y);
  y += 24;

  /* -------------------------------------------------------------- plots */

  const drawFitted = (img, maxH) => {
    const w = Math.min(inner, (img.width / img.height) * maxH);
    const h = (img.height / img.width) * w;
    ctx.drawImage(img, MARGIN + (inner - w) / 2, y, w, h);
    y += h + 40;
  };
  drawFitted(schematic, schematicH);
  if (plot) drawFitted(plot, plotH);

  /* ------------------------------------------------- answers and checks */

  if (answers.length) {
    text("Readings entered", MARGIN, y, { font: `700 15px ${sans}` });
    y += 26;
    answers.forEach(([prompt, value]) => {
      text(prompt, MARGIN + 16, y, { color: c.soft });
      text(value, MARGIN + inner - 8, y, { font: `16px ${mono}`, align: "right" });
      y += lineH;
    });
    y += 16;
  }

  text("Checks", MARGIN, y, { font: `700 15px ${sans}` });
  y += 26;
  outcome.results.forEach((r) => {
    text(r.pass ? "✓" : "✗", MARGIN + 16, y, { font: `16px ${sans}`, color: r.pass ? c.ok : c.bad });
    text(r.label, MARGIN + 44, y);
    y += lineH;
    if (r.detail) {
      text(r.detail, MARGIN + 44, y - 8, { font: `13px ${mono}`, color: c.soft });
      y += 22;
    }
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The submission sheet could not be encoded."))), "image/png");
  });
}
