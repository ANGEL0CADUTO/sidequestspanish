// Punctual trigger for the "Publish Shorts" workflow. GitHub's own cron runs
// whenever it has capacity (hours late at times); this Worker checks the public
// schedule every 5 minutes and dispatches the workflow as soon as something is
// due and not yet published. Secret: GH_TOKEN (fine-grained, Actions: write on
// ANGEL0CADUTO/sidequestspanish).
const REPO = "ANGEL0CADUTO/sidequestspanish";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/data`;

async function check(env) {
  const bust = `?t=${Date.now()}`;
  const [schedule, done, config] = await Promise.all(
    ["schedule.json", "published.json", "config.json"].map((f) => fetch(`${RAW}/${f}${bust}`).then((r) => r.json())),
  );
  const now = new Date().toISOString();
  // TikTok in direct mode only posts what was approved in the studio.
  const due = schedule.filter(
    (s) => s.at <= now && !done[`${s.platform}:${s.id}`] && (s.platform !== "tiktok" || config.tiktokMode !== "direct" || s.tiktok),
  );
  if (!due.length) return "nothing due";
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/publish.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "sidequest-trigger" },
    body: JSON.stringify({ ref: "main" }),
  });
  return `${due.length} due → dispatch ${r.status}`;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env).then((m) => console.log(m)));
  },
  // GET /  shows what the trigger would do now (no secrets exposed).
  async fetch(_req, env) {
    return new Response(await check(env));
  },
};
