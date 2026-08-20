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

Built: the deterministic core, the eight-stage worldgen (river, crossings,
arterials, blocks, plots, courts, quota assignment, gas and drain and post
networks, tram, prehistory), the all-pairs next-hop street graph, schedules with
errands, needs, pressures with the cause ring, the prose layer, the isometric
renderer with ID picking, and the full UI shell.

Not built yet: `art/bake.py` and the real pixel atlas, so the city currently
renders from the vector fallback primitives. That is the intended order. The
renderer's contract is that a missing atlas frame falls back to a primitive, so
art can never blank the game, and the compositor, depth sort, ID buffer and
camera contract were all built against boxes so the atlas drops in behind an
unchanged `blit()`.

Also outstanding: claims and gossip, incidents, the interventions themselves,
day and night baking, weather, and the 9-slice panel frames.

Time is **forward only** in this version. The sim is deterministic so a true
rewind is a replay, and a replay of a day costs about 300ms; that is affordable
but it needs a snapshot ring to stay affordable over a month, so the control says
"advance to" and means it.
