// Keeps one Mattermost bot per Paperclip agent. The manager client (a personal access
// token of a System Admin user; Mattermost refuses bot accounts creating bots even
// with the System Admin role) creates, renames, disables and enables the agent bots, adds them
// to its teams, and joins every public channel so it hears mentions anywhere.
// Agent bot tokens are minted at startup and held in memory only; tokens a previous
// run minted are revoked first, so a restart never leaves extras behind.
import { botUsername, type Member, type PostedEvent, type Roster, type Store } from "./bridge.ts";
import { MattermostClient } from "./mattermost.ts";

type Log = (msg: string, meta?: Record<string, unknown>) => void;
export interface AgentInfo { id: string; name: string; title?: string | null; /** Fetchable URL of the agent's portrait. */ avatarUrl?: string | null }
interface Bot { user_id: string; username: string; display_name: string; description: string; delete_at: number; owner_id?: string }
type Manager = Pick<MattermostClient, "request" | "setProfileImage" | "botUserId">;
type BotClient = Pick<MattermostClient, "init" | "connect" | "close" | "connected"> & Member["chat"];

/** Whether a failed request means "it does not exist", as opposed to "could not ask right now". */
const notFound = (err: unknown) => (err as { status?: number })?.status === 404;
const TOKEN_DESCRIPTION = "paperclip-plugin";

export class AgentBots {
  private members = new Map<string, Member & { client: BotClient }>();
  private manager: Manager;
  private newClient: (token: string) => BotClient;
  private listAgents: () => Promise<AgentInfo[]>;
  private store: Store;
  private log: Log;
  private onPosted: (evt: PostedEvent) => void;

  constructor(manager: Manager, url: string, listAgents: () => Promise<AgentInfo[]>, store: Store, log: Log, onPosted: (evt: PostedEvent) => void,
    newClient?: (token: string) => BotClient) {
    this.manager = manager;
    this.newClient = newClient ?? ((token) => new MattermostClient(url, token, log));
    this.listAgents = listAgents;
    this.store = store;
    this.log = log;
    this.onPosted = onPosted;
  }

  roster(): Roster {
    const all = [...this.members.values()];
    return {
      byBotId: (id) => all.find((m) => m.botUserId === id),
      byUsername: (name) => all.find((m) => m.username === name.toLowerCase()),
      byAgentId: (id) => this.members.get(id),
      // Not the manager: its token may be a person's admin account, and that person still chats.
      isBot: (id) => all.some((m) => m.botUserId === id),
    };
  }

  all(): Member[] {
    return [...this.members.values()];
  }

  /** The Mattermost client of an agent's bot, for posts beyond chat replies. */
  clientOf(agentId: string): MattermostClient | undefined {
    return this.members.get(agentId)?.client as MattermostClient | undefined;
  }

