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

**Schematic editor.** Fourteen parts: R, C, L, voltage and current sources,
diodes with four models, a switch, an ammeter, ground, NPN and PNP transistors,
N- and P-channel MOSFETs, and an op-amp with supply rails. Rotation in 90° steps, box select,
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

**Measuring current.** ngspice only reports `i(...)` for voltage sources and
inductors, so measuring current in an arbitrary branch normally means hand-
inserting a zero-volt source as an ammeter. The **Ammeter** part does that for
you: it draws as a meter, emits `V<label> n+ n- DC 0`, and is electrically a
perfect wire. Drop it in a branch, switch to the Probe tool, and click it.

The sign is worth pointing out to students, because it is the opposite of what
they see on a source. An ammeter reads **positive when conventional current
flows from its + pin to its − pin**, marked by the arrow on the symbol. A
voltage source reads negative while delivering current, because ngspice defines
source current as flowing from + to − *inside* the element. Same convention,
opposite outcome — a decent five-minute discussion in its own right.

**Waveforms.** Multi-trace plot with a log frequency axis for AC sweeps,
magnitude in dB or phase, a hover cursor reading every trace at that point, a
clickable legend, and CSV export. Place probes to narrow the plot to the nodes
you care about.

**Measurements.** Under every plot, a table gives min, max, peak-to-peak, mean,
RMS, and frequency for each visible trace — the numbers lab worksheets actually
ask for. Drag across the plot to measure a slice of it instead of the whole
sweep, which is how you get steady-state figures without the startup transient
dragging them off. Click once, or press the Whole sweep button, to go back.

Columns follow the analysis: a DC sweep drops frequency and RMS, and an AC
sweep reports only min, max and peak-to-peak of whatever quantity is displayed.

ngspice picks its own timestep, so transient samples are **not** evenly spaced —
in a 60 Hz test run the interval varied by 100× within a single sweep. Mean and
RMS are therefore integrated over time with the trapezoid rule. Averaging over
samples instead would over-weight whatever region the solver sampled densely:
on that same run it put RMS out by 1.1e-2, where the time-weighted figure is
within 3.6e-8 of Vp/√2.

Statistics more than nine orders of magnitude below a trace's own amplitude are
reported as zero, so the mean of a symmetric waveform reads `0 V` rather than
`60.86p V`.

**Labs.** Five guided labs — voltage divider, RC low-pass, half-wave rectifier,
transistor bias, inverting amplifier — each with a starter circuit, tasks, and
checks that run a real simulation and report against a tolerance.

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

### The op-amp

The op-amp is emitted as a behavioural source whose output is clamped between
its rails:

```
BU1 3 0 V = max(-15, min(15, 200k*(0 - V(2))))
```

Set the open-loop gain and both rails on the part; use 0 for the negative rail
in a single-supply circuit. Because the rails are real, an overdriven amplifier
flattens against them instead of producing a physically impossible swing, and
the finite open-loop gain shows up where it should — an inverting stage built
from 1 kΩ and 10 kΩ measures 9.9995 rather than exactly 10, matching
10 / (1 + 11/200k).

Two notes for anyone extending this. ngspice's own `limit(x, lo, hi)` looks like
the obvious way to write the clamp, but it is **broken in this build**: it
silently returns the gain constant instead of a clamped value, with no error
raised. `max(lo, min(hi, x))` works and clips exactly. A `tanh` soft clip also
works and converges identically — including in a relaxation oscillator, where
the positive feedback loop landed within 0.13% of 1/(2RC·ln3) — but it
overshoots the rail slightly, so the hard clamp is what ships.

`V(0)` is not a legal node reference, so a grounded input is written as a
literal `0` in the expression.

## Known limits

- The op-amp has rails but no supply pins: they are fields on the part rather
  than nodes you wire. It also has no slew-rate limit, no input offset, no
  frequency compensation, and no output resistance. Those need a `.subckt` for
  a specific device.
- Current probes work on ammeters, voltage sources, and inductors, which is
  what ngspice exposes as `i(...)` without extra `.save` directives. To measure
  current anywhere else, drop an ammeter into the branch.
- The switch is emitted as a resistor (1 mΩ closed, 1 GΩ open) named `R` +
  its label, so `SW1` appears in the netlist as `RSW1`.
- MOSFET models are Level 1 and are for teaching behaviour, not device accuracy.

## Licence and credits

Simulation by [ngspice](https://ngspice.sourceforge.io/) via
[eecircuit-engine](https://github.com/eelab-dev/EEcircuit-engine) (MIT).
Built for Engineering & Technology, Brookdale Community College.
