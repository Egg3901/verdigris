# Verdigris

A living 1890s city district you watch from above.

Named for the green patina on its brass. White stone, gold leaf, civic bunting,
arc lamps, pneumatic post, one tram line, one dirigible mooring mast. Toned-down
steampunk, in the register of inkle's 80 Days and BioShock Infinite's Columbia.

**The theme is civic pride papering over rot.** The district presents beautifully
and is quietly failing underneath. That is not flavour text: `rot` is a simulation
variable that decides whether a repair that was ordered actually happened, and the
courts behind the gold-leaf frontages are a spatial fact the generator produces.

**You are an observer with light nudges.** You never place a building. You watch,
advance time, click a building or a soul to read what is happening inside, follow
someone, and spend three interventions a day.

## Running it

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # tsc && vite build
./deploy.sh        # build, then rsync dist/ to /var/www/verdigris/
```

`?seed=coppergate` generates a different district. `?ui=3` scales the panels up.

## Shape of the code

- `src/sim/` is pure and deterministic. Zero DOM, zero `Math.random`, zero
  `Date.now`. Integers only in state. The world is a pure function of
  `(seedStr, tickCount, nudges)`, which is why the save format is the nudge log
  and why `hashWorld()` can anchor every determinism test.
- `src/render/` never writes to the sim. Buildings are flattened once into their
  own sprites and sorted per object; the ID buffer is stamped in the same
  painter's order so picking is pixel-exact through roofs and overhangs.
- `src/ui/` is HTML and CSS over the canvas, not drawn in it.

Three contracts that nothing may violate:

1. **Integer transform.** Zoom is 1, 2 or 3 and never fractional. Every atlas
   pixel lands on an exact N by N block of device pixels.
2. **Palette.** Every non-transparent pixel is a member of `PAL`, alpha is 0 or
   255. This is what makes the ID buffer exact.
3. **No gradients on the world canvas.** Baked dithered sprites only. Smooth
   gradients live in the UI DOM layer.

## Where it is

Live at **https://lakesidegames.net/games/verdigris/**

Built and playing:

- The deterministic core. The world is a pure function of
  `(seedStr, tickCount, nudges)`, so the save format is the nudge log and
  `hashWorld()` anchors every determinism test.
- Eight-stage worldgen: river with polite and working banks, two crossings,
  civic square, arterials as least-cost paths, block subdivision, plot slicing,
  courts, quota-scored assignment, gas and drain and post networks, tram, and a
  prehistory of grudges that predate tick 0.
- All-pairs next-hop street graph, about 300 nodes. No runtime pathfinding.
- Schedules with jitter plus an ambient errand layer, so the district has people
  in it whenever you look and not only at the two rushes.
- Eight pressures with a cause ring, and baselines that are functions of world
  state rather than constants.
- Claims that spread over a relationship graph, distort on transmission, and keep
  a lineage you can walk back.
- Six incidents with hysteresis and cooldowns, each carrying the cause chain that
  produced it.
- The eight interventions, each with a second-order effect and a backfire that is
  a documented state condition rather than a dice roll.
- Predicate-gated prose that cannot assert anything the sim does not contain.
- Isometric renderer: pitched roofs (gable, hip, pyramid, flat), chimneys, window
  rhythm, trees, ground texture, flatten-per-building compositor, per-object depth
  sort, pixel-exact ID-buffer picking, discrete zoom stepper.
- The full UI shell, and a keyboard equivalent for every verb.

Measured behaviour: undisturbed, the district settles at an average facade of 610
against an average fabric of 520. Fourteen days of funding the bunting takes
facade to 669 and fabric to 462. The city looks better and is structurally worse.

Not built:

- `art/bake.py` and a baked pixel atlas. The city renders from vector primitives
  drawn in code. The compositor, depth sort, ID buffer and camera contract were
  all built against those primitives, so an atlas drops in behind an unchanged
  `blit()`. `atlas.ts`'s contract is that a missing frame falls back to a
  primitive, so art can never blank the game.
- Day and night grading, weather, and smoke. The lamp glow pass runs; the tint
  does not.
- The 9-slice panel frames and the two pixel fonts. Panels use flat CSS borders
  and a system monospace stack.
- The tram does not physically run yet. Delaying it is a real pressure with real
  consequences, but there is no vehicle on the rails.

Time is **forward only**. The sim is deterministic so a true rewind is a replay,
and a replay of a day costs about 300ms; affordable, but it needs a snapshot ring
to stay affordable over a month. The control says "advance to" and means it.
