// Posts every finished CI run to a Discord channel.
//
// Built to be readable at a glance in a phone notification: the first line
// says pass or fail and on what, and everything needed to chase a failure
// (the commit, who pushed it, the run) is one tap away. It never throws on a
// missing webhook - a pull request from a fork gets no secrets, and a CI run
// must not be reported as failing because its own notifier could not reach
// Discord.
const SHA = /^[0-9a-f]{40}$/;
const HOSTS = ["discord.com", "canary.discord.com", "ptb.discord.com"];
// Same defusing as the release notifiers: commit subjects and branch names
// are attacker-influenced text heading for a channel, so backticks cannot
// break out of code spans and an @ cannot become a mention. allowed_mentions
// below is the real guard; this keeps the text from *looking* like a ping.
const clean = (text) =>
  String(text ?? "")
    .replaceAll("`", "ˋ")
    .replaceAll("@", "＠")
    .trim();
const truncate = (text, limit) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
// A push event carries the whole commit message; only its first line is a
// subject. A pull request title is already one line and passes through.
const firstLine = (text) => String(text ?? "").split("\n", 1)[0];

export function buildPayload({
  conclusion,
  repository,
  repositoryUrl,
  sha,
  subject,
  actor,
  event,
  branch,
  prNumber,
  runUrl,
  finishedAt,
}) {
  if (!SHA.test(sha)) throw new Error("SHA must be a full lowercase Git SHA");
  const passed = conclusion === "success";
  // Anything that is not a pass and not an outright failure (cancelled, a
  // run that timed out) reads as neither - reporting it green would be a
  // lie and reporting it red would send people chasing a bug that is not
  // there.
  const indeterminate = !passed && conclusion !== "failure";
  const short = sha.slice(0, 7);
  const where = prNumber
    ? `[PR #${prNumber}](${repositoryUrl}/pull/${prNumber})`
    : `\`${clean(branch) || "unknown"}\``;
  const fields = [
    {
      name: "Commit",
      value: `[\`${short}\`](${repositoryUrl}/commit/${sha}) ${truncate(clean(firstLine(subject)) || "(no subject)", 200)}`,
      inline: false,
    },
    {
      name: "Triggered by",
      value: `${clean(actor) || "unknown"} · \`${clean(event) || "unknown"}\``,
      inline: true,
    },
    { name: "Run", value: `[View logs](${runUrl})`, inline: true },
  ];
  return {
    username: "Tiki Taka CI",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${passed ? "✅" : indeterminate ? "⚪" : "❌"} CI ${indeterminate ? clean(conclusion) || "did not finish" : passed ? "passed" : "failed"} on ${clean(repository)}`,
        url: runUrl,
        description: passed
          ? `All required suites are green on ${where}.`
          : indeterminate
            ? `The run on ${where} did not complete.`
            : `Something is red on ${where}. The logs say which suite.`,
        color: passed ? 3066993 : indeterminate ? 9807270 : 15158332,
        fields,
        timestamp: new Date(finishedAt || Date.now()).toISOString(),
      },
    ],
  };
}

async function main() {
  const raw = process.env.DISCORD_CI_WEBHOOK_URL || "";
  if (!raw) {
    // Expected on fork pull requests, which are not given secrets.
    console.log("No DISCORD_CI_WEBHOOK_URL configured; skipping CI notification.");
    return;
  }
  let webhook;
  try {
    webhook = new URL(raw);
  } catch {
    throw new Error("DISCORD_CI_WEBHOOK_URL is not a valid URL");
  }
  if (
    webhook.protocol !== "https:" ||
    !HOSTS.includes(webhook.hostname) ||
    !webhook.pathname.startsWith("/api/webhooks/")
  )
    throw new Error("Webhook must be an official Discord HTTPS webhook URL");
  webhook.searchParams.set("wait", "true");
  const payload = buildPayload({
    conclusion: process.env.CI_CONCLUSION || "",
    repository: process.env.REPOSITORY || "",
    repositoryUrl: process.env.REPOSITORY_URL || "",
    sha: process.env.CI_SHA || "",
    subject: process.env.CI_SUBJECT || "",
    actor: process.env.CI_ACTOR || "",
    event: process.env.CI_EVENT || "",
    branch: process.env.CI_BRANCH || "",
    prNumber: process.env.CI_PR_NUMBER || "",
    runUrl: process.env.RUN_URL || "",
    finishedAt: process.env.CI_FINISHED_AT || "",
  });
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error(`Discord webhook returned HTTP ${response.status}`);
  console.log(`CI notification sent (${process.env.CI_CONCLUSION}).`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  await main();
