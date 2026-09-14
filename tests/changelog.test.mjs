import test from "node:test";
import assert from "node:assert/strict";
import { parseChangelog } from "../scripts/changelog.mjs";

const SAMPLE = `# Changelog

Front matter before the first entry heading must be ignored entirely.

## 0.4.2 - 2026-09-14

Fixes found by playing 0.4.1.

### Your progress is safe from older clients

One account lost every unlocked court and star.
It kept going across this soft line break.

### Also

- OLE leads the leaderboard's bonus columns, grouping the yellow columns
  together.
- The Daily circuit is gone.

## 0.4.1 - 2026-09-14

### Progression rebuilt

Levels used to arrive about once a round with **bold** and \`code\` markup.
`;

test("parses entries newest-first in file order, skipping front matter", () => {
  const entries = parseChangelog(SAMPLE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, "0.4.2");
  assert.equal(entries[0].date, "2026-09-14");
  assert.equal(entries[1].version, "0.4.1");
});

test("an entry's intro paragraph before any ### heading becomes its summary", () => {
  const [entry] = parseChangelog(SAMPLE);
  assert.deepEqual(entry.summary, ["Fixes found by playing 0.4.1."]);
});

test("### headings open sections, and soft-wrapped lines join into one paragraph", () => {
  const [entry] = parseChangelog(SAMPLE);
  assert.equal(entry.sections.length, 2);
  assert.equal(entry.sections[0].heading, "Your progress is safe from older clients");
  assert.deepEqual(entry.sections[0].paragraphs, [
    "One account lost every unlocked court and star. It kept going across this soft line break.",
  ]);
});

test("each bullet becomes its own paragraph, continuation lines folded in", () => {
  const [entry] = parseChangelog(SAMPLE);
  assert.deepEqual(entry.sections[1].paragraphs, [
    "OLE leads the leaderboard's bonus columns, grouping the yellow columns together.",
    "The Daily circuit is gone.",
  ]);
});

test("inline markdown emphasis and code marks are stripped to plain text", () => {
  const [, older] = parseChangelog(SAMPLE);
  assert.deepEqual(older.sections[0].paragraphs, [
    "Levels used to arrive about once a round with bold and code markup.",
  ]);
});

test("empty or malformed input parses to no entries rather than throwing", () => {
  assert.deepEqual(parseChangelog(""), []);
  assert.deepEqual(parseChangelog(undefined), []);
  assert.deepEqual(parseChangelog("just some prose, no headings at all"), []);
});
