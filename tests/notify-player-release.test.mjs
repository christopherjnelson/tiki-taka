import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload } from "../scripts/notify-discord-player-release.mjs";

const CHANGELOG = `# Changelog

## 0.9.1 - 2026-10-02

### A shorter round

Rounds are a minute now.

## 0.9.0 - 2026-10-01

Ask @everyone about it.

### New courts

Two more places to play.
`;

const base = {
  tag: "v0.9.1",
  changelog: CHANGELOG,
  releaseUrl: "https://example.test/releases/v0.9.1",
  productionUrl: "https://example.test",
  deployedAt: "2026-10-02T10:00:00Z",
};

test("the announcement is the changelog entry for that exact version", () => {
  const { embeds } = buildPayload(base);
  assert.equal(embeds[0].title, "⚽ Tiki Taka v0.9.1");
  assert.match(embeds[0].description, /### A shorter round/);
  assert.match(embeds[0].description, /Rounds are a minute now\./);
  // The previous release's text must not leak into this one's announcement.
  assert.doesNotMatch(embeds[0].description, /Two more places to play/);
});

test("it links players to the game and to the full notes", () => {
  const { embeds } = buildPayload(base);
  assert.match(embeds[0].description, /\[Play now\]\(https:\/\/example\.test\)/);
  assert.match(embeds[0].description, /\[Full notes\]\(https:\/\/example\.test\/releases\/v0\.9\.1\)/);
});

test("mentions in a changelog entry cannot ping a public channel", () => {
  const { allowed_mentions, embeds } = buildPayload({ ...base, tag: "v0.9.0" });
  // Belt: Discord is told to parse no mentions at all.
  assert.deepEqual(allowed_mentions, { parse: [] });
  // Braces: the text itself no longer reads as a mention either, so the
  // message says what it looks like it says.
  assert.doesNotMatch(embeds[0].description, /@everyone/);
  assert.match(embeds[0].description, /Ask ＠everyone about it\./);
});

test("a release with no changelog entry fails loudly instead of posting nothing", () => {
  assert.throws(
    () => buildPayload({ ...base, tag: "v9.9.9" }),
    /no entry for 9\.9\.9/,
    "a missing entry is the exact mistake CLAUDE.md's release rule exists to prevent",
  );
});

test("a malformed tag is rejected before anything is sent", () => {
  assert.throws(() => buildPayload({ ...base, tag: "0.9.1" }), /Invalid release tag/);
  assert.throws(() => buildPayload({ ...base, tag: "v0.9" }), /Invalid release tag/);
});

test("a very long entry is cut on a paragraph boundary and says there is more", () => {
  const long = `# Changelog\n\n## 1.0.0 - 2026-10-03\n\n${Array.from(
    { length: 60 },
    (_, index) => `Paragraph number ${index} padded out with enough words to matter here.`,
  ).join("\n\n")}\n`;
  const { embeds } = buildPayload({ ...base, tag: "v1.0.0", changelog: long });
  assert.ok(embeds[0].description.length <= 4096, "Discord rejects a description over 4096 characters");
  assert.match(embeds[0].description, /…and more in the full notes\./);
  assert.doesNotMatch(embeds[0].description, /padded out with enough words to matter here\.\s*…and more/);
});
