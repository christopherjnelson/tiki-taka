# Changelog

Entries are added as part of the version bump for a release (see CLAUDE.md);
this file is not touched by ordinary pull requests. Parsed at build time by
`scripts/changelog.mjs`, compiled into the client bundle by
`vite.desktop.config.js` (the same pattern as `buildIdentity`), and rendered
in Settings by `apps/desktop/src/main.js` - never fetched at runtime, so it
works offline behind the service worker like everything else.

## 0.4.2 - 2026-09-14

Fixes found by playing 0.4.1.

### Your progress is safe from older clients

One account lost every unlocked court and star after 0.4.1. The XP reset was
not the cause - that deliberately keeps courts, stars and records. The cause
was an older build reading the new save format, not recognising it, and
writing an empty save over the top.

A build that cannot read your save now refuses to touch it and tells you
plainly to reload, rather than quietly replacing it with nothing. This
applies to both account saves and guest saves on a single device.

If you were affected, your round history was never lost - it lives
separately - so your courts and personal bests can be rebuilt from it.

### Choosing a court works on a phone in portrait

Tapping a court in portrait did nothing; the selection only took effect
after a reload, and landscape seemed fine. A leftover rule from before the
home screen was redesigned forced the court grid into a clipped horizontal
strip on any screen narrower than 700px - which a phone is in portrait and
is not in landscape - so taps past the first court landed on nothing.

### The home demo plays one-touch properly

The demo's one-touch run looked like trapping the ball and holding it. It
now queues each pass while the ball is still travelling, the way a player
does, so the ball is released the moment it arrives and never settles.

It also stops after an olé instead of running forever, so a viewer sees a
triangle, a split and a zone hit rather than an endless olé reel.

### Under the hood

The browser test suites now wait on animation frames and observable
conditions instead of fixed slices of wall-clock time, which is what made
them fail on busy machines. A guard fails any new unjustified fixed wait
immediately rather than letting it flake weeks later.

## 0.4.1 - 2026-09-14

### Progression rebuilt

Levels used to arrive about once a round - four test rounds could reach
level 5. XP now rewards taking new ground rather than replaying it: a large
one-time bonus the first time you clear a court at a tier, a small trickle
for repeats, both scaled by court and difficulty. Free practice earns
nothing; it is a sandbox, not a way to grind.

The ladder is a 50-level curve - level 2 at 70 XP, level 10 at ~920, level
50 at ~12,800 - with 12 rank titles instead of 6, so they keep changing all
the way up rather than reading "Master of possession" from level 11.

Existing saves: progress moves to version 2 and XP resets to 0. Courts,
stars, records and unlocks are all preserved - only the level ladder
restarts, because there is no honest way to rescale an old total onto the
new curve.

### The home screen explains itself again

The attract demo is back in the preview slot under Play, and its bots now
perform on purpose: a deterministic cycle of split, triangle, one-touch,
zone, so every mechanic shows within the first few seconds instead of
whenever luck allows. Selecting or hovering a court re-skins the rally to
that venue live - background, accent and light change while play continues
uninterrupted.

It also knows when to stop: on hardware that cannot afford it, the demo
freezes to a single painted frame rather than costing the rest of the page
its frame budget.

### Courts that read either way

Every venue was rebuilt to be painted in the orientation you are actually
looking at, rather than drawn for landscape and rotated. The playing
surface is quiet now - a flat floor and one pool of venue-tinted light - so
the ball and the players own the contrast. Each venue's character moved to
the border, wrapping all four sides: Sao Paulo's cage, Lisbon's rooftops,
Barcelona's mosaic, Tokyo's neon, London's truss, Amsterdam's gables.

Signage stays upright whichever way the court turns, and the venue
watermark is measured to fit rather than cropping in portrait.

### Playing with a controller

The home screen is navigated by zones instead of one flat list. Up and down
move within a zone, left and right move between them, and each zone
remembers where you were. Getting from Play to the courts no longer means
walking seven leaderboard controls. Each zone follows its own layout - the
mode row is walked left to right, the court list up and down - and choosing
a court hands the cursor to the modes, then to Play.

### Also

- OLE leads the leaderboard's bonus columns, grouping the yellow columns
  together.
- The Daily circuit is gone. The roster is World tour, King of the Court,
  Endless and Free practice.
