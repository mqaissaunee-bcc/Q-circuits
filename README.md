# Spice Lab

Browser-based schematic capture and circuit simulation for electronics teaching.
Draw a circuit, and it runs on real ngspice compiled to WebAssembly — no server,
no account, no install. Circuits are simulated in the tab and are never uploaded.

Built as a replacement for PSpice in lab sections where site licences, Windows-only
installers, and lab-machine lockdown get in the way.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # writes dist/
npm run preview    # serves dist/ at http://localhost:4173
node test/e2e.mjs  # 34 end-to-end checks against dist/
```

`dist/` is a static site. It deploys to GitHub Pages, Netlify, or any web root
with no configuration; `base` is set to `./` so it works from a subdirectory.

## Deploying to GitHub Pages

Push to `main`. `.github/workflows/deploy.yml` builds the site and publishes it
as a Pages artifact. In the repository settings, set Pages → Source to
**GitHub Actions** once; nothing else is needed.

**Do not commit `dist/`.** Git keeps every version forever, so each rebuild
would add another ~19 MB blob permanently and cross GitHub's 1 GB repository
recommendation in about fifty builds. The workflow builds on CI so `dist/`
never enters history, and it avoids the ten-builds-per-hour cap on the classic
Jekyll path.

Four things that usually break WASM projects on Pages, and why they don't here:

- **No cross-origin isolation.** Pages cannot set COOP/COEP headers. ngspice
  here is single-threaded and needs no `SharedArrayBuffer`.
- **No `.wasm` MIME type to get wrong.** The binary is base64-inlined in the JS
  module, so Pages never serves a `.wasm` file at all.
- **Under the file limits.** The engine chunk is ~19 MB: below GitHub's 50 MiB
  warning and its 100 MiB hard block. Pages gzips JavaScript in transit, so a
  cold load pulls about 5.4 MB, and the filename is content-hashed so it caches
  until the next build.
- **Jekyll is disabled.** `public/.nojekyll` is copied into every build.

The build job fails loudly if any of that regresses — a missing `.nojekyll`, an
engine chunk over 50 MiB, or absolute asset paths that would 404 on a project
site.

At 5.4 MB per cold load, the soft 100 GB monthly bandwidth limit works out to
roughly 18,000 first visits.

### Smoke checklist for a new deployment

Run this on the weakest device you actually support, not just your desk.

1. The page paints before the engine downloads — parts palette and sheet visible.
2. First **Run simulation** finishes; note how long it takes on campus wifi.
3. A second run is immediate (the engine chunk cached).
4. Waveforms draw and the hover cursor reads values.
5. Reload: the circuit comes back from autosave.
6. **Save** downloads a `.json`, **Open** restores it.
7. It loads inside a Canvas page as an iframe.
8. On a tablet: parts can be placed and the sheet can be read. There is no
   pinch-zoom or touch pan yet, so panning needs a mouse.

## What it does

**Schematic editor.** Thirteen parts: R, C, L, voltage and current sources,
diodes with four models, a switch, ground, NPN and PNP transistors, N- and
P-channel MOSFETs, and an ideal op-amp. Rotation in 90° steps, box select,
shift-click, drag to move, undo/redo, copy/paste, arrow-key nudging, pan and
zoom.

**Connectivity.** Pins and wire endpoints are merged with a union-find. Points
that share coordinates merge, and any point lying along a wire's span merges
with that wire — which is what makes a wire ending part-way along another wire
behave as a real tee rather than a crossing.

**Netlist.** Regenerated on every edit and always visible. Model cards are
emitted only for the parts that need them. Copy it or download a `.cir`.

**Simulation.** Operating point, DC sweep, transient, and AC sweep, run by
ngspice itself.

**Waveforms.** Multi-trace plot with a log frequency axis for AC sweeps,
magnitude in dB or phase, a hover cursor reading every trace at that point, a
clickable legend, and CSV export. Place probes to narrow the plot to the nodes
you care about.

**Labs.** Four guided labs — voltage divider, RC low-pass, half-wave rectifier,
transistor bias — each with a starter circuit, tasks, and checks that run a real
simulation and report against a tolerance.

## Layout

```
index.html          app shell
src/
  parts.js          part library: symbols, pin geometry, fields, netlist emitters
  netlist.js        union-find connectivity, netlist assembly, validation, units
  store.js          state, snapshot undo/redo, clipboard, autosave, file I/O
  engine.js         ngspice wrapper; normalises results, surfaces engine errors
  canvas.js         SVG rendering and every pointer gesture that edits the sheet
  scope.js          waveform plotting on a 2D canvas
  labs.js           lab definitions and the check runner
  main.js           wiring: panels redraw from one refresh()
  styles.css        theme tokens, dark mode, responsive workspace
