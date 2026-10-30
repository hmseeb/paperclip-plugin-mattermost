import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { choiceProps, chosenProps, extractChoices, verifyChoice } from "../src/choices.ts";
import { diskFiles, type Files } from "../src/files.ts";
import { absoluteLinks, Bridge, linkTasks, botUsername, mentions, splitMessage, stripMention, type Member, type PostedEvent, type Post } from "../src/bridge.ts";

const MANAGER = "mgr";

type Reply = (sessionId: string, prompt: string) => Promise<string | null>;
function setup(opts: { reply?: Reply; files?: Files; buttons?: boolean; canTalk?: (userId: string, agentId: string) => Promise<boolean>; turnLimit?: number } = {}) {
  const posts: { id: string; by: string; channelId: string; rootId: string; message: string; props?: Record<string, unknown> }[] = [];
  const typings: { at: number; channelId: string; rootId: string }[] = [];
  const notes: { userId: string; channelId: string; rootId: string; text: string }[] = [];
  const reactions: { by: string; postId: string; emoji: string }[] = [];
  const uploads: { by: string; rootId: string; message: string; files: { name: string; text: string }[] }[] = [];
  const sessions: { agentId: string; taskKey: string; id: string }[] = [];
  const prompts: { sessionId: string; prompt: string }[] = [];
  const joined: { channelId: string; userId: string }[] = [];
  const state = new Map<string, unknown>();
  const humanPosts: Post[] = [];
  let n = 0;
  const member = (agentId: string, agentName: string, botUserId: string): Member => ({
    agentId, agentName, botUserId, username: botUsername(agentName),
    chat: {
      async createPost(channelId, rootId, message, props) { const id = `p${++n}`; posts.push({ id, by: botUserId, channelId, rootId, message, props }); return { id }; },
      async typing(channelId, rootId) { typings.push({ at: Date.now(), channelId, rootId }); },
      async react(postId, emoji) { reactions.push({ by: botUserId, postId, emoji }); },
      async download(id) { return { name: `${id}.txt`, data: new TextEncoder().encode(`contents of ${id}`) }; },
      async upload(_c, rootId, message, files) { uploads.push({ by: botUserId, rootId, message, files: files.map((f) => ({ name: f.name, text: new TextDecoder().decode(f.data) })) }); },
    },
  });
  const members = [member("a-ceo", "CEO", "bot-ceo"), member("a-cto", "CTO", "bot-cto"), member("a-csm", "Client Success Manager", "bot-csm")];
  const roster = {
    byBotId: (id: string) => members.find((m) => m.botUserId === id),
    byUsername: (u: string) => members.find((m) => m.username === u.toLowerCase()),
    byAgentId: (id: string) => members.find((m) => m.agentId === id),
    isBot: (id: string) => members.some((m) => m.botUserId === id),
  };
  const directory = {
    async userName(id: string) { return { username: id, displayName: `User ${id}` }; },
    async threadPosts(rootId: string) {
      return [...humanPosts.filter((p) => p.id === rootId || p.root_id === rootId),
        ...posts.filter((p) => p.rootId === rootId).map((p) => ({ id: p.id, user_id: p.by, channel_id: p.channelId, root_id: rootId, message: p.message }))];
    },
    async ensureMember(channelId: string, userId: string) { joined.push({ channelId, userId }); },
    async notify(userId: string, channelId: string, rootId: string, text: string) { notes.push({ userId, channelId, rootId, text }); },
  };
  const agents = {
    async createSession(agentId: string, taskKey: string) { const id = `s${sessions.length + 1}`; sessions.push({ agentId, taskKey, id }); return id; },
    async ask(sessionId: string, prompt: string) { prompts.push({ sessionId, prompt }); return opts.reply ? opts.reply(sessionId, prompt) : `reply from ${sessionId}`; },
  };
  const store = { async get<T>(k: string) { return (state.get(k) ?? null) as T | null; }, async set(k: string, v: unknown) { state.set(k, v); } };
  const bridge = new Bridge(() => roster, directory, agents, store, () => {}, opts.files ?? null,
    opts.buttons ? (where, choices) => choiceProps("k", "https://pc/actions", where, choices) : null, opts.canTalk ?? null, opts.turnLimit);
  const handle = (e: PostedEvent) => { humanPosts.push(e.post); return bridge.handle(e); };
  return { handle, posts, typings, uploads, reactions, notes, sessions, prompts, joined, state, bridge, humanPosts };
}

