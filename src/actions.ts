// What agents can do in Mattermost, as their own bot: read the channels they are in,
// post, react, DM the people allowed to talk to them, and run work channels. Served
// as plugin API routes that only agents may call; Paperclip verifies which agent is
// calling and which company it belongs to, so an agent only ever acts as itself, in
// its own company's Mattermost. policy.ts decides what needs a person's approval.
import { canCreateChannel, canDm, canManage, canPost, channelSlug, type Verdict } from "./policy.ts";

export interface MmClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  botUserId: string;
}

export interface AgentRef { agentId: string; agentName: string; username: string; botUserId: string }

export interface ActionDeps {
  /** The calling agent's own bot, or undefined when it has none in this company's Mattermost. */
  bot(agentId: string): MmClient | undefined;
  /** The admin account: membership changes and archiving, after this module's own checks. */
  manager: MmClient;
  agents(): AgentRef[];
  canTalk(userId: string, agentId: string): Promise<boolean>;
  /**
   * The Mattermost thread a task this run works on was asked for in, when the run posts into that
   * thread's channel without naming a thread: so a task's result lands in the conversation.
   */
  taskThread?(agentId: string, runId: string | null, channelId: string): Promise<string | null>;
  /** The thread the agent is answering right now, where results and requests are reported. */
  origin(agentId: string): { channelId: string; rootId: string } | null;
  /** A Paperclip task of this company, or null. */
  task(taskId: string): Promise<{ id: string; identifier?: string | null; title: string } | null>;
  /** Posts an Approve / Reject card for a request; returns nothing, the card carries the id. */
  askApproval(request: PendingRequest): Promise<void>;
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  newId(): string;
}

export type RequestKind = "post" | "create-channel" | "invite";
export interface PendingRequest {
  id: string;
  agentId: string;
  agentName: string;
  kind: RequestKind;
  summary: string;
  why: string;
  args: Record<string, unknown>;
  origin: { channelId: string; rootId: string } | null;
  status: "pending" | "approved" | "rejected" | "failed";
  result?: unknown;
  decidedBy?: string;
}

export interface WorkLink { issueId: string; identifier: string | null; title: string; agentId: string; origin: { channelId: string; rootId: string } | null }

type Result = { status: number; body: unknown };
const ok = (body: unknown): Result => ({ status: 200, body });
const bad = (status: number, error: string): Result => ({ status, body: { error } });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const ID = /^[a-z0-9]{26}$/;

interface Channel { id: string; name: string; display_name: string; type: string; purpose?: string; header?: string; team_id: string; delete_at?: number }
interface Post { id: string; user_id: string; message: string; root_id?: string; create_at: number; channel_id: string }

export class Actions {
  private d: ActionDeps;
  private names = new Map<string, string>();

  constructor(deps: ActionDeps) {
    this.d = deps;
  }

  /** One route call. `params` are the route's path parameters, `input` its query or body. */
  private runId: string | null = null;