test/e2e.mjs        end-to-end suite (Playwright)
```

## Design notes

**The engine is lazy-loaded.** `eecircuit-engine` is a single ~20 MB ES module
with the WASM binary inlined. It is pulled in with a dynamic `import()` on the
first run and split into its own chunk, so the app shell — 56 kB of JS and 12 kB
of CSS — paints immediately. First run costs roughly two seconds including the
download; every run after that is instant.

**Undo is snapshot based.** The schematic is small enough that deep-cloning it
on each committed edit is free, and it avoids the bug class that command-pattern
undo attracts. Drag gestures apply live and commit once, on release.

**Lab checks resolve nodes through part labels, not node numbers.** Node
numbering falls out of the drawing and shifts the moment a student rewires
anything. `ctx.v("R2", 0)` asks for the voltage on pin 0 of R2 and survives a
rewire; asking for node 2 does not.

**Everything redraws from `refresh()`.** The netlist, parts table, validation
messages, and inspector are all pure functions of the store, so they cannot
disagree with the sheet.

## Adding a part

Add an entry to `PARTS` in `src/parts.js` and its key to `PALETTE`:

```js
ZENER: {
  key: "ZENER", name: "Zener diode", prefix: "D",
  shape: ["M0 0H22", "M38 0H60", "M22 -9L38 0L22 9Z", "M30 -9V9 M38 -9H30 M38 9H46"],
  pins: [[0, 0], [60, 0]],
  pinNames: ["cathode", "anode"],
  box: [-4, -14, 64, 14],
  fields: [{ k: "model", label: "Model", def: "DZ5V1", options: ["DZ5V1"] }],
  emit: (c, n) => [`${c.label} ${n[0]} ${n[1]} ${c.model}`],
  models: (c) => [c.model]
}
```

Pins must sit on multiples of `GRID` so a 90° rotation keeps them on the grid.
Shapes are drawn in local coordinates with the anchor at (0,0); anything in
`FILLED` is filled rather than stroked. `models` names cards from `MODEL_CARDS`,
and only the ones actually used reach the netlist.

## Adding a lab

Append to `LABS` in `src/labs.js`. A lab is a starter circuit, a list of tasks,
and checks that receive a context with `v(label, pin)`, `i(label)`,
`trace(name)`, `part(label)`, and `value(str)` for parsing SPICE units.

## Known limits

- The ideal op-amp is a voltage-controlled source with no supply rails, so it
  will not clip. Real op-amp behaviour needs a `.subckt` model.
- Current probes work on voltage sources and inductors, which is what ngspice
  exposes as `i(...)` without extra `.save` directives. Current through a
  resistor needs a 0 V source in series.
- The switch is emitted as a resistor (1 mΩ closed, 1 GΩ open) named `R` +
  its label, so `SW1` appears in the netlist as `RSW1`.
- MOSFET models are Level 1 and are for teaching behaviour, not device accuracy.

## Licence and credits

Simulation by [ngspice](https://ngspice.sourceforge.io/) via
[eecircuit-engine](https://github.com/eelab-dev/EEcircuit-engine) (MIT).
Built for Engineering & Technology, Brookdale Community College.