let seq = 0;
const evt = (message: string, o: Partial<Post> & { channelType?: string; channelName?: string } = {}): PostedEvent => ({
  post: { id: o.id ?? `u${++seq}`, user_id: o.user_id ?? "alice", channel_id: o.channel_id ?? "c1", root_id: o.root_id ?? "", message, type: o.type ?? "", props: o.props ?? {}, file_ids: o.file_ids },
  channelType: o.channelType ?? "O",
  channelName: o.channelName ?? "general",
});

test("a direct message goes to the agent whose bot it was sent to, and that bot replies", async () => {
  const t = setup();
  await t.handle(evt("hello there", { id: "m1", channelType: "D", channelName: "alice__bot-cto" }));
  assert.deepEqual(t.sessions, [{ agentId: "a-cto", taskKey: "mattermost:m1", id: "s1" }]);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].by, "bot-cto");
  assert.equal(t.posts[0].message, "reply from s1");
  assert.deepEqual(t.reactions, [{ by: "bot-cto", postId: "m1", emoji: "eyes" }]);
  assert.match(t.prompts[0].prompt, /User alice \(@alice\) wrote to you \(@cto\) in a direct message/);
  assert.deepEqual(t.joined, []);
});

test("in a channel only a mention of an agent bot gets an answer, from that bot, which joins first", async () => {
  const t = setup();
  await t.handle(evt("no mention here"));
  await t.handle(evt("@someone-else hi"));
  assert.equal(t.posts.length, 0);
  await t.handle(evt("@client-success-manager can you check the renewal?", { id: "m2", channel_id: "c9" }));
  assert.equal(t.sessions[0].agentId, "a-csm");
  assert.equal(t.posts[0].by, "bot-csm");
  assert.deepEqual(t.joined, [{ channelId: "c9", userId: "bot-csm" }]);
  assert.match(t.prompts[0].prompt, /in #general/);
  assert.match(t.prompts[0].prompt, /can you check the renewal\?$/);
});

test("with two agents mentioned, the first one answers", async () => {
  const t = setup();
  await t.handle(evt("@cto and @ceo, thoughts?"));
  assert.equal(t.sessions[0].agentId, "a-cto");
});

test("follow-ups in the thread continue the same agent and session without a mention", async () => {
  const t = setup();
  await t.handle(evt("@ceo first", { id: "root" }));
  await t.handle(evt("second, no mention", { root_id: "root" }));
  assert.equal(t.sessions.length, 1);
  assert.deepEqual(t.prompts.map((p) => p.sessionId), ["s1", "s1"]);
  assert.ok(t.posts.every((p) => p.by === "bot-ceo"));
});

test("mentioning another agent in the thread hands the thread to it", async () => {
  const t = setup();
  await t.handle(evt("@ceo budget?", { id: "root" }));
  await t.handle(evt("@cto what about infra cost?", { root_id: "root" }));
  assert.deepEqual(t.sessions.map((s) => s.agentId), ["a-ceo", "a-cto"]);
  assert.equal(t.posts.at(-1)!.by, "bot-cto");
});

test("a follow-up carries the thread so far, oldest first, other bots by name", async () => {
  const t = setup({ reply: async (sid) => (sid === "s1" ? "PONG" : "ack") });
  await t.handle(evt("@ceo say PONG", { id: "root" }));
  await t.handle(evt("@cto what did the CEO say?", { root_id: "root" }));
  const p = t.prompts[1].prompt;
  assert.match(p, /Earlier in this thread \(oldest first\):\n@alice: @ceo say PONG\n@ceo: PONG\n\nNew message:\n\nwhat did the CEO say\?$/);
  assert.doesNotMatch(t.prompts[0].prompt, /Earlier in this thread/);
});

test("the same post arriving on several sockets is answered once", async () => {
  const t = setup();
  const e = evt("@ceo hi", { id: "dup" });
  await Promise.all([t.handle(e), t.handle(e), t.handle(e)]);
  assert.equal(t.sessions.length, 1);
  assert.equal(t.posts.length, 1);
});

test("ignores other bots, webhooks, system posts, plugin task updates, and agents talking to no one", async () => {
  const t = setup();
  await t.handle(evt("@ceo hi", { props: { from_bot: "true" }, user_id: "some-other-bot" }));
  await t.handle(evt("@ceo hi", { props: { from_webhook: "true" } }));
  await t.handle(evt("@ceo hi", { type: "system_join_channel" }));
  await t.handle(evt("@ceo hi", { user_id: "bot-cto", props: { from_bot: "true", from_paperclip: "true" } }));
  await t.handle(evt("status update, no mention", { user_id: "bot-cto", props: { from_bot: "true" } }));
  await t.handle(evt("@cto note to self", { user_id: "bot-cto", props: { from_bot: "true" } }));
  await t.handle(evt("hi", { channelType: "D", channelName: "alice__some-human" }));
  assert.equal(t.posts.length, 0);
  assert.equal(t.sessions.length, 0);
});

test("an agent mentioning another agent starts it, which answers in the thread", async () => {
  const t = setup();
  await t.handle(evt("@ceo can you take a look?", { id: "m1", user_id: "bot-cto", props: { from_bot: "true" } }));
  assert.deepEqual(t.sessions.map((x) => x.agentId), ["a-ceo"]);
  assert.match(t.prompts[0].prompt, /\(@bot-cto, another agent\) wrote to you \(@ceo\)/);
  assert.equal(t.posts[0].by, "bot-ceo");
  assert.equal(t.posts[0].rootId, "m1");
});
test("a dead session is replaced and the message is retried once", async () => {
  const t = setup({ reply: async (sid) => { if (sid === "s1" && t.prompts.length === 2) throw new Error("session closed"); return `ok ${sid}`; } });
  await t.handle(evt("@ceo one", { id: "root" }));
  await t.handle(evt("two", { root_id: "root" }));
  assert.equal(t.sessions.length, 2);
  assert.equal(t.posts.at(-1)!.message, "ok s2");
  assert.deepEqual(t.state.get("thread:root"), { agentId: "a-ceo", sessionId: "s2" });
});

test("an agent failure is shown in the thread", async () => {
  const t = setup({ reply: async () => { throw new Error("adapter crashed"); } });
  await t.handle(evt("@ceo hi"));
  assert.match(t.posts[0].message, /:warning: CEO could not answer: adapter crashed/);
});

test("long replies are split across posts", async () => {
  const t = setup({ reply: async () => "line\n".repeat(7000) });
  await t.handle(evt("hi", { channelType: "D", channelName: "alice__bot-ceo" }));
  assert.ok(t.posts.length >= 3);
  assert.ok(t.posts.every((p) => p.message.length <= 15000));
});

test("posts in one thread are processed in order, one session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const t = setup({ reply: async (sid, p) => { if (p.endsWith("first")) await gate; return `r ${sid}`; } });
  const a = t.handle(evt("@ceo first", { id: "root" }));
  const b = t.handle(evt("second", { root_id: "root" }));
  release();
  await Promise.all([a, b]);
  assert.equal(t.sessions.length, 1);
  assert.deepEqual(t.prompts.map((x) => x.prompt.split("\n\n").at(-1)), ["first", "second"]);
});

