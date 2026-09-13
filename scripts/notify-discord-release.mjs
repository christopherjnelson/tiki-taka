import { execFileSync } from "node:child_process";
const SEMVER = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const clean = (text) => text.replaceAll("`", "ˋ").replaceAll("@", "＠").trim();
function category(subject) {
  const type = subject.match(/^([a-z]+)(?:\([^)]*\))?!?:/i)?.[1]?.toLowerCase();
  if (type === "feat") return "Features";
  if (type === "fix") return "Fixes";
  if (type === "perf") return "Performance";
  if (["docs", "test", "build", "ci", "refactor", "style", "chore"].includes(type)) return "Engineering";
  return "Other changes";
}
export function buildPayload({ tag, sha, releaseUrl, runUrl, repositoryUrl, productionUrl, deployedAt }) {
  if (!SEMVER.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  if (!SHA.test(sha)) throw new Error("RELEASE_SHA must be a full lowercase Git SHA");
  const tags = git("tag", "--merged", `${tag}^{commit}`, "--sort=-version:refname").split("\n").filter((value) => SEMVER.test(value) && value !== tag);
  const previous = tags[0] || null;
  const range = previous ? `${previous}..${tag}` : tag;
  const rows = git("log", "--no-merges", "--format=%H%x1f%s", range).split("\n").filter(Boolean).map((row) => {
    const [commit, ...parts] = row.split("\x1f");
    return { commit, subject: clean(parts.join("\x1f")) };
  });
  const compareUrl = previous ? `${repositoryUrl}/compare/${previous}...${tag}` : `${repositoryUrl}/commits/${tag}`;
  const groups = new Map();
  for (const row of rows) {
    const name = category(row.subject);
    const bullet = `• [\`${row.commit.slice(0, 7)}\`](${repositoryUrl}/commit/${row.commit}) ${row.subject}`;
    groups.set(name, [...(groups.get(name) || []), bullet]);
  }
  const fields = [{ name: "Deployment", value: `**Environment:** Production\n**Commit:** [\`${sha.slice(0, 12)}\`](${repositoryUrl}/commit/${sha})\n**Workflow:** [View run](${runUrl})`, inline: false }];
  let used = 300 + fields[0].value.length;
  let included = 0;
  for (const [name, bullets] of groups) {
    const accepted = [];
    for (const bullet of bullets) {
      if (accepted.join("\n").length + bullet.length + 1 > 1024 || used + name.length + bullet.length + 1 > 5500) break;
      accepted.push(bullet); used += bullet.length + 1; included += 1;
    }
    if (accepted.length) { fields.push({ name, value: accepted.join("\n"), inline: false }); used += name.length; }
  }
  const omitted = rows.length - included;
  fields.push({ name: `All changes (${rows.length} commits)`, value: `[Compare ${previous || "repository start"} → ${tag}](${compareUrl})${omitted ? ` · ${omitted} not shown above` : ""}`, inline: false });
  return { username: "Tiki Taka Releases", allowed_mentions: { parse: [] }, embeds: [{ title: `⚽ Tiki Taka ${tag} deployed`, url: releaseUrl, description: `The verified release is now live at [${productionUrl}](${productionUrl}).`, color: 3066993, fields, footer: { text: `Previous release: ${previous || "none"}` }, timestamp: new Date(deployedAt).toISOString() }] };
}
async function main() {
  let webhook;
  try { webhook = new URL(process.env.DISCORD_DEPLOY_WEBHOOK_URL || ""); } catch { throw new Error("DISCORD_DEPLOY_WEBHOOK_URL is missing or invalid"); }
  if (webhook.protocol !== "https:" || !["discord.com", "canary.discord.com", "ptb.discord.com"].includes(webhook.hostname) || !webhook.pathname.startsWith("/api/webhooks/")) throw new Error("Webhook must be an official Discord HTTPS webhook URL");
  webhook.searchParams.set("wait", "true");
  const payload = buildPayload({ tag: process.env.RELEASE_TAG || "", sha: process.env.RELEASE_SHA || "", releaseUrl: process.env.RELEASE_URL || "", runUrl: process.env.RUN_URL || "", repositoryUrl: process.env.REPOSITORY_URL || "", productionUrl: process.env.PRODUCTION_URL || "", deployedAt: process.env.DEPLOYED_AT || "" });
  const response = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
  console.log(`Discord deployment announcement sent for ${process.env.RELEASE_TAG}`);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await main();
