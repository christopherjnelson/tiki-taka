import test from "node:test";
import assert from "node:assert/strict";
import {
  parseManifest,
  selectCourtTracks,
  fetchManifest,
} from "../apps/desktop/src/manifest.js";

test("parseManifest reads a well-formed manifest", () => {
  const tracks = parseManifest({
    version: 1,
    tracks: [
      { file: "beach-bounce.ogg", title: "Beach Bounce", court: "home" },
      { file: "neon-biscayne.ogg", title: "Neon Biscayne", court: "home" },
    ],
  });
  assert.deepEqual(tracks, [
    { file: "beach-bounce.ogg", title: "Beach Bounce", court: "home" },
    { file: "neon-biscayne.ogg", title: "Neon Biscayne", court: "home" },
  ]);
});

test("parseManifest defaults a missing court to home", () => {
  const tracks = parseManifest({
    tracks: [{ file: "beach-bounce.ogg", title: "Beach Bounce" }],
  });
  assert.deepEqual(tracks, [
    { file: "beach-bounce.ogg", title: "Beach Bounce", court: "home" },
  ]);
});

test("parseManifest drops entries missing a file or a title", () => {
  const tracks = parseManifest({
    tracks: [
      { file: "beach-bounce.ogg", title: "Beach Bounce" },
      { file: "no-title.ogg" },
      { title: "No File" },
      { file: "", title: "Empty file" },
      { file: "blank-title.ogg", title: "   " },
      null,
      "not an object",
      42,
    ],
  });
  assert.deepEqual(tracks, [
    { file: "beach-bounce.ogg", title: "Beach Bounce", court: "home" },
  ]);
});

test("parseManifest returns an empty list for every malformed shape", () => {
  assert.deepEqual(parseManifest(null), []);
  assert.deepEqual(parseManifest(undefined), []);
  assert.deepEqual(parseManifest("not json"), []);
  assert.deepEqual(parseManifest(42), []);
  assert.deepEqual(parseManifest([]), []);
  assert.deepEqual(parseManifest({}), []);
  assert.deepEqual(parseManifest({ tracks: "beach-bounce.ogg" }), []);
  assert.deepEqual(parseManifest({ tracks: null }), []);
});

test("selectCourtTracks returns the court's own tracks when it has any", () => {
  const tracks = [
    { file: "a.ogg", title: "A", court: "home" },
    { file: "b.ogg", title: "B", court: "lisbon" },
    { file: "c.ogg", title: "C", court: "lisbon" },
  ];
  assert.deepEqual(selectCourtTracks(tracks, "lisbon"), [
    { file: "b.ogg", title: "B", court: "lisbon" },
    { file: "c.ogg", title: "C", court: "lisbon" },
  ]);
});

test("selectCourtTracks falls back to home when the court has none of its own", () => {
  const tracks = [
    { file: "a.ogg", title: "A", court: "home" },
    { file: "b.ogg", title: "B", court: "home" },
    { file: "c.ogg", title: "C", court: "lisbon" },
  ];
  assert.deepEqual(selectCourtTracks(tracks, "tokyo"), [
    { file: "a.ogg", title: "A", court: "home" },
    { file: "b.ogg", title: "B", court: "home" },
  ]);
});

test("selectCourtTracks asking for home itself just returns the home tracks", () => {
  const tracks = [
    { file: "a.ogg", title: "A", court: "home" },
    { file: "c.ogg", title: "C", court: "lisbon" },
  ];
  assert.deepEqual(selectCourtTracks(tracks, "home"), [
    { file: "a.ogg", title: "A", court: "home" },
  ]);
});

test("selectCourtTracks returns an empty list when nothing matches, even the fallback", () => {
  const tracks = [{ file: "c.ogg", title: "C", court: "lisbon" }];
  assert.deepEqual(selectCourtTracks(tracks, "tokyo"), []);
});

test("selectCourtTracks tolerates a missing or non-string court, defaulting to home", () => {
  const tracks = [{ file: "a.ogg", title: "A", court: "home" }];
  assert.deepEqual(selectCourtTracks(tracks, undefined), tracks);
  assert.deepEqual(selectCourtTracks(tracks, ""), tracks);
  assert.deepEqual(selectCourtTracks(tracks, 42), tracks);
});

test("selectCourtTracks tolerates a non-array tracks argument", () => {
  assert.deepEqual(selectCourtTracks(null, "home"), []);
  assert.deepEqual(selectCourtTracks(undefined, "home"), []);
});

// fetchManifest talks to the network, so only its failure modes are worth
// exercising here without a real server: a missing global fetch (an
// unreachable/nonexistent endpoint in practice), a non-OK response, and a
// response whose body is not valid JSON. Every one must resolve to an empty
// array rather than reject - the "no manifest, no crash" contract.
test("fetchManifest resolves to an empty array when fetch itself rejects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    assert.deepEqual(await fetchManifest("./audio/manifest.json"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchManifest resolves to an empty array on a non-OK response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  try {
    assert.deepEqual(await fetchManifest("./audio/manifest.json"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchManifest resolves to an empty array when the body is not valid JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });
  try {
    assert.deepEqual(await fetchManifest("./audio/manifest.json"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchManifest resolves the real tracks on a well-formed response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: 1,
      tracks: [{ file: "beach-bounce.ogg", title: "Beach Bounce", court: "home" }],
    }),
  });
  try {
    assert.deepEqual(await fetchManifest("./audio/manifest.json"), [
      { file: "beach-bounce.ogg", title: "Beach Bounce", court: "home" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