test("helpers", () => {
  assert.equal(botUsername("Client Success Manager"), "client-success-manager");
  assert.equal(botUsername("CFO (Chief Financing Offer Agent)"), "cfo-chief-financing-offer-agent");
  assert.equal(botUsername("F&I Agent"), "f-i-agent");
  assert.equal(botUsername("360 Review"), "agent-360-review");
  assert.deepEqual(mentions("hey @CTO, and @ceo. also email@x.com"), ["cto", "ceo"]);
  assert.equal(stripMention("@cto: is the build green?", "cto"), "is the build green?");
  assert.equal(stripMention("ping @cto now", "cto"), "ping now");
  assert.equal(stripMention("ping @ctox", "cto"), "ping @ctox");
  assert.deepEqual(splitMessage("abc", 10), ["abc"]);
});

test("the manager account's own posts are answered (it may be a person's admin token)", async () => {
  const t = setup();
  await t.handle(evt("@ceo status?", { user_id: MANAGER }));
  assert.equal(t.sessions.length, 1);
});


test("files: attachments are saved for the agent, and what it leaves in the outbox is posted back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mm-files-"));
  let seen = "";
  const t = setup({ files: diskFiles(root), reply: async (_sid, prompt) => {
    const saved = prompt.match(/^- (\/\S+) \(/m)![1];
    seen = await readFile(saved, "utf8");
    const outbox = prompt.match(/save them in (\S+)$/)![1];
    await writeFile(path.join(outbox, "report.md"), "# done");
    return "here you go";
  } });
  await t.handle(evt("", { id: "m1", channelType: "D", channelName: "alice__bot-cto", file_ids: ["f1abcdefgh"] }));
  assert.equal(seen, "contents of f1abcdefgh");
  assert.match(t.prompts[0].prompt, /\(no text, only files\)/);
  assert.equal(t.posts[0].message, "here you go");
  assert.deepEqual(t.uploads, [{ by: "bot-cto", rootId: "m1", message: "", files: [{ name: "report.md", text: "# done" }] }]);
});

