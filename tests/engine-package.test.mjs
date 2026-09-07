import assert from "node:assert/strict";
import test from "node:test";

import * as engine from "../packages/engine/src/index.js";
import * as packageGame from "../packages/engine/src/game.js";
import * as packageProgress from "../packages/engine/src/progress.js";
import * as packageSettings from "../packages/engine/src/settings.js";
import * as packageVenues from "../packages/engine/src/venues.js";
import * as legacyGame from "../src/game.js";
import * as legacyProgress from "../src/progress.js";
import * as legacySettings from "../src/settings.js";
import * as legacyVenues from "../src/venues.js";

test("legacy modules preserve the shared engine export identities", () => {
  assert.equal(legacyGame.Game, packageGame.Game);
  assert.equal(legacyGame.COURTS, packageGame.COURTS);
  assert.equal(legacyProgress.awardMatch, packageProgress.awardMatch);
  assert.equal(legacySettings.normalizeSettings, packageSettings.normalizeSettings);
  assert.equal(legacyVenues.getVenue, packageVenues.getVenue);
  assert.equal(engine.Game, packageGame.Game);
  assert.equal(engine.freshProgress, packageProgress.freshProgress);
  assert.equal(engine.defaultSettings, packageSettings.defaultSettings);
  assert.equal(engine.VENUES, packageVenues.VENUES);
});

test("shared engine entrypoint runs without browser globals", () => {
  const game = new engine.Game(engine.COURTS[0]);
  assert.equal(game.status, "playing");
  assert.equal(engine.defaultSettings().theme, "dark");
  assert.equal(engine.freshProgress().version, 1);
  assert.ok(engine.getVenue({ mode: "practice" }).id);
});
