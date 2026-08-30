# Verdigris

A living 1890s city district that brings its troubles to your desk.

Named for the green patina on its brass. White stone, gold leaf, civic bunting,
arc lamps, pneumatic post, one tram line, one dirigible mooring mast. Toned-down
steampunk, in the register of inkle's 80 Days and BioShock Infinite's Columbia.

**The theme is civic pride papering over rot.** The district presents beautifully
and is quietly failing underneath. That is not flavour text: `rot` is a simulation
variable that decides whether a repair that was ordered actually happened, and the
courts behind the gold-leaf frontages are a spatial fact the generator produces.

**You are Verdigris's alderman.** You never place a building. Named residents
bring real conditions to your desk: a failing house, aggrieved hands, a public
door needed before the rain, sickness behind doors, or a disputed public account.
You inspect the people and place, follow them through the day, and spend a small
number of measures of influence. The ledger judges
what the city actually did, not which button you pressed. Every seventh dawn,
named patrons and opponents physically come to the square and put your record
before the ratepayers; their vote changes how much influence the chair can move
during the following week.

## Running it

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # tsc && vite build
VERDIGRIS_WEB_ROOT=/path/to/webroot ./deploy.sh   # build, then rsync dist/
```

`?seed=coppergate` generates a different district. `?ui=3` scales the panels up.

## Docs

- [Architecture](docs/ARCHITECTURE.md): the layer split, the determinism
  contract, the render contracts, and the decisions that are load bearing.
- [Simulation reference](docs/SIMULATION.md): what each system models, and the
  rule that keeps it honest.
- [Playing Verdigris](docs/PLAYING.md): what an alderman actually does.
- [Contributing](CONTRIBUTING.md): the rules a change must not break.

## Shape of the code

- `src/sim/` is pure and deterministic. Zero DOM, zero `Math.random`, zero
  `Date.now`. Integers only in state. The world is a pure function of
  `(seedStr, tickCount, player action log)`, which is why the save format is the action log
  and why `hashWorld()` can anchor every determinism test.
- `src/render/` never writes to the sim. Buildings are flattened once into their
  own sprites and sorted per object; the ID buffer is stamped in the same
  painter's order so picking is pixel-exact through roofs and overhangs.
- `src/ui/` is HTML and CSS over the canvas, not drawn in it.

Three contracts that nothing may violate:

1. **Integer transform.** Zoom is 1, 2 or 3 and never fractional. Every atlas
   pixel lands on an exact N by N block of device pixels.
2. **Palette.** Every non-transparent pixel belongs to a finite render palette,
   and alpha is 0 or 255. Lighting variants quantize into palette banks. This keeps the ID
   buffer exact and prevents blended browser colours from creeping into the art.
3. **No gradients on the world canvas.** Baked dithered sprites only. Smooth
   gradients live in the UI DOM layer.

## Where it is

Live at **https://lakesidegames.net/games/verdigris/**

Built and playing:

- The deterministic core. The world is a pure function of
  `(seedStr, tickCount, player action log)`, so the save format is the action log and
  `hashWorld()` anchors every determinism test.
- Worldgen on a 64 by 64 grid: seeded coves and headlands, polite and
  working banks, two or three crossings, a variable civic square, five to eight
  edge gates, least-cost arterials, block subdivision, six named wards, plot
  slicing, courts, ward-aware assignment, gas and drain and post networks, tram,
  and a prehistory of grudges that predate tick 0. Civic, garden, merchant,
  works, courts, and quayside wards share identity across block grain, building
  mix, materials, paving, vegetation, street furniture, and inspector text.
- All-pairs next-hop street graph, usually 400 to 520 nodes. No runtime
  pathfinding. A 64-seed corpus guards density, connectivity, variation and caps.
- Schedules with jitter plus an ambient errand layer, so the district has people
  in it whenever you look and not only at the two rushes.
- Eight pressures with a cause ring, and baselines that are functions of world
  state rather than constants.
- Claims that spread over a relationship graph, distort on transmission, and keep
  a lineage you can walk back.
- Six incidents with hysteresis and cooldowns, each carrying the cause chain that
  produced it.
- Eleven interventions, each with a second-order effect and a backfire that is
  a documented state condition rather than a dice roll.
- The Alderman's Desk: a bounded daily agenda derived from live city state, with
  named petitioners, inspectable places, visible causes, deadlines, a political
  standing, persistent patrons and opponents, and delayed verdicts. A filed
  repair counts only if the fabric is actually made good; a strike faces a real
  four-hour clearing contest; a refuge counts only when somebody vulnerable
  reaches it; sanitation is judged by sickness on the named street; an inquiry
  needs a detention that still holds or an account that remains credible; and
  turnout is judged by the actual weekly vote. Pending promises can be pressed
  at further political cost, and work filed before a petition receives its
  proper credit.
- Street politics: petitioners walk to Civic Hall without delaying an actionable
  case. Kept promises send a named patron to speak at the newspaper; broken or
  declined promises send a named opponent to a public house. Their support or
  opposition changes the ward only after the person reaches the destination.
- The ratepayers' sitting: every seventh day, a named supporter and opponent test
  the chair's standing and exposed clandestine record. Up to eight named adults
  travel to a fixed 8AM vote, and only those who reach the square count.
  Confidence grants four daily measures next week, a divided room keeps three,
  and a loss narrows the chair to two. No result ends play, and the next sitting
  can reverse it.
- Intervention forecasts taken from the same deterministic predicates as the
  sim. Each available move is marked public or deniable and settled, contested
  or unclear; a selected petition marks relevant measures without choosing one
  for the player.
- The Works Register: file a fabric, drain or gas case on a building. Pneumatic
  post access changes lead time; coin, rot and workshop state decide whether it
  is repaired, cosmetically skimmed or shelved. Survey marks, scaffold, blue
  sheeting, completion plaques, gutters, broken pipes, damp and puddles put that
  state directly on the building. Honest completed work leaves permanent roof,
  masonry, pipe and repaved-street scars, so a repaired district keeps its history.
- Predicate-gated prose that cannot assert anything the sim does not contain.
- Seeded six-hour weather watches with rain, storms, fog, wind, wet streets,
  umbrellas, exposure, failed-drain wear, altered wharf output, and weather-gated
  fires and floods. A 48-day visible year turns gardens and street trees through
  spring blossom, summer leaf, autumn colour and bare winter structure.
- A fixed civic record at every address. Disasters, works cases, hearings and
  storm relief leave bounded household burdens, institutional evidence and
  persistent inspector history after the temporary event has cleared.
- Civic Market Day: a seeded public occasion whose vendors and visitors walk to
  the square, whose goods appear only after vendors arrive, and whose turnout can
  be thinned or cancelled by weather, public order, a deputation or storm relief.
- Isometric renderer: gable, hip, pyramid, flat, mansard, gambrel, sawtooth and
  dome roofs, varied per address and ward; chimneys, dormers, bay windows,
  facade materials, window rhythm, opening-hour shutters and awnings, dry-day
  work displays, wind-driven washing, working flywheels and pump beams, live
  gas-holder collars and civic clocks, hoisting dock cranes, shift-weighted
  freight traffic, vehicles, smoke, lit windows, seasonal trees and ground texture,
  drifting blossom and leaves, immediate picket and shutdown signals, rooftop
  coops, tanks and hoists that accumulate over a long aldermanic term, a slowly
  filling river with animated outfalls, a weather-gated packet airship,
  flatten-per-building compositor, one depth merge for buildings, props, people,
  trams, and carts, pixel-exact ID-buffer picking and discrete zoom.
- The full UI shell, and a keyboard equivalent for every verb.
- A single-surface phone shell with persistent LOOK, ACT, DESK, VESTRY and HELP
  routes, dynamic bottom-bar clearance, stepped pinch zoom, coarse-pointer person
  picking, and 44px decision and close targets.

Measured behaviour: undisturbed, the district settles at an average facade of 610
against an average fabric of 520. Fourteen days of funding the bunting takes
facade to 669 and fabric to 462. The city looks better and is structurally worse.

Not built:

- `art/bake.py` and a baked pixel atlas. The city renders from vector primitives
  drawn in code. The compositor, depth sort, ID buffer and camera contract were
  all built against those primitives, so an atlas drops in behind an unchanged
  `blit()`. `atlas.ts`'s contract is that a missing frame falls back to a
  primitive, so art can never blank the game.
- The 9-slice panel frames and the two pixel fonts. Panels use flat CSS borders
  and a system monospace stack.

Time is **forward only**. The sim is deterministic so a true rewind is a replay,
and a replay of a day costs about 300ms; affordable, but it needs a snapshot ring
to stay affordable over a month. The control says "advance to" and means it.