  async handle(agentId: string, routeKey: string, params: Record<string, string>, input: Record<string, unknown>, runId: string | null = null): Promise<Result> {
    this.runId = runId;
    const bot = this.d.bot(agentId);
    if (!bot) return bad(409, "You have no Mattermost bot in this company yet (your agent may be switched off in the plugin's settings).");
    try {
      switch (routeKey) {
        case "channels": return ok(await this.myChannels(bot));
        case "channel-posts": return ok(await this.posts(bot, params.channel, input));
        case "thread": return ok(await this.thread(bot, params.postId));
        case "channel-members": return ok(await this.members(bot, params.channel));
        case "search": return ok(await this.search(bot, str(input.q)));
        case "people": return ok(await this.people(str(input.q)));
        case "post": return await this.post(agentId, bot, input);
        case "react": return await this.react(bot, input);
        case "dm": return await this.dm(agentId, bot, input);
        case "create-channel": return await this.createChannel(agentId, bot, input);
        case "invite": return await this.invite(agentId, bot, params.channel, input);
        case "update-channel": return await this.updateChannel(agentId, bot, params.channel, input);
        case "archive": return await this.archive(agentId, bot, params.channel);
        case "request": return ok(await this.d.store.get<PendingRequest>(`req:${params.id}`) ?? { error: "no such request" });
        default: return bad(404, `unknown action ${routeKey}`);
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = String((err as Error)?.message ?? err).replace(/^Mattermost \w+ \S+: \d+ /, "");
      return bad(status && status >= 400 && status < 500 ? status : 502, `Mattermost refused or failed: ${message.slice(0, 300)}`);
    }
  }

  // ---- reading -------------------------------------------------------------------

  private async teamOf(bot: MmClient): Promise<string> {
    const teams = await bot.request<{ id: string }[]>("GET", "/users/me/teams");
    if (!teams.length) throw Object.assign(new Error("your bot is in no team"), { status: 409 });
    return teams[0].id;
  }

  /** A channel by id, URL name ("decisions"), display name ("Decisions") or "~decisions". */
  async channel(bot: MmClient, ref: string): Promise<Channel> {
    const want = str(ref).replace(/^[~#]/, "");
    if (ID.test(want)) return bot.request<Channel>("GET", `/channels/${want}`);
    for (const team of await bot.request<{ id: string }[]>("GET", "/users/me/teams")) {
      try { return await bot.request<Channel>("GET", `/teams/${team.id}/channels/name/${encodeURIComponent(channelSlug(want))}`); } catch { /* try display names */ }
      const mine = await bot.request<Channel[]>("GET", `/users/me/teams/${team.id}/channels`).catch(() => [] as Channel[]);
      const hit = mine.find((c) => c.display_name.toLowerCase() === want.toLowerCase());
      if (hit) return hit;
    }
    throw Object.assign(new Error(`no channel "${ref}" that you can see; you can only use channels you are a member of`), { status: 404 });
  }

  private async userName(id: string): Promise<string> {
    if (!this.names.has(id)) {
      const u = await this.d.manager.request<{ username: string }>("GET", `/users/${id}`).catch(() => ({ username: id }));
      this.names.set(id, u.username);
    }
    return this.names.get(id)!;
  }

  private async shape(p: Post) {
    return { id: p.id, from: `@${await this.userName(p.user_id)}`, at: new Date(p.create_at).toISOString(), threadId: p.root_id || null, text: p.message };
  }

  private async ordered(res: { order: string[]; posts: Record<string, Post> }) {
    const posts = res.order.map((id) => res.posts[id]).filter(Boolean).sort((a, b) => a.create_at - b.create_at);
    return Promise.all(posts.map((p) => this.shape(p)));
  }

  private async myChannels(bot: MmClient) {
    const team = await this.teamOf(bot);
    const created = await this.created();
    const channels = await bot.request<Channel[]>("GET", `/users/me/teams/${team}/channels`);
    return channels.filter((c) => c.type === "O" || c.type === "P").map((c) => ({
      id: c.id, name: c.name, displayName: c.display_name, private: c.type === "P", purpose: c.purpose || "", createdByYou: created[c.id] === bot.botUserId,
    }));
  }

  private async posts(bot: MmClient, ref: string, input: Record<string, unknown>) {
    const ch = await this.channel(bot, ref);
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 100);
    return { channel: ch.name, posts: await this.ordered(await bot.request(`GET`, `/channels/${ch.id}/posts?per_page=${limit}`)) };
  }

  private async thread(bot: MmClient, postId: string) {
    return { posts: await this.ordered(await bot.request("GET", `/posts/${postId}/thread`)) };
  }

  private async members(bot: MmClient, ref: string) {
    const ch = await this.channel(bot, ref);
    const ms = await bot.request<{ user_id: string }[]>("GET", `/channels/${ch.id}/members?per_page=200`);
    const agents = new Map(this.d.agents().map((a) => [a.botUserId, a]));
    return Promise.all(ms.map(async (m) => {
      const a = agents.get(m.user_id);
      return a ? { username: a.username, agent: a.agentName } : { username: await this.userName(m.user_id) };
    }));
  }

  private async search(bot: MmClient, q: string) {
    if (!q) throw Object.assign(new Error("say what to search for (q)"), { status: 400 });
    const team = await this.teamOf(bot);
    return { posts: (await this.ordered(await bot.request("POST", `/teams/${team}/posts/search`, { terms: q, is_or_search: false }))).slice(-30) };
  }

  private async people(q: string) {
    const users = await this.d.manager.request<{ id: string; username: string; first_name?: string; last_name?: string; is_bot?: boolean; delete_at?: number }[]>(
      "POST", "/users/search", { term: q, allow_inactive: false, limit: 25 });
    const agents = new Map(this.d.agents().map((a) => [a.botUserId, a]));
    return users.filter((u) => !u.delete_at && (!u.is_bot || agents.has(u.id))).map((u) => agents.has(u.id)
      ? { username: u.username, agent: agents.get(u.id)!.agentName }
      : { username: u.username, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username });
  }

  // ---- talking ---------------------------------------------------------------------

  private async gate(agentId: string, verdict: Verdict, kind: RequestKind, summary: string, args: Record<string, unknown>): Promise<Result | null> {
    if (verdict.ok) return null;
    if (!verdict.askFirst) return bad(403, `Not allowed: ${verdict.why}.`);
    const request: PendingRequest = {
      id: this.d.newId(), agentId, agentName: this.agentName(agentId), kind, summary, why: verdict.why, args,
      origin: this.d.origin(agentId), status: "pending",
    };
    await this.d.store.set(`req:${request.id}`, request);
    await this.d.askApproval(request);
    return { status: 202, body: { status: "waiting_for_approval", requestId: request.id, why: verdict.why,
      note: "A person has been asked to approve this. Tell whoever you are working with, and carry on; if approved it runs as you, and the result is posted where you asked." } };
  }

  private agentName(agentId: string) {
    return this.d.agents().find((a) => a.agentId === agentId)?.agentName ?? "An agent";
  }

  private async post(agentId: string, bot: MmClient, input: Record<string, unknown>): Promise<Result> {
    const text = str(input.text);
    if (!text) return bad(400, "text is empty");
    const ch = await this.channel(bot, str(input.channel));
    const threadId = str(input.threadId) || (await this.d.taskThread?.(agentId, this.runId, ch.id).catch(() => null)) || "";
    const waiting = await this.gate(agentId, canPost(text), "post", `post in ~${ch.name}: "${text.slice(0, 200)}"`, { channelId: ch.id, threadId, text });
    if (waiting) return waiting;
    return ok(await this.doPost(bot, ch.id, threadId, text));
  }

  async doPost(bot: MmClient, channelId: string, threadId: string, text: string) {
    const p = await bot.request<Post>("POST", "/posts", { channel_id: channelId, root_id: threadId, message: text });
    return { posted: p.id, threadId: p.root_id || p.id };
  }

  private async react(bot: MmClient, input: Record<string, unknown>): Promise<Result> {
    const emoji = str(input.emoji).replace(/^:|:$/g, "");
    if (!str(input.postId) || !emoji) return bad(400, "postId and emoji are required");
    await bot.request("POST", "/reactions", { user_id: bot.botUserId, post_id: str(input.postId), emoji_name: emoji });
    return ok({ reacted: emoji });
  }

  private async dm(agentId: string, bot: MmClient, input: Record<string, unknown>): Promise<Result> {
    const text = str(input.text);
    const username = str(input.person).replace(/^@/, "");
    if (!text || !username) return bad(400, "person and text are required");
    const user = await this.d.manager.request<{ id: string }>("GET", `/users/username/${encodeURIComponent(username)}`);
    const verdict = canDm(await this.d.canTalk(user.id, agentId));
    if (!verdict.ok) return bad(403, `Not allowed: ${verdict.why}.`);
    const channel = await bot.request<{ id: string }>("POST", "/channels/direct", [bot.botUserId, user.id]);
    const threadId = str(input.threadId) || (await this.d.taskThread?.(agentId, this.runId, channel.id).catch(() => null)) || "";
    return ok(await this.doPost(bot, channel.id, threadId, text));
  }

  // ---- channels ----------------------------------------------------------------------

  private async created(): Promise<Record<string, string>> {
    return (await this.d.store.get<Record<string, string>>("channels-created")) ?? {};
  }

  private async createdBy(channelId: string): Promise<string | undefined> {
    return (await this.created())[channelId];
  }

  private async resolvePeople(names: string[]): Promise<{ ids: string[]; unknown: string[] }> {
    const agents = this.d.agents();
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const raw of names) {
      const n = raw.replace(/^@/, "").toLowerCase();
      const a = agents.find((x) => x.username === n || x.agentName.toLowerCase() === n);
      if (a) { ids.push(a.botUserId); continue; }
      const u = await this.d.manager.request<{ id: string }>("GET", `/users/username/${encodeURIComponent(n)}`).catch(() => null);
      if (u) ids.push(u.id); else unknown.push(raw);
    }
    return { ids, unknown };
  }

  private async addMembers(channelId: string, ids: string[]) {
    for (const id of ids) await this.d.manager.request("POST", `/channels/${channelId}/members`, { user_id: id }).catch(() => {});
  }

  private async createChannel(agentId: string, bot: MmClient, input: Record<string, unknown>): Promise<Result> {
    const isPrivate = input.private !== false;
    const display = str(input.name);
    if (!display) return bad(400, "name is required, e.g. 'inc checkout 5xx'");
    const taskId = str(input.taskId);
    if (taskId && !(await this.d.task(taskId))) return bad(404, `no task ${taskId} in this company`);
    const args = { name: display, private: isPrivate, purpose: str(input.purpose), people: list(input.people), agents: list(input.agents), taskId };
    const waiting = await this.gate(agentId, canCreateChannel(isPrivate), "create-channel", `open the public channel "${display}"`, args);
    if (waiting) return waiting;
    return ok(await this.doCreateChannel(agentId, bot, args, this.d.origin(agentId)));
  }

  async doCreateChannel(agentId: string, bot: MmClient, args: Record<string, unknown>, origin: WorkLink["origin"]) {
    const team = await this.teamOf(bot);
    const display = str(args.name);
    let ch: Channel | null = null;
    for (const suffix of ["", "-2", "-3", "-4", "-5"]) {
      try {
        ch = await bot.request<Channel>("POST", "/channels", {
          team_id: team, name: channelSlug(display) + suffix, display_name: display.slice(0, 64), type: args.private === false ? "O" : "P", purpose: str(args.purpose).slice(0, 250),
        });
        break;
      } catch (err) {
        if ((err as { status?: number }).status !== 400) throw err; // 400: the name is taken
      }
    }
    if (!ch) throw Object.assign(new Error(`a channel named like "${display}" exists already; pick another name`), { status: 409 });
    const created = await this.created();
    created[ch.id] = bot.botUserId;
    await this.d.store.set("channels-created", created);
    const { ids, unknown } = await this.resolvePeople([...list(args.people), ...list(args.agents)]);
    await this.addMembers(ch.id, ids);
    let task: WorkLink | null = null;
    const taskId = str(args.taskId);
    if (taskId) {
      const t = await this.d.task(taskId);
      if (t) {
        task = { issueId: t.id, identifier: t.identifier ?? null, title: t.title, agentId, origin };
        await this.d.store.set(`worklink:${ch.id}`, task);
        await this.d.store.set(`taskchannel:${t.id}`, ch.id);
      }
    }
    return { channel: ch.name, channelId: ch.id, private: ch.type === "P", added: ids.length, unknownPeople: unknown, linkedTask: task?.identifier ?? task?.issueId ?? null };
  }

  private async invite(agentId: string, bot: MmClient, ref: string, input: Record<string, unknown>): Promise<Result> {
    const ch = await this.channel(bot, ref);
    const names = [...list(input.people), ...list(input.agents)];
    if (!names.length) return bad(400, "people or agents to invite are required");
    const mine = (await this.createdBy(ch.id)) === bot.botUserId;
    const waiting = await this.gate(agentId, canManage(mine, "invite"), "invite", `add ${names.join(", ")} to ~${ch.name}`, { channelId: ch.id, names });
    if (waiting) return waiting;
    return ok(await this.doInvite(ch.id, names));
  }

  async doInvite(channelId: string, names: string[]) {
    const { ids, unknown } = await this.resolvePeople(names);
    await this.addMembers(channelId, ids);
    return { added: ids.length, unknownPeople: unknown };
  }

  private async updateChannel(agentId: string, bot: MmClient, ref: string, input: Record<string, unknown>): Promise<Result> {
    const ch = await this.channel(bot, ref);
    const verdict = canManage((await this.createdBy(ch.id)) === bot.botUserId, "update");
    if (!verdict.ok) return bad(403, `Not allowed: ${verdict.why}.`);
    const patch: Record<string, string> = {};
    if (typeof input.purpose === "string") patch.purpose = input.purpose.slice(0, 250);
    if (typeof input.header === "string") patch.header = input.header.slice(0, 1024);
    if (typeof input.name === "string" && input.name.trim()) patch.display_name = input.name.trim().slice(0, 64);
    if (!Object.keys(patch).length) return bad(400, "nothing to change: purpose, header or name");
    await this.d.manager.request("PUT", `/channels/${ch.id}/patch`, patch);
    return ok({ updated: Object.keys(patch) });
  }

  private async archive(agentId: string, bot: MmClient, ref: string): Promise<Result> {
    const ch = await this.channel(bot, ref);
    const verdict = canManage((await this.createdBy(ch.id)) === bot.botUserId, "archive");
    if (!verdict.ok) return bad(403, `Not allowed: ${verdict.why}.`);
    await this.d.manager.request("DELETE", `/channels/${ch.id}`);
    return ok({ archived: ch.name });
  }

  /** A person approved or rejected a request: run it as the agent, then report where it was asked. */
  async decide(requestId: string, approved: boolean, who: string): Promise<PendingRequest | null> {
    const req = await this.d.store.get<PendingRequest>(`req:${requestId}`);
    if (!req || req.status !== "pending") return req;
    req.decidedBy = who;
    if (!approved) {
      req.status = "rejected";
    } else {
      const bot = this.d.bot(req.agentId);
      try {
        if (!bot) throw new Error("the agent has no bot any more");
        const a = req.args;
        req.result = req.kind === "post" ? await this.doPost(bot, str(a.channelId), str(a.threadId), str(a.text))
          : req.kind === "create-channel" ? await this.doCreateChannel(req.agentId, bot, a, req.origin)
          : await this.doInvite(str(a.channelId), list(a.names));
        req.status = "approved";
      } catch (err) {
        req.status = "failed";
        req.result = { error: String((err as Error)?.message ?? err).slice(0, 300) };
      }
    }
    await this.d.store.set(`req:${requestId}`, req);
    const bot = this.d.bot(req.agentId);
    if (bot && req.origin) {
      const line = req.status === "approved" ? `:white_check_mark: ${who} approved: ${req.summary}.`
        : req.status === "rejected" ? `:x: ${who} rejected: ${req.summary}.`
        : `:warning: Approved by ${who}, but it failed: ${(req.result as { error?: string })?.error}`;
      await bot.request("POST", "/posts", { channel_id: req.origin.channelId, root_id: req.origin.rootId, message: line }).catch(() => {});
    }
    return req;
  }
}
