import { test } from "node:test";
import assert from "node:assert/strict";
import { Actions, type MmClient, type PendingRequest } from "../src/actions.ts";
import { WorkLinks, type TaskComment } from "../src/worklinks.ts";
import { broadcastMention, canManage, channelSlug } from "../src/policy.ts";

const CH = "c".repeat(26);

/** A Mattermost that records every call and holds channels by id. */
function fakeMm() {
  const calls: { as: string; method: string; path: string; body?: unknown }[] = [];
  const channels = new Map<string, { id: string; name: string; display_name: string; type: string; team_id: string }>([[CH, { id: CH, name: "general", display_name: "General", type: "O", team_id: "t1" }]]);
  let n = 0;
  const client = (botUserId: string): MmClient => ({
    botUserId,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ as: botUserId, method, path, body });
      if (path === "/users/me/teams") return [{ id: "t1" }] as T;
      if (path === "/channels" && method === "POST") {
        const b = body as { name: string; display_name: string; type: string };
        if ([...channels.values()].some((c) => c.name === b.name)) throw Object.assign(new Error("taken"), { status: 400 });
        const id = String(++n).padStart(26, "n");
        channels.set(id, { id, name: b.name, display_name: b.display_name, type: b.type, team_id: "t1" });
        return channels.get(id) as T;
      }
      const ch = path.match(/^\/channels\/(\w{26})$/);
      if (ch && method === "GET") return channels.get(ch[1]) as T;
      const byName = path.match(/^\/teams\/t1\/channels\/name\/(.+)$/);
      if (byName) {
        const hit = [...channels.values()].find((c) => c.name === decodeURIComponent(byName[1]));
        if (!hit) throw Object.assign(new Error("nope"), { status: 404 });
        return hit as T;
      }
      if (path.startsWith("/users/me/teams/t1/channels")) return [...channels.values()] as T;
      if (path.startsWith("/users/username/")) return { id: `u-${path.split("/").pop()}` } as T;
      if (path === "/posts") return { id: `p${++n}`, root_id: (body as { root_id?: string }).root_id } as T;
      return {} as T;
    },
  });
  return { calls, channels, client };
}

function setup() {
  const mm = fakeMm();
  const store = new Map<string, unknown>();
  const asked: PendingRequest[] = [];
  const bots: Record<string, MmClient> = { "a-cto": mm.client("bot-cto"), "a-ceo": mm.client("bot-ceo") };
  const actions = new Actions({
    bot: (id) => bots[id],
    manager: mm.client("mgr"),
    agents: () => [
      { agentId: "a-cto", agentName: "CTO", username: "cto", botUserId: "bot-cto" },
      { agentId: "a-ceo", agentName: "CEO", username: "ceo", botUserId: "bot-ceo" },
    ],
    canTalk: async (userId) => userId === "u-alice",
    origin: () => ({ channelId: CH, rootId: "root1" }),
    task: async (id) => (id === "BAD-1" ? { id: "issue-1", identifier: "BAD-1", title: "Checkout 5xx" } : null),
    askApproval: async (r) => { asked.push(r); },
    store: { get: async <T,>(k: string) => (store.get(k) ?? null) as T | null, set: async (k, v) => { store.set(k, v); } },
    newId: () => `r${asked.length + 1}`,
    // run-42 works on a task asked for in thread root-x of channel CH
    taskThread: async (_a, runId, channelId) => (runId === "run-42" && channelId === CH ? "root-x" : null),
  });
  return { mm, store, asked, actions };
}

test("policy: broadcasts, channel ownership, names", () => {
  assert.equal(broadcastMention("hey @channel look"), "@channel");
  assert.equal(broadcastMention("mail me at a@here.com"), null);
  assert.equal(canManage(false, "invite").ok, false);
  assert.equal(canManage(false, "archive").ok === false && !("askFirst" in canManage(false, "archive") && canManage(false, "archive").askFirst), true);
  assert.equal(channelSlug("Inc: Checkout 5xx!"), "inc-checkout-5xx");
});

