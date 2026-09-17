# Changelog

Entries are added as part of the version bump for a release (see CLAUDE.md);
this file is not touched by ordinary pull requests. Parsed at build time by
`scripts/changelog.mjs`, compiled into the client bundle by
`vite.desktop.config.js` (the same pattern as `buildIdentity`), and rendered
in Settings by `apps/desktop/src/main.js` - never fetched at runtime, so it
works offline behind the service worker like everything else.

## 0.4.7 - 2026-09-16

### Endless is playable

One fixed rondo, one difficulty, and a clock that counts up instead of down.
Nothing is scored but the seconds you last, so the leaderboard, your personal
best and the results screen all read as a time rather than a total. Bonuses
still fire, still feed your streaks and still pay Energy - they just pay no
points, so a zone reads as a zone and promises nothing it cannot give.

The press is the difficulty, and the clock turns it: two defenders at
kickoff, a third at 0:45, a fourth at 1:45, a fifth at 3:15, and they keep
getting quicker after that with no ceiling. There is nothing to extend and
nothing to buy - triangles no longer add seconds. The first mistake ends the
run.

The HUD says what matters in a run: how many defenders are on the court, how
long until the next one arrives, and how long you have lasted.

## 0.4.6 - 2026-09-15

### Scoring rebuilt around the bonus zone

The multiplier is now driven by the bonus zone alone, and it climbs further
than it used to — to a ceiling of x10 — but it takes longer to get there and
a turnover still knocks it back to the start. Passing well no longer raises
it on its own; moving into the zone does. Zones live for a shorter time and
go dark for a beat before the next one appears.

### Energy is something you spend, not something you ride

Focus and Boost now cost the same amount per second, and that cost is much
higher: a full meter is about two seconds of either, where Focus alone used
to be worth ten. The rewards for triangles, zones, splits and olés are
halved to match. Energy is banked for the moment that needs it rather than
held down through a round.

### Targets, stars and difficulty all mean something different

Every court is now tuned against one number: what a clean round — no
turnovers at all — actually scores there. The score you need to clear a
court, the two-star score and the three-star score are each set from it
independently, so clearing a court can be generous without making three
stars unreachable. Three stars now means you scored what the court is
capable of producing.

Difficulty changed shape too. A tier no longer alters the court you are
playing: the press speed and the number of defenders belong to the court,
and Ruthless no longer quietly adds a fifth defender to a court whose own
description says four. What a tier changes is how many possessions you get,
and what you are graded against. Relaxed keeps its gentler press.

Because a single-possession round never loses its multiplier, Ruthless asks
for the most points of any tier and is still the hardest — the difficulty is
surviving long enough to score them.

### Leaderboards have been reset

Scores set under the old scoring cannot be compared to scores set under this
one, so the boards start again from here.

### Fixes

- The home leaderboard names the mode you are looking at and shows its icon,
  instead of always reading "Circuit Leaderboards" under a trophy.
- Free practice is a sandbox again. It had started demanding a real clearing
  score, and awarding three stars for wandering around one.
- Only a round you actually cleared is saved as a score or a personal best.

## 0.4.5 - 2026-09-15

### The soundtrack lives outside the app now

Music is no longer packaged with the game. Tracks are fetched at runtime from
a manifest, so new music can be added without shipping a new version of the
game — and the download you get on a release dropped from about 19 MB to just
over 1 MB.

Nothing changes about how it plays. If the soundtrack cannot be reached, the
game runs exactly as it always does, just without music.

This is the groundwork for per-court soundtracks: each court will be able to
have its own music, unlocked as you clear it.

## 0.4.4 - 2026-09-14

### Release packaging recovery

0.4.3 was not deployed because its app shell exceeded the release size budget.
Production builds now omit developer-only HTML comments, reducing the payload
without changing gameplay, UI, or the release notes in Settings. 0.4.4 carries
all of the 0.4.3 features.

## 0.4.3 - 2026-09-14

### More ways to make the game yours

Focus now gives the soundtrack a tape-slowdown, underwater feel while it is
active. Prefer the original music? Turn that effect off in Settings.

On touch devices, choose whether Focus and Boost are tap-to-toggle (the
existing behaviour) or press-and-hold. You can also skip tracks with
remappable keyboard or controller controls.

### Discord and the community

Sign in with Discord as well as email. New Discord players choose their
leaderboard name once, then are ready to play.

The Discord invite is now available throughout the game, including compact
layouts.

### A leaderboard that keeps up

Leaderboard requests now time out cleanly instead of appearing stuck, and a
manual refresh keeps the scores already on screen while it updates. Changing
a court or difficulty cancels the obsolete request, so the board always
settles on the scores you asked for.

After a reload, a syncing state stays visible while your account and save data
restore, instead of leaving the home screen looking frozen.

The refresh control is now a clear, high-contrast icon button sized to match
the difficulty toggle.

### Release notes in Settings

The changelog is built into Settings, so you can read what changed even
offline.

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