test("files: no outbox files means no upload, and a post without text or files is ignored", async () => {
  const t = setup({ files: diskFiles(await mkdtemp(path.join(os.tmpdir(), "mm-files-"))) });
  await t.handle(evt("hello", { channelType: "D", channelName: "alice__bot-cto" }));
  await t.handle(evt("", { channelType: "D", channelName: "alice__bot-cto" }));
  assert.equal(t.uploads.length, 0);
  assert.equal(t.prompts.length, 1);
});

test("choices: the last `choices:` line becomes the options; anything else is left alone", () => {
  assert.deepEqual(extractChoices("Pick a plan.\nchoices: Basic | **Pro** | Pro | Enterprise"), { text: "Pick a plan.", choices: ["Basic", "Pro", "Enterprise"] });
  assert.deepEqual(extractChoices("Use choices: a | b in the middle\nthen more"), { text: "Use choices: a | b in the middle\nthen more", choices: [] });
  assert.deepEqual(extractChoices("x\nchoices: only one").choices, []);
  assert.equal(extractChoices("x\nChoices: 1|2|3|4|5|6|7").choices.length, 5);
});

test("choices: offered options are posted as signed buttons under the reply, and a tampered click is refused", async () => {
  const t = setup({ buttons: true, reply: async () => "Which region?\nchoices: US | EU" });
  await t.handle(evt("deploy it", { id: "m1", channelType: "D", channelName: "alice__bot-cto" }));
  assert.equal(t.posts[0].message, "Which region?");
  const actions = (t.posts[1].props as any).attachments[0].actions;
  assert.deepEqual(actions.map((a: any) => a.name), ["US", "EU"]);
  const ctx = actions[1].integration.context;
  assert.deepEqual([ctx.kind, ctx.channelId, ctx.rootId, ctx.channelType, ctx.choice], ["choice", "c1", "m1", "D", "EU"]);
  assert.equal(verifyChoice("k", ctx), true);
  assert.equal(verifyChoice("k", { ...ctx, choice: "Mars" }), false);
  assert.equal(verifyChoice("other", ctx), false);
  assert.match(JSON.stringify(chosenProps("EU", "@alice")), /@alice chose \*\*EU\*\*/);
});

