// A small, deliberately dumb Markdown-subset parser for CHANGELOG.md. It only
// understands the shape that file is written in - `## <version> - <date>`
// entries, each holding an optional intro paragraph and `### <heading>`
// sections - because that shape is the whole contract: CHANGELOG.md changes
// only as part of a release's version bump (see CLAUDE.md), never for an
// ordinary PR, so "updates on releases" is structural rather than a promise
// this code has to keep on its own.
//
// Pure and dependency-free on purpose: vite.desktop.config.js calls this at
// build/dev time (Node, via fs.readFileSync) and compiles the result into
// the client bundle the same way it already does for buildIdentity, so no
// network fetch ever happens for this at runtime - the app must work offline
// behind the service worker. tests/changelog.test.mjs exercises the parsing
// directly with an inline Markdown string, no file I/O.
const ENTRY_HEADING = /^##\s+(\S+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;

function normalizeText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns entries in the order they appear in the file - CHANGELOG.md is
// written newest-first, and nothing here re-sorts it, so authorship order is
// display order.
export function parseChangelog(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const entries = [];
  let entry = null;
  let section = null;
  let paragraph = [];

  const target = () => (section ? section.paragraphs : entry?.summary);
  const flush = () => {
    if (!entry || !paragraph.length) {
      paragraph = [];
      return;
    }
    const text = normalizeText(paragraph.join(" "));
    if (text) target().push(text);
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const entryMatch = ENTRY_HEADING.exec(line);
    if (entryMatch) {
      flush();
      entry = {
        version: entryMatch[1],
        date: entryMatch[2],
        summary: [],
        sections: [],
      };
      section = null;
      entries.push(entry);
      continue;
    }
    // Anything before the file's first `## <version> - <date>` heading (the
    // explanatory note at the top of CHANGELOG.md) is front matter, not an
    // entry, and is silently ignored.
    if (!entry) continue;
    const sectionMatch = SECTION_HEADING.exec(line);
    if (sectionMatch) {
      flush();
      section = { heading: normalizeText(sectionMatch[1]), paragraphs: [] };
      entry.sections.push(section);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const bulletMatch = BULLET.exec(line);
    if (bulletMatch) {
      flush();
      paragraph.push(bulletMatch[1]);
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return entries;
}
