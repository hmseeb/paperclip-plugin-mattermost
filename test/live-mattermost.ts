// Manual live check of MattermostClient + Bridge against a real Mattermost, with an
// echo agent instead of Paperclip. Usage:
//   MM_URL=https://... MM_BOT_TOKEN_FILE=/path MM_ADMIN_FILE=/path(user|pass) node test/live-mattermost.ts
import { readFileSync } from "node:fs";
import { Bridge } from "../src/bridge.ts";
import { MattermostClient } from "../src/mattermost.ts";

const URL_ = process.env.MM_URL!;
const botToken = readFileSync(process.env.MM_BOT_TOKEN_FILE!, "utf8").trim();
const [adminUser, adminPw] = readFileSync(process.env.MM_ADMIN_FILE!, "utf8").trim().split("|");
const mm = new MattermostClient(URL_, botToken, (m, meta) => console.log("[mm]", m, meta ?? ""));
await mm.init();
const state = new Map<string, unknown>();
const bridge = new Bridge(mm, {
  async list() { return [{ id: "echo", name: "Echo" }]; },
  async createSession() { return "sess-1"; },
  async ask(_s, prompt) { await new Promise((r) => setTimeout(r, 1500)); return `echo: ${prompt.split("\n\n").at(-1)}`; },
}, { async get(k) { return (state.get(k) ?? null) as never; }, async set(k, v) { state.set(k, v); } },
{ defaultAgent: "Echo", channelAgents: new Map() }, (m, meta) => console.log("[bridge]", m, meta ?? ""));
mm.connect((e) => { void bridge.handle(e); });
await new Promise((r) => setTimeout(r, 4000));
if (!mm.connected) throw new Error("websocket did not connect: " + mm.lastError);

// Admin DMs the bot, as a person would.
const api = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(`${URL_}/api/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { r, j: r.status === 204 ? null : await r.json() };
};
const login = await fetch(`${URL_}/api/v4/users/login`, { method: "POST", body: JSON.stringify({ login_id: adminUser, password: adminPw }) });
const at = login.headers.get("Token")!;
const me = (await login.json()).id;
const dm = (await api("POST", "/channels/direct", at, [me, mm.botUserId])).j;
const tag = Math.random().toString(36).slice(2, 8);
const sent = (await api("POST", "/posts", at, { channel_id: dm.id, message: `live check ${tag}` })).j;
let reply = "";
for (let i = 0; i < 20 && !reply.startsWith("echo"); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const posts = Object.values((await api("GET", `/posts/${sent.id}/thread`, at)).j.posts) as { user_id: string; message: string }[];
  reply = posts.find((p) => p.user_id === mm.botUserId)?.message ?? "";
}
mm.close();
console.log("bot reply:", reply);
if (reply !== `echo: live check ${tag}`) { console.log("LIVE FAIL"); process.exit(1); }
console.log("LIVE PASS");
process.exit(0);
