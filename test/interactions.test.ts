import { test } from "node:test";
import assert from "node:assert/strict";
import { Cards, type Card, type OpenIssue } from "../src/interactions.ts";
import { sign } from "../src/approvals.ts";

const KEY = "k";
const T0 = "2026-10-28T00:00:00.000Z";
const later = "2026-10-28T01:00:00.000Z";
const before = "2026-10-27T23:00:00.000Z";

function setup() {
  const issues: OpenIssue[] = [{ id: "i1", identifier: "BAD-9", title: "Launch site", assigneeAgentId: "a-cto" }];
  const byIssue = new Map<string, Card[]>([["i1", [
    { id: "old", issueId: "i1", kind: "request_confirmation", status: "pending", createdAt: before, payload: { prompt: "Old?" } },
  ]]]);
  const posts: { id: string; as: string | null; channelId: string; message: string; props: any }[] = [];
  const responses: unknown[] = [];
  const comments: { issueId: string; body: string; actor: string }[] = [];
  const state = new Map<string, unknown>();
  const c = new Cards({
    poster: {
      async post(agentId, where, message, props) { const id = `p${posts.length + 1}`; posts.push({ id, as: agentId, channelId: where.channelId, message, props }); return id; },
      async patch(postId, message, props) { Object.assign(posts.find((p) => p.id === postId)!, { message, props }); },
      async channel(name) { return name === "decisions" ? "c-dec" : null; },
      async email(uid) { return uid === "mm-sam" ? "sam@example.com" : null; },
    },
    openIssues: async () => issues,
    cards: async (id) => byIssue.get(id) ?? [],
    async respond(issueId, cardId, action, actor, reason) {
      responses.push({ issueId, cardId, action, actor, reason });
      const card = byIssue.get(issueId)!.find((x) => x.id === cardId)!;
      Object.assign(card, { status: action === "accept" ? "accepted" : "rejected", resolvedByUserId: actor });
    },
    async comment(issueId, body, actor) { comments.push({ issueId, body, actor }); },
    agentName: (id) => (id === "a-ceo" ? "CEO" : "CTO"),
    store: { async get<T>(k: string) { return (state.get(k) ?? null) as T | null; }, async set(k, v) { state.set(k, v); } },
    actionUrl: "https://pc/hook", key: KEY, paperclipUrl: "https://pc", channel: "decisions",
    approvers: new Map([["sam@example.com", "u-sam"]]),
    now: () => new Date(T0),
  });
  const add = (card: Card) => byIssue.get("i1")!.push(card);
  return { c, posts, responses, comments, add, byIssue };
}

test("cards raised after the first run are posted to the channel, as the agent that raised them; older ones are not", async () => {
  const t = setup();
  await t.c.poll();
  assert.equal(t.posts.length, 0);
  t.add({ id: "k1", issueId: "i1", kind: "request_confirmation", status: "pending", createdAt: later, createdByAgentId: "a-ceo",
    payload: { prompt: "Ship the pricing page?", detailsMarkdown: "Copy is final.", acceptLabel: "Ship it", rejectLabel: "Hold" } });
  await t.c.poll();
  await t.c.poll(); // not twice
  assert.equal(t.posts.length, 1);
  const p = t.posts[0];
  assert.deepEqual([p.as, p.channelId], ["a-ceo", "c-dec"]);
  assert.equal(p.message, "**Decision needed** from CEO on [BAD-9: Launch site](https://pc/issues/BAD-9)");
  const att = p.props.attachments[0];
  assert.equal(att.title, "Ship the pricing page?");
  assert.equal(att.text, "Copy is final.");
  assert.deepEqual(att.actions.map((a: any) => a.name), ["Ship it", "Hold"]);
  assert.equal(att.actions[0].integration.context.sig, sign(KEY, "card:i1:k1", "accept"));
});

test("a multiple-choice question is shown with its options and a link, without buttons", async () => {
  const t = setup();
  await t.c.poll();
  t.add({ id: "q1", issueId: "i1", kind: "ask_user_questions", status: "pending", createdAt: later,
    payload: { questions: [{ prompt: "Which CMS?", selectionMode: "single", options: [{ label: "Sanity" }, { label: "Contentful" }] }] } });
  await t.c.poll();
  const att = t.posts[0].props.attachments[0];
  assert.match(t.posts[0].message, /^\*\*Question\*\* from CTO/);
  assert.equal(att.text, "**Which CMS?**\n- Sanity\n- Contentful");
  assert.deepEqual(att.actions, []);
  assert.match(att.footer, /Answer it in Paperclip/);
});

test("an approver's click resolves the card as their Paperclip user; others and forgeries are refused", async () => {
  const t = setup();
  await t.c.poll();
  t.add({ id: "k1", issueId: "i1", kind: "suggest_tasks", status: "pending", createdAt: later, payload: { tasks: [{ title: "Write copy" }, { title: "Pick images" }] } });
  await t.c.poll();
  assert.equal(t.posts[0].props.attachments[0].text, "- Write copy\n- Pick images");
  const ctx = (action: string, sig = sign(KEY, "card:i1:k1", action)) => ({ kind: "card", issueId: "i1", cardId: "k1", action, sig });
  assert.match((await t.c.click({ user_id: "mm-sam", context: ctx("accept", "bad") }))!, /not valid/);
  assert.match((await t.c.click({ user_id: "mm-sam", context: { ...ctx("accept"), cardId: "other" } }))!, /not valid/);
  assert.match((await t.c.click({ user_id: "mm-x", context: ctx("accept") }))!, /not set up/);
  assert.equal(await t.c.click({ user_id: "mm-sam", user_name: "sam", context: ctx("accept") }), null);
  assert.deepEqual(t.responses, [{ issueId: "i1", cardId: "k1", action: "accept", actor: "u-sam", reason: "Accepted from Mattermost by @sam" }]);
  const att = t.posts[0].props.attachments[0];
  assert.deepEqual(att.actions, []);
  assert.equal(att.footer, ":white_check_mark: Accepted by @sam");
  await t.c.poll(); // nothing left to update, the name stays
  assert.equal(t.posts[0].props.attachments[0].footer, ":white_check_mark: Accepted by @sam");
});

