import { test } from "node:test";
import assert from "node:assert/strict";
import { missedRun, RoutineReports, type RoutineTask } from "../src/routines.ts";

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

const W = 7 * DAY;
test("missedRun: a run made at this time the last two weeks, not made now", () => {
  const daily = Array.from({ length: 15 }, (_, d) => d * DAY); // days 0..14
  assert.equal(missedRun(daily, 15 * DAY + 1 * H), null, "within the grace");
  assert.equal(missedRun(daily, 15 * DAY + 3 * H), 15 * DAY);
  assert.equal(missedRun([...daily, 15 * DAY + H], 15 * DAY + 5 * H), null, "ran an hour late (clock change): fine");
  assert.equal(missedRun(daily.slice(7), 15 * DAY + 3 * H), null, "only one week of history");
  assert.equal(missedRun([0], W + 3 * H), null, "a one-off");
  assert.equal(missedRun(daily, 30 * DAY), null, "stopped weeks ago: no pattern left to expect");
  // Weekdays only: days 5 and 6 of each week are off.
  const weekdays = Array.from({ length: 21 }, (_, d) => d * DAY).filter((t) => ![5, 6].includes((t / DAY) % 7));
  assert.equal(missedRun(weekdays.filter((t) => t < 19 * DAY), 19 * DAY + 3 * H), null, "a Saturday: no run expected");
  assert.equal(missedRun(weekdays.filter((t) => t < 21 * DAY), 21 * DAY + 3 * H), 21 * DAY, "the Monday after: expected");
});

test("a missed routine is warned about once, in its agent's channel", async () => {
  const days = Array.from({ length: 15 }, (_, d) => run({ id: `r${d}`, identifier: `BAD-${100 + d}`, status: "done", createdAt: new Date(Date.UTC(2026, 9, 21 + d, 15)) }));
  const t = setup(days, { now: Date.UTC(2026, 10, 5, 19) });
  await t.r.checkMissed();
  await t.r.checkMissed();
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].text, ":warning: **Daily client report** missed its Thu 15:00 UTC run (it ran at that time the last two weeks). Last run: 2026-11-04 15:00 UTC (**BAD-114**). Check the routine in Paperclip; if it was paused on purpose, ignore this.");
});
