# Q Circuits

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

The repository is `Q-Circuits`; `base` is `./`, so the app runs from whatever
path it is served at and the `homepage` field is documentation only.

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

**Moving parts keeps the wiring.** Drag a part and any wire end sitting on one
of its pins travels with it. On release each stretched wire is bent into an
elbow along its original axis, so the schematic never ends up full of diagonals.
A wire that is itself selected moves whole instead of stretching.

**Move versus drag.** A plain drag keeps the wiring: attached ends follow and
stretch. **Command-drag, or Control-drag, moves the part and leaves every wire
exactly where it is** — the way KiCad's Move differs from its Drag. Because
connectivity is decided by geometry, a part slid *along* a wire stays connected
to it, which makes this the right gesture for adjusting spacing on a bus. A pin
that leaves its wire genuinely comes off, and the sheet marks it.

Shift is not this modifier. Shift means "add to the selection", and nothing
else; see the note below.

**Broken connections are shown on the drawing.** An unconnected pin is drawn as
a filled red circle and a wire end touching nothing gets a dashed red ring, so a
detached move that pulled something loose is obvious where it happened rather
than only in the messages under the parts table.

**Wire editing.** Select a wire and drag either end to reroute it. Ends resting
on a pin are left alone, so grabbing near a part moves the part rather than
pulling the wire off it. Dragging an end onto its other end removes the wire.

**Alt-drag duplicates.** Hold Alt and drag a selection to peel off a copy,
designators and all.

**Keyboard placement.** With a part, wire or text tool active, the arrow keys
move a placement cursor across the grid and Enter drops the part there. Hold
Shift for five-square steps. Nothing on the sheet needs a mouse.

**Shortcuts panel.** The Shortcuts button, or `?`, opens the full list.

**Lab progress.** A lab that passes every check is ticked in the list and dated
in the panel, with a running tally in the heading. Progress lives in the
browser, so it is per machine rather than per student account.

**Navigation.** A hand tool for dragging the view and a zoom-area tool for
framing a rectangle, alongside the existing Alt-drag pan, scroll zoom, and Fit.
Dragging with the zoom tool frames that region; clicking with it steps in.

**Annotations.** A text tool for putting notes on the sheet — what a stage does,
what to measure, a formula worth remembering. Annotations are selected, moved,
copied, and deleted like anything else, and they travel through saves, links,
and PNG exports. They never reach the netlist, so they cannot create a node or
a dangling-connection warning.

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

**Measurements.** Traces are drawn with their own dash pattern as well as their
own colour, so they stay distinguishable without relying on colour vision, and
the legend swatches show the same pattern. Under every plot, a table gives min,
max, peak-to-peak, mean, RMS, and frequency for each visible trace — the numbers lab worksheets actually
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

**Your circuits.** Named circuits saved in the browser, listed in the My
circuits panel. Anything that would replace the sheet — opening a lab, starting
a new sheet, opening a file or a link — checks first whether there are unsaved
changes and asks before discarding them.

**Shareable links.** Copy link puts the whole circuit in a URL. Post one in
Canvas and it opens the exact starting circuit; a student pastes one back as
their submission. No files, no uploads, no version confusion. The payload is
deflated where the browser supports CompressionStream and stored plain where it
does not, so a link made in one browser opens in any of them.

**Editing on the sheet.** Double-click a value or a designator to change it in
place, without the trip to the inspector. Enter commits, Escape abandons.
Parts whose only settings are dropdowns open the inspector instead.

**PNG export.** The schematic and the waveform plot each export as an image for
lab reports. The schematic is exported at the content's own bounds rather than
the current zoom, at roughly 2600 pixels wide whatever the zoom level, with the
dot grid left out.

**Errors in plain language.** ngspice talks to circuit engineers: "Error on
line 2 or its substitute" and "singular matrix" mean nothing to someone three
weeks into a course. Failures are translated into what went wrong and what to
do about it, with the offending netlist line quoted back and the original
message one click away.

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

### Notes on the error translations

Two of these are worth knowing about if you extend `src/errors.js`.

ngspice reports a **bad value on a passive part as a missing model**, because an
unrecognised third token on the line is read as a model name. Typing
`4.7 kilohms` into a resistor produces `can't find model '4.7'`. The translation
for that case names both causes, or a student with a typo in a resistance gets
sent hunting for a model they never touched.

An **unrecognised** message still produces a title and a suggested next step
rather than falling through to raw SPICE. The raw text is always kept and shown
behind a disclosure, because it matters to anyone who does read it.

### Two things the browser does that shaped this

`render()` rebuilds the whole sheet on every `pointerdown`, which detaches the
node the press landed on. Chrome then has no common ancestor for the press and
the release, so **`click` and `dblclick` never fire on the sheet at all** — the
double-click-to-end-a-wire binding had been dead since it was written.
Double-clicks are timed by hand in the `pointerdown` handler instead.

Opening the inline editor also has to call `preventDefault()` on that
`pointerdown`. Otherwise the compatibility `mousedown` runs its default focus
action, focus lands on the sheet, the editor blurs, and it commits and closes
before a key is pressed.

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

**Fit and export measure the rendered sheet, not the model.** Annotation text
has no geometric bounds — its extent depends on the font — so both frame the
sheet from `getBBox` on the rendered groups. Computing bounds from the model
instead crops long notes and any label sitting outside its symbol.

**PNG export copies computed styles rather than restating the stylesheet.** The
schematic is SVG styled by an external sheet, so a serialised clone comes out
unstyled. The exporter walks the clone alongside the original and copies each
painting property from `getComputedStyle`, which cannot drift the way a second
copy of the CSS would. Content bounds come from `getBBox` on the rendered
groups, because the geometric bounds cover only the symbols and would crop the
labels sitting outside them.

**Unsaved work is tracked by comparison, not by flag.** `markClean()` stores a
serialised copy of the state at each save or load, and `isDirty()` compares
against it. Circuits are small enough that this costs nothing, and it cannot
drift out of sync the way a boolean set from a dozen call sites does.

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

### One modifier, one meaning

Detaching was briefly bound to Shift, which was a mistake worth recording.
Shift already meant "add to the selection", so shift-dragging a part that was
not yet selected first added it to the selection and then dragged *everything
selected*, wires left behind — two parts moving when the user grabbed one, and
a floating wire run left in the middle of the sheet. It also clashed with Shift
as the larger-step modifier for the arrow keys.

Modifiers now do exactly one thing each: **Shift** extends the selection and
takes bigger steps, **Alt** drags off a copy, **Command or Control** moves
without the wires.

### Alt is duplicate, not pan

Alt-drag used to pan. Now that there is a dedicated hand tool and middle-drag
still pans, Alt-drag is free for the more useful gesture of dragging off a copy.

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
