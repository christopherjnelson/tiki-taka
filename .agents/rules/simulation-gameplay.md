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
   - Completing a pass cycle across 3 distinct teammates awards **35 points** (scaled by flow) and **1.5 seconds of Focus**.
   - In Endless mode, triangles also grant +5 bonus seconds on the match clock.
4. **Wall Pass**:
   - Banking a pass off an arena boundary awards **18 points** and **0.5 seconds of Focus**.
5. **Bonus Zones**:
   - Receiving a pass inside the active bonus circle awards **25 points** and **1.0 second of Focus**.
   - Bonus zones move after a collection or after 12 seconds of inactivity.
6. **Splitting the Press**:
   - Threading a pass between two defenders crossing the passing segment awards points and **2.0 seconds of Focus**. Narrower gaps award higher bonuses (`SPLIT_PRESS` ladder).
7. **One-Touch Passes**:
   - Queued while ball is in flight, or executed within **0.35 seconds** of reception with **≤8 court units** of carrier movement.
   - Adds **5 flat points** per pass, and a milestone bonus of **50 points** every 10 consecutive one-touch passes.

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
