// Posts the player-facing release notes to a public Discord channel.
//
// This is the second of two announcements, and the difference between them is
// the audience. notify-discord-release.mjs builds an engineering summary -
// commits grouped by conventional-commit type, SHAs, a workflow link - which
// belongs in a private team channel. This one posts what a player would want
// to read, and nothing else: no commits, no SHAs, no internal links.
//
// The text comes from CHANGELOG.md through the same parser the in-app
// changelog uses (scripts/changelog.mjs), so what Discord shows and what
// Settings shows can never drift. That also means this inherits the rule in
// CLAUDE.md: a release whose version bump skips its changelog entry has
// nothing to announce, and this says so loudly rather than posting an empty
// message.

import { readFile } from "node:fs/promises";
import { parseChangelog } from "./changelog.mjs";

const SEMVER = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

// Discord's limits, minus room for the heading and footer we add below.
const DESCRIPTION_LIMIT = 4096;
const SAFE_BODY = 3600;

// The public channel is the one place release text reaches people who did not
// ask for it, so a stray @everyone in a changelog entry would be a genuine
// incident rather than a typo. allowed_mentions parse:[] makes Discord ignore
// every mention in the payload regardless of what the text says; neutering the
// characters as well means the message also READS as intended rather than
// silently pinging nothing while looking like it pings someone.
const defuse = (text) => String(text ?? "").replaceAll("@", "＠").trim();

function renderEntry(entry) {
  const blocks = [];
  for (const paragraph of entry.summary) blocks.push(defuse(paragraph));
  for (const section of entry.sections) {
    blocks.push(`### ${defuse(section.heading)}`);
    for (const paragraph of section.paragraphs) blocks.push(defuse(paragraph));
  }
  return blocks.filter(Boolean).join("\n\n");
}

export function buildPayload({ tag, changelog, releaseUrl, productionUrl, deployedAt }) {
  if (!SEMVER.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  const version = tag.slice(1);
  const entry = parseChangelog(changelog).find((item) => item.version === version);
  if (!entry) {
    throw new Error(
      `CHANGELOG.md has no entry for ${version}. Add it in the same commit as the version bump (see CLAUDE.md) - there is nothing to announce without it.`,
    );
  }

  let body = renderEntry(entry);
  if (!body) throw new Error(`The CHANGELOG.md entry for ${version} is empty.`);
  if (body.length > SAFE_BODY) {
    // Cut on a paragraph boundary rather than mid-sentence, and say plainly
    // that there is more rather than trailing off.
    const cut = body.lastIndexOf("\n\n", SAFE_BODY);
    body = `${body.slice(0, cut > 0 ? cut : SAFE_BODY).trim()}\n\n*…and more in the full notes.*`;
  }

  const description = `${body}\n\n**[Play now](${productionUrl})** · [Full notes](${releaseUrl})`.slice(
    0,
    DESCRIPTION_LIMIT,
  );

  return {
    username: "Tiki Taka",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `⚽ Tiki Taka ${tag}`,
        url: releaseUrl,
        description,
        color: 2224096,
        timestamp: new Date(deployedAt || Date.now()).toISOString(),
      },
    ],
  };
}

async function main() {
  let webhook;
  try {
    webhook = new URL(process.env.DISCORD_RELEASE_WEBHOOK_URL || "");
  } catch {
    throw new Error("DISCORD_RELEASE_WEBHOOK_URL is missing or invalid");
  }
  if (
    webhook.protocol !== "https:" ||
    !["discord.com", "canary.discord.com", "ptb.discord.com"].includes(webhook.hostname) ||
    !webhook.pathname.startsWith("/api/webhooks/")
  ) {
    throw new Error("Webhook must be an official Discord HTTPS webhook URL");
  }
  webhook.searchParams.set("wait", "true");

  const payload = buildPayload({
    tag: process.env.RELEASE_TAG || "",
    changelog: await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
    releaseUrl: process.env.RELEASE_URL || "",
    productionUrl: process.env.PRODUCTION_URL || "",
    deployedAt: process.env.DEPLOYED_AT || "",
  });

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
  console.log(`Player release notes posted for ${process.env.RELEASE_TAG}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await main();
