import { test } from "node:test";
import assert from "node:assert/strict";
import { lateBy, RoutineReports, type RoutineTask } from "../src/routines.ts";

const H = 3_600_000, DAY = 24 * H;

function setup(tasks: RoutineTask[], opts: { results?: string[]; channel?: boolean; now?: number; comments?: string[] } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const store = new Map<string, unknown>();
  const posts: { as: string; channelId: string; text: string }[] = [];
  let fail = false;
  const r = new RoutineReports({
    store: { get: async <T,>(k: string) => (store.has(k) ? structuredClone(store.get(k)) : null) as T | null, set: async (k, v) => { store.set(k, v); } },
    task: async (id) => byId.get(id) ?? null,
    comments: async () => (opts.comments ?? ["GHL login expired; need someone to sign in."]).map((body, i) => ({ id: `c${i}`, body, createdAt: new Date() })),
    runs: async () => [...byId.values()],
    channelFor: async () => (opts.channel === false ? null : { channelId: "client-reporting" }),
    postsResults: (a) => (opts.results ?? []).includes(a),
    post: async (as, channelId, text) => { if (fail) throw new Error("down"); posts.push({ as, channelId, text }); },
    mention: async (u) => (u === "u-greg" ? "@greg" : null),
    agentName: (a) => a.slice(2).toUpperCase(),
    now: () => opts.now ?? Date.now(),
    sleep: async () => {},
  });
  return { r, posts, store, set: (t: RoutineTask) => byId.set(t.id, t), failNext: (v: boolean) => { fail = v; } };
}

const run = (over: Partial<RoutineTask>): RoutineTask => ({ id: "t1", identifier: "BAD-1412", title: "Daily client report", status: "in_progress", originKind: "routine_execution", originId: "rt1", assigneeAgentId: "a-reporting", ...over });

test("a routine run that gets blocked is posted once, mentioning who it needs; one that finishes stays quiet", async () => {
  const t = setup([run({ responsibleUserId: "u-greg" })]);
  await t.r.updated("t1");
  assert.equal(t.posts.length, 0, "running: nothing");
  t.set(run({ status: "blocked", responsibleUserId: "u-greg" }));
  await t.r.updated("t1");
  await t.r.updated("t1");
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].channelId, "client-reporting");
  assert.equal(t.posts[0].as, "a-reporting");
  assert.match(t.posts[0].text, /^:pause_button: Blocked · \*\*BAD-1412\*\* Daily client report · REPORTING\n_Routine run, needs @greg\._\n\n> GHL login expired/);
  t.set(run({ status: "done" }));
  await t.r.updated("t1");
  assert.equal(t.posts.length, 1, "done: silent");
});

test("agents set to post routine results get each finished run, with its result", async () => {
  const t = setup([run({ status: "done" })], { results: ["a-reporting"], comments: ["Ryan's Auto: 41 calls, 12 booked."] });
  await t.r.updated("t1");
  assert.equal(t.posts.length, 1);
  assert.match(t.posts[0].text, /^:white_check_mark: Done · \*\*BAD-1412\*\* Daily client report · REPORTING\n\nRyan's Auto: 41 calls/);
});

test("other tasks, agents with no channel and failed posts", async () => {
  const t = setup([run({ id: "m", status: "blocked", originKind: "manual" })]);
  await t.r.updated("m");
  assert.equal(t.posts.length, 0, "not a routine run");
  const n = setup([run({ status: "blocked" })], { channel: false });
  await n.r.updated("t1");
  assert.equal(n.posts.length, 0, "nowhere to post");
  const f = setup([run({ status: "blocked" })]);
  f.failNext(true);
  await assert.rejects(f.r.updated("t1"));
  f.failNext(false);
  await f.r.updated("t1");
  assert.equal(f.posts.length, 1, "retried on the next update");
  assert.match(f.posts[0].text, /needs a person/);
});

test("lateBy: a steady routine overdue by an eighth of its interval; not before, not irregular ones, not long-stopped ones", () => {
  const daily = [0, 1, 2, 3].map((d) => d * DAY);
  assert.equal(lateBy(daily, 4 * DAY + 2 * H), null, "2 hours late: not yet");
  assert.deepEqual(lateBy(daily, 4 * DAY + 4 * H), { interval: DAY, last: 3 * DAY });
  assert.equal(lateBy(daily.slice(0, 3), 5 * DAY), null, "too few runs to know its rhythm");
  assert.equal(lateBy([0, DAY, 3 * DAY, 4 * DAY], 6 * DAY), null, "irregular");
  assert.equal(lateBy(daily, 7 * DAY), null, "idle for over three intervals: stopped on purpose");
  const hourly = [0, 1, 2, 3, 4].map((h) => h * H);
  assert.equal(lateBy(hourly, 5.5 * H), null, "at least an hour late");
  assert.ok(lateBy(hourly, 6.1 * H));
});

test("a missed routine is warned about once, in its agent's channel", async () => {
  const days = [0, 1, 2, 3].map((d) => run({ id: `r${d}`, identifier: `BAD-${100 + d}`, status: "done", createdAt: new Date(Date.UTC(2026, 10, 1 + d, 15)) }));
  const t = setup(days, { now: Date.UTC(2026, 10, 5, 19) });
  await t.r.checkMissed();
  await t.r.checkMissed();
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].text, ":warning: **Daily client report** has not run. It usually runs every day; the last run was 2026-11-04 15:00 UTC (**BAD-103**). Check the routine in Paperclip; if it was paused on purpose, ignore this.");
});
