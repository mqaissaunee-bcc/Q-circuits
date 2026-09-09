/**
 * Circuits as links.
 *
 * A circuit is small enough to travel in a URL, which removes file handling
 * from the assignment entirely: an instructor posts a link that opens the exact
 * starting circuit, and a student pastes a link back as their submission.
 *
 * The payload is deflated where the browser supports CompressionStream and
 * stored raw where it does not, so a link made in one browser opens in any of
 * them. The prefix says which: `c` compressed, `j` plain JSON.
 */

const PREFIX_COMPRESSED = "c";
const PREFIX_PLAIN = "j";

/* ------------------------------------------------------- base64url helpers */

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot read compressed circuit links.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------- the payload */

/** Only what is needed to rebuild the sheet — ids are reassigned on load. */
function toPayload(state) {
  return {
    t: state.title,
    c: state.comps.map(({ id, ...rest }) => rest),
    w: state.wires.map(({ id, ...rest }) => rest),
    q: state.seq,
    p: state.probes,
    n: state.notes,
    a: state.analysis
  };
}

function fromPayload(p) {
  return {
    title: p.t || "Shared circuit",
    comps: p.c || [],
    wires: p.w || [],
    seq: p.q || {},
    probes: p.p || [],
    notes: p.n || [],
    analysis: p.a || {}
  };
}

/* -------------------------------------------------------------- public API */

/** Encode state into a hash fragment, including the leading '#'. */
export async function encodeCircuit(state) {
  const json = JSON.stringify(toPayload(state));
  const bytes = new TextEncoder().encode(json);
  const packed = await deflate(bytes);
  return packed && packed.length < bytes.length
    ? `#${PREFIX_COMPRESSED}=${bytesToBase64Url(packed)}`
    : `#${PREFIX_PLAIN}=${bytesToBase64Url(bytes)}`;
}

/** Full shareable URL for the current circuit. */
export async function shareUrl(state, href = window.location.href) {
  const base = href.split("#")[0];
  return base + (await encodeCircuit(state));
}

/**
 * Decode a hash fragment back into a circuit, or null when there is nothing to
 * decode. Throws with a readable message when the link is damaged, which
 * happens often enough — links get truncated by chat clients and LMS editors.
 */
export async function decodeCircuit(hash = window.location.hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;

  const eq = raw.indexOf("=");
  if (eq < 1) return null;
  const kind = raw.slice(0, eq);
  const body = raw.slice(eq + 1);
  if (kind !== PREFIX_COMPRESSED && kind !== PREFIX_PLAIN) return null;

  try {
    const bytes = base64UrlToBytes(body);
    const json = new TextDecoder().decode(kind === PREFIX_COMPRESSED ? await inflate(bytes) : bytes);
    const payload = JSON.parse(json);
    if (!Array.isArray(payload.c)) throw new Error("no parts in the payload");
    return fromPayload(payload);
  } catch (e) {
    throw new Error(
      "That circuit link could not be read. It may have been cut short when it was copied — links are long, so check the whole thing came across."
    );
  }
}

/** Drop the payload from the address bar without reloading. */
export function clearHash() {
  if (window.location.hash) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