test("an agent posts as its own bot; @channel waits for approval and runs once approved", async () => {
  const t = setup();
  const r = await t.actions.handle("a-cto", "post", {}, { channel: "general", text: "deploy is done" });
  assert.equal(r.status, 200);
  assert.equal(t.mm.calls.find((c) => c.path === "/posts")?.as, "bot-cto");
  const held = await t.actions.handle("a-cto", "post", {}, { channel: "general", text: "@channel outage" });
  assert.equal(held.status, 202);
  assert.equal(t.asked.length, 1);
  assert.equal(t.mm.calls.filter((c) => c.path === "/posts").length, 1, "not posted yet");
  const done = await t.actions.decide(t.asked[0].id, true, "@alice");
  assert.equal(done?.status, "approved");
  const posts = t.mm.calls.filter((c) => c.path === "/posts").map((c) => (c.body as { message: string }).message);
  assert.ok(posts.includes("@channel outage"));
  assert.ok(posts.some((m) => /@alice approved/.test(m)), "outcome reported in the origin thread");
  assert.equal((await t.actions.decide(t.asked[0].id, true, "@bob"))?.decidedBy, "@alice", "a second click does nothing");
});

test("DMs only to people allowed to talk to the agent", async () => {
  const t = setup();
  assert.equal((await t.actions.handle("a-cto", "dm", {}, { person: "alice", text: "hi" })).status, 200);
  assert.equal((await t.actions.handle("a-cto", "dm", {}, { person: "mallory", text: "hi" })).status, 403);
});

test("work channels: private by default, tied to the task, managed only by their creator", async () => {
  const t = setup();
  const r = await t.actions.handle("a-cto", "create-channel", {}, { name: "inc checkout 5xx", people: ["alice"], agents: ["ceo"], taskId: "BAD-1" });
  assert.equal(r.status, 200);
  const body = r.body as { channel: string; channelId: string; private: boolean; linkedTask: string };
  assert.deepEqual([body.channel, body.private, body.linkedTask], ["inc-checkout-5xx", true, "BAD-1"]);
  assert.equal(t.store.get("taskchannel:issue-1"), body.channelId);
  const again = await t.actions.handle("a-cto", "create-channel", {}, { name: "inc checkout 5xx" });
  assert.equal((again.body as { channel: string }).channel, "inc-checkout-5xx-2", "a taken name gets a suffix");
  assert.equal((await t.actions.handle("a-cto", "create-channel", {}, { name: "x", taskId: "BAD-9" })).status, 404);
  assert.equal((await t.actions.handle("a-cto", "create-channel", {}, { name: "town hall", private: false })).status, 202, "public needs approval");
  assert.equal((await t.actions.handle("a-ceo", "archive", { channel: body.channelId }, {})).status, 403, "not the creator");
  assert.equal((await t.actions.handle("a-cto", "invite", { channel: "general" }, { people: ["bob"] })).status, 202, "not its channel: ask");
  assert.equal((await t.actions.handle("a-cto", "archive", { channel: body.channelId }, {})).status, 200);
});

test("an agent with no bot is told so", async () => {
  const t = setup();
  assert.equal((await t.actions.handle("a-nobody", "channels", {}, {})).status, 409);
});

test("a work channel mirrors task comments and closes with the task", async () => {
  const store = new Map<string, unknown>([
    ["taskchannel:issue-1", "chan"],
    ["worklink:chan", { issueId: "issue-1", identifier: "BAD-1", title: "Checkout 5xx", agentId: "a-cto", origin: { channelId: "o", rootId: "r" } }],
  ]);
  const posts: { as: string; channelId: string; rootId: string; text: string }[] = [];
  const archived: string[] = [];
  let status = "in_progress";
  const comments: TaskComment[] = [{ id: "k1", body: "Found it: bad deploy", authorAgentId: "a-ceo" }, { id: "k2", body: "Board note", authorAgentId: null }];
  const work = new WorkLinks({
    store: { get: async <T,>(k: string) => (store.get(k) ?? null) as T | null, set: async (k, v) => { store.set(k, v); } },
    post: async (as, channelId, rootId, text) => { posts.push({ as, channelId, rootId, text }); },
    hasBot: (id) => id === "a-ceo" || id === "a-cto",
    agentName: (id) => id,
    archive: async (id) => { archived.push(id); },
    channelName: async () => "inc checkout 5xx",
    task: async () => ({ identifier: "BAD-1", title: "Checkout 5xx", status }),
    comments: async () => comments,
  });
  await work.comment("issue-1", "k1");
  await work.comment("issue-1", "k2");
  assert.deepEqual(posts.map((p) => p.as), ["a-ceo", "a-cto"]);
  assert.match(posts[1].text, /A team member\*\* commented on BAD-1/);
  await work.updated("issue-1");
  assert.equal(posts.length, 2, "same status: nothing new");
  status = "done";
  await work.updated("issue-1");
  assert.deepEqual(archived, ["chan"]);
  assert.match(posts.at(-1)!.text, /Done.*BAD-1[\s\S]*Board note[\s\S]*archived/);
  assert.deepEqual([posts.at(-1)!.channelId, posts.at(-1)!.rootId], ["o", "r"]);
  await work.updated("issue-1");
  await work.comment("issue-1", "k1");
  assert.equal(archived.length, 1, "closed links stay closed");
});

