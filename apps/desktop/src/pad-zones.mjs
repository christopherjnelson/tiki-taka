// Pure helpers for zone-based d-pad/gamepad navigation on the home screen.
//
// No browser globals here on purpose: apps/desktop/src/main.js gathers each
// zone's current focusable elements from the live DOM and calls into these
// functions to decide what should be focused next, so the decision logic can
// be exercised by a plain `node --test` without a browser. Keep all DOM
// querying in the caller.
//
// A "zone" here is a plain { id, elements } pair, `elements` being that
// zone's enabled/visible focusables in DOM order at the moment of the call.
// Nothing in this module holds onto elements between calls — callers rebuild
// the zone list fresh each poll and carry any "remembered element per zone"
// state themselves.

// Left-to-right order of the home screen's zones, matching the on-screen
// three-panel grid (action | leaderboard | courts, then modes spanning the
// row below, then the top bar). Reorder this — and only this — when the
// home layout is redesigned.
export const HOME_ZONE_ORDER = ["action", "leaderboard", "courts", "modes", "topbar"];

function wrap(i, n) {
  return ((i % n) + n) % n;
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
