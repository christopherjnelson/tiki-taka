# Simulation & Gameplay Mechanics Rules

This document outlines the core physics, scoring, timing, and deterministic simulation principles of the Tiki Taka game engine (`packages/engine/src/game.js`).

---

## Pitch Geometry and Coordinate System

- **Dimensions**: `WIDTH = 1000`, `HEIGHT = 620` court units.
- **Boundaries**: `LIMITS = { left: 50, right: 950, top: 50, bottom: 570 }`.
- Players and the ball are clamped within these boundaries.
- Wall passes bank against these boundary limits using `bankPoint(from, to, limits)`.

---

## Determinism & Seeded PRNG

- **PRNG**: `xorshift128+` implementation initialized with an integer seed.
- **Reproducibility**: When initialized with the same seed, calling `update(dt, input)` with identical input arrays must yield bit-identical player/ball positions and match events.
- **Seeded Daily Circuit**: `dailyConfig(date)` derives a stable challenge configuration based on the UTC day.

---

## Core Scoring Mechanics

1. **Pass Points**:
   - Standard pass: **12 points**.
   - Immediate back-pass (return to the previous carrier): **6 points**.
2. **Flow Multiplier**:
   - Increments by +1 every **4 consecutive passes** (up to a maximum of **x5**).
   - Multiplies pass points, triangle bonuses, wall play, and zone bonuses.
   - Resets to x1 immediately on a turnover.
3. **Triangles (A → B → C → A)**:
   - Completing a pass cycle across 3 distinct teammates within **3.5 seconds** (and without any player holding the ball longer than **1.2 seconds**) awards **35 points** (scaled by flow) and **1.5 seconds of Focus**.
   - Endless has no clock to extend, and pays no points at all: triangles there pay Energy only (see **Endless** below).
4. **Wall Pass**:
   - Banking a pass off an arena boundary awards **18 points** (scaled by flow). It does not award Focus.
5. **Bonus Zones**:
   - Receiving a pass inside the active bonus circle awards **25 points** and **1.0 second of Focus**.
   - Bonus zones move after a collection or after 12 seconds of inactivity.
6. **Splitting the Press**:
   - Threading a pass between two defenders crossing the passing segment awards points and **2.0 seconds of Focus**. Narrower gaps award higher bonuses (`SPLIT_PRESS` ladder).
7. **One-Touch Passes**:
   - Queued while ball is in flight, or executed within **0.35 seconds** of reception with **≤8 court units** of carrier movement.
   - Adds **5 flat points** per pass, and an Olé milestone bonus of **50 points** and **2.0 seconds of Focus** every 10 consecutive one-touch passes.

---

## Focus & Boost Mechanics

- **Focus**: Slows match clock, player movement, and ball speed to create passing lanes. Drains real-time seconds while active.
- **Boost**: Allows the ball carrier to sprint at **1.75x speed** while consuming Focus reserve at normal game speed.
- **Rule**: Skill pass bonuses (triangles, wall passes, splits, zones) cannot generate new Focus while Focus is actively engaged.

---

## Tactics Configuration

Three tactics provide different tradeoffs:
- **`balanced` (Playmaker)**: 155 move speed, 690 ball speed, 5s focus reserve.
- **`runner` (Mover)**: 195 move speed, 640 ball speed, 3s focus reserve.
- **`maestro` (Conductor)**: 135 move speed, 840 ball speed, 4s focus reserve.

---

## Endless

Endless is the survival mode, and it is scored on nothing but time:

- The clock **counts up** from zero and never runs out. The score is the
  whole seconds survived, which is what the leaderboard and the personal
  best both hold.
- **No points.** Every bonus above still fires, still feeds the streaks and
  still pays Energy, but adds no score - so the popups carry a name and a
  colour and no number.
- **One possession.** The first turnover ends the run.
- **Its own court**: Still Water (`ENDLESS_COURT` in game.js, venue `still-water`), which is deliberately not a member of `COURTS` - it has no target, no stars and no place in the circuit.
- **One difficulty**, turned by the clock rather than a tier: two defenders
  at kickoff, three at 0:45, four at 1:45, five at 3:15, and a press speed
  that rises continuously with no ceiling (`ENDLESS_DEFENDER_STEPS` and
  `ENDLESS_PRESS` in `packages/engine/src/game.js`). The speed ramp is
  deliberately uncapped: a cap would let a good enough run last forever.
