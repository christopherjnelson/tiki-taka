// Pure helpers for zone-based d-pad/gamepad navigation on the home screen.
//
// No browser globals here on purpose: apps/desktop/src/main.js gathers each
// zone's current focusable elements from the live DOM and calls into these
// functions to decide what should be focused next, so the decision logic can
// be exercised by a plain `node --test` without a browser. Keep all DOM
// querying in the caller.
//
// A "zone" here is a plain { id, axis, elements } object: `elements` is that
// zone's enabled/visible focusables in DOM order at the moment of the call,
// `axis` is "row" or "column" (from the container's data-pad-axis attribute,
// "column" if absent) and says which physical direction moves WITHIN the
// zone — the other direction always moves to a neighbouring zone instead.
// Nothing in this module holds onto elements between calls — callers rebuild
// the zone list fresh each poll and carry any "remembered element per zone"
// state themselves.

// Cycle order of the home screen's zones. It is used for BOTH axes — a
// forward move (down or right) advances through it, a backward move (up or
// left) reverses it — rather than keeping one order for rows and another for
// columns. The zones already lay out as one loop on screen (action |
// leaderboard | courts across the top, modes spanning the row below, the top
// bar above everything as the wrap point), so a second, axis-specific order
// would encode the same adjacency twice for no gain: right out of courts and
// down out of courts both land somewhere that reads as "the next thing",
// because there is nothing further right (courts is the last column) and the
// modes row sits directly under it. Reorder this — and only this — when the
// home layout is redesigned.
export const HOME_ZONE_ORDER = ["action", "leaderboard", "courts", "modes", "topbar"];

function wrap(i, n) {
  return ((i % n) + n) % n;
}

// Whether a zone's own internal axis is vertical (up/down moves within it,
// left/right leaves it) as opposed to horizontal (the reverse). A zone with
// fewer than two focusables has no internal axis at all — there is nothing
// to move to within it — so BOTH directions must leave it; returning null
// here (rather than defaulting to either true or false) is what stops a
// single-control zone like the action zone from swallowing the first press
// in a direction that would otherwise just wrap the one element onto itself.
export function zoneAxisIsVertical(zone) {
  if (!zone || zone.elements.length < 2) return null;
  return zone.axis !== "row";
}

// Decide what a d-pad press should do to the zone currently holding focus.
// `vertical`/`horizontal` are +1/-1/0 and are expected to be mutually
// exclusive (pollGamepad reads up/down and left/right as separate axes and
// only one fires per poll). Returns `{ within: dir }` when the press should
// move focus inside the zone along its own axis, `{ between: dir }` when it
// should hand off to a neighbouring zone instead, or null when there is
// nothing to do this poll.
export function resolveHomeMove(zone, { vertical = 0, horizontal = 0 } = {}) {
  const axisVertical = zoneAxisIsVertical(zone);
  if (vertical) return axisVertical === true ? { within: vertical } : { between: vertical };
  if (horizontal) return axisVertical === false ? { within: horizontal } : { between: horizontal };
  return null;
}

// Move focus within the zone that currently holds it. `elements` is that
// zone's focusable list, `current` the element focus is presently on (it
// need not be a member of `elements`), `dir` is +1 (next) or -1 (previous).
// Wraps at both ends. Returns the element to focus, or null if the zone has
// nothing focusable.
export function withinZone(elements, current, dir) {
  if (!elements.length) return null;
  const idx = elements.indexOf(current);
  if (idx === -1) return elements[0];
  return elements[wrap(idx + dir, elements.length)];
}

// Pick which zone to move to next, given the full ordered zone list, the id
// of the zone focus is presently in, and a horizontal direction (+1 right,
// -1 left). Zones with no focusable elements are skipped, wrapping around
// the whole order — a zone whose buttons are all disabled never traps the
// cursor. Returns null only if no zone anywhere has a focusable element.
export function nextZone(zones, currentZoneId, dir) {
  const n = zones.length;
  if (!n) return null;
  let idx = zones.findIndex((zone) => zone.id === currentZoneId);
  if (idx === -1) idx = 0;
  for (let step = 1; step <= n; step++) {
    const zone = zones[wrap(idx + dir * step, n)];
    if (zone.elements.length) return zone;
  }
  return null;
}

// Which element to land on when entering (or re-entering) a zone: the
// remembered element if it is still one of the zone's current focusables,
// otherwise the zone's first element. `remembered` is whatever this zone's
// memory currently holds (may be undefined/null, or stale after a re-render).
export function restoreInZone(zone, remembered) {
  if (!zone || !zone.elements.length) return null;
  if (remembered && zone.elements.includes(remembered)) return remembered;
  return zone.elements[0];
}

// Which zone (by id) an element currently belongs to, given the same zones
// list used above. Returns null if the element is not one of any zone's
// current focusables (nothing focused yet, or focus has drifted outside
// every tagged zone).
export function zoneContaining(zones, element) {
  if (!element) return null;
  const zone = zones.find((z) => z.elements.includes(element));
  return zone ? zone.id : null;
}
