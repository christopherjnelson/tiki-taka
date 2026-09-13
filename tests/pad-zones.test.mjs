import test from "node:test";
import assert from "node:assert/strict";
import {
  HOME_ZONE_ORDER,
  withinZone,
  nextZone,
  restoreInZone,
  zoneContaining,
} from "../apps/desktop/src/pad-zones.mjs";

// Fake "elements" are just plain objects — pad-zones.mjs never touches the
// DOM, it only ever indexOf/includes them, so any distinct values work.
const el = (name) => ({ name });

test("HOME_ZONE_ORDER is the expected left-to-right cycle", () => {
  assert.deepEqual(HOME_ZONE_ORDER, [
    "action",
    "leaderboard",
    "courts",
    "modes",
    "topbar",
  ]);
});

test("withinZone moves forward and wraps at the end", () => {
  const [a, b, c] = [el("a"), el("b"), el("c")];
  assert.equal(withinZone([a, b, c], a, 1), b);
  assert.equal(withinZone([a, b, c], b, 1), c);
  assert.equal(withinZone([a, b, c], c, 1), a);
});

test("withinZone moves backward and wraps at the start", () => {
  const [a, b, c] = [el("a"), el("b"), el("c")];
  assert.equal(withinZone([a, b, c], a, -1), c);
  assert.equal(withinZone([a, b, c], c, -1), b);
});

test("withinZone falls back to the first element when current isn't in the zone", () => {
  const [a, b] = [el("a"), el("b")];
  assert.equal(withinZone([a, b], el("stranger"), 1), a);
  assert.equal(withinZone([a, b], null, -1), a);
});

test("withinZone returns null for an empty zone", () => {
  assert.equal(withinZone([], el("a"), 1), null);
});

test("nextZone walks the order in each direction", () => {
  const zones = [
    { id: "action", elements: [el("play")] },
    { id: "leaderboard", elements: [el("tab")] },
    { id: "courts", elements: [el("court")] },
  ];
  assert.equal(nextZone(zones, "action", 1).id, "leaderboard");
  assert.equal(nextZone(zones, "leaderboard", 1).id, "courts");
  assert.equal(nextZone(zones, "courts", 1).id, "action", "wraps forward");
  assert.equal(nextZone(zones, "action", -1).id, "courts", "wraps backward");
});

test("nextZone skips zones with no focusable elements", () => {
  const zones = [
    { id: "action", elements: [el("play")] },
    { id: "leaderboard", elements: [] }, // e.g. every tab currently disabled
    { id: "courts", elements: [el("court")] },
  ];
  assert.equal(
    nextZone(zones, "action", 1).id,
    "courts",
    "empty leaderboard zone is skipped, not landed on",
  );
  assert.equal(
    nextZone(zones, "courts", -1).id,
    "action",
    "skipped going the other way too",
  );
});

test("nextZone returns null when no zone has anything focusable", () => {
  const zones = [
    { id: "action", elements: [] },
    { id: "leaderboard", elements: [] },
  ];
  assert.equal(nextZone(zones, "action", 1), null);
});

test("nextZone treats an unknown current zone as the first zone", () => {
  const zones = [
    { id: "action", elements: [el("play")] },
    { id: "leaderboard", elements: [el("tab")] },
  ];
  assert.equal(nextZone(zones, "does-not-exist", 1).id, "leaderboard");
});

test("restoreInZone lands on the remembered element when it is still present", () => {
  const [a, b] = [el("a"), el("b")];
  const zone = { id: "modes", elements: [a, b] };
  assert.equal(restoreInZone(zone, b), b);
});

test("restoreInZone falls back to the first element when nothing is remembered, or the remembered element is gone", () => {
  const [a, b] = [el("a"), el("b")];
  const zone = { id: "modes", elements: [a, b] };
  assert.equal(restoreInZone(zone, undefined), a);
  assert.equal(restoreInZone(zone, el("stale")), a);
});

test("restoreInZone returns null for an empty or missing zone", () => {
  assert.equal(restoreInZone({ id: "modes", elements: [] }, el("a")), null);
  assert.equal(restoreInZone(null, el("a")), null);
});

test("zoneContaining finds the zone owning an element", () => {
  const [a, b] = [el("a"), el("b")];
  const zones = [
    { id: "action", elements: [a] },
    { id: "courts", elements: [b] },
  ];
  assert.equal(zoneContaining(zones, a), "action");
  assert.equal(zoneContaining(zones, b), "courts");
});

test("zoneContaining returns null when the element is in no zone, or is nullish", () => {
  const zones = [{ id: "action", elements: [el("a")] }];
  assert.equal(zoneContaining(zones, el("stranger")), null);
  assert.equal(zoneContaining(zones, null), null);
  assert.equal(zoneContaining(zones, undefined), null);
});