test("a card resolved in Paperclip, or gone with its closed task, is closed in Mattermost", async () => {
  const t = setup();
  await t.c.poll();
  t.add({ id: "k1", issueId: "i1", kind: "request_confirmation", status: "pending", createdAt: later, payload: { prompt: "A?" } });
  t.add({ id: "q1", issueId: "i1", kind: "ask_user_questions", status: "pending", createdAt: later, payload: { questions: [] } });
  await t.c.poll();
  Object.assign(t.byIssue.get("i1")!.find((c) => c.id === "k1")!, { status: "rejected", resolvedByUserId: "u-sam" });
  Object.assign(t.byIssue.get("i1")!.find((c) => c.id === "q1")!, { status: "answered" });
  await t.c.poll();
  assert.deepEqual(t.posts.map((p) => p.props.attachments[0].footer), ["Rejected by sam@example.com", ":white_check_mark: Answered"].map((f, i) => (i === 0 ? ":x: " + f : f)));
});

const question = (qs: unknown[]): Card => ({ id: "q1", issueId: "i1", kind: "ask_user_questions", status: "pending", createdAt: later, title: "Launch choices", payload: { questions: qs } });
const pickCtx = (q: string, o: string) => { const action = `pick:${q}:${o}`; return { kind: "card", issueId: "i1", cardId: "q1", action, sig: sign(KEY, "card:i1:q1", action) }; };

test("questions: each option is a button, and one pick on a one-question card sends the answer as the picker's comment", async () => {
  const t = setup();
  await t.c.poll();
  t.add(question([{ id: "cms", prompt: "Which CMS?", selectionMode: "single", allowOther: true, options: [{ id: "s", label: "Sanity" }, { id: "c", label: "Contentful" }] }]));
  await t.c.poll();
  const att = t.posts[0].props.attachments;
  assert.equal(att.length, 1);
  assert.deepEqual(att[0].actions.map((a: any) => a.name), ["Sanity", "Contentful"]);
  assert.match(att[0].text, /Or answer something else in Paperclip/);
  assert.equal(await t.c.click({ user_id: "mm-sam", user_name: "sam", context: pickCtx("cms", "c") }), null);
  assert.deepEqual(t.comments, [{ issueId: "i1", actor: "u-sam", body: 'Answer to "Launch choices" (question q1), sent from Mattermost:\n\n- Which CMS? **Contentful**' }]);
  const after = t.posts[0].props.attachments[0];
  assert.deepEqual(after.actions, []);
  assert.match(after.text, /Answer: \*\*Contentful\*\*/);
  assert.match(after.footer, /Answered by @sam from Mattermost/);
  assert.match((await t.c.click({ user_id: "mm-sam", context: pickCtx("cms", "s") }))!, /already been answered/);
  assert.equal(t.comments.length, 1);
});

test("questions: with two questions the answers are sent together, after both are picked", async () => {
  const t = setup();
  await t.c.poll();
  t.add(question([
    { id: "a", prompt: "Region?", options: [{ id: "us", label: "US" }, { id: "eu", label: "EU" }] },
    { id: "b", prompt: "Tier?", options: [{ id: "pro", label: "Pro" }] },
  ]));
  await t.c.poll();
  await t.c.click({ user_id: "mm-sam", user_name: "sam", context: pickCtx("a", "eu") });
  assert.equal(t.comments.length, 0);
  assert.equal(t.posts[0].props.attachments[0].actions[1].name, "✓ EU");
  await t.c.click({ user_id: "mm-sam", user_name: "sam", context: pickCtx("b", "pro") });
  assert.equal(t.comments.length, 1);
  assert.match(t.comments[0].body, /- Region\? \*\*EU\*\*\n- Tier\? \*\*Pro\*\*$/);
});

test("questions: forged or unmapped picks send nothing; multi-choice questions stay link-only", async () => {
  const t = setup();
  await t.c.poll();
  t.add(question([{ id: "cms", prompt: "Which CMS?", options: [{ id: "s", label: "Sanity" }] }]));
  await t.c.poll();
  assert.match((await t.c.click({ user_id: "mm-sam", context: { ...pickCtx("cms", "s"), sig: "x" } }))!, /not valid/);
  assert.match((await t.c.click({ user_id: "mm-x", context: pickCtx("cms", "s") }))!, /not set up/);
  assert.equal(t.comments.length, 0);
  const m = setup();
  await m.c.poll();
  m.add(question([{ id: "x", prompt: "Pick any", selectionMode: "multi", options: [{ id: "1", label: "One" }] }]));
  await m.c.poll();
  assert.deepEqual(m.posts[0].props.attachments[0].actions, []);
});
