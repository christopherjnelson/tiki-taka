---
name: tiki-taka-engine-dev
description: >-
  Use this skill when modifying or implementing game mechanics, physics, scoring rules,
  AI movement, tactics, or deterministic simulation in packages/engine.
---

# Game Engine Development Runbook

Follow these procedures when modifying game rules, mechanics, collision, or progression in `packages/engine/`.

---

## 1. Golden Rules for Engine Code

1. **Strictly Headless**: Never import or reference browser globals (`window`, `document`, `navigator`, `localStorage`, `AudioContext`).
2. **Pure Determinism**: Match simulation must be 100% reproducible for identical input sequences and seeds.
3. **Discrete Steps**: All physics and movement must scale with `dt` (delta time) and maintain stable behavior regardless of framerate spikes.

---

## 2. Typical Development Workflows

### Modifying Tactics & Player Attributes
- Location: `packages/engine/src/game.js` (`TACTICS` object).
- Attributes: `speed` (carrier speed), `ballSpeed` (pass velocity), `focus` (maximum focus seconds).
- Validation: Ensure `tactics` capacities and fallback logic pass `tests/game.test.mjs`.

### Modifying Scoring or Bonus Multipliers
- Location: `packages/engine/src/game.js` (`FOCUS_REWARDS`, `BONUS_LABELS`, `ONE_TOUCH`, `SPLIT_PRESS`).
- Pass points: 12 standard, 6 back-pass.
- Flow multiplier increments every 4 passes, up to 5x.
- Remember: Skill passes completed while Focus is active keep bonus points but **do not add to the Focus reserve**.

### Adding or Tuning Court Venues
- Locations: `packages/engine/src/venues.js` (`VENUES` array) and `packages/engine/src/game.js` (`COURTS` array).
- Each court defines `target` score, round `time` in seconds, and number of press defenders.

---

## 3. Verification & Regression Testing

After editing engine code:
1. Run engine-specific unit tests:
   ```sh
   node --test tests/game.test.mjs
   node --test tests/engine-package.test.mjs
   ```
2. Verify full unit test suite:
   ```sh
   npm test
   ```
3. Verify match loop integration:
   ```sh
   npm run test:browser
   ```
