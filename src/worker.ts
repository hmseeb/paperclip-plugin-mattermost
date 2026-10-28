import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createHmac } from "node:crypto";
import { Cards } from "./interactions.ts";
import { choiceProps, chosenProps, verifyChoice, type ChoiceContext } from "./choices.ts";
import { Approvals, parseApprovers, type ActionRequest, type ApprovalPoster } from "./approvals.ts";
import { Bridge, type Agents, type Directory, type PostedEvent, type Store } from "./bridge.ts";
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
  key = "";
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
      ask(sessionId, prompt, onOutput) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no reply after 30 minutes")), ASK_TIMEOUT_MS);
          ctx.agents.sessions
            .sendMessage(sessionId, companyId, {
              prompt,
              reason: "Mattermost message",
              onEvent: (e) => {
                if (e.eventType === "chunk" && e.stream === "stdout" && e.message) onOutput?.(e.message);
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

  private store(): Store {
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
        for (const team of await manager.request<{ id: string }[]>("GET", "/users/me/teams")) {
          try { return (await manager.request<{ id: string }>("GET", `/teams/${team.id}/channels/name/${encodeURIComponent(name.replace(/^[#~]/, ""))}`)).id; } catch { /* next team */ }
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
    const bridge = new Bridge(() => roster.roster(), directoryOf(manager), this.agents(), store, warn, diskFiles(),
      paperclipUrl ? (where, choices) => this.tag(choiceProps(key, actionUrl, where, choices)) : null, accessCheck(manager, config));
    onPosted = (evt) => { void bridge.handle(evt); };
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
    Object.assign(this, { manager, bots: roster, bridge, approvals, cards, key });
    this.status = `connecting to ${url} as @${manager.botUsername}`;
    // Everything below runs from Mattermost sockets and timers, outside this invocation.
    detached(() => {
      manager.connect(onPosted);
      const sync = () => roster.sync()
        .then(() => { this.status = `${roster.size} agent bots in sync`; })
        .catch((err) => { this.status = `agent bot sync failed: ${errText(err)}`; ctx.logger.error(this.status, { companyId }); });
      void sync();
      this.timers.push(setInterval(sync, SYNC_EVERY_MS));
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
    Object.assign(this, { manager: null, bots: null, bridge: null, approvals: null, cards: null });
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
    if (kind === "choice") {
      const choice = req.context as Partial<ChoiceContext>;
      if (!this.manager || !this.bridge || !req.user_id || !req.post_id || !verifyChoice(this.key, choice)) return;
      const who = req.user_name ? `@${req.user_name}` : "Someone";
      await this.manager.request("PUT", `/posts/${req.post_id}/patch`, { props: chosenProps(choice.choice, who) }).catch(() => {});
      // The pick reaches the agent as that person's next message in the thread; the
      // card's post id keeps a double click from sending it twice.
      void this.bridge.handle({
        post: { id: `choice:${req.post_id}`, user_id: req.user_id, channel_id: choice.channelId, root_id: choice.rootId, message: choice.choice },
        channelType: choice.channelType, channelName: choice.channelName,
      });
      return;
    }
    if (this.approvals) await this.notify(req, await this.approvals.click(req).catch(failed));
  }
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

async function saveBoot(companyId: string, config: Record<string, unknown>): Promise<void> {
  const all = ((await ctx.state.get(BOOT)) as Record<string, Record<string, unknown>> | null) ?? {};
  all[companyId] = config;
  await ctx.state.set(BOOT, all);
}

const plugin = definePlugin({
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
    ctx.actions.register("verify-url", async (params) => verifyUrl(String(params.url ?? ""), PLUGIN_KEY));
    const quietly = (what: string, fn: () => Promise<void>) => fn().catch((err) => ctx.logger.warn(what, { err: errText(err) }));
    ctx.events.on("approval.created", (e) => quietly("could not post approval", async () => { if (e.entityId) await tenants.get(e.companyId)?.approvals?.created(e.entityId); }));
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
