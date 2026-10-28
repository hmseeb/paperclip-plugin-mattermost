import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBots } from "../src/roster.ts";

const MANAGER = "mgr";
const OPS = { id: "a-ops", name: "Operations Agent" };

/** A Mattermost that keeps bots and users in memory, and can be made to fail lookups. */
function fakeMattermost() {
  const bots = new Map<string, { user_id: string; username: string; display_name: string; description: string; delete_at: number; owner_id: string }>();
  let n = 0;
  const state = { failLookups: false, created: 0 };
  const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const add = (username: string, owner = MANAGER, deleted = false) => {
    const user_id = `b${++n}`;
    bots.set(user_id, { user_id, username, display_name: username, description: "", delete_at: deleted ? 1 : 0, owner_id: owner });
    return user_id;
  };
  const manager = {
    botUserId: MANAGER,
    async setProfileImage() {},
    async request<T>(method: string, path: string, body?: { username?: string; display_name?: string }): Promise<T> {
      const p = path.split("?")[0];
      let m: RegExpMatchArray | null;
      if (p === "/users/me/teams") return [{ id: "t1" }] as T;
      if ((m = p.match(/^\/bots\/(\w+)$/)) && method === "GET") {
        if (state.failLookups) throw err(503);
        const bot = bots.get(m[1]);
        if (!bot) throw err(404);
        return { ...bot } as T;
      }
      if (p === "/bots" && method === "POST") {
        if ([...bots.values()].some((b) => b.username === body!.username)) throw err(400);
        state.created++;
        return { ...bots.get(add(body!.username!))! } as T;
      }
      if ((m = p.match(/^\/bots\/(\w+)\/(enable|disable)$/))) {
        bots.get(m[1])!.delete_at = m[2] === "disable" ? 1 : 0;
        return {} as T;
      }
      if ((m = p.match(/^\/bots\/(\w+)$/)) && method === "PUT") {
        Object.assign(bots.get(m[1])!, { display_name: body!.display_name });
        return { ...bots.get(m[1])! } as T;
      }
      if ((m = p.match(/^\/users\/username\/(.+)$/))) {
        const bot = [...bots.values()].find((b) => b.username === m![1]);
        if (!bot) throw err(404);
        return { id: bot.user_id, is_bot: true } as T;
      }
      if (/^\/users\/\w+\/tokens$/.test(p)) return (method === "GET" ? [] : { token: "t" }) as T;
      if (/^\/users\/me\/teams\/t1\/channels$/.test(p) || /^\/teams\/t1\/channels$/.test(p)) return [] as T;
      if (/^\/teams\/t1\/members$/.test(p)) return {} as T;
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { manager, bots, add, state };
}

function setup(mm: ReturnType<typeof fakeMattermost>, saved: Record<string, string> = {}) {
  const store = new Map<string, unknown>([["bots", saved]]);
  const client = () => ({
    connected: true, async init() {}, connect() {}, close() {},
    async createPost() { return { id: "p" }; }, async patchPost() {}, async typing() {}, async react() {},
    async download() { return { name: "", data: new Uint8Array() }; }, async upload() {},
  });
  const log: string[] = [];
  const roster = new AgentBots(mm.manager as never, "https://mm", async () => [OPS], {
    get: async <T,>(k: string) => (store.get(k) ?? null) as T | null,
    set: async (k, v) => { store.set(k, v); },
  }, (msg) => log.push(msg), () => {}, client as never);
  return { roster, store, log, map: () => store.get("bots") as Record<string, string> };
}

test("a failed lookup while Mattermost restarts never creates a second bot", async () => {
  const mm = fakeMattermost();
  const t = setup(mm);
  await t.roster.sync();
  assert.equal(mm.state.created, 1);
  const first = t.map()[OPS.id];
  mm.state.failLookups = true;
  await t.roster.sync();
  assert.equal(mm.state.created, 1, "no second bot");
  assert.equal(t.map()[OPS.id], first);
  assert.equal(t.roster.roster().byUsername("operations-agent")?.agentId, OPS.id, "still answering as itself");
});

test("an agent on a stand-in bot moves back to its own, and the stand-in is switched off", async () => {
  const mm = fakeMattermost();
  const original = mm.add("operations-agent");
  const standIn = mm.add("operations-agent-agent");
  const t = setup(mm, { [OPS.id]: standIn });
  await t.roster.sync();
  assert.equal(t.map()[OPS.id], original);
  assert.equal(mm.bots.get(standIn)!.delete_at > 0, true, "stand-in disabled");
  assert.equal(t.roster.roster().byUsername("operations-agent")?.agentId, OPS.id);
  assert.equal(t.roster.roster().byUsername("operations-agent-agent"), undefined);
  assert.ok(t.log.includes("moved agent back to its own bot"));
});

test("a bot at the agent's name that is not ours, or is another agent's, is left alone", async () => {
  const mm = fakeMattermost();
  mm.add("operations-agent", "someone-else");
  const standIn = mm.add("operations-agent-agent");
  const t = setup(mm, { [OPS.id]: standIn });
  await t.roster.sync();
  assert.equal(t.map()[OPS.id], standIn);
  const mm2 = fakeMattermost();
  const taken = mm2.add("operations-agent");
  const standIn2 = mm2.add("operations-agent-agent");
  const t2 = setup(mm2, { [OPS.id]: standIn2, "a-other": taken });
  await t2.roster.sync();
  assert.equal(t2.map()[OPS.id], standIn2);
});

test("with its saved list lost, an agent's existing bot is reused rather than duplicated", async () => {
  const mm = fakeMattermost();
  const original = mm.add("operations-agent", MANAGER, true);
  const t = setup(mm);
  await t.roster.sync();
  assert.equal(mm.state.created, 0);
  assert.equal(t.map()[OPS.id], original);
  assert.equal(mm.bots.get(original)!.delete_at, 0, "re-enabled");
});
