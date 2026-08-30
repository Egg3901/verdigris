# Architecture

Verdigris is a deterministic city simulation with a pixel renderer over it. This
document covers the layer split, the contracts that hold it together, and the
structural decisions that are load bearing. For what the systems actually model,
see [SIMULATION.md](SIMULATION.md). For how to play, see [PLAYING.md](PLAYING.md).

## Three layers, one direction

```
src/sim/     pure, deterministic, no DOM        the world
src/render/  reads sim, writes pixels           the picture
src/ui/      HTML and CSS over the canvas       the controls
```

Dependencies point one way only. `src/sim/` imports nothing from `render` or
`ui`. `src/render/` never writes to sim state. `src/ui/` is DOM, not canvas
drawing: panels, buttons and text live in the document so that they are
selectable, accessible and stylable without reimplementing text layout.

`src/sim/city.ts` is the only module the application touches. Everything else in
`sim/` is reached through it.

## The determinism contract

The world is a pure function of `(seedStr, tickCount, nudges)`.

That single sentence is the most important constraint in the codebase, and most
of the odd looking decisions below exist to preserve it.

**What it buys.** The save format is the nudge log, not a state dump: a handful
of integers replays a month of city history exactly. Every test can assert on
`hashWorld()` rather than on a hand written expectation. Bug reports are a seed
and a tick count.

**What it forbids, inside `src/sim/`:**

- No `Math.random`. All randomness goes through `src/sim/rng.ts`.
- No `Date.now`, no `performance.now`, no clock reads of any kind.
- No DOM access.
- No floats in stored state. Integers only. The float `simMin` lives in
  `main.ts` and never enters the sim; `city.tick` is the canonical integer clock,
  and one tick is one game minute.

**No stored PRNG cursor.** This is the part that is easy to get wrong. A
generator whose position advances and is saved would make replay depend on
hidden state. Instead every random decision derives its own generator from
`(seed, stream, tick, entity)`, so any decision can be recomputed at any time
from values that are already in the world. `mix()` in `rng.ts` is the integer
mixer that does this, and argument order matters: every argument shifts the whole
downstream stream.

**One stream per stage and per system.** Worldgen stages and runtime systems each
draw from a named stream. This is what lets a stage be inserted later without
reshuffling the stages before it, which would otherwise change every existing
seed.

### Time is forward only

The sim is deterministic, so a true rewind is a replay. A replay of one day costs
roughly 300ms: affordable, but it needs a snapshot ring to stay affordable across
a month. Until that exists the control says "advance to" and means it.

## The three render contracts

Nothing may violate these. They are what keep the picture crisp and the picking
exact.

1. **Integer transform.** Zoom is 1, 2 or 3 and never fractional. Every atlas
   pixel lands on an exact N by N block of device pixels. A fractional zoom
   resamples, and a resampled ID buffer cannot be trusted for picking.
2. **Palette.** Every non transparent pixel belongs to a finite render palette,
   and alpha is 0 or 255. Lighting variants quantize into palette banks. Partial
   alpha would let the browser blend colours that are not in the palette, which
   corrupts the ID buffer.
3. **No gradients on the world canvas.** Baked dithered sprites only. Smooth
   gradients are a UI concern and live in the DOM layer.

### Picking

Buildings are flattened once into their own sprites and sorted per object. The ID
buffer is stamped in the same painter's order as the colour buffer, so a click
resolves to exactly the object drawn at that pixel, through roofs and overhangs.
This is why contracts 1 and 2 are not stylistic preferences.

A narrow pulse pass runs immediately after each visible building or marked prop
in that same depth merge. It owns only details that must move or report live
state, such as clock hands, machinery, washing and crane falls. The building and
prop bodies remain flattened, while their moving parts cannot float over a
nearer roof or corrupt the ID buffer.

Seasonal foliage and grass use a four-step revision derived from the simulation
clock. Trees and ground rebake only when that revision changes. The much smaller
blossom and leaf drift pass stays world-space, deterministic and strictly capped,
and is drawn under the depth merge so buildings occlude it correctly.

### The atlas seam

`art/bake.py` and the baked pixel atlas are not built. The city currently renders
from vector primitives drawn in code. The compositor, depth sort, ID buffer and
camera contract were all built against those primitives, so an atlas drops in
behind an unchanged `blit()`. `atlas.ts` guarantees that a missing frame falls
back to a primitive, so art can never blank the game.