test("choices: without buttons the options stay readable as a numbered list", async () => {
  const t = setup({ reply: async () => "Which region?\nchoices: US | EU" });
  await t.handle(evt("deploy it", { channelType: "D", channelName: "alice__bot-cto" }));
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].message, "Which region?\n\n1. US\n2. EU");
});

test("choices: a click comes back as the clicker's message in the same thread and session", async () => {
  const t = setup({ buttons: true, reply: async (_s, p) => (p.endsWith("EU") ? "Deploying to EU." : "Which region?\nchoices: US | EU") });
  await t.handle(evt("deploy it", { id: "m1", channelType: "D", channelName: "alice__bot-cto" }));
  const card = (t.posts[1].props as any).attachments[0].actions[1].integration.context;
  const click = { post: { id: `choice:${t.posts[1].id}`, user_id: "alice", channel_id: card.channelId, root_id: card.rootId, message: card.choice }, channelType: card.channelType, channelName: card.channelName };
  await Promise.all([t.handle(click), t.handle(click)]); // double click
  assert.equal(t.sessions.length, 1);
  assert.deepEqual(t.prompts.map((p) => p.sessionId), ["s1", "s1"]);
  assert.equal(t.posts.at(-1)!.message, "Deploying to EU.");
});

test("access: people who may not talk to agents get a private note, and no agent runs", async () => {
  const t = setup({ canTalk: async (id) => id === "alice" });
  await t.handle(evt("@ceo hi", { user_id: "mallory", id: "m1" }));
  assert.equal(t.sessions.length, 0);
  assert.equal(t.posts.length, 0);
  assert.equal(t.reactions.length, 0);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].text, /don't have access to talk to CEO/);
  assert.equal(t.notes[0].userId, "mallory");
  await t.handle(evt("@ceo hi", { user_id: "alice" }));
  assert.equal(t.sessions.length, 1);
  await t.handle(evt("no mention, nobody addressed", { user_id: "mallory" })); // not for an agent: no note
  assert.equal(t.notes.length, 1);
});

test("access: a person limited to some agents reaches those and gets a note from the rest", async () => {
  const t = setup({ canTalk: async (id, agent) => id === "client" && agent === "a-csm" });
  await t.handle(evt("@client-success-manager status?", { user_id: "client" }));
  await t.handle(evt("@cto status?", { user_id: "client" }));
  assert.deepEqual(t.sessions.map((s) => s.agentId), ["a-csm"]);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].text, /talk to CTO/);
});

test("the bot shows 'is typing' until the answer is posted, with no placeholder message", async () => {
  const t = setup({ reply: async () => { await new Promise((r) => setTimeout(r, 3500)); return "done"; } });
  await t.handle(evt("hi", { id: "m1", channelType: "D", channelName: "alice__bot-ceo" }));
  assert.deepEqual(t.posts.map((p) => p.message), ["done"]);
  assert.ok(t.typings.length >= 2, `refreshed while working (${t.typings.length})`);
  assert.ok(t.typings.every((x) => x.channelId === "c1" && (x.rootId === "m1" || x.rootId === "")));
  assert.ok(t.typings.some((x) => x.rootId === "m1") && t.typings.some((x) => x.rootId === ""), "thread and channel");
  const after = t.typings.length;
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(t.typings.length, after, "stops once answered");
});

test("old placeholder posts are left out of the thread history sent to the agent", async () => {
  const t = setup();
  await t.handle(evt("@ceo first", { id: "root" }));
  t.posts.push({ id: "old", by: "bot-ceo", channelId: "c1", rootId: "root", message: "_thinking…_\n- ✓ `ls`" });
  await t.handle(evt("second", { root_id: "root" }));
  assert.doesNotMatch(t.prompts[1].prompt, /thinking…/);
});

