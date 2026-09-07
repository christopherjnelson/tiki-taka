# Gameplay guide

## Scoring

Move the ball carrier while three teammates find supporting positions. An intercepted pass or tackle costs a life and resets the formation. The third turnover ends the round; reaching a score target early does not end it.

- **Pass:** 12 points, or 6 when immediately returning to the previous carrier.
- **Flow:** rises every four consecutive passes, up to x5, and resets after a turnover.
- **One touch:** queue while the ball travels or release within 0.35 seconds without dribbling. Each completed one-touch pass adds 5 points; every ten adds another 50. Holding, dribbling, or losing possession breaks the streak.
- **Triangle:** complete A → B → C → A with distinct players for 35 points and 1.5 seconds of Focus.
- **Wall pass:** bank off the boundary for 18 points and 0.5 seconds of Focus.
- **Bonus zone:** receive inside the orange ring for 25 points and 1 second of Focus. It moves after a bonus or 12 seconds.
- **Focus:** slows the court and clock. Successful normal-speed triangles, wall passes, and bonus-zone receptions fill its reserve. Rewards cannot be earned while Focus is active.

The flow multiplier applies to pass, triangle, wall, and zone points. One-touch bonuses are flat additions. The possession ring warns when the carrier has held the ball too long. Light dotted lanes indicate clearer passes; coral lanes indicate interception risk.

## Controls

| Action | Keyboard / mouse | Touch | Standard gamepad |
| --- | --- | --- | --- |
| Move | WASD / arrows; drag empty court | Onscreen stick | Left stick |
| Aim | Point or move toward teammate | Move toward teammate | Right stick; left when right is idle |
| Pass | Click teammate; 1–4; Space for suggestion | Tap teammate or Pass | A / bottom face |
| Wall pass | Hold Shift; B or Wall arms | Wall arms; Pass sends | X / left face sends immediately |
| Focus | Hold E; button toggles | Hold Focus | Hold LT |
| Pause | Esc or Pause | Pause / Resume | Start; B also resumes |
| Menus | Tab, Enter/Space, mouse | Tap | D-pad/stick; A selects |

Gamepad labels use the standard browser mapping and may differ from printed controller labels. Disconnecting a controller or hiding the browser pauses an active round.

On mobile, Wall defaults to an armed toggle. Tap it again to cancel, or press Pass or a teammate to send. Settings also offers an Instant wall-pass mode. Passing while the ball travels queues one pass from the receiver; choosing another target replaces it. Pausing clears the queue. Focus does not extend the one-touch timing window.

## Modes and progression

World Tour has six courts from Lisbon to Amsterdam. Meet the target and survive the full timer to unlock the next court.

| Stars | Requirement after surviving the round |
| --- | --- |
| ★ | Reach the target |
| ★★ | Reach 1.5x the target |
| ★★★ | Reach 2.2x the target with no turnovers |

Difficulty rises from two to four defenders, base defender speed from 76 to 123 court units per second, targets from 600 to 2,400, and timers from 75 to 90 seconds.

- **Free practice:** gentler press, unlimited recoveries, 90 seconds.
- **Endless:** starts at 60 seconds; triangles add five seconds, the press intensifies, and three turnovers end the run.
- **Daily Circuit:** the UTC date generates the challenge. Records remain local; there is no online leaderboard.

Finished rounds grant XP, with a new level and rank title every 300 XP.

| Tactic | Strength | Tradeoff |
| --- | --- | --- |
| Playmaker | Largest Focus reserve | Balanced movement and passing |
| Mover | Fastest movement | Smaller reserve and slower passes |
| Conductor | Fastest passes | Slowest movement and medium reserve |

## Interface and offline behavior

Home offers four modes, local progress, and the six World Tour courts. Opening Home during a round pauses it. Choosing another mode or court asks before abandoning unfinished play.

Desktop offers remappable keyboard controls, light and dark themes, Play view, and fullscreen. Mobile uses Home, Play, Profile, and Settings navigation; landscape puts movement on the left and actions on the right. Rotating pauses play and releases held controls.

The production desktop build caches assets after an initial online load. Service workers require localhost or HTTPS. The mobile browser preview does not install an offline worker; the Capacitor app bundles everything needed for offline play. Decorative effects honor reduced-motion preferences, while gameplay remains visual and real time.

Profiles and progress are local demo data. See [the README](../README.md#local-demo-profiles-and-saves) for persistence and privacy limits.