## Load bearing data structures

**The tile grid** (`district.ts`) is flat typed arrays, row major. No object per
cell: 4096 cells times a handful of arrays stays compact and keeps iteration
order fixed, which matters because iteration order is part of determinism.

**The street graph** (`graph.ts`) is the reason the game can afford 200 walking
souls. There is no runtime pathfinding. The graph is small by construction
(junctions, door nodes, tram stops and bridgeheads, capped at 512), so an
all pairs next hop matrix is about 512 KB and roughly 50ms to build once at
worldgen. Travel is then a single array read, `nextHop[from * n + to]`. Per agent
A* is the classic mistake in a game shaped like this one, and it is bought off
here for half a megabyte.

**Souls** (`souls.ts`) travel along graph edges rather than cells. A position is
`(atNode, toNode, progressMilli)`, so a movement update is two integer adds and a
compare. That is what makes 200 of them free. The renderer interpolates with
`soulPos()`.

**Relationships** (`relations.ts`) are CSR adjacency, built once and edited
rarely. Only principals carry a full relationship graph: 200 souls is more names
than any player will read, so both the writing effort and the gossip cost are
concentrated on the roughly 40 who will actually be looked at.

**The cause ring** (`pressures.ts`) is a 512 entry ring buffer that every
pressure write appends to. `applyPressure` is the only writer. This is what lets
`explain('gas')` walk backwards and produce "the tram is late because the depot
lost gas because you cut the main on Foundry Row". Legibility is a data structure
here, not a UI trick, and it costs one array write per change.

**Building footprints** (`buildings.ts`) cap at 2x2 for ordinary buildings. A
4x1 building anchored at its south corner has a depth key that sorts it in front
of a soul who is visibly further south than its west end. Landmarks may reach 4x4
and are placed with a one tile no walk apron on their south and west sides, and
that apron is enforced in the sim rather than in the renderer.

## The rule that keeps the game honest

**A player action must never be a direct pressure poke.**

If `cutGas` were `applyPressure('gas', -300)`, and if `curfew` were
`applyPressure('mood', -40)`, the game would be a slider board. Instead:

- `cutGas` breaks a specific segment of a specific tree. A specific set of
  buildings downstream of it loses service. The pressure moves as a
  *consequence*, reported by the hourly network read.
- `curfew` changes a specific rule that specific souls read when they decide
  whether to leave the house. Some stay in, some go out anyway, and the pressures
  follow from that.

The gas, drain and post trees in `networks.ts` exist for no other reason. This
rule is why interventions and ordinances have second order effects and documented
backfire conditions rather than dice rolls, and it is the difference between a
city and a control panel.

The same principle governs prose. Every fragment in `lexicon.ts` carries a `when`
predicate that reads real integers out of the sim, and a fragment whose predicate
fails is never selected. The prose layer therefore cannot assert anything the
simulation does not contain. That property is worth more than fluency, and it is
exactly what a language model in this slot would destroy.

## Physical events need physical bodies

Nothing teleports a crowd or fires an effect before a named body arrives.

- Petitioners walk to Civic Hall (`civic-visits.ts`).
- Patrons and opponents carry a verdict to a newspaper office or a public house,
  and the ward's support changes only once they arrive.
- Storm refuges relieve a person only when that person is physically inside
  (`shelters.ts`).
- Market Day goods appear only after vendors reach the square (`occasions.ts`).
- Witnesses to an event are computed from actual positions: occupants of the
  place plus souls standing on adjacent graph nodes (`events.ts`). Nobody learns
  anything by magic.

## Build and test

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # tsc && vite build, with qa/atlascheck.mjs as prebuild
```

`?seed=coppergate` generates a different district. `?ui=3` scales the panels up.

The `qa/` directory holds Playwright driven harnesses that are not part of the
unit suite: render contract checks, roof occlusion, density sweeps and mobile
play. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## TypeScript notes

`tsconfig` sets `erasableSyntaxOnly`, so there are no TypeScript enums anywhere
in the project: enums are not erasable. Const objects plus union types instead.
Shared ids, tile codes and vocabularies live in `sim/types.ts`, which everything
imports and which imports nothing, so no import cycle can form.