test("agents trading mentions pause at the turn limit until a person replies", async () => {
  const t = setup({ turnLimit: 3 });
  const agentPost = (n: number, from: string, to: string) => evt(`@${to} turn ${n}`, { id: `a${n}`, root_id: "root", user_id: from, props: { from_bot: "true" } });
  await t.handle(evt("@ceo kick off", { id: "root" }));
  for (let n = 1; n <= 5; n++) await t.handle(agentPost(n, n % 2 ? "bot-ceo" : "bot-cto", n % 2 ? "cto" : "ceo"));
  assert.equal(t.prompts.length, 1 + 3, "three agent turns, then stop");
  const notes = t.posts.filter((p) => /Pausing here/.test(p.message));
  assert.equal(notes.length, 1, "the pause is announced once");
  await t.handle(evt("go on", { root_id: "root", user_id: "alice" }));
  await t.handle(agentPost(6, "bot-ceo", "cto"));
  assert.equal(t.prompts.length, 1 + 3 + 1 + 1, "a person's reply resets the count");
});

test("an agent's Paperclip-relative links open Paperclip, not Mattermost", () => {
  assert.equal(absoluteLinks("I opened [BAD-705](/BAD/issues/BAD-705) and [docs](https://x.dev/a).", "https://os.badaaas.com/"),
    "I opened [BAD-705](https://os.badaaas.com/BAD/issues/BAD-705) and [docs](https://x.dev/a).");
  assert.equal(absoluteLinks("[x](/a)", ""), "[x](/a)", "no Paperclip URL set: left alone");
  assert.equal(absoluteLinks("[x](//cdn.example/a)", "https://p"), "[x](//cdn.example/a)");
});

test("steering: a message sent while the agent works reaches that run, and is not run again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let inRun: { from: string; text: string }[] = [];
  const t = setup({ reply: async (sid, prompt) => {
    if (prompt.includes("long job")) { await gate; inRun = await t.bridge.takeInbox("a-cto"); return "Stopped, as you asked."; }
    return `reply from ${sid}`;
  } });
  const first = t.handle(evt("@cto do the long job", { id: "root" }));
  await new Promise((r) => setTimeout(r, 20));
  const second = t.handle(evt("never mind, stop", { id: "m2", root_id: "root" }));
  assert.equal(t.bridge.hasInbox("a-cto"), true);
  release();
  await first; await second;
  assert.deepEqual(inRun.map((m) => m.text), ["never mind, stop"]);
  assert.match(inRun[0].from, /@alice/);
  assert.equal(t.prompts.length, 1, "the steering message did not start a second turn");
  assert.ok(t.reactions.some((r) => r.postId === "m2" && r.emoji === "white_check_mark"), "marked as handled");
  assert.match(t.prompts[0].prompt, /mm\/inbox/);
});

test("steering the agent did not read still runs afterwards, as before", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const t = setup({ reply: async (sid, prompt) => { if (prompt.includes("long job")) await gate; return `reply from ${sid}`; } });
  const first = t.handle(evt("@cto do the long job", { id: "root2" }));
  await new Promise((r) => setTimeout(r, 20));
  const second = t.handle(evt("also check X", { id: "m3", root_id: "root2" }));
  release();
  await first; await second;
  assert.equal(t.prompts.length, 2);
  assert.match(t.prompts[1].prompt, /also check X/);
  assert.equal(t.bridge.hasInbox("a-cto"), false);
});

test("the company's task numbers become links to Paperclip; look-alikes, code and links are left alone", () => {
  const base = "https://os.badaaas.com";
  assert.equal(linkTasks("Next steps on **BAD-728**: see BAD-705.", base, "BAD"),
    "Next steps on **[BAD-728](https://os.badaaas.com/BAD/issues/BAD-728)**: see [BAD-705](https://os.badaaas.com/BAD/issues/BAD-705).");
  assert.equal(linkTasks("COVID-19, SHA-256, XBAD-1, BAD-1x", base, "BAD"), "COVID-19, SHA-256, XBAD-1, BAD-1x");
  assert.equal(linkTasks("`BAD-1` and [BAD-2](https://x/BAD-2) and https://os.badaaas.com/BAD/issues/BAD-3", base, "BAD"),
    "`BAD-1` and [BAD-2](https://x/BAD-2) and https://os.badaaas.com/BAD/issues/BAD-3");
  assert.equal(linkTasks("```\nBAD-9\n```", base, "BAD"), "```\nBAD-9\n```");
  assert.equal(linkTasks("BAD-1", "", "BAD"), "BAD-1", "no Paperclip URL: left as text");
});

