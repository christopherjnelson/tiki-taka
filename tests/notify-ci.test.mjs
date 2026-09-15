import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload } from "../scripts/notify-discord-ci.mjs";

const base = {
  conclusion: "success",
  repository: "owner/tiki-taka",
  repositoryUrl: "https://github.com/owner/tiki-taka",
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject: "fix: a thing",
  actor: "someone",
  event: "push",
  branch: "main",
  prNumber: "",
  runUrl: "https://github.com/owner/tiki-taka/actions/runs/1",
  finishedAt: "2026-09-15T10:00:00Z",
};

const embed = (overrides) => buildPayload({ ...base, ...overrides }).embeds[0];

test("a pass and a failure are told apart by title, colour and wording", () => {
  const passed = embed({});
  assert.match(passed.title, /✅ CI passed/);
  assert.equal(passed.color, 3066993);
  assert.match(passed.description, /green/);

  const failed = embed({ conclusion: "failure" });
  assert.match(failed.title, /❌ CI failed/);
  assert.equal(failed.color, 15158332);
  assert.match(failed.description, /red/);
});

test("a cancelled run reads as neither green nor red", () => {
  const cancelled = embed({ conclusion: "cancelled" });
  assert.match(cancelled.title, /⚪ CI cancelled/);
  assert.notEqual(cancelled.color, 3066993);
  assert.notEqual(cancelled.color, 15158332);
  assert.match(cancelled.description, /did not complete/);
});

test("a pull request run links the PR; a push names the branch", () => {
  assert.match(
    embed({ event: "pull_request", prNumber: "81", branch: "feat/x" }).description,
    /\[PR #81\]\(https:\/\/github\.com\/owner\/tiki-taka\/pull\/81\)/,
  );
  assert.match(embed({}).description, /`main`/);
});

test("only the first line of a commit message becomes the subject", () => {
  const commit = embed({ subject: "fix: the thing\n\nA long body that\nruns on." })
    .fields.find((f) => f.name === "Commit").value;
  assert.match(commit, /fix: the thing$/);
  assert.doesNotMatch(commit, /long body/);
});

test("mentions and code fences in attacker-influenced text are defused", () => {
  const payload = buildPayload({ ...base, subject: "feat: ping @everyone with `code`", branch: "@here" });
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /@everyone|@here/);
  assert.doesNotMatch(payload.embeds[0].fields[0].value.replace(/\[`[0-9a-f]+`\]/, ""), /`code`/);
});

test("an over-long subject is truncated rather than rejected by Discord", () => {
  const commit = embed({ subject: "x".repeat(500) }).fields.find((f) => f.name === "Commit").value;
  assert.ok(commit.length < 300);
  assert.match(commit, /…$/);
});

test("a malformed SHA is refused outright", () => {
  assert.throws(() => buildPayload({ ...base, sha: "not-a-sha" }), /full lowercase Git SHA/);
});
