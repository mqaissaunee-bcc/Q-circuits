/**
 * PNG export, for dropping a circuit or a plot into a lab report.
 *
 * The schematic is live SVG styled by an external stylesheet, so serialising
 * the node on its own produces an unstyled black-on-transparent mess. Rather
 * than duplicating the stylesheet here — which would drift the first time a
 * colour changes — the exporter walks the clone alongside the original and
 * copies the computed value of each painting property onto the clone. The
 * output then matches what is on screen by construction.
 */

const PAINT_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor"
];

/** Copy computed paint styles from a live tree onto its clone, in step. */
function inlineStyles(live, clone) {
  const computed = getComputedStyle(live);
  let css = "";
  for (const prop of PAINT_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value) css += `${prop}:${value};`;
  }
  clone.setAttribute("style", css);

  const liveKids = live.children, cloneKids = clone.children;
  for (let i = 0; i < liveKids.length && i < cloneKids.length; i++) {
    inlineStyles(liveKids[i], cloneKids[i]);
  }
}

function themeBackground(el) {
  return getComputedStyle(el).getPropertyValue("--panel").trim() || "#ffffff";
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Render an SVG element to a PNG blob at `scale` device pixels per CSS pixel.
 * Everything is inlined, so the canvas is never tainted and toBlob succeeds.
 */
export async function svgToPngBlob(svg, { scale = null, background = null, padding = 16, viewBox = null, omit = [] } = {}) {
  // Default to whatever is on screen, but callers pass the content bounds so an
  // export holds the whole circuit rather than the current zoom window.
  const box = viewBox || svg.viewBox.baseVal;
  const width = box && box.w ? box.w : (box && box.width ? box.width : svg.clientWidth);
  const height = box && box.h ? box.h : (box && box.height ? box.height : svg.clientHeight);

  // Aim for a consistently crisp image no matter how the sheet is zoomed.
  const TARGET_WIDTH = 2600;
  const pixelScale = scale || Math.max(2, Math.min(8, TARGET_WIDTH / width));

  const clone = svg.cloneNode(true);
  inlineStyles(svg, clone);
  // The dot grid is drawing aid, not something a lab report wants.
  omit.forEach((sel) => clone.querySelectorAll(sel).forEach((n) => n.remove()));
  if (viewBox) clone.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const markup = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("The schematic could not be rendered to an image."));
      i.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round((width + padding * 2) * pixelScale);
    canvas.height = Math.round((height + padding * 2) * pixelScale);
    const ctx = canvas.getContext("2d");
    ctx.scale(pixelScale, pixelScale);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width + padding * 2, height + padding * 2);
    }
    ctx.drawImage(img, padding, padding, width, height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Composite a transparent canvas onto the theme background and encode it. */
export async function canvasToPngBlob(source, { background = null, padding = 12 } = {}) {
  const out = document.createElement("canvas");
  out.width = source.width + padding * 2;
  out.height = source.height + padding * 2;
  const ctx = out.getContext("2d");
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(source, padding, padding);
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))), "image/png");
  });
}

export async function exportSvg(svg, filename, viewBox = null) {
  const blob = await svgToPngBlob(svg, { background: themeBackground(svg), viewBox, omit: [".grid-layer"] });
  triggerDownload(blob, filename);
  return blob;
}

export async function exportCanvas(canvas, filename) {
  const blob = await canvasToPngBlob(canvas, { background: themeBackground(canvas) });
  triggerDownload(blob, filename);
  return blob;
}