test("a reply interrupted by a plugin restart is asked for again and posted in its thread", async () => {
  const t = setup({ reply: async () => { throw new Error("worker stopped"); } });
  // A first worker, stopped mid-reply: what it was waiting for stays recorded.
  t.state.set("inflight", { "root-r": { agentId: "a-cto", sessionId: "s9", channelId: "c1", channelType: "O", channelName: "general", at: Date.now() } });
  const t2 = setup({ reply: async (_sid, prompt) => (prompt.includes("restarted") ? "Scan finished: 1,712 contacts to sync." : "x") });
  for (const [k, v] of t.state) t2.state.set(k, v);
  assert.equal(await t2.bridge.resume(), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(t2.prompts.map((p) => p.sessionId), ["s9"], "the same session");
  assert.equal(t2.posts.at(-1)!.message, "Scan finished: 1,712 contacts to sync.");
  assert.equal(t2.posts.at(-1)!.rootId, "root-r");
  assert.deepEqual(t2.state.get("inflight"), {}, "cleared once delivered");
});

test("a normal reply leaves nothing to resume", async () => {
  const t = setup();
  await t.handle(evt("@cto hi", { id: "q1" }));
  assert.deepEqual(t.state.get("inflight"), {});
});

test("one thread's reply record cleared while another is recorded does not come back (no lost updates)", async () => {
  const t = setup();
  const real = t.state;
  const slow = { async get<T>(k: string) { await new Promise((r) => setTimeout(r, 2)); return structuredClone(real.get(k) ?? null) as T | null; }, async set(k: string, v: unknown) { await new Promise((r) => setTimeout(r, 3)); real.set(k, structuredClone(v)); } };
  const b = t.bridge as unknown as { store: typeof slow; inFlight(rootId: string, f: unknown): Promise<void> };
  b.store = slow;
  const rec = (root: string) => ({ agentId: "a-cto", sessionId: "s", channelId: "c1", channelType: "O", channelName: "general", at: Date.now(), postId: root });
  await b.inFlight("A", rec("A"));
  await Promise.all([b.inFlight("A", null), b.inFlight("B", rec("B"))]);
  assert.deepEqual(Object.keys(real.get("inflight") as object), ["B"]);
});

test("after a restart, a reply that already reached the thread is not asked for again", async () => {
  const t = setup();
  await t.handle(evt("@cto run the daily reporting", { id: "root-d" }));
  // As if the restart came after the reply posted but its record was not cleared.
  t.state.set("inflight", { "root-d": { agentId: "a-cto", sessionId: "s1", channelId: "c1", channelType: "O", channelName: "general", at: Date.now(), postId: "root-d" } });
  const before = t.prompts.length;
  await t.bridge.resume();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.prompts.length, before, "the agent is not asked again");
  assert.deepEqual(t.state.get("inflight"), {});
});

test("a resumed reply is given the message it was answering", async () => {
  // A fresh worker after the restart: the thread holds the person's message and no reply yet.
  const t = setup({ reply: async () => "DNS is fine." });
  t.humanPosts.push(evt("@cto check the DNS", { id: "root-q" }).post);
  t.state.set("inflight", { "root-q": { agentId: "a-cto", sessionId: "s7", channelId: "c1", channelType: "O", channelName: "general", at: Date.now(), postId: "root-q" } });
  await t.bridge.resume();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(t.prompts.find((p) => p.sessionId === "s7")?.prompt ?? "", /The message you were answering:\n@cto check the DNS/);
  assert.equal(t.posts.at(-1)?.message, "DNS is fine.");
});
