# Contributing to Verdigris

Thanks for looking. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: most
of the review comments on a first pull request are about a contract described
there, not about style.

## Getting set up

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # tsc && vite build
```

`?seed=coppergate` in the URL generates a different district. `?ui=3` scales the
panels up.

## The rules a change must not break

These are not preferences. Every one of them is load bearing, and breaking one
tends to break something distant and hard to trace.

### 1. The sim stays pure

Inside `src/sim/`:

- No `Math.random`. Use `src/sim/rng.ts`.
- No `Date.now`, `performance.now`, or any other clock read.
- No DOM access.
- No floats in stored state. Integers only.
- No stored PRNG cursor. Derive the generator from `(seed, stream, tick, entity)`.

The world must remain a pure function of `(seedStr, tickCount, nudges)`. If your
change means a replay from those three values no longer reproduces the same
world, the change is wrong even if every test passes.

`hashWorld()` is the anchor. If you are unsure whether something broke
determinism, run the same seed twice and compare hashes.

### 2. The renderer never writes to the sim

`src/render/` reads. It does not mutate. If a renderer needs a value that does
not exist, add it to the sim and read it, rather than computing a shadow copy in
the render layer that can drift.

### 3. The three render contracts

Integer zoom only (1, 2 or 3). Every pixel in the finite palette, alpha 0 or 255.
No gradients on the world canvas. See
[ARCHITECTURE.md](docs/ARCHITECTURE.md#the-three-render-contracts) for why: these
are what make ID-buffer picking exact, not a look.

### 4. A player action is never a direct pressure poke

If you find yourself writing `applyPressure('mood', -40)` inside an intervention
or an ordinance, stop. The action must change a specific thing in the world, and
the pressure must move as a consequence of that change, reported by the normal
hourly pass. Otherwise the game becomes a slider board.

The same applies in reverse to prose: a fragment in `lexicon.ts` must carry a
`when` predicate that reads real sim integers, so the writing can never assert
something the simulation does not contain.

### 5. Nothing happens without a body

No teleporting crowds, no effects that fire before a named person arrives. If an
effect should happen when somebody reaches a place, make them walk there and fire
it on arrival.

### 6. No TypeScript enums

`tsconfig` sets `erasableSyntaxOnly`. Use const objects plus union types. Shared
vocabularies live in `src/sim/types.ts`, which must not import anything.

## Tests

The unit suite is vitest, under `src/sim/__tests__/`. There are 20 test files and
they are the fastest way to find out you broke a contract.

`determinism.test.ts` is the one to watch. If it fails, do not "fix" it by
updating the expected hash unless you can say exactly which intended behaviour
change moved the world, because the same failure is what a genuine determinism
bug looks like.

`worldgen-fuzz.test.ts` runs a 64 seed corpus and guards density, connectivity,
variation and caps. A generator change that passes on your favourite seed and
fails the corpus is a generator change that only works on your favourite seed.

### The QA harnesses

`qa/` holds Playwright driven checks that are not part of the unit run, because
they need a browser and take longer:

```
npm run qa:render     # render contract: palette, alpha, integer transform
npm run qa:roof       # roof occlusion and picking through overhangs
npm run qa:capture    # screenshots
npm run qa:mobile     # phone shell play-through
```

`qa/atlascheck.mjs` runs automatically as a `prebuild`.

Run `qa:render` before any pull request that touches `src/render/`.

## Branches and commits

Trunk is `main`. Branch from it, and open a pull request against it.

Commit messages are conventional commits, and the subject describes the change in
the game's own terms rather than the code's. The existing history is the style
guide:

```
fix(render): gas holders that are round, and made of iron
feat(gen): streets wide enough to see a building across
feat: a wider view on a phone, and a sky with no seam in it
```

Prefixes in use: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`.
Scopes in use: `sim`, `gen`, `render`, `ui`, `qa`.

## Pull requests

`main` is protected: changes land through a pull request, and the `verify` check
(typecheck, unit tests, build) has to pass.

In the description, say:

- what changes in the district, in player-visible terms;
- which seed you tested on, if the change touches generation;
- whether `hashWorld()` moved, and if so, why that is intended.

A change to worldgen that shifts every existing seed is sometimes correct, but it
is never incidental. Say so explicitly.

## Things that are deliberately not built

Do not add these without discussing it first, because their absence is a decision
rather than a gap:

- **A real economy.** Firms are one orders integer and one margin. No price
  discovery, no markets, no supply chains. Nobody watching a city from above can
  see a price.
- **Utility AI or GOAP.** Schedules with interrupts are cheaper, more testable,
  and crucially more legible: this game only works if a deviation from a soul's
  routine reads as meaningful.
- **Runtime pathfinding.** The all pairs next hop matrix is half a megabyte and
  built once. Per agent A* is the classic mistake in a game shaped like this.
- **A language model in the prose slot.** The predicate gated lexicon cannot
  assert something the sim does not contain, and that property is the point.
- **Rewind.** The sim is deterministic so a rewind is a replay, and a replay needs
  a snapshot ring before it is affordable over a month.

## Licence

Verdigris is released under the PolyForm Noncommercial License 1.0.0. By
contributing you agree that your contribution is licensed under those terms. See
[LICENSE.md](LICENSE.md).