test("a task's result, posted by its run without naming a thread, lands in the thread it was asked for in", async () => {
  const t = setup();
  await t.actions.handle("a-cto", "post", {}, { channel: "general", text: "BAD-1 is done" }, "run-42");
  assert.equal((t.mm.calls.filter((c) => c.path === "/posts").at(-1)!.body as { root_id: string }).root_id, "root-x");
  await t.actions.handle("a-cto", "post", {}, { channel: "general", text: "unrelated" }, "run-other");
  assert.equal((t.mm.calls.filter((c) => c.path === "/posts").at(-1)!.body as { root_id: string }).root_id, "", "other runs post as before");
  await t.actions.handle("a-cto", "post", {}, { channel: "general", text: "explicit", threadId: "chosen" }, "run-42");
  assert.equal((t.mm.calls.filter((c) => c.path === "/posts").at(-1)!.body as { root_id: string }).root_id, "chosen", "a named thread wins");
});

test("a task asked for in a thread reports back there when done, cancelled or blocked, once per status", async () => {
  const store = new Map<string, unknown>([["issuethread:issue-9", { channelId: "dm", rootId: "root-q", agentId: "a-ceo", status: "todo" }]]);
  const posts: { as: string; channelId: string; rootId: string; text: string }[] = [];
  let status = "in_progress";
  const work = new WorkLinks({
    store: { get: async <T,>(k: string) => (store.get(k) ?? null) as T | null, set: async (k, v) => { store.set(k, v); } },
    post: async (as, channelId, rootId, text) => { posts.push({ as, channelId, rootId, text }); },
    hasBot: (id) => id === "a-ceo" || id === "a-reporting",
    agentName: (id) => id, archive: async () => {}, channelName: async () => "",
    task: async () => ({ identifier: "BAD-728", title: "Client reporting batch", status, assigneeAgentId: "a-reporting" }),
    comments: async () => [{ id: "k1", body: "Batch posted for approval: 12 receipts, 3 weekly reports.", authorAgentId: "a-reporting" }],
  });
  await work.threadUpdate("issue-9");
  assert.equal(posts.length, 0, "in progress: nothing yet");
  status = "done";
  await work.threadUpdate("issue-9");
  await work.threadUpdate("issue-9");
  assert.equal(posts.length, 1, "once");
  // Posted by the agent the DM is with (the assignee's bot is not in it), naming who did the work.
  assert.deepEqual([posts[0].as, posts[0].channelId, posts[0].rootId], ["a-ceo", "dm", "root-q"]);
  assert.match(posts[0].text, /^:white_check_mark: Done: \*\*BAD-728\*\* Client reporting batch _\(by a-reporting\)_\n\nBatch posted for approval/);
  await work.threadUpdate("issue-unlinked");
  assert.equal(posts.length, 1, "tasks not asked for in a thread are left alone");
});

test("a result Mattermost refuses is not marked reported, so the next update tries again", async () => {
  const store = new Map<string, unknown>([["issuethread:issue-9", { channelId: "dm", rootId: "root-q", agentId: "a-ceo", status: "todo" }]]);
  let fail = true;
  const posts: string[] = [];
  const work = new WorkLinks({
    store: { get: async <T,>(k: string) => (store.get(k) ?? null) as T | null, set: async (k, v) => { store.set(k, v); } },
    post: async (_as, _c, _r, text) => { if (fail) throw new Error("403"); posts.push(text); },
    hasBot: () => true, agentName: (id) => id, archive: async () => {}, channelName: async () => "",
    task: async () => ({ identifier: "BAD-1", title: "T", status: "done", assigneeAgentId: "a-ceo" }),
    comments: async () => [],
  });
  await assert.rejects(work.threadUpdate("issue-9"));
  fail = false;
  await work.threadUpdate("issue-9");
  assert.equal(posts.length, 1);
});
