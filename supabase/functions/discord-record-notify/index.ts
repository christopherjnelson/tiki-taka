import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Posts a Discord notification when a round beats the standing global best for
// its (mode, difficulty, court) board.
//
// Auth: verify_jwt is off because the caller is a Postgres trigger, which has
// no JWT to present. The function authenticates the caller itself with a shared
// secret header instead — the secret lives in public.integration_config, which
// is RLS-locked to the service role, so it is neither in this source nor in the
// trigger definition.
//
// The trigger decides what counts as a record and passes the beaten score in,
// so this function never re-queries the leaderboard. That keeps the "beat X by
// Y" line consistent even when two rounds land in the same second.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const adminHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
};

const COURT_NAMES = [
  "THE COURTYARD",
  "CONCRETE CLUB",
  "EL PATIO",
  "AFTER HOURS",
  "THE CAGE",
  "TOTAL FOOTBALL",
];

// Ruthless records are the rarer ones, so they get the warmer colour.
const COLORS: Record<string, number> = {
  standard: 0x35d7c3,
  ruthless: 0xff9f43,
};
// Endless (shown to players as Extra Time since 0.5.0; the stored mode key
// stays "endless") is scored on seconds survived, not points, and has no court: it is
// one global ladder played on its own rondo. Everything below that differs
// between the two kinds of record hangs off this one check.
const isEndless = (mode: unknown) => mode === "endless";
// Its own colour, matching the court's jade rather than the tour's teal.
const ENDLESS_COLOR = 0x8fe6cf;
// King of the Court is scored on squares held (crowns * 24 + squares), has no
// court number, and keeps one board per difficulty. Read as points it would
// post "took UNKNOWN COURT".
const isKotc = (mode: unknown) => mode === "kotc";
const KOTC_COLOR = 0xffd166;

async function config(): Promise<Record<string, string>> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/integration_config?select=key,value`,
    { headers: adminHeaders },
  );
  if (!response.ok) throw new Error(`config read failed: ${response.status}`);
  const rows = (await response.json()) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function courtName(court: number | null): string {
  if (court === null || court === undefined) return "UNKNOWN COURT";
  const name = COURT_NAMES[court];
  return name ? `${String(court + 1).padStart(2, "0")} • ${name}` : `COURT ${court}`;
}

function title(difficulty: string): string {
  return difficulty === "ruthless" ? "RUTHLESS" : difficulty.toUpperCase();
}

const count = (value: unknown) => Number(value ?? 0).toLocaleString("en-US");
const clock = (value: unknown) => {
  const whole = Math.max(0, Math.floor(Number(value ?? 0)));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let settings: Record<string, string>;
  try {
    settings = await config();
  } catch (error) {
    console.error("config", error);
    return new Response("Configuration unavailable", { status: 500 });
  }

  const expected = settings.record_hook_secret;
  const presented = req.headers.get("x-record-secret");
  if (!expected || presented !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const webhook = settings.discord_record_webhook_url;
  if (!webhook) return new Response("No webhook configured", { status: 500 });

  const payload = await req.json().catch(() => null);
  const record = payload?.record ?? {};
  if (!record?.id) return new Response("No round in payload", { status: 400 });

  const username = payload?.username ?? "Someone";
  const previousBest = Number(payload?.previous_best ?? 0);
  const previousHolder = payload?.previous_holder ?? null;
  const margin = Number(record.score) - previousBest;
  const endless = isEndless(record.mode);
  // A run is read as a duration everywhere it appears, including the margin:
  // "by 0:14" is the sentence a player would say, "by 14" is not.
  const amount = endless ? clock : count;
  const kotc = isKotc(record.mode);
  const squares = (value: unknown) => `${count(value)} squares`;

  // previous_best is 0 when the board was empty (the trigger sends it that
  // way): there is nothing beaten, so the line is omitted rather than
  // claiming a margin over nobody.
  const beaten =
    previousBest <= 0
      ? ""
      : previousHolder
        ? `Beat **${previousHolder}**'s ${kotc ? squares(previousBest) : amount(previousBest)} by ${kotc ? squares(margin) : amount(margin)}.`
        : `Beat the old best of ${kotc ? squares(previousBest) : amount(previousBest)} by ${kotc ? squares(margin) : amount(margin)}.`;

  const body = {
    username: "Tiki Taka Scores",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: endless
        ? "⏱️ NEW EXTRA TIME RECORD"
        : kotc
          ? "👑 NEW KING OF THE COURT RECORD"
          : "🏆 NEW COURT RECORD",
      description: [
        endless
          ? `**${username}** lasted **${clock(record.score)}** on **STILL WATER**.`
          : kotc
            ? `**${username}** held **${squares(record.score)}** on **THE ROOFTOP** on **${title(record.difficulty)}**.`
            : `**${username}** took **${courtName(record.court)}** on **${title(record.difficulty)}**.`,
        beaten,
      ]
        .filter(Boolean)
        .join("\n"),
      color: endless ? ENDLESS_COLOR : kotc ? KOTC_COLOR : COLORS[record.difficulty] ?? 0x35d7c3,
      fields: [
        endless
          ? { name: "Survived", value: clock(record.score), inline: true }
          : kotc
            ? { name: "Squares", value: count(record.score), inline: true }
            : { name: "Score", value: count(record.score), inline: true },
        { name: "Passes", value: count(record.passes), inline: true },
        { name: "Zones", value: count(record.zones), inline: true },
        { name: "Best one-touch", value: count(record.best_one_touch), inline: true },
      ],
      footer: {
        text: endless
          ? "Longest run on the global Extra Time ladder"
          : kotc
            ? "Most squares held for this difficulty"
            : "Global best for this court and difficulty",
      },
      timestamp: record.created_at ?? new Date().toISOString(),
    }],
  };

  const sent = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!sent.ok) {
    const detail = await sent.text().catch(() => "");
    console.error("discord", sent.status, detail);
    return new Response(`Discord rejected the post: ${sent.status}`, { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
