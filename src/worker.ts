import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createHmac } from "node:crypto";
import { Cards } from "./interactions.ts";
import { choiceProps, chosenProps, verifyChoice, type ChoiceContext } from "./choices.ts";
import { Approvals, parseApprovers, sign, signed, type ActionRequest, type ApprovalPoster } from "./approvals.ts";
import { Actions, type PendingRequest } from "./actions.ts";
import { WorkLinks, FROM_PAPERCLIP } from "./worklinks.ts";
import { HELP } from "./help.ts";
import { randomUUID } from "node:crypto";
import { absoluteLinks, Bridge, DEFAULT_TURN_LIMIT, linkTasks, type Agents, type Directory, type PostedEvent, type Store } from "./bridge.ts";
import { accessCheck } from "./access.ts";
import { MattermostClient } from "./mattermost.ts";
import { detached } from "./detach.ts";
import { diskFiles } from "./files.ts";
import { detectPublicUrl, localBaseUrl, receivePing, verifyUrl } from "./public-url.ts";
import { agentAvatarUrl, resolveAgentAppearance } from "@paperclipai/shared";
import { AgentBots, type AgentInfo } from "./roster.ts";
import manifest from "./manifest.ts";

const ASK_TIMEOUT_MS = 30 * 60 * 1000;
const PLUGIN_KEY = manifest.id;
const SYNC_EVERY_MS = 5 * 60 * 1000;
const CARDS_EVERY_MS = 60_000;
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
// Every company's settings, saved by onConfigChanged so a worker the host restarts
// after a crash (which gets no config replay) can start them all again.
const BOOT = { scopeKind: "instance" as const, namespace: "mattermost", stateKey: "boot-v2" };
const BOOT_AFTER_MS = 15_000;

let ctx: PluginContext;

declare const __BUILT_FOR_PAPERCLIP__: string;
const BUILT_FOR = typeof __BUILT_FOR_PAPERCLIP__ === "string" ? __BUILT_FOR_PAPERCLIP__ : "";
/** Set when this server runs a different Paperclip than the plugin was built and tested against. */
let versionNote: string | null = null;

async function checkVersion(): Promise<void> {
  const health = await fetch(`${await localBaseUrl()}/api/health`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json() as Promise<{ commit?: string }>);
  if (BUILT_FOR && health.commit && health.commit !== BUILT_FOR) {
    versionNote = `built and tested for Paperclip ${BUILT_FOR.slice(0, 7)}, this server runs ${health.commit.slice(0, 7)}; most features keep working, report problems at https://github.com/hmseeb/paperclip-plugin-mattermost/issues`;
    ctx.logger.warn(`Mattermost plugin ${versionNote}`);
  }
}

const errText = (err: unknown) => String((err as Error)?.message ?? err);

/**
 * One company's Mattermost: its own server, admin token, bots, sockets, state and
 * button key. Companies never share any of it.
 */
class Tenant {
  status = "starting";
  manager: MattermostClient | null = null;
  bots: AgentBots | null = null;
  bridge: Bridge | null = null;
  approvals: Approvals | null = null;
  cards: Cards | null = null;
  actions: Actions | null = null;
  work: WorkLinks | null = null;
  key = "";
  private approvers = new Map<string, string>();
  private paperclipUrl = "";
  private approvalsChannel = "";
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(readonly companyId: string) {}

