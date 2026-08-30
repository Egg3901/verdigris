# Playing Verdigris

You are Verdigris's alderman. You never place a building.

Named residents bring real conditions to your desk: an unsound house, aggrieved
hands, a public door needed before the rain, sickness behind doors, a disputed
public account. You inspect the people and the place, follow them through the
day, and make personal calls around the ward.

The ledger judges what the city actually did, not which button you pressed.

## The short version

- Read the matter. Find out who is bringing it and why.
- Look at the place and the people before you answer.
- Spend influence only when a pending undertaking is worth pressing or a default
  is worth bringing before the petty sessions.
- Every seventh dawn, the ratepayers vote on your record. That vote sets how many
  measures you get for the following week.

## Your day

**Influence** is scarce. You get 2, 3, or 4 measures a day depending on how the
last ratepayers' sitting went. They let you send a clerk after an undertaking
that is already pending, or lay a complaint after a nuisance notice expires.
Looking, walking, reading, ordinary civic powers, and following somebody do not
spend influence. Those powers have costs in public temper, order, the purse, and
the record of high-handed conduct instead.

**Ward calls** are limited to three a day. A call belongs to one address, so the
choice matters:

- **Take a statement** enters a named occupant's account and establishes a civic
  relationship. A person heard at the address may give you a private warning
  about its petition.
- **View premises** sends the inspector of nuisances. A recent return lets you
  serve the named occupier with a nuisance notice, or support a public works case
  against civic skimming. It cannot supply an empty purse, an empty treasury, or
  a stopped crew.
- **Canvass** asks a ratepayer for a pledge. The answer depends on your standing,
  their grievance, and traced high-handed acts. Either answer is carried into the
  next ward sitting.

**Time runs forward only.** The control says "advance to" and means it. There is
no rewind, so an unwatched afternoon is genuinely gone.

**One tick is one game minute.** Souls are on schedules, so the district has
people in it whenever you look, and not only at the two rushes.

## The Alderman's Desk

A bounded daily agenda derived from live city state. Each matter carries:

- A **named petitioner**, who is a real resident with a real address.
- An **inspectable place**.
- **Visible causes**: the chain of events that produced the condition.
- A **day for answer**.
- A **delayed verdict**.

Matters are not quests. Their cause, day for answer and verdict are all read out of the
simulation, which means an answer that does not change the underlying condition
will be recorded as a failure however good it sounded at the desk.

Each open card carries its available courses and the clerk's risk note. You can
act from the desk, inspect the address first, or decline. An unavailable course
stays visible with the fact that prevents it.

### Verdicts are judged on outcomes

This is the part that catches people out. Filing the right paperwork is not the
same as fixing the thing:

| You promise | It counts only if |
| --- | --- |
| A repair | The fabric is actually made good |
| To back a stoppage | The picket survives the first four hours |
| A refuge | Somebody vulnerable actually reaches it |
| Sanitation | Sickness on the named street actually falls |
| An inquiry | A detention still holds, or an account stays credible |
| Turnout | The actual weekly vote bears it out |

Pending undertakings can be **pressed** at further political cost. Work you filed
*before* a petition arrived still receives its proper credit, so acting early on
something you noticed yourself is rewarded.

### Forecasts

Each available move is marked **public or deniable**, and **settled, contested or
unclear**. These forecasts come from the same deterministic predicates the sim
uses, so they are not flavour: an "unclear" really is a state the simulation
cannot currently resolve.

Selecting a petition marks the relevant powers in the ACT panel. The same
courses are available directly on the petition without changing targets by hand.

## Nuisance notices

View defective premises, then serve the occupier entered in the rate book. Six
hours are allowed for compliance.

- If that household is out of arrears and can meet the real cost, its purse pays
  for the work and the exact defect is made good.
- If it cannot pay, the notice falls into default. You may enter public works, or
  spend influence to lay the complaint before the petty sessions.
- The magistrates can make an order of abatement. The order is paper. The wall,
  drain, or gas service remains defective until somebody executes the work.

The posted paper and survey mark remain visible on the building while the notice
is alive.

## The Works Register

File a fabric, drain or gas case against a specific building.

A works case is a request, not a repair. It travels through the pneumatic post,
so **post access changes how long it takes to arrive**. It then waits for an
actual workshop, and finally succeeds or fails against the district's coin and
its `rot`. The three outcomes are repaired, cosmetically skimmed, or shelved.

You can read case state off the building itself: survey marks, scaffold, blue
sheeting, completion plaques, gutters, broken pipes, damp and puddles are all
evidence of simulation state rather than decoration.

## Street politics

Nothing here teleports. Every political effect requires a body to make a journey.

- Petitioners walk to the Town Hall. This does not delay an actionable case.
- A **kept promise** sends a named patron to speak at the newspaper.
- A **broken or declined promise** sends a named opponent to a public house.
- The ward's support or opposition changes only once that person arrives.

You can watch this happen, and you can intervene while it is in transit.

## The ratepayers' sitting

Every seventh day, at a fixed 8AM vote in the square:

- A named supporter and a named opponent test your standing and any exposed
  clandestine record.
- Up to eight named adults travel to the square. **Only those who actually reach
  it count.**

| Result | Follow-up measures per day next week |
| --- | --- |
| Confidence | 4 |
| Divided room | 3 |
| Loss | 2 |

No result ends the game. The next sitting can reverse it.

Because attendance is a physical journey, weather and public order on the morning
of the vote are part of the vote.

## What the district does on its own

You are not the only thing happening.

- **Eight pressures** move on their own, against baselines that are functions of
  world state.
- **Six incidents** fire from pressure thresholds, each carrying the cause chain
  that produced it. Ask why, and the game can tell you.
- **Disasters** are physical and stateful: a damaged building, a broken main, a
  cleanup clock.
- **Claims** spread along the relationship graph and distort as they travel. A
  rumour keeps a lineage you can walk back to whoever started it.
- **Weather** runs in seeded six hour watches, and gates fires and floods.
- **Civic Market Day** is a real occasion with real vendors who have to arrive
  before the goods do.

## The thing the game is actually about

Civic pride papering over rot.

`rot` decides whether a repair that was ordered actually happened. The courts
behind the gold leaf frontages are a spatial fact the generator produces, not
flavour text.

Undisturbed, the district settles at an average facade of 610 against an average
fabric of 520. Spend fourteen days funding the bunting and facade rises to 669
while fabric falls to 462.

The city looks better and is structurally worse. That is the whole game, and
nothing in the interface will stop you doing it.

## Controls

`?seed=coppergate` in the URL generates a different district. `?ui=3` scales the
panels up.

Every verb has a keyboard equivalent. On a phone, the single surface shell keeps
persistent LOOK, ACT, DESK, COUNCIL and HELP routes, with stepped pinch zoom and
coarse pointer person picking.
