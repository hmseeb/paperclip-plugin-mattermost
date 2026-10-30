import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoChannels, type AutoTask } from "../src/autochannels.ts";

function setup(tasks: AutoTask[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const store = new Map<string, unknown>();
  const opened: { owner: string; task: string }[] = [];
  const added: { channelId: string; agents: string[]; users: string[] }[] = [];
  const posts: { as: string; channelId: string; text: string }[] = [];
  const auto = new AutoChannels({
    store: { get: async <T,>(k: string) => (store.get(k) ?? null) as T | null, set: async (k, v) => { store.set(k, v); } },
    task: async (id) => byId.get(id) ?? null,
    comments: async () => [{ body: "Numbers checked." }],
    hasBot: (id) => id.startsWith("a-"),
    agentName: (id) => id.slice(2).toUpperCase(),
    open: async (owner, t) => { opened.push({ owner, task: t.id }); return `ch-${t.id}`; },
    add: async (channelId, agents, users) => { added.push({ channelId, agents, users }); return users.filter((u) => u === "u-unknown"); },
    post: async (as, channelId, text) => { posts.push({ as, channelId, text }); },
  });
  const set = (t: AutoTask) => byId.set(t.id, t);
  return { auto, opened, added, posts, store, set };
}

const base = { status: "todo", title: "T" };

test("rule 1: an agent's task assigned to a person gets a channel with the agent, the person and who asked", async () => {
  const t = setup([{ id: "t1", identifier: "BAD-1", ...base, assigneeAgentId: "a-cto", assigneeUserId: "u-greg", responsibleUserId: "u-haseeb" }]);
  await t.auto.changed("t1");
  await t.auto.changed("t1"); // events come more than once
  assert.deepEqual(t.opened, [{ owner: "a-cto", task: "t1" }]);
  assert.deepEqual(t.added[0], { channelId: "ch-t1", agents: ["a-cto"], users: ["u-greg", "u-haseeb"] });
  assert.match(t.posts[0].text, /people and agents are working on it together/);
});

test("rule 1: a person as reviewer counts; a person who only asked does not", async () => {
  const t = setup([
    { id: "r", ...base, assigneeAgentId: "a-cto", executionPolicy: { stages: [{ participants: [{ type: "user", userId: "u-greg" }, { type: "agent", agentId: "a-rev" }] }] } },
    { id: "plain", ...base, assigneeAgentId: "a-cto", responsibleUserId: "u-haseeb" },
  ]);
  await t.auto.changed("r");
  await t.auto.changed("plain");
  assert.deepEqual(t.opened.map((o) => o.task), ["r"]);
});

test("rule 2: subtasks with two other agents open a channel on the parent; one other agent does not", async () => {
  const t = setup([
    { id: "p", identifier: "BAD-9", ...base, assigneeAgentId: "a-ceo", responsibleUserId: "u-haseeb" },
    { id: "k1", ...base, parentId: "p", assigneeAgentId: "a-cfo" },
    { id: "k2", ...base, parentId: "p", assigneeAgentId: "a-cfo" },
    { id: "k3", ...base, parentId: "p", assigneeAgentId: "a-cmo" },
  ]);
  await t.auto.changed("k1");
  await t.auto.changed("k2");
  assert.equal(t.opened.length, 0, "only the CFO so far");
  await t.auto.changed("k3");
  assert.deepEqual(t.opened, [{ owner: "a-ceo", task: "p" }]);
  assert.deepEqual(t.added[0], { channelId: "ch-p", agents: ["a-ceo", "a-cfo", "a-cmo"], users: ["u-haseeb"] });
  assert.match(t.posts[0].text, /several agents are working on it/);
});

test("agents and people joining later are added; subtask outcomes are noted once; closed and single-agent tasks get nothing", async () => {
  const t = setup([
    { id: "p", identifier: "BAD-9", ...base, assigneeAgentId: "a-ceo" },
    { id: "k1", identifier: "BAD-10", ...base, title: "Scorecard", parentId: "p", assigneeAgentId: "a-cfo" },
    { id: "k2", ...base, parentId: "p", assigneeAgentId: "a-cmo" },
    { id: "solo", ...base, assigneeAgentId: "a-cto" },
    { id: "shut", ...base, status: "done", assigneeAgentId: "a-cto", assigneeUserId: "u-greg" },
  ]);
  await t.auto.changed("k1");
  await t.auto.changed("k2");
  t.set({ id: "k3", ...base, parentId: "p", assigneeAgentId: "a-growth" });
  await t.auto.changed("k3");
  assert.deepEqual(t.added.at(-1), { channelId: "ch-p", agents: ["a-growth"], users: [] });
  t.set({ id: "k1", identifier: "BAD-10", ...base, title: "Scorecard", status: "done", parentId: "p", assigneeAgentId: "a-cfo" });
  await t.auto.changed("k1");
  await t.auto.changed("k1");
  const notes = t.posts.filter((p) => p.text.includes("Subtask"));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^:white_check_mark: Subtask \*\*BAD-10\*\* Scorecard is done _\(CFO\)_\.\n\nNumbers checked\./);
  assert.equal(notes[0].as, "a-ceo", "posted by the channel's owner, who is in it");
  await t.auto.changed("solo");
  await t.auto.changed("shut");
  assert.deepEqual(t.opened.map((o) => o.task), ["p"]);
});

test("a task an agent already opened a channel for is left alone; people not found are named", async () => {
  const t = setup([
    { id: "m", ...base, assigneeAgentId: "a-cto", assigneeUserId: "u-greg" },
    { id: "x", ...base, assigneeAgentId: "a-cto", assigneeUserId: "u-unknown" },
  ]);
  t.store.set("taskchannel:m", "manual");
  await t.auto.changed("m");
  await t.auto.changed("x");
  assert.deepEqual(t.opened.map((o) => o.task), ["x"]);
  assert.match(t.posts[0].text, /Could not add u-unknown/);
});