  private agents(): Agents {
    const companyId = this.companyId;
    return {
      async createSession(agentId, taskKey) {
        // The host's sendMessage only finds sessions whose task key starts with
        // `plugin:<pluginKey>:session:`; any other key is stored but then "not found".
        const key = `plugin:${PLUGIN_KEY}:session:${taskKey}`;
        return (await ctx.agents.sessions.create(agentId, companyId, { taskKey: key, reason: "Mattermost thread" })).sessionId;
      },
      ask(sessionId, prompt) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no reply after 30 minutes")), ASK_TIMEOUT_MS);
          ctx.agents.sessions
            .sendMessage(sessionId, companyId, {
              prompt,
              reason: "Mattermost message",
              onEvent: (e) => {
                if (e.eventType === "done") { clearTimeout(timer); resolve(e.message); }
                if (e.eventType === "error") { clearTimeout(timer); reject(new Error(e.message || "the agent run failed")); }
              },
            })
            .catch((err) => { clearTimeout(timer); reject(err); });
        });
      },
    };
  }

  /** The agents that get a bot: all of them, or the ones ticked in settings. */
  private async listAgents(config: Record<string, unknown>): Promise<AgentInfo[]> {
    const picked = config.agentsMode === "selected" && Array.isArray(config.agents) ? new Set(config.agents as string[]) : null;
    const agents = await ctx.agents.list({ companyId: this.companyId, limit: 500 });
    const base = await localBaseUrl();
    return agents.filter((a) => a.status !== "terminated" && (!picked || picked.has(a.id))).map((a) => ({
      id: a.id, name: a.name, title: a.title,
      // The agent's Paperclip portrait (or its uploaded custom one), on a dark background so it reads in a round Mattermost avatar.
      avatarUrl: base + agentAvatarUrl(resolveAgentAppearance((a as { appearance?: unknown }).appearance, a.id), 512, 1, "rest", false, "paperclip-dark"),
    }));
  }

  store(): Store {
    const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: this.companyId, namespace: "mattermost", stateKey });
    return {
      get: async (k) => (await ctx.state.get(key(k))) as never,
      set: (k, v) => ctx.state.set(key(k), v),
    };
  }

  /** Stamps this company on every button, so a click is routed back here. */
  private tag(props: Record<string, unknown>): Record<string, unknown> {
    for (const att of (props.attachments as { actions?: { integration?: { context?: Record<string, unknown> } }[] }[] | undefined) ?? []) {
      for (const action of att.actions ?? []) if (action.integration?.context) action.integration.context.companyId = this.companyId;
    }
    return props;
  }

  private poster(manager: MattermostClient, roster: AgentBots): ApprovalPoster {
    return {
      post: async (agentId, where, message, props) => {
        const as = (agentId && roster.clientOf(agentId)) || manager;
        await manager.request("POST", `/channels/${where.channelId}/members`, { user_id: as.botUserId }).catch(() => {}); // DMs refuse; already in
        return (await as.request<{ id: string }>("POST", "/posts", { channel_id: where.channelId, root_id: where.rootId, message, props: this.tag(props) })).id;
      },
      patch: async (postId, message, props) => {
        await manager.request("PUT", `/posts/${postId}/patch`, { message, props: this.tag(props) });
      },
      async channel(name) {
        // By URL name ("decisions") or by display name in any case ("Decisions"),
        // since a setting typed before Mattermost was connected is often the latter.
        const wanted = name.replace(/^[#~]/, "").trim();
        const teams = await manager.request<{ id: string }[]>("GET", "/users/me/teams");
        for (const team of teams) {
          try { return (await manager.request<{ id: string }>("GET", `/teams/${team.id}/channels/name/${encodeURIComponent(wanted.toLowerCase())}`)).id; } catch { /* not a URL name here */ }
        }
        for (const team of teams) {
          const list = await manager.request<{ id: string; display_name: string }[]>("GET", `/teams/${team.id}/channels?per_page=200`).catch(() => []);
          const hit = list.find((ch) => ch.display_name.trim().toLowerCase() === wanted.toLowerCase());
          if (hit) return hit.id;
        }
        return null;
      },
      async email(userId) {
        return (await manager.request<{ email?: string }>("GET", `/users/${userId}`)).email ?? null;
      },
    };
  }

  async start(config: Record<string, unknown>): Promise<void> {
    const companyId = this.companyId;
    const url = typeof config.mattermostUrl === "string" ? config.mattermostUrl.trim() : "";
    const token = await ctx.secrets.resolve(config.botToken as string, { companyId, configPath: "botToken" });
    const manager = new MattermostClient(url, token, (msg, meta) => ctx.logger.info(msg, { companyId, ...meta }));
    await manager.init();
    const warn = (msg: string, meta?: Record<string, unknown>) => ctx.logger.warn(msg, { companyId, ...meta });
    const store = this.store();
    let onPosted: (evt: PostedEvent) => void = () => {};
    const roster = new AgentBots(manager, url, () => this.listAgents(config), store, warn, (evt) => onPosted(evt));
    const paperclipUrl = typeof config.paperclipUrl === "string" ? config.paperclipUrl.trim().replace(/\/+$/, "") : "";
    const actionUrl = `${paperclipUrl}/api/plugins/${PLUGIN_KEY}/webhooks/actions`;
    // Signs every button. Derived from the admin token: stable across restarts, and rotating the token voids old buttons.
    const key = createHmac("sha256", token).update("mattermost-approval-buttons").digest("hex");
    const canTalk = accessCheck(manager, config);
    const bridge = new Bridge(() => roster.roster(), directoryOf(manager), this.agents(), store, warn, diskFiles(),
      paperclipUrl ? (where, choices) => this.tag(choiceProps(key, actionUrl, where, choices)) : null, canTalk,
      Number(config.agentTurnLimit) > 0 ? Number(config.agentTurnLimit) : DEFAULT_TURN_LIMIT);
    onPosted = (evt) => { void bridge.handle(evt); };
    bridge.linkBase = paperclipUrl;
    const company = await ctx.companies.get(companyId).catch(() => null);
    bridge.taskPrefix = company?.issuePrefix ?? "";
    // A person wrote to a busy agent: the Agent computer plugin ends a computer wait so the agent reads it.
    bridge.onSteer = (agentId, postId) => {
      void ctx.events.emit("person-wrote", companyId, { agentId, postId }).catch(() => {});
    };
    const approvers = parseApprovers(config.approvers);
    const approvalsChannel = typeof config.approvalsChannel === "string" ? config.approvalsChannel.trim() : "";
    const agentName = (agentId: string | null) => (agentId && roster.roster().byAgentId(agentId)?.agentName) || "Paperclip";
    const approvals = paperclipUrl ? new Approvals({
      poster: this.poster(manager, roster), activeThread: (agentId) => bridge.activeThread(agentId), agentName,
      get: async (id) => (await ctx.approvals.get(id, companyId)) as never,
      decide: async (id, action, actorUserId, decisionNote) => { await ctx.approvals.decide(id, { action, actorUserId, decisionNote }, companyId); },
      store, actionUrl, key, fallbackChannel: approvalsChannel, approvers,
    }) : null;
    const cards = paperclipUrl && approvalsChannel ? new Cards({
      poster: this.poster(manager, roster),
      openIssues: async () => (await Promise.all(OPEN_STATUSES.map((status) => ctx.issues.list({ companyId, status, limit: 500 })))).flat(),
      cards: async (issueId) => (await ctx.issues.listInteractions(issueId, companyId)) as never,
      respond: async (issueId, cardId, action, actorUserId, reason) => { await ctx.issues.respondInteraction(issueId, cardId, { action, actorUserId, reason }, companyId); },
      comment: async (issueId, body, actorUserId) => { await ctx.issues.createComment(issueId, body, companyId, { actorUserId }); },
      agentName, store, actionUrl, key, paperclipUrl, channel: approvalsChannel, approvers,
    }) : null;
    const poster = this.poster(manager, roster);
    const actions = new Actions({
      bot: (agentId) => roster.clientOf(agentId),
      manager,
      agents: () => roster.all().map((m) => ({ agentId: m.agentId, agentName: m.agentName, username: m.username, botUserId: m.botUserId })),
      canTalk: async (userId, agentId) => !canTalk || canTalk(userId, agentId),
      origin: (agentId) => bridge.activeThread(agentId),
      format: (text) => linkTasks(absoluteLinks(text, paperclipUrl), paperclipUrl, bridge.taskPrefix),
      // The task this run works on (its execution or checkout run), and the thread it was asked for in.
      taskThread: async (agentId, runId, channelId) => {
        if (!runId) return null;
        const issues = await ctx.issues.list({ companyId, assigneeAgentId: agentId, limit: 200 });
        const issue = issues.find((i) => i.executionRunId === runId || i.checkoutRunId === runId);
        const at = issue ? await store.get<{ channelId: string; rootId: string }>(`issuethread:${issue.id}`) : null;
        return at && at.channelId === channelId ? at.rootId : null;
      },
      task: async (taskId) => (await ctx.issues.get(taskId, companyId)) as never,
      askApproval: async (req) => {
        if (!paperclipUrl || !approvers.size) throw Object.assign(new Error("this needs a person's approval, and nobody can approve from Mattermost yet (the plugin needs its Paperclip public URL and approvers set)"), { status: 403 });
        const { message, props } = requestCard(req, actionUrl, key);
        const targets = [req.origin, approvalsChannel ? await poster.channel(approvalsChannel).then((id) => id && id !== req.origin?.channelId ? { channelId: id, rootId: "" } : null) : null];
        const postIds: string[] = [];
        for (const where of targets) if (where) postIds.push(await poster.post(req.agentId, where, message, props));
        await store.set(`reqcard:${req.id}`, postIds);
      },
      store, newId: () => randomUUID(),
    });
    const work = new WorkLinks({
      store,
      post: async (agentId, channelId, rootId, text) => {
        const as = roster.clientOf(agentId) ?? manager;
        const message = linkTasks(absoluteLinks(text, paperclipUrl), paperclipUrl, bridge.taskPrefix);
        await as.request("POST", "/posts", { channel_id: channelId, root_id: rootId, message, props: FROM_PAPERCLIP });
      },
      hasBot: (agentId) => Boolean(roster.clientOf(agentId)),
      agentName: (agentId) => agentName(agentId),
      archive: async (channelId) => { await manager.request("DELETE", `/channels/${channelId}`); },
      channelName: async (channelId) => (await manager.request<{ display_name: string }>("GET", `/channels/${channelId}`)).display_name,
      task: async (issueId) => (await ctx.issues.get(issueId, companyId)) as never,
      comments: async (issueId) => (await ctx.issues.listComments(issueId, companyId)).map((c) => ({ id: c.id, body: c.body, authorAgentId: c.authorAgentId })),
    });
    Object.assign(this, { manager, bots: roster, bridge, approvals, cards, actions, work, key, approvers, paperclipUrl, approvalsChannel });
    this.status = `connecting to ${url} as @${manager.botUsername}`;
    // Everything below runs from Mattermost sockets and timers, outside this invocation.
    detached(() => {
      manager.connect(onPosted);
      const sync = () => roster.sync()
        .then(() => { this.status = `${roster.size} agent bots in sync`; })
        .catch((err) => { this.status = `agent bot sync failed: ${errText(err)}`; ctx.logger.error(this.status, { companyId }); });
      // Once the bots are connected: replies a restart interrupted are asked for again and delivered.
      void sync().then(() => bridge.resume()).then((n) => { if (n) ctx.logger.info("resuming replies interrupted by a restart", { companyId, threads: n }); })
        .catch((err) => warn("could not resume interrupted replies", { err: errText(err) }));
      this.timers.push(setInterval(sync, SYNC_EVERY_MS));
      void ensureSkill(companyId).catch((err) => warn("could not install the Mattermost skill", { err: errText(err) }));
      if (cards) {
        const poll = () => cards.poll().catch((err) => warn("decision cards poll failed", { err: errText(err) }));
        this.timers.push(setTimeout(poll, 20_000), setInterval(poll, CARDS_EVERY_MS));
      }
    });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.bots?.close();
    this.manager?.close();
    Object.assign(this, { manager: null, bots: null, bridge: null, approvals: null, cards: null, actions: null, work: null });
  }

  /** Approve / Reject on an agent's ask-first request (a broadcast, a public channel, an invite). */
  private async decideRequest(req: ActionRequest & { channel_id?: string }): Promise<string | null> {
    const { requestId, action, sig } = (req.context ?? {}) as { requestId?: string; action?: string; sig?: string };
    if (!this.actions || !this.manager || !requestId || (action !== "approve" && action !== "reject") || !signed(this.key, `req:${requestId}`, action, sig)) return "This button is not valid.";
    const email = req.user_id ? (await this.manager.request<{ email?: string }>("GET", `/users/${req.user_id}`).catch(() => ({ email: "" }))).email?.toLowerCase() : "";
    if (!email || !this.approvers.has(email)) return "You are not set up to approve agent requests from Mattermost. Ask an admin to add your email to the plugin's approvers.";
    const decided = await this.actions.decide(requestId, action === "approve", req.user_name ? `@${req.user_name}` : email);
    if (!decided) return "That request is gone.";
    const { message, props } = requestCard(decided, "", this.key);
    const store = this.store();
    for (const postId of (await store.get<string[]>(`reqcard:${requestId}`)) ?? []) {
      await this.manager.request("PUT", `/posts/${postId}/patch`, { message, props }).catch(() => {});
    }
    return null;
  }

  /** An agent's call to one of the plugin's `/mm/...` routes. */
  async api(agentId: string, routeKey: string, params: Record<string, string>, input: Record<string, unknown>, runId: string | null = null): Promise<{ status: number; body: unknown }> {
    if (!this.actions) return { status: 503, body: { error: `Mattermost is not connected for this company (${this.status})` } };
    return this.actions.handle(agentId, routeKey, params, input, runId);
  }

  /** The Agent computer plugin: an agent wants a person at its computer. Posted where the agent is working. */
  async computerNeedsPerson(p: { agentId?: string; kind?: string; reason?: string; url?: string | null; path?: string | null; computer?: string | null; browser?: string | null }): Promise<void> {
    if (!this.manager || !this.bots || !this.bridge || !p.agentId) return;
    const poster = this.poster(this.manager, this.bots);
    const where = this.bridge.activeThread(p.agentId)
      ?? (this.approvalsChannel ? await poster.channel(this.approvalsChannel).then((id) => (id ? { channelId: id, rootId: "" } : null)) : null);
    if (!where) return;
    const link = this.paperclipUrl && p.path ? `${this.paperclipUrl}${p.path}` : null;
    const on = p.url ? ` on ${p.url}` : "";
    const message = p.kind === "password"
      ? `:key: I ${p.reason ?? "need a password"}${on}. ${link ? `[Enter it here](${link})` : "Enter it from Computers in Paperclip"}: it goes straight into the page, and I never see it.`
      : `:raising_hand: I need a person at ${(p.computer ?? p.browser) ? `the shared ${p.computer ?? p.browser} computer` : "my computer"}${on}: ${p.reason ?? "I am stuck"}. ${link ? `[Take over](${link})` : "Take over from Computers in Paperclip"}, then hand it back; I carry on as soon as you do.`;
    await poster.post(p.agentId, where, message, { ...FROM_PAPERCLIP });
  }

  private async notify(req: ActionRequest & { channel_id?: string }, notice: string | null): Promise<void> {
    if (notice && req.user_id && req.channel_id) {
      await this.manager?.request("POST", "/posts/ephemeral", { user_id: req.user_id, post: { channel_id: req.channel_id, message: notice } }).catch(() => {});
    }
  }

  /** A button click from this company's Mattermost. */
  async click(req: ActionRequest & { channel_id?: string }): Promise<void> {
    const kind = (req.context as { kind?: string } | undefined)?.kind;
    const failed = (err: unknown) => `Could not record that: ${errText(err).slice(0, 300)}`;
    if (kind === "card") {
      if (this.cards) await this.notify(req, await this.cards.click(req as never).catch(failed));
      return;
    }
    if (kind === "request") {
      await this.notify(req, await this.decideRequest(req).catch(failed));
      return;
    }
    if (kind === "choice") {
      const choice = req.context as Partial<ChoiceContext>;
      if (!this.manager || !this.bridge || !req.user_id || !req.post_id || !verifyChoice(this.key, choice)) return;
      const who = req.user_name ? `@${req.user_name}` : "Someone";
      await this.manager.request("PUT", `/posts/${req.post_id}/patch`, { props: chosenProps(choice.choice, who) }).catch(() => {});
      // The pick reaches the agent as that person's next message in the thread; the
      // card's post id keeps a double click from sending it twice. Detached: the agent
      // answers long after this webhook request ends, and Paperclip refuses calls made
      // under a finished request ("missing, expired, or unknown invocation scope").
      const bridge = this.bridge;
      detached(() => void bridge.handle({
        post: { id: `choice:${req.post_id}`, user_id: req.user_id, channel_id: choice.channelId, root_id: choice.rootId, message: choice.choice },
        channelType: choice.channelType, channelName: choice.channelName,
      }));
      return;
    }
    if (this.approvals) await this.notify(req, await this.approvals.click(req).catch(failed));
  }
}

/** The Approve / Reject card for an agent's request; without buttons once decided. */
function requestCard(r: PendingRequest, actionUrl: string, key: string): { message: string; props: Record<string, unknown> } {
  const pending = r.status === "pending";
  const button = (id: "approve" | "reject", name: string, style: string) => ({
    id, name, style, type: "button",
    integration: { url: actionUrl, context: { kind: "request", requestId: r.id, action: id, sig: sign(key, `req:${r.id}`, id) } },
  });
  const outcome = r.status === "approved" ? ":white_check_mark: Approved" : r.status === "rejected" ? ":x: Rejected" : ":warning: Approved, but it failed";
  return {
    message: `**${r.agentName}** asks to ${r.summary}`,
    props: {
      attachments: [{
        color: pending ? "#f2a900" : r.status === "approved" ? "#3db887" : "#d24b4e",
        text: `Needs approval because ${r.why}.`,
        footer: pending ? "Approvers decide here" : `${outcome} by ${r.decidedBy}`,
        actions: pending ? [button("approve", "Approve", "primary"), button("reject", "Reject", "danger")] : [],
      }],
    },
  };
}

function directoryOf(manager: MattermostClient): Directory {
  return {
    userName: (id) => manager.userName(id),
    threadPosts: (rootId) => manager.threadPosts(rootId),
    async ensureMember(channelId, userId) {
      await manager.request("POST", `/channels/${channelId}/members`, { user_id: userId });
    },
    async notify(userId, channelId, rootId, text) {
      await manager.request("POST", "/posts/ephemeral", { user_id: userId, post: { channel_id: channelId, root_id: rootId, message: text } });
    },
  };
}


const tenants = new Map<string, Tenant>();
// Starts and stops per company run one at a time, so a settings save racing a restart cannot leave two bridges.
let queue: Promise<unknown> = Promise.resolve();

function configure(companyId: string, config: Record<string, unknown>): Promise<void> {
  const run = queue.then(async () => {
    tenants.get(companyId)?.stop();
    tenants.delete(companyId);
    const url = typeof config.mattermostUrl === "string" ? config.mattermostUrl.trim() : "";
    if (!url || !config.botToken) return; // cleared or incomplete: this company is off
    const tenant = new Tenant(companyId);
    tenants.set(companyId, tenant);
    try {
      await tenant.start(config);
    } catch (err) {
      tenant.status = `could not start: ${errText(err)}`;
      ctx.logger.error("Mattermost bridge failed to start", { companyId, err: tenant.status });
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** Installs the plugin's Mattermost skill in a company's library, or brings it back to this version's text. */
async function ensureSkill(companyId: string): Promise<string | null> {
  let r = await ctx.skills.managed.reconcile("mattermost", companyId);
  if (r.skill && r.defaultDrift?.changedFiles.length) r = await ctx.skills.managed.reset("mattermost", companyId);
  return r.skill?.key ?? null;
}

async function saveBoot(companyId: string, config: Record<string, unknown>): Promise<void> {
  const all = ((await ctx.state.get(BOOT)) as Record<string, Record<string, unknown>> | null) ?? {};
  all[companyId] = config;
  await ctx.state.set(BOOT, all);
}

const plugin = definePlugin({
  // One worker serves every company, each with its own Mattermost (Tenant above).
  // Without this Paperclip refuses a second company's settings as a cross-tenant risk.
  multiCompanyConfig: true,

  async setup(c) {
    // No company-scoped calls here: the host denies them until the plugin is
    // configured for a company, so the install itself would fail. The host
    // replays each company's saved config through onConfigChanged right after
    // startup, and calls it again whenever an operator saves the settings.
    ctx = c;
    // For the settings page: the detected public URL, this company's Mattermost
    // channels, and which approver emails have an account there.
    ctx.data.register("setup", async (params) => {
      const tenant = typeof params.companyId === "string" ? tenants.get(params.companyId) : undefined;
      const emails = Array.isArray(params.emails) ? (params.emails as unknown[]).filter((e): e is string => typeof e === "string") : [];
      const manager = tenant?.manager;
      let channels: { name: string; displayName: string }[] = [];
      const accounts: Record<string, string | null> = {};
      if (manager) {
        for (const team of await manager.request<{ id: string }[]>("GET", "/users/me/teams").catch(() => [])) {
          const list = await manager.request<{ name: string; display_name: string; type: string }[]>("GET", `/teams/${team.id}/channels?per_page=200`).catch(() => []);
          channels.push(...list.filter((ch) => ch.type === "O").map((ch) => ({ name: ch.name, displayName: ch.display_name })));
        }
        channels = channels.sort((a, b) => a.displayName.localeCompare(b.displayName));
        for (const email of emails) {
          accounts[email] = await manager.request<{ username: string }>("GET", `/users/email/${encodeURIComponent(email)}`).then((u) => u.username).catch(() => null);
        }
      }
      return { detectedUrl: await detectPublicUrl(), connected: Boolean(manager), status: tenant?.status ?? null, versionNote, channels, accounts };
    });
    // The company's Mattermost skill, (re)installed from the manifest; the settings page assigns it to agents.
    ctx.actions.register("skill", async (params) => {
      if (typeof params.companyId !== "string") throw new Error("companyId is required");
      return { key: await ensureSkill(params.companyId) };
    });
    ctx.actions.register("verify-url", async (params) => verifyUrl(String(params.url ?? ""), PLUGIN_KEY));
    const quietly = (what: string, fn: () => Promise<void>) => fn().catch((err) => ctx.logger.warn(what, { err: errText(err) }));
    ctx.events.on("approval.created", (e) => quietly("could not post approval", async () => { if (e.entityId) await tenants.get(e.companyId)?.approvals?.created(e.entityId); }));
    ctx.events.on("issue.comment.created", (e) => quietly("could not mirror a task comment", async () => {
      const commentId = (e.payload as { commentId?: string } | undefined)?.commentId;
      if (e.entityId && commentId) await tenants.get(e.companyId)?.work?.comment(e.entityId, commentId);
    }));
    ctx.events.on("issue.updated", (e) => quietly("could not follow a task update", async () => {
      if (!e.entityId) return;
      const work = tenants.get(e.companyId)?.work;
      await work?.updated(e.entityId);
      await work?.threadUpdate(e.entityId);
    }));
    ctx.events.on("plugin.agent-computer.needs-person", (e) => quietly("could not post a computer help request", async () => {
      await tenants.get(e.companyId)?.computerNeedsPerson((e.payload ?? {}) as never);
    }));
    // A task an agent creates while answering in a Mattermost thread belongs to that conversation:
    // its later results are threaded there (Actions' taskThread).
    ctx.events.on("issue.created", (e) => quietly("could not link a task to its thread", async () => {
      const tenant = tenants.get(e.companyId);
      if (!tenant?.bridge || !e.entityId) return;
      const issue = await ctx.issues.get(e.entityId, e.companyId);
      const by = issue?.createdByAgentId;
      const at = by ? tenant.bridge.activeThread(by) : null;
      if (at) await tenant.store().set(`issuethread:${e.entityId}`, { ...at, agentId: by, status: issue?.status });
    }));
    ctx.events.on("approval.decided", (e) => quietly("could not update approval", async () => { if (e.entityId) await tenants.get(e.companyId)?.approvals?.decided(e.entityId); }));
    detached(() => void checkVersion().catch(() => {}));
    // After a crash the host restarts the worker without replaying config; normal
    // activation replays it within moments, so only start from the saved copies if
    // nothing has started by then.
    detached(() => setTimeout(() => {
      if (tenants.size) return;
      void ctx.state.get(BOOT).then((boot) => {
        const all = (boot as Record<string, Record<string, unknown>> | null) ?? {};
        if (tenants.size || !Object.keys(all).length) return;
        ctx.logger.warn("starting from saved settings after a worker restart", { companies: Object.keys(all).length });
        return Promise.all(Object.entries(all).map(([companyId, config]) => configure(companyId, config)));
      }).catch((err) => ctx.logger.warn("no saved settings to restart from", { err: String(err) }));
    }, BOOT_AFTER_MS));
  },

  async onConfigChanged(newConfig, context) {
    if (!context?.companyId) return;
    await saveBoot(context.companyId, newConfig).catch((err) => ctx.logger.warn("could not save settings for restarts", { err: String(err) }));
    await configure(context.companyId, newConfig);
  },

  async onWebhook(input) {
    if (input.endpointKey !== "actions" || receivePing(input.parsedBody)) return;
    const req = (input.parsedBody ?? {}) as ActionRequest & { channel_id?: string };
    const companyId = (req.context as { companyId?: unknown } | undefined)?.companyId;
    // Buttons from before companies were stamped on them belong to the only company there was.
    const tenant = typeof companyId === "string" ? tenants.get(companyId) : tenants.size === 1 ? [...tenants.values()][0] : undefined;
    await tenant?.click(req);
  },

  async onApiRequest(input) {
    const agentId = input.actor.agentId;
    if (input.actor.actorType !== "agent" || !agentId) return { status: 403, body: { error: "Only agents call these routes." } };
    if (input.routeKey === "help") return { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" }, body: HELP };
    const tenant = tenants.get(input.companyId);
    if (!tenant) return { status: 503, body: { error: "Mattermost is not set up for your company." } };
    const query = Object.fromEntries(Object.entries(input.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
    // Steering: what people wrote in the agent's thread while it works, on request or with any answer.
    if (input.routeKey === "inbox") {
      const messages = tenant.bridge ? await tenant.bridge.takeInbox(agentId) : [];
      return { status: 200, body: { messages, note: messages.length ? "Written to you while you were working. Act on them now: they are not sent to you again." : "Nothing new." } };
    }
    const res = await tenant.api(agentId, input.routeKey, input.params, { ...query, ...body }, input.actor.runId ?? null);
    if (tenant.bridge?.hasInbox(agentId) && res.body && typeof res.body === "object" && !Array.isArray(res.body)) {
      res.body = { ...(res.body as object), newMessages: await tenant.bridge.takeInbox(agentId) };
    }
    return { status: res.status, body: res.body };
  },

  async onHealth() {
    if (!tenants.size) return { status: "error", message: "not configured: set up Mattermost in this plugin's settings for a company" };
    let ok = true;
    const parts = [...tenants.values()].map((t) => {
      const live = t.bots?.connected ?? 0;
      const total = t.bots?.size ?? 0;
      if (!t.manager?.connected || live !== total || !total) ok = false;
      return `${t.status}; ${live}/${total} agent bots connected`;
    });
    return { status: ok ? "ok" : "degraded", message: parts.join(" | ") + (versionNote ? ` | Note: ${versionNote}` : "") };
  },

  async onShutdown() {
    for (const t of tenants.values()) t.stop();
    tenants.clear();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
