# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via GitHub's "Report a vulnerability" (Security → Advisories) on
this repository, or by contacting a maintainer directly. Include:

- what the issue is and where (file),
- reproduction steps, including the seed if it is relevant,
- the impact you believe it has.

We will acknowledge as fast as we can and keep you updated on the fix.

## Scope of note

Verdigris is a client side, single player browser game. It has no server, no
accounts, no database, and it collects nothing. That removes most of the usual
surface, and it means the interesting reports are about the build and the
dependencies rather than about the game.

In scope:

- Anything in the published bundle that executes code from an untrusted source.
- Supply chain problems in the dependency tree (`vite`, `vitest`, `typescript`,
  `playwright`).
- A crafted URL parameter (`?seed=`, `?ui=`) that does more than change the
  world or the interface scale. Seeds are hashed into a PRNG and are not
  evaluated, so a report here would be a real finding.

## Out of scope

- Anything requiring a modified local build, browser devtools, or an already
  compromised machine. The player owns their own client, and cheating at a single
  player game is not a vulnerability.
- Determinism bugs and generator crashes. Those are ordinary bugs, and a public
  issue with the seed is the fastest way to get them fixed.
