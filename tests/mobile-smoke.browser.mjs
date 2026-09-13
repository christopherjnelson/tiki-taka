// A fast phone-layout check: geometry and overlap, nothing else.
//
// The mobile groups inside browser/interface/navigation are bolted onto full
// gameplay suites, so asserting "the court is the right shape and nothing
// covers it" costs a career run and the better part of half an hour. Every
// layout defect this branch actually hit — a control rail eating the court, a
// meter rendering at 0x0, a toast on the scoreboard, an Energy pill printed
// over a bonus zone — was visible in a bounding box within a second of the
// round starting. That is what this file checks, in one browser launch.
//
// It deliberately does NOT replay gameplay, drive input, or assert scoring.
// Those belong in the slow suites. Keep this one cheap enough to run on every
// change, or it stops being run at all — which is how the last mobile layout
// was left to rot behind a freeze flag.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { freePort } from "./free-port.mjs";
import { gotoArena, expectedCourtAspect } from "./open-arena.mjs";

const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
let server;
try {
  const response = await fetch(baseURL);
  if (!response.ok) throw new Error(String(response.status));
} catch {
  const url = new URL(baseURL);
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: url.port || "5173" },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      if ((await fetch(baseURL)).ok) break;
    } catch {}
    if (attempt === 49)
      throw new Error(`Could not start test server at ${baseURL}`);
  }
}

// Three shapes, each standing for a real failure mode: a tall phone (the
// rotated court), the narrowest phone still supported (where things collide
// first), and a landscape phone wide enough to fall inside the desktop
// breakpoint, which is where the desktop chassis used to leak through.
const VIEWPORTS = [
  { width: 390, height: 844, name: "portrait 390x844" },
  { width: 320, height: 740, name: "portrait 320x740" },
  { width: 844, height: 390, name: "landscape 844x390" },
  { width: 932, height: 430, name: "landscape 932x430" },
];

// Every readout and control a player needs mid-round. None of these may cover
// another, and none may sit over the middle of the pitch.
//
// Note what is NOT asserted: that they keep off the court entirely. Floating
// the controls and the HUD over the playing surface is the design — it is what
// won the court back the width an opaque side rail used to take. The rule is
// that they hug its edges.
const OVERLAYS = [
  ".scoreboard",
  "#energy-info",
  "#joystick",
  "#touch-pass",
  "#touch-bank",
  "#touch-shout",
  "#touch-focus",
  "#touch-boost",
];

function overlaps(a, b) {
  // A shared edge is not an overlap; require real area in common. Sub-pixel
  // layout rounding routinely leaves boxes touching by a fraction.
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 1 && h > 1;
}

let failures = 0;
const browser = await chromium.launch();
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await gotoArena(page, baseURL);
    await page.locator("#start-button").tap();
    await page.waitForFunction(
      () => !document.querySelector("#touch-pass")?.disabled,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );

    const boxes = await page.evaluate((selectors) => {
      const out = {};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out[selector] = {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      }
      return out;
    }, ["#court", ...OVERLAYS]);

    // Everything in the list has to actually be on screen. A control or a
    // readout that measures 0x0 is the failure mode that hid the Energy
    // meter for several releases, and it is invisible to an overlap check.
    for (const selector of ["#court", ...OVERLAYS]) {
      assert.ok(
        boxes[selector],
        `${viewport.name}: ${selector} is missing or has no size`,
      );
    }

    const court = boxes["#court"];
    assert.ok(
      Math.abs(court.width / court.height - expectedCourtAspect(viewport)) <
        0.01,
      `${viewport.name}: court aspect ${(court.width / court.height).toFixed(3)}, expected ${expectedCourtAspect(viewport).toFixed(3)}`,
    );

    // The court has to be worth looking at. Below roughly half the screen the
    // pitch is a stamp in a field of chrome, which is exactly the state
    // portrait was in before it was rotated (28.6%).
    const share =
      ((court.width * court.height) / (viewport.width * viewport.height)) * 100;
    assert.ok(
      share > 50,
      `${viewport.name}: court takes only ${share.toFixed(1)}% of the screen`,
    );

    for (const [selector, box] of Object.entries(boxes)) {
      assert.ok(
        box.left >= -1 &&
          box.top >= -1 &&
          box.right <= viewport.width + 1 &&
          box.bottom <= viewport.height + 1,
        `${viewport.name}: ${selector} is off screen (${JSON.stringify(box)})`,
      );
    }

    // No readout or control may cover another. This is the check that catches
    // a meter printed under a button, or a hint toast dropped on the score.
    const named = OVERLAYS.filter((s) => boxes[s]).map((s) => [s, boxes[s]]);
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        const [aName, a] = named[i];
        const [bName, b] = named[j];
        assert.ok(
          !overlaps(a, b),
          `${viewport.name}: ${aName} overlaps ${bName}`,
        );
      }
    }

    // NOT CHECKED HERE: whether a floating overlay sits somewhere that hides
    // play. It is a real failure — an Energy pill was once moved off the Wall
    // button and landed on a bonus zone, hiding a scoring opportunity — but it
    // resists a cheap geometric rule. A "keep out of the court's middle" box
    // fails honestly in both directions: the scoreboard and the action buttons
    // graze it by a few pixels at short viewports while legitimately hugging
    // an edge, and the pill that caused the bug sat near the court's bottom
    // edge, so a box loose enough to admit the first would have admitted it
    // too. Bonus zones spawn anywhere on the pitch, so no fixed rectangle
    // stands in for "where play happens".
    //
    // Tuning a threshold until this passes would buy a green check and no
    // information. It needs eyes on a screenshot instead, which is why the
    // slow suites and a look at the rendered page both still earn their keep.

    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      true,
      `${viewport.name}: the page scrolls sideways`,
    );
    assert.deepEqual(errors, [], `${viewport.name}: console errors`);
    console.log(`✓ ${viewport.name} — court ${share.toFixed(1)}% of screen`);
  } catch (error) {
    failures++;
    console.error(`✗ ${viewport.name}\n${error.message}`);
  } finally {
    await context.close();
  }
}
await browser.close();
server?.kill();
if (failures) {
  console.error(`\n${failures} phone layout check(s) failed.`);
  process.exit(1);
}
console.log("\nAll phone layout checks passed.");
