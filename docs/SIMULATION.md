# Simulation reference

What each system models, and the rule that keeps it honest. Structural concerns
(determinism, layering, the render contracts) are in
[ARCHITECTURE.md](ARCHITECTURE.md).

Every module here is pure and deterministic. One tick is one game minute.

## Generation

### `worldgen.ts`, `district.ts`, `hydrology.ts`

The whole world is a pure function of one seed string. Nothing in worldgen reads
the clock, the DOM or `Math.random`, and every stage draws from its own RNG
stream so that inserting a stage later does not reshuffle the stages before it.

The stages, in order, on a 64 by 64 grid:

1. Seeded coves and headlands, and a river with a polite bank and a working bank.
2. Two or three crossings, a civic square of variable size, five to eight edge
   gates.
3. Least cost arterials, then block subdivision.
4. Six named wards: civic, garden, merchant, works, courts and quayside.
5. Plot slicing, and the courts behind the frontages.
6. Ward aware building assignment.
7. Gas, drain and post networks, and the tram line.
8. A prehistory of grudges that predate tick 0.

A validator runs after generation, and `worldgen-fuzz.test.ts` plus a 64 seed
corpus guard density, connectivity, variation and caps.

Ward identity is not just a label. It is expressed through block grain, building
mix, materials, paving, vegetation, street furniture and inspector text, so the
six wards read differently before anything is named.

River level is a pure function of `(seed, tick)`: a weighted sum of the last 28
precipitation watches, with a slow dry spell bias, clamped to 0..4. Deriving it
rather than storing it keeps replay and the save format untouched.

### `names.ts`, `lexicon.ts`

Data, no logic. Name pools are 1890s English industrial city, which means Old
Testament given names on the working bank and Latinate ones on the polite one.

The lexicon is authored fragments plus predicates. See "Prose" below.

## People

### `souls.ts`

A soul is a person: position, schedule, needs, ties. Movement is along graph
edges, so 200 of them cost almost nothing. Roughly 40 are principals and carry a
full relationship graph.

### `schedule.ts`

Daily patterns with interrupts, deliberately not utility AI and not GOAP. That is
cheaper and far more testable, but the real reason is legibility: this game only
works if a soul's day is predictable enough that a *deviation* reads as
meaningful. An agent that does something surprising every day is noise, not
character.

Schedules carry jitter, and an ambient errand layer keeps people in the district
whenever you look rather than only at the two rushes.

### `relations.ts`, `households.ts`, `firms.ts`

Relations are CSR adjacency. Households own rent, arrears, and the eviction chain
that turns a lost wage into a soul leaving the district.

Firms are deliberately thin: one orders integer and one margin. No price
discovery, no markets, no supply chains. Simulating a real economy would eat the
entire build, and nobody watching a city from above can see a price anyway. What
a firm needs to do is employ people, pay them, and be capable of stopping.

## What the district knows

### `events.ts`

An event is the bridge between the mechanical layer (a segment broke, a firm
closed) and the social one (people now believe something). Witnesses are computed
from actual positions: occupants of the place, plus souls standing on the graph
nodes next to it.

### `claims.ts`

A claim is a proposition about somebody. It has a truth value the player can
never see directly, and a separate conviction per soul who holds it. Claims
spread along the relationship graph in the gossip slice, and every transmission
can distort. The child claim keeps a `parentId`, so a rumour has a lineage you
can walk back to whoever started it. That lineage is most of what makes an
intervention legible three days later.

### `civic-memory.ts`

A fixed set of address records, not an ever growing chronicle. Every address
keeps the last decisive civic episode and its scars; households carry the part of
that history which still changes their lives. Disasters, works cases, hearings
and storm relief leave bounded household burdens, institutional evidence and
persistent inspector history after the temporary event has cleared.

## Pressure and consequence

### `pressures.ts`

Eight fine grained pressures, with baselines that are functions of world state
rather than constants. `applyPressure` is the only writer, and every write
appends to a 512 entry cause ring, so `explain()` can produce a causal chain
instead of a number.

### `metrics.ts`

The eight pressures are the right vocabulary for the machinery and the wrong one
for the goal. A player is not trying to hold `suspicion` at 180. Metrics roll the
pressures plus the enforcement level into the three things a ward boss is
actually balancing: whether the district is happy, orderly and solvent, and which
of the three they are willing to spend to buy the others.

### `networks.ts`

Gas, drains and pneumatic post: three trees sharing one implementation. They
exist so that cutting a gas main has a *shape*. Breaking one segment darkens a
specific set of buildings downstream, and the pressure change is a consequence
of that rather than the move itself.

### `incidents.ts`

Six named things that go wrong on their own. Incidents fire from pressure
thresholds with hysteresis and a cooldown. Without the hysteresis band a pressure
sitting on a threshold chatters an incident every hour and the ticker becomes
noise the player learns to ignore, which is worse than having no ticker. Every
incident carries the cause chain that produced it.

### `disasters.ts`

Physical, stateful failures the district can actually suffer and repair, and
deliberately separate from the ticker incidents. An incident says what the
district noticed; a disaster owns the damaged building, the broken main and the
cleanup clock.

### `weather.ts`