  get connected(): number {
    return [...this.members.values()].filter((m) => m.client.connected).length;
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * The bot, or null only when Mattermost says it does not exist. Any other failure (the
   * server restarting, a timeout) throws, so the agent is skipped this round rather than
   * given a second bot: that is how Carma's Operations Agent became @operations-agent-agent
   * while @operations-agent, the one people mention, was left with nobody behind it.
   */
  private async bot(id: string): Promise<Bot | null> {
    try {
      return await this.manager.request<Bot>("GET", `/bots/${id}?include_deleted=true`);
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  /** The bot at an agent's own username, if it is one of ours and no other agent uses it. */
  private async reclaimable(agent: AgentInfo, map: Record<string, string>): Promise<Bot | null> {
    let user: { id: string; is_bot?: boolean };
    try {
      user = await this.manager.request("GET", `/users/username/${botUsername(agent.name)}`);
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
    if (!user.is_bot || Object.entries(map).some(([other, id]) => other !== agent.id && id === user.id)) return null;
    const bot = await this.bot(user.id);
    return bot && bot.owner_id === this.manager.botUserId ? bot : null;
  }

  private async createBot(agent: AgentInfo): Promise<Bot> {
    const base = botUsername(agent.name);
    let last: unknown;
    for (const username of [base, `${base}-agent`, `${base}-2`, `${base}-3`]) {
      try {
        return await this.manager.request<Bot>("POST", "/bots", { username, display_name: agent.name, description: agent.title || "Paperclip agent" });
      } catch (err) {
        last = err; // most often: the username is taken by a person or another bot
      }
    }
    throw last;
  }

  private async mintToken(botId: string): Promise<string> {
    const tokens = await this.manager.request<{ id: string; description: string }[]>("GET", `/users/${botId}/tokens?per_page=200`);
    for (const t of tokens) if (t.description === TOKEN_DESCRIPTION) await this.manager.request("POST", "/users/tokens/revoke", { token_id: t.id }).catch(() => {});
    return (await this.manager.request<{ token: string }>("POST", `/users/${botId}/tokens`, { description: TOKEN_DESCRIPTION })).token;
  }

  /** Brings Mattermost in line with the company's agents. Safe to run repeatedly. */
  async sync(): Promise<void> {
    const agents = await this.listAgents();
    const map = (await this.store.get<Record<string, string>>("bots")) ?? {};
    // Agents whose bot is switched off (removed, or unticked in settings). The bot is
    // kept, so ticking the agent again brings back the same account and its history.
    const off = new Set((await this.store.get<string[]>("bots-off")) ?? []);
    // Which portrait each bot shows, so it is uploaded once and again only when the agent's changes.
    const avatars = (await this.store.get<Record<string, string>>("avatars")) ?? {};
    const teams = await this.manager.request<{ id: string }[]>("GET", "/users/me/teams");

    for (const agent of agents) {
      try {
        let bot = map[agent.id] ? await this.bot(map[agent.id]) : null;
        if (!bot) {
          // A bot this plugin made earlier for the agent (its saved list was lost, say) is reused.
          const mine = await this.reclaimable(agent, map);
          bot = mine ?? await this.createBot(agent);
          this.log(mine ? "reused the agent's existing bot" : "created agent bot", { agent: agent.name, username: bot.username });
        } else if (bot.username !== botUsername(agent.name)) {
          // On a fallback name (taken at the time): move back to the agent's own bot when
          // it is ours and free, and switch the stand-in off.
          const original = await this.reclaimable(agent, map);
          if (original && original.user_id !== bot.user_id) {
            await this.manager.request("POST", `/bots/${bot.user_id}/disable`).catch(() => {});
            this.log("moved agent back to its own bot", { agent: agent.name, from: bot.username, to: original.username });
            bot = original;
          }
        }
        {
          if (bot.delete_at > 0) await this.manager.request("POST", `/bots/${bot.user_id}/enable`);
          if (bot.display_name !== agent.name) {
            bot = await this.manager.request<Bot>("PUT", `/bots/${bot.user_id}`, { username: bot.username, display_name: agent.name, description: agent.title || bot.description });
          }
        }
        map[agent.id] = bot.user_id;
        off.delete(agent.id);
        if (agent.avatarUrl && avatars[agent.id] !== agent.avatarUrl) {
          try {
            const r = await fetch(agent.avatarUrl, { signal: AbortSignal.timeout(30000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            await this.manager.setProfileImage(bot.user_id, new Uint8Array(await r.arrayBuffer()));
            avatars[agent.id] = agent.avatarUrl;
          } catch (err) {
            this.log("could not set the bot's picture", { agent: agent.name, err: String((err as Error)?.message ?? err) });
          }
        }
        for (const team of teams) {
          await this.manager.request("POST", `/teams/${team.id}/members`, { team_id: team.id, user_id: bot.user_id }).catch(() => {});
        }
        const current = this.members.get(agent.id);
        if (current && current.botUserId === bot.user_id) {
          current.agentName = agent.name;
          continue;
        }
        current?.client.close();
        const client = this.newClient(await this.mintToken(bot.user_id));
        await client.init();
        client.connect(this.onPosted);
        this.members.set(agent.id, { agentId: agent.id, agentName: agent.name, botUserId: bot.user_id, username: bot.username, chat: client, client });
      } catch (err) {
        this.log("could not set up agent bot", { agent: agent.name, err: String((err as Error)?.message ?? err) });
      }
    }

    const live = new Set(agents.map((a) => a.id));
    for (const [agentId, botId] of Object.entries(map)) {
      if (live.has(agentId) || off.has(agentId)) continue;
      this.members.get(agentId)?.client.close();
      this.members.delete(agentId);
      await this.manager.request("POST", `/bots/${botId}/disable`).catch(() => {});
      off.add(agentId);
      this.log("disabled the bot of an agent no longer in Mattermost", { agentId });
    }
    await this.store.set("bots", map);
    await this.store.set("bots-off", [...off]);
    await this.store.set("avatars", avatars);

    // The manager listens in every public channel, so a mention of an agent that is
    // not in the channel yet is still heard (the agent joins when it answers).
    for (const team of teams) {
      const mine = new Set((await this.manager.request<{ id: string }[]>("GET", `/users/me/teams/${team.id}/channels`)).map((c) => c.id));
      for (const ch of await this.manager.request<{ id: string }[]>("GET", `/teams/${team.id}/channels?per_page=200`)) {
        if (!mine.has(ch.id)) await this.manager.request("POST", `/channels/${ch.id}/members`, { user_id: this.manager.botUserId }).catch(() => {});
      }
    }
  }

  close(): void {
    for (const m of this.members.values()) m.client.close();
    this.members.clear();
  }
}
