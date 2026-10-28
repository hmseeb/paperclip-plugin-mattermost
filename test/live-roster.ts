// Manual live check of AgentBots + Bridge against a real Mattermost, with fake agents
// and an echo agent instead of Paperclip. Cleans up after itself (bots disabled).
//   MM_URL=... MM_MANAGER_TOKEN_FILE=... MM_ADMIN_FILE=(user|pass) node test/live-roster.ts
import { readFileSync } from "node:fs";
import { Bridge, type PostedEvent } from "../src/bridge.ts";
import { MattermostClient } from "../src/mattermost.ts";
import { AgentBots, type AgentInfo } from "../src/roster.ts";

const URL_ = process.env.MM_URL!;
const log = (m: string, meta?: Record<string, unknown>) => console.log("[live]", m, meta ? JSON.stringify(meta) : "");
const manager = new MattermostClient(URL_, readFileSync(process.env.MM_MANAGER_TOKEN_FILE!, "utf8").trim(), log);
await manager.init();
const mem = new Map<string, unknown>();
const store = { async get<T>(k: string) { return (mem.get(k) ?? null) as T | null; }, async set(k: string, v: unknown) { mem.set(k, v); } };
let agents: AgentInfo[] = [{ id: "t1", name: "Plugin Test One" }, { id: "t2", name: "Plugin Test Two" }];
// Reuse test bots from an earlier run (the sync re-enables them) instead of minting new ones.
const seed: Record<string, string> = {};
for (const a of agents) {
  try { seed[a.id] = (await manager.request<{ id: string }>("GET", `/users/username/${a.name.toLowerCase().replace(/ /g, "-")}`)).id; } catch { /* first run */ }
}
await store.set("bots", seed);
let onPosted: (e: PostedEvent) => void = () => {};
const roster = new AgentBots(manager, URL_, async () => agents, store, log, (e) => onPosted(e));
const bridge = new Bridge(() => roster.roster(), {
  userName: (id) => manager.userName(id), threadPosts: (r) => manager.threadPosts(r),
  async ensureMember(c, u) { await manager.request("POST", `/channels/${c}/members`, { user_id: u }); },
}, { async createSession(a) { return `sess-${a}`; }, async ask(s, p) { return `echo from ${s}: ${p.split("\n\n").at(-1)}`; } }, store, log);
onPosted = (e) => { void bridge.handle(e); };
manager.connect(onPosted);
await roster.sync();
await new Promise((r) => setTimeout(r, 5000));
console.log("bots:", roster.size, "connected:", roster.connected);

const [user, pw] = readFileSync(process.env.MM_ADMIN_FILE!, "utf8").trim().split("|");
const login = await fetch(`${URL_}/api/v4/users/login`, { method: "POST", body: JSON.stringify({ login_id: user, password: pw }) });
const at = login.headers.get("Token")!;
const me = (await login.json()).id;
const api = async (m: string, p: string, b?: unknown) => (await fetch(`${URL_}/api/v4${p}`, { method: m, headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
const two = roster.roster().byAgentId("t2")!, one = roster.roster().byAgentId("t1")!;
const waitReply = async (rootId: string, botId: string) => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const p = Object.values((await api("GET", `/posts/${rootId}/thread`)).posts) as { user_id: string; message: string }[];
    const hit = p.find((x) => x.user_id === botId && x.message.startsWith("echo"));
    if (hit) return hit.message;
  }
  return null;
};
const dm = await api("POST", "/channels/direct", [me, two.botUserId]);
const dmPost = await api("POST", "/posts", { channel_id: dm.id, message: "hello two" });
const r1 = await waitReply(dmPost.id, two.botUserId);
console.log("DM to @" + two.username + " ->", r1);
const team = (await api("GET", `/users/me/teams`))[0];
const town = await api("GET", `/teams/${team.id}/channels/name/town-square`);
const chPost = await api("POST", "/posts", { channel_id: town.id, message: `@${one.username} ping` });
const r2 = await waitReply(chPost.id, one.botUserId);
console.log("mention of @" + one.username + " in town-square ->", r2);

agents = [];
await roster.sync();
const after = await Promise.all([one, two].map(async (m) => (await api("GET", `/bots/${m.botUserId}?include_deleted=true`)).delete_at > 0));
console.log("test bots disabled after cleanup:", after);
roster.close(); manager.close();
console.log(r1?.includes("hello two") && r2?.includes("ping") && after.every(Boolean) ? "LIVE ROSTER PASS" : "LIVE ROSTER FAIL");
process.exit(0);
