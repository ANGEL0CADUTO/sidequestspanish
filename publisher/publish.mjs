// Side Quest Spanish: publishes the Shorts that are due on Instagram and TikTok,
// run by .github/workflows/publish.yml every 30 minutes (no PC needed).
// Videos: assets of the "media" release. Data: data/*.json. Tokens: data/tokens.enc,
// AES-256-GCM with the TOKEN_KEY secret, renewed and re-saved by this script.
//   node publisher/publish.mjs due [--dry]
//   node publisher/publish.mjs seal <file.json>   (local: encrypt tokens, TOKEN_KEY in env)
import fs from "node:fs";
import crypto from "node:crypto";

const D = "data";
const MEDIA = "https://github.com/ANGEL0CADUTO/sidequestspanish/releases/download/media";
const IG = "https://graph.instagram.com/v23.0";
const TT = "https://open.tiktokapis.com/v2";
const read = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const config = read(`${D}/config.json`, {});

// ---------------------------------------------------------------- tokens
const key = () => crypto.createHash("sha256").update(process.env.TOKEN_KEY ?? "").digest();
function openTokens() {
  if (!fs.existsSync(`${D}/tokens.enc`)) return {};
  const [iv, tag, data] = fs.readFileSync(`${D}/tokens.enc`, "utf8").trim().split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString());
}
function sealTokens(t) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(t)), c.final()]);
  fs.writeFileSync(`${D}/tokens.enc`, [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".") + "\n");
}
const tokens = process.argv[2] === "seal" ? {} : openTokens();

// ---------------------------------------------------------------- Instagram
async function ig(path, init) {
  const r = await fetch(`${IG}${path}`, init);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`Instagram ${path.split("?")[0]}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`);
  return j;
}
async function igToken() {
  // Long-lived tokens last 60 days: renew when older than 20.
  if (tokens.ig && Date.now() - (tokens.igRenewedAt ?? 0) > 20 * 864e5) {
    const j = await ig(`/refresh_access_token?grant_type=ig_refresh_token&access_token=${tokens.ig}`);
    Object.assign(tokens, { ig: j.access_token, igRenewedAt: Date.now() });
    sealTokens(tokens);
    console.log("Instagram token renewed");
  }
  return tokens.ig;
}
async function publishInstagram(id, c) {
  const token = await igToken();
  // Our designed cover (release asset); TikTok has no image cover in its API, but
  // the first frame of every Short is already the cover (video_cover_timestamp_ms 0).
  const cover = c.cover ? { cover_url: `${MEDIA}/${id}-cover.jpg` } : { thumb_offset: "0" };
  const form = new URLSearchParams({ media_type: "REELS", video_url: `${MEDIA}/${id}.mp4`, caption: c.instagram, share_to_feed: "true", ...cover, access_token: token });
  const container = await ig(`/${config.igUserId}/media`, { method: "POST", body: form });
  for (let i = 0; i < 60; i++) {
    const st = await ig(`/${container.id}?fields=status_code,status&access_token=${token}`);
    if (st.status_code === "FINISHED") break;
    if (["ERROR", "EXPIRED"].includes(st.status_code)) throw new Error(`Instagram processing: ${st.status}`);
    await wait(10000);
  }
  const pub = await ig(`/${config.igUserId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: container.id, access_token: token }) });
  const info = await ig(`/${pub.id}?fields=permalink&access_token=${token}`);
  return info.permalink ?? pub.id;
}

// ---------------------------------------------------------------- TikTok
async function ttToken() {
  if (tokens.tt && tokens.ttExpiresAt > Date.now() + 60_000) return tokens.tt;
  if (!tokens.ttRefresh) throw new Error("TikTok not connected");
  const r = await fetch(`${TT}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: tokens.ttRefresh }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`TikTok token: ${JSON.stringify(j).slice(0, 200)}`);
  Object.assign(tokens, { tt: j.access_token, ttRefresh: j.refresh_token, ttExpiresAt: Date.now() + j.expires_in * 1000 });
  sealTokens(tokens);
  return tokens.tt;
}
async function tt(path, token, body) {
  const r = await fetch(`${TT}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error?.code && j.error.code !== "ok") throw new Error(`TikTok ${path}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.data;
}
async function publishTikTok(id, c) {
  const token = await ttToken();
  const video = Buffer.from(await (await fetch(`${MEDIA}/${id}.mp4`)).arrayBuffer());
  const source_info = { source: "FILE_UPLOAD", video_size: video.length, chunk_size: video.length, total_chunk_count: 1 };
  const direct = config.tiktokMode === "direct";
  let init;
  if (direct) {
    const info = await tt("/post/publish/creator_info/query/", token, {});
    const privacy = info.privacy_level_options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : info.privacy_level_options[0];
    init = await tt("/post/publish/video/init/", token, { post_info: { title: c.tiktok, privacy_level: privacy, video_cover_timestamp_ms: 0 }, source_info });
  } else init = await tt("/post/publish/inbox/video/init/", token, { source_info });
  const put = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${video.length - 1}/${video.length}` }, body: video });
  if (!put.ok) throw new Error(`TikTok upload ${put.status}`);
  return `${direct ? "post" : "draft"}:${init.publish_id}`;
}

// ---------------------------------------------------------------- due
async function due(dry) {
  const captions = read(`${D}/captions.json`, {});
  const schedule = read(`${D}/schedule.json`, []);
  const done = read(`${D}/published.json`, {});
  const ready = { instagram: !!tokens.ig && !!config.igUserId, tiktok: !!tokens.ttRefresh };
  const now = new Date().toISOString();
  let failures = 0;
  for (const s of schedule.filter((s) => s.at <= now && !done[`${s.platform}:${s.id}`] && ready[s.platform])) {
    console.log(`${s.platform} ${s.id} (due ${s.at})${dry ? " [dry]" : ""}`);
    if (dry) continue;
    try {
      const ref = s.platform === "instagram" ? await publishInstagram(s.id, captions[s.id]) : await publishTikTok(s.id, captions[s.id]);
      done[`${s.platform}:${s.id}`] = { at: new Date().toISOString(), ref };
      write(`${D}/published.json`, done);
      console.log("  ok", ref);
    } catch (e) {
      failures++;
      console.error("  FAILED", e.message);
    }
  }
  if (!dry) await igToken().catch((e) => console.error("token renewal:", e.message));
  if (failures) process.exitCode = 1; // the run shows red and GitHub emails the owner
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "due") await due(process.argv.includes("--dry"));
else if (cmd === "seal" && arg) { sealTokens(JSON.parse(fs.readFileSync(arg, "utf8"))); console.log("sealed"); }
else console.log("Usage: due [--dry] | seal <tokens.json>");
