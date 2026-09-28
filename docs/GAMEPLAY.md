# Gameplay guide

## Scoring

Move the ball carrier while three teammates find supporting positions. An intercepted pass or tackle costs a possession and resets the formation. Running out of possessions ends the round; reaching a score target early does not end it. How many you get is set by the difficulty tier: five on Relaxed, three on Standard, one on Ruthless.

- **Pass:** 12 points, or 6 when immediately returning to the previous carrier.
- **Multiplier:** raised only by receiving in the bonus zone — one step per zone up to x5, then one step per two zones to a x10 ceiling. It never decays; a turnover resets it to x1.
- **One touch:** queue while the ball travels or release within 0.35 seconds without dribbling. Each completed one-touch pass adds 5 points; every ten adds another 50 points and 2 units of Energy (Olé milestone). Holding, dribbling, or losing possession breaks the streak.
- **Triangle:** complete A → B → C → A with distinct players within 3.5 seconds (and without any player holding the ball longer than 1.2 seconds) for 35 points and 1 unit of Energy.
- **Wall pass:** bank off the boundary for 18 points. It does not earn Energy.
- **Bonus zone:** receive inside the ring for 18 points and 1 unit of Energy. It moves after a bonus or 7 seconds, then goes dark for a short gap before the next one appears.
- **Split the press:** thread a pass between two closing defenders for high bonus points and 2 units of Energy.
- **Energy (Focus & Boost):** a shared tactical meter holding up to 10 units. Focus slows the court and clock; Boost sprints the carrier. Both cost the same 4.5 units per second, so a full meter is roughly two seconds of either — Energy is banked for the moment that needs it rather than held down. Triangles, bonus-zone receptions, press splits, and Olé milestones refill it, but only on a pass made without Focus or Boost active.

The multiplier applies to every scoring event: passes, triangles, wall passes, zones, splits and one-touch bonuses alike. The possession ring warns when the carrier has held the ball too long. Light dotted lanes indicate clearer passes; coral lanes indicate interception risk.

## Controls

| Action | Keyboard / mouse | Standard gamepad |
| --- | --- | --- |
| Move | WASD / arrows; drag empty court | Left stick |
| Aim | Point or move toward teammate | Right stick; left when right is idle |
| Pass | Click teammate; 1–4; Space for suggestion | A / bottom face |
| Wall pass | B or Wall arms | X / left face sends immediately |
| Focus | Hold E; button toggles | Hold LT |
| Boost | Hold Shift or click Boost | Hold RT |
| Pause | Esc or Pause | Start; B also resumes |
| Menus | Tab, Enter/Space, mouse | D-pad/stick; A selects |

Gamepad labels use the standard browser mapping and may differ from printed controller labels. Disconnecting a controller or hiding the browser pauses an active round.

Wall defaults to an armed toggle: press it again to cancel, or press Pass or a teammate to send. Settings also offers an Instant wall-pass mode. Passing while the ball travels queues one pass from the receiver; choosing another target replaces it. Pausing clears the queue. Focus does not extend the one-touch timing window.

## Modes and progression

World Tour has six courts from Lisbon to Amsterdam. Meet the target and survive the full timer to unlock the next court.

| Stars | Requirement after surviving the round |
| --- | --- |
| ★ | Reach the clear target |
| ★★ | Reach 75% of the court's reference score (scaled to your difficulty tier) |
| ★★★ | Reach 100% of the reference score with no turnovers |

Difficulty rises from two to four defenders, base defender speed from 76 to 123 court units per second, and 90 seconds to complete each court. Targets depend on the chosen difficulty tier; on Standard they range from 4,900 (The Courtyard) to 7,000 (Total Football).

- **Free practice:** press capped at 65 units per second, unlimited recoveries, no time limit.
- **Extra Time:** one possession on Still Water, played against a countdown that starts at 30 seconds and never holds more than 60. Your score is the whole seconds you last, and the run ends when the clock hits zero or on the first mistake. Bonuses buy time back: olé +4s, zone +3s, triangle +2s, split the press +2s (bonuses on one pass add up). Wall passes and plain one-touch passes earn none. Refunds fade with the run: full value at the start, down to 40% from 3:00, so every run ends eventually. Focus slow-motion slows the clock too.
  - **Challenges:** the first appears at 8 seconds, then one every 6 seconds after the last is done or missed, each giving you 10 seconds. Split the press, play a triangle, hit the zone with another bonus on the same pass, or play five one-touch passes in a row. A completed challenge pays 8 seconds (scaled by the same fade). It never repeats the previous one.
  - **The press:** a third defender joins at 0:45, a fourth at 1:45, a fifth at 3:15, and they keep quickening after that with no ceiling.
Finished rounds grant XP on a 50-level curve that widens as it climbs; Free practice grants none.

| Tactic | Strength | Tradeoff |
| --- | --- | --- |
| Playmaker | Largest Energy reserve (10 units) | Balanced movement and passing |
| Mover | Fastest movement | Smaller reserve (6 units) and slower passes |
| Conductor | Fastest passes | Slowest movement and medium reserve (8 units) |

## Interface and offline behavior

Home offers four modes, local progress, and the six World Tour courts. Opening Home during a round pauses it. Choosing another mode or court asks before abandoning unfinished play.

The game offers remappable keyboard controls, Play view, and fullscreen.

The production build caches assets after an initial online load, so it keeps working offline. Service workers require localhost or HTTPS. Decorative effects honor reduced-motion preferences, while gameplay remains visual and real time.

With no Supabase configuration, progress is guest-only, device-local data. See [the README](../README.md#guest-saves-and-accounts) for persistence and privacy limits.