Seeded six hour watches, derived from the clock rather than advanced through a
hidden cursor. A watch is long enough to become part of the district's day, and a
two day pressure system keeps adjacent watches from feeling like dice. Weather
produces rain, storms, fog, wind, wet streets, umbrellas, exposure, failed drain
wear and altered wharf output, and it gates fires and floods.

The same clock derives a 48-day visual year. Spring wraps around day zero,
summer begins on day 6, autumn on day 18 and winter on day 30, placing the
coldest day at the center of winter. The season is render input only: it changes
foliage, open ground and ambient leaf or blossom movement without introducing a
second mutable calendar into the simulation.

The renderer also reads three broad term-age bands from the clock, at days 7,
21 and 42. They do not change simulation rules. They allow occupied homes and
working premises to acquire sparse rooftop coops, tanks and lifting frames over
time while firm shutdowns and strikes remain direct readings of firm state.

## What the player does

### `interventions.ts`

Eleven interventions, each with a second order effect and a backfire that is a
documented state condition rather than a dice roll.

**Hard rule: an intervention must never be a direct pressure poke.** See
[ARCHITECTURE.md](ARCHITECTURE.md#the-rule-that-keeps-the-game-honest).

### `ordinances.ts`

Named laws, under the same hard rule. A law changes a specific rule that specific
souls read when they decide whether to leave the house. Unenforced is a real
outcome: the constables are on a schedule, and `rot` decides whether an order to
act is actually carried out.

### `matters.ts`

Matters before the alderman, and the system that reversed the game's original
relationship with the player. The simulation used to generate hundreds of facts
and then wait for the player to invent a reason to care about one. Instead, named
residents bring a real condition to the desk, the player may investigate and
answer it, and the ledger records what the simulation eventually did.

A matter is never a random quest. Its cause, day for answer and verdict are all read
out of live city state. Verdicts are delayed and judged on outcomes:

- A filed repair counts only if the fabric is actually made good.
- A strike faces a real four hour clearing contest.
- A refuge counts only when somebody vulnerable reaches it.
- Sanitation is judged by sickness on the named street.
- An inquiry needs a detention that still holds, or an account that remains
  credible.
- Turnout is judged by the actual weekly vote.

Pending promises can be pressed at further political cost, and work filed before
a petition receives its proper credit.

### `notices.ts`

Statutory nuisance enforcement tied to a recent premises view. A notice names a
real household, waits six hours, and tests that household's purse and arrears.
Compliance executes the same physical repair primitive used by public works.
Default may be summoned before the petty sessions, but an abatement order does
not change fabric or reconnect a service. The player must still secure private
compliance or enter public works.

### `works.ts`

The Works Register. A works case is a request, not a magic repair button. It
travels through the actual pneumatic post (so post access changes lead time),
waits for an actual workshop, and succeeds or fails against the district's actual
coin and `rot`. It may be repaired, cosmetically skimmed, or shelved.

The visible scaffold is therefore evidence of simulation state, not decoration
laid over it: survey marks, blue sheeting, completion plaques, gutters, broken
pipes, damp and puddles all put case state directly on the building.

## Public life

### `civic-visits.ts`

A petition may be readable as soon as the morning papers reach the desk, but its
authors still walk to the Town Hall. Kept promises send a named patron to speak at
the newspaper; broken or declined promises send a named opponent to a public
house. Support or opposition changes the ward only after the person arrives.

### `deputations.ts`

Public deputations are actual residents making an actual journey. A filed case
can be heard sooner, but the crowd never repairs a wall or a pipe itself.

### `shelters.ts`

Storm refuges are a physical service, not a morale button. A provider opens its
doors for a few hours, selected people walk there, and relief happens only once
their body is inside.

### `occasions.ts`

Civic Market Day is a bounded public occasion. It owns a small real group, sends
them through the street graph, and never turns a calendar entry into a crowd
unless bodies reach the square. Goods appear only after vendors arrive, and
turnout can be thinned or cancelled by weather, public order, a deputation or
storm relief.

### The ratepayers' sitting

Every seventh day a named supporter and a named opponent test the chair's
standing and any exposed clandestine record. Up to eight named adults travel to a
fixed 8AM vote in the square, and only those who reach it count.

| Result | Daily measures next week |
| --- | --- |
| Confidence | 4 |
| Divided room | 3 |
| Loss | 2 |

No result ends play, and the next sitting can reverse it.

## Prose

### `prose.ts`

State driven sentence assembly, in three parts and in this order:

- **Sense line.** The top passing fragments from the lexicon, joined as a list.
- **Standing fact.** A grudge with a negative `sinceTick`, rendered in years.
- **Live clause.** Only if something is actually happening, otherwise omitted.

The standing fact is the trick that makes day one feel like year eleven. The
generator invented a past before the player arrived, so an argument about
drainage can already be eleven years old on the first morning.

Because every fragment's `when` predicate reads real integers out of the sim, the
prose layer cannot assert anything the simulation does not contain.

## Measured behaviour

Undisturbed, the district settles at an average facade of 610 against an average
fabric of 520. Fourteen days of funding the bunting takes facade to 669 and fabric
to 462: the city looks better and is structurally worse.

That number is the thesis of the game. `rot` is a simulation variable that decides
whether a repair that was ordered actually happened, and the courts behind the
gold leaf frontages are a spatial fact the generator produces.
