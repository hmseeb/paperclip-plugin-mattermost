import { test } from "node:test";
import assert from "node:assert/strict";
import { Approvals, parseApprovers, render, sign, type ApprovalInfo } from "../src/approvals.ts";

const KEY = "k";
const URL_ = "https://pc.example/api/plugins/mattermost-bridge/webhooks/actions";

function setup(opts: { active?: boolean; fallback?: string } = {}) {
  const approvals = new Map<string, ApprovalInfo>([["ap1", {
    id: "ap1", type: "request_board_approval", status: "pending", requestedByAgentId: "a-cto", decidedByUserId: null,
    payload: { title: "Approve hosting spend", summary: "$42/month", recommendedAction: "Approve", risks: ["May grow"] },
  }]]);
  const posts: { id: string; as: string | null; channelId: string; rootId: string; message: string; props: any }[] = [];
  const decisions: { id: string; action: string; actor: string; note: string }[] = [];
  const state = new Map<string, unknown>();
  const a = new Approvals({
    poster: {
      async post(agentId, where, message, props) { const id = `p${posts.length + 1}`; posts.push({ id, as: agentId, ...where, message, props }); return id; },
      async patch(postId, message, props) { Object.assign(posts.find((p) => p.id === postId)!, { message, props }); },
      async channel(name) { return name === "approvals" ? "c-approvals" : null; },
      async email(uid) { return uid === "mm-sam" ? "Sam@Example.com" : "stranger@x.com"; },
    },
    activeThread: (agentId) => (opts.active && agentId === "a-cto" ? { channelId: "c-dm", rootId: "root1" } : null),
    agentName: () => "CTO",
    get: async (id) => approvals.get(id) ?? null,
    async decide(id, action, actor, note) {
      decisions.push({ id, action, actor, note });
      Object.assign(approvals.get(id)!, { status: action === "approve" ? "approved" : "rejected", decidedByUserId: actor });
    },
    store: { async get<T>(k: string) { return (state.get(k) ?? null) as T | null; }, async set(k, v) { state.set(k, v); } },
    actionUrl: URL_, key: KEY, fallbackChannel: opts.fallback ?? "",
    approvers: parseApprovers("# board\nsam@example.com = u-sam\nnot a line\n"),
  });
  const click = (user: string, action: string, sig = sign(KEY, "ap1", action)) =>
    a.click({ user_id: user, user_name: user.replace("mm-", ""), context: { approvalId: "ap1", action, sig } });
  return { a, posts, decisions, click, approvals };
}

test("an approval raised while the agent answers a thread goes to that thread and the approvals channel", async () => {
  const t = setup({ active: true, fallback: "approvals" });
  await t.a.created("ap1");
  await t.a.created("ap1"); // the event may arrive twice
  assert.deepEqual(t.posts.map((p) => [p.as, p.channelId, p.rootId]), [["a-cto", "c-dm", "root1"], ["a-cto", "c-approvals", ""]]);
  const att = t.posts[0].props.attachments[0];
  assert.equal(att.title, "Approve hosting spend");
  assert.match(att.text, /\$42\/month[\s\S]*\*\*Recommended:\*\* Approve[\s\S]*- May grow/);
  assert.deepEqual(att.actions.map((x: any) => x.integration.context.action), ["approve", "reject"]);
  assert.equal(att.actions[0].integration.url, URL_);
  assert.equal(att.actions[0].integration.context.sig, sign(KEY, "ap1", "approve"));
});

test("without a thread it goes to the approvals channel only, and with neither nowhere", async () => {
  const t = setup({ fallback: "approvals" });
  await t.a.created("ap1");
  assert.deepEqual(t.posts.map((p) => [p.channelId, p.rootId]), [["c-approvals", ""]]);
  const none = setup();
  await none.a.created("ap1");
  assert.equal(none.posts.length, 0);
});

test("deciding on one card closes both", async () => {
  const t = setup({ active: true, fallback: "approvals" });
  await t.a.created("ap1");
  assert.equal(await t.click("mm-sam", "reject"), null);
  assert.deepEqual(t.posts.map((p) => p.props.attachments[0].footer), [":x: Rejected by @sam", ":x: Rejected by @sam"]);
  assert.deepEqual(t.posts.map((p) => p.props.attachments[0].actions.length), [0, 0]);
});

test("a mapped approver's click decides it as their Paperclip user and closes the buttons", async () => {
  const t = setup({ active: true });
  await t.a.created("ap1");
  assert.equal(await t.click("mm-sam", "approve"), null);
  assert.deepEqual(t.decisions, [{ id: "ap1", action: "approve", actor: "u-sam", note: "Decided from Mattermost by @sam" }]);
  const att = t.posts[0].props.attachments[0];
  assert.deepEqual(att.actions, []);
  assert.equal(att.footer, ":white_check_mark: Approved by @sam");
  await t.a.decided("ap1"); // Paperclip's own approval.decided event afterwards keeps the name
  assert.equal(t.posts[0].props.attachments[0].footer, ":white_check_mark: Approved by @sam");
});

test("forged, replayed-for-another-action, and unmapped clicks decide nothing", async () => {
  const t = setup({ active: true });
  await t.a.created("ap1");
  assert.match((await t.click("mm-sam", "approve", "deadbeef"))!, /not valid/);
  assert.match((await t.click("mm-sam", "reject", sign(KEY, "ap1", "approve")))!, /not valid/);
  assert.match((await t.click("mm-sam", "approve", sign("other-key", "ap1", "approve")))!, /not valid/);
  assert.match((await t.click("mm-mallory", "approve"))!, /not set up/);
  assert.equal(t.decisions.length, 0);
});

test("a decision made in Paperclip updates the post with the approver's email", async () => {
  const t = setup({ active: true });
  await t.a.created("ap1");
  Object.assign(t.approvals.get("ap1")!, { status: "rejected", decidedByUserId: "u-sam" });
  await t.a.decided("ap1");
  assert.equal(t.posts[0].props.attachments[0].footer, ":x: Rejected by sam@example.com");
});

test("render falls back to the type when the payload has no title", () => {
  const r = render({ id: "x", type: "hire_agent", status: "pending", requestedByAgentId: null, decidedByUserId: null, payload: {} }, "CEO", URL_, KEY);
  assert.equal(r.message, "**Hire request** from CEO");
  assert.equal((r.props.attachments as any)[0].title, "Hire request");
});
