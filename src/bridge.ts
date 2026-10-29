import { extractChoices, MAX_CHOICES } from "./choices.ts";
import type { FileChat, Files } from "./files.ts";

// Mattermost <-> Paperclip agent bridge. Pure logic: chat, agents, directory and
// storage are injected, so it is unit-tested with fakes (test/bridge.test.ts).
//
// Every Paperclip agent is its own Mattermost bot. Which agent answers a post:
// a direct message goes to the bot it was sent to; in a channel, the first agent
// bot mentioned; a later post in a thread an agent is part of goes to that agent.
// One agent session per thread, and follow-ups carry the thread so far, because
// agents may start each turn without memory.

export interface Post {
  id: string;
  user_id: string;
  channel_id: string;
  root_id?: string;
  message: string;
  type?: string;
  props?: Record<string, unknown>;
  file_ids?: string[];
}

export interface PostedEvent {
  post: Post;
  channelType: string; // "O" public, "P" private, "D" direct, "G" group
  channelName: string; // for "D": "<userId>__<userId>"
}

/** Posting as one agent's bot. */
export interface ChatApi extends FileChat {
  createPost(channelId: string, rootId: string, message: string, props?: Record<string, unknown>): Promise<{ id: string }>;
  typing(channelId: string, rootId: string): Promise<void>;
  react(postId: string, emoji: string): Promise<void>;
}

/** Read access and channel membership, through the manager account. */
export interface Directory {
  userName(userId: string): Promise<{ username: string; displayName: string }>;
  threadPosts(rootId: string): Promise<Post[]>;
  ensureMember(channelId: string, userId: string): Promise<void>;
  /** A note only that person sees. */
  notify(userId: string, channelId: string, rootId: string, text: string): Promise<void>;
}

export interface Member {
  agentId: string;
  agentName: string;
  botUserId: string;
  username: string;
  chat: ChatApi;
}

export interface Roster {
  byBotId(userId: string): Member | undefined;
  byUsername(username: string): Member | undefined;
  byAgentId(agentId: string): Member | undefined;
  /** Agent bots: never answered, so agents do not loop on each other. */
  isBot(userId: string): boolean;
}

export interface Agents {
  createSession(agentId: string, taskKey: string): Promise<string>;
  /** Resolves with the final reply text (null when the agent said nothing); rejects on failure. */
  ask(sessionId: string, prompt: string): Promise<string | null>;
}

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

/** Builds the buttons for options an agent offers; null when buttons cannot be clicked back. */
export type ChoiceButtons = (where: { channelId: string; rootId: string; channelType: string; channelName: string }, choices: string[]) => Record<string, unknown> | null;

interface ThreadState {
  agentId: string;
  sessionId: string;
}

export const DEFAULT_TURN_LIMIT = 10; // agent-to-agent messages in a thread before a person must reply
export const TYPING_EVERY_MS = 3000; // Mattermost drops a typing indicator after ~5s
/** The placeholder earlier versions posted while an agent worked; still in old threads. */
const OLD_PLACEHOLDER = /^_(thinking…|.+ is working on it…)_/;
export const MAX_POST = 15000; // Mattermost's limit is 16383; leave room
export const MAX_HISTORY = 8000; // characters of earlier thread messages sent with a follow-up
const MENTION = /(?:^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi;

/** Mattermost bot username for an agent name: "Client Success Manager" -> "client-success-manager". */
export function botUsername(agentName: string): string {
  const slug = agentName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return /^[a-z]/.test(slug) ? slug : `agent-${slug || "x"}`;
}

export function mentions(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[1].replace(/[._-]+$/, "").toLowerCase());
}

export function stripMention(text: string, username: string): string {
  return text.replace(new RegExp(`(^|[^\\w@])@${username.replace(/[.-]/g, "\\$&")}\\b[:,]?`, "gi"), "$1").replace(/\s{2,}/g, " ").trim();
}

/**
 * Paperclip-relative links an agent writes (`[BAD-705](/BAD/issues/BAD-705)`) made absolute, so a
 * click in Mattermost opens Paperclip rather than a page on Mattermost's own domain.
 */
export function absoluteLinks(text: string, base: string): string {
  if (!base) return text;
  const root = base.replace(/\/+$/, "");
  return text.replace(/\]\((\/(?!\/)[^)\s]*)\)/g, (_m, path: string) => `](${root}${path})`);
}

/**
 * The company's task numbers (BAD-728) as links to the task in Paperclip, when an agent writes them
 * as plain text. Only this company's prefix, so COVID-19 or SHA-256 are left alone, and never inside
 * code or an existing link.
 */
export function linkTasks(text: string, base: string, prefix: string): string {
  if (!base || !/^[A-Z][A-Z0-9]{0,15}$/.test(prefix)) return text;
  const root = base.replace(/\/+$/, "");
  const skip = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/[^\s)]+)/;
  const id = new RegExp(`(?<![\\w/-])(${prefix}-\\d+)(?![\\w-])`, "g");
  return text.split(skip).map((part, i) => (i % 2 ? part : part.replace(id, (m) => `[${m}](${root}/${prefix}/issues/${m})`))).join("");
}

export function splitMessage(text: string, max = MAX_POST): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}

export class Bridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();
  private active = new Map<string, { channelId: string; rootId: string }>();
  private roster: () => Roster;
  private directory: Directory;
  private agents: Agents;
  private store: Store;
  private log: (msg: string, meta?: Record<string, unknown>) => void;
  private files: Files | null;
  private choiceButtons: ChoiceButtons | null;
  private canTalk: ((userId: string, agentId: string) => Promise<boolean>) | null;
  private turnLimit: number;
  /** Paperclip's public URL, for agents' relative links, and the company's task prefix (BAD). */
  linkBase = "";
  taskPrefix = "";
  /**
   * Steering: messages people send in a thread while its agent is mid-run, kept for that agent to
   * read in the same run (`takeInbox`). One it read is not run again afterwards.
   */
  private inbox = new Map<string, { id: string; rootId: string; userId: string; text: string; at: number }[]>();
  private delivered = new Set<string>();
  /** Told when a person writes to an agent that is busy (the computer plugin wakes a waiting agent). */
  onSteer: ((agentId: string, postId: string) => void) | null = null;

  constructor(roster: () => Roster, directory: Directory, agents: Agents, store: Store,
    log: (msg: string, meta?: Record<string, unknown>) => void = () => {}, files: Files | null = null,
    choiceButtons: ChoiceButtons | null = null, canTalk: ((userId: string, agentId: string) => Promise<boolean>) | null = null,
    turnLimit = DEFAULT_TURN_LIMIT) {
    this.files = files;
    this.turnLimit = turnLimit;
    this.canTalk = canTalk;
    this.choiceButtons = choiceButtons;
    this.roster = roster;
    this.directory = directory;
    this.agents = agents;
    this.store = store;
    this.log = log;
  }

  /**
   * Handles one Mattermost "posted" event. The same post arrives on every socket that
   * can see it, so it is processed once. Posts in one thread run one at a time.
   */
  handle(evt: PostedEvent): Promise<void> {
    if (this.seen.has(evt.post.id)) return Promise.resolve();
    this.seen.add(evt.post.id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);

    const rootId = evt.post.root_id || evt.post.id;
    this.steer(evt, rootId);
    const prev = this.queues.get(rootId) ?? Promise.resolve();
    const next = prev.then(() => this.process(evt, rootId)).catch((err) => this.log("bridge error", { err: String(err) }));
    this.queues.set(rootId, next);
    void next.finally(() => { if (this.queues.get(rootId) === next) this.queues.delete(rootId); });
    return next;
  }

  /** A person writing in a thread whose agent is mid-run: offered to that run as well as queued. */
  private steer(evt: PostedEvent, rootId: string) {
    const { post } = evt;
    if (!post.root_id || post.type || post.props?.from_webhook === "true" || post.props?.from_paperclip === "true" || post.props?.from_bot === "true") return;
    if (this.roster().isBot(post.user_id) || !post.message?.trim()) return;
    for (const [agentId, at] of this.active) {
      if (at.rootId !== rootId) continue;
      const list = this.inbox.get(agentId) ?? [];
      list.push({ id: post.id, rootId, userId: post.user_id, text: post.message.slice(0, 4000), at: Date.now() });
      this.inbox.set(agentId, list.slice(-20));
      this.onSteer?.(agentId, post.id);
    }
  }

  /** Whether the agent has unread messages from people in the thread it is answering. */
  hasInbox(agentId: string): boolean {
    return (this.inbox.get(agentId)?.length ?? 0) > 0;
  }

  /** What people wrote in the agent's thread since its run started; each is handed over once. */
  async takeInbox(agentId: string): Promise<{ from: string; text: string; at: string }[]> {
    const list = this.inbox.get(agentId) ?? [];
    this.inbox.delete(agentId);
    const out = [];
    for (const m of list) {
      this.delivered.add(m.id);
      const who = await this.directory.userName(m.userId).catch(() => ({ username: m.userId, displayName: m.userId }));
      out.push({ from: `${who.displayName} (@${who.username})`, text: m.text, at: new Date(m.at).toISOString() });
    }
    if (this.delivered.size > 2000) this.delivered.delete(this.delivered.values().next().value as string);
    return out;
  }

  /** The thread an agent is answering right now, for posts its run causes (approvals). */
  activeThread(agentId: string): { channelId: string; rootId: string } | null {
    return this.active.get(agentId) ?? null;
  }

  /** The agent another agent's post addresses: the first other agent it mentions. */
  private mentioned(evt: PostedEvent, author: Member): Member | undefined {
    if (evt.channelType === "D") return undefined; // a DM holds only its two members
    const roster = this.roster();
    for (const name of mentions(evt.post.message)) {
      const member = roster.byUsername(name);
      if (member && member.agentId !== author.agentId) return member;
    }
    return undefined;
  }

  /**
   * Agents may address agents, up to the turn limit per thread; a person posting in the
   * thread resets it. At the limit the addressed agent says once that it is waiting.
   */
  private async resetTurns(rootId: string): Promise<void> {
    const turns = await this.store.get<{ n: number }>(`turns:${rootId}`);
    if (turns?.n) await this.store.set(`turns:${rootId}`, { n: 0 });
  }

  private async allowAgentTurn(rootId: string, fromAgent: Member | undefined, member: Member, channelId: string): Promise<boolean> {
    if (!fromAgent) {
      await this.resetTurns(rootId);
      return true;
    }
    const key = `turns:${rootId}`;
    const turns = (await this.store.get<{ n: number; paused?: boolean }>(key)) ?? { n: 0 };
    if (turns.n >= this.turnLimit) {
      if (!turns.paused) {
        await this.store.set(key, { ...turns, paused: true });
        await member.chat.createPost(channelId, rootId, `_Pausing here: agents have traded ${turns.n} messages in this thread. Reply to let us carry on._`).catch(() => {});
      }
      return false;
    }
    await this.store.set(key, { n: turns.n + 1 });
    return true;
  }

  private target(evt: PostedEvent, thread: ThreadState | null): Member | undefined {
    const roster = this.roster();
    if (evt.channelType === "D") {
      const other = evt.channelName.split("__").find((id) => id !== evt.post.user_id);
      return other ? roster.byBotId(other) : undefined;
    }
    for (const name of mentions(evt.post.message)) {
      const member = roster.byUsername(name);
      if (member) return member;
    }
    return thread ? roster.byAgentId(thread.agentId) : undefined;
  }

  private async history(rootId: string, currentId: string, me: Member): Promise<string> {
    const roster = this.roster();
    const lines: string[] = [];
    for (const p of await this.directory.threadPosts(rootId)) {
      if (p.id === currentId || p.type || !p.message.trim() || OLD_PLACEHOLDER.test(p.message)) continue;
      const who = p.user_id === me.botUserId ? "You" : `@${roster.byBotId(p.user_id)?.username ?? (await this.directory.userName(p.user_id)).username}`;
      lines.push(`${who}: ${p.message}`);
    }
    let text = lines.join("\n");
    if (text.length > MAX_HISTORY) text = "…" + text.slice(-MAX_HISTORY);
    return text;
  }

  private async process(evt: PostedEvent, rootId: string): Promise<void> {
    const { post } = evt;
    const roster = this.roster();
    // An agent's own bot may address other agents; other bots, webhooks, system posts and
    // the plugin's mirrored task updates never start anything.
    const fromAgent = roster.isBot(post.user_id) ? roster.byBotId(post.user_id) : undefined;
    if (post.type || post.props?.from_webhook === "true" || post.props?.from_paperclip === "true") return;
    if (post.props?.from_bot === "true" && !fromAgent) return;

    const threadKey = `thread:${rootId}`;
    const thread = await this.store.get<ThreadState>(threadKey);
    const member = fromAgent ? this.mentioned(evt, fromAgent) : this.target(evt, thread);
    if (!member) {
      if (!fromAgent && post.root_id) await this.resetTurns(rootId); // a person spoke in the thread
      return;
    }
    if (this.delivered.has(post.id)) {
      // Read and handled by the agent in the run that was going when it arrived.
      await member.chat.react(post.id, "white_check_mark").catch(() => {});
      return;
    }
    if (!(await this.allowAgentTurn(rootId, fromAgent, member, post.channel_id))) return;
    const text = stripMention(post.message, member.username);
    const fileIds = this.files ? post.file_ids ?? [] : [];
    if (!text && !fileIds.length) return;
    if (!fromAgent && this.canTalk && !(await this.canTalk(post.user_id, member.agentId))) {
      await this.directory.notify(post.user_id, post.channel_id, post.root_id ?? "", `You don't have access to talk to ${member.agentName} here. Ask a Paperclip admin to add you in the Mattermost plugin's settings.`).catch(() => {});
      return;
    }

    const isDirect = evt.channelType === "D";
    if (!isDirect) await this.directory.ensureMember(post.channel_id, member.botUserId);
    // Seen, before anything slow: the first sign the agent picked the message up.
    await member.chat.react(post.id, "eyes").catch(() => {});

    const sender = await this.directory.userName(post.user_id);
    const where = isDirect ? "a direct message" : `#${evt.channelName}`;
    const history = post.root_id ? await this.history(post.root_id, post.id, member) : "";

    // Mattermost's own "is typing…" indicator, refreshed until the reply is posted: it
    // fades after a few seconds unless sent again, and an agent can work for minutes.
    // Sent for the thread (where the reply lands) and the channel (where people often
    // look), since Mattermost shows each only in its own view.
    const typing = () => {
      void member.chat.typing(post.channel_id, rootId).catch(() => {});
      void member.chat.typing(post.channel_id, "").catch(() => {});
    };
    typing();
    const typingTimer = setInterval(typing, TYPING_EVERY_MS);
    try {
      await this.answer(evt, member, rootId, threadKey, thread, { sender, where, history, text, fileIds });
    } finally {
      clearInterval(typingTimer);
    }
  }

  private async answer(evt: PostedEvent, member: Member, rootId: string, threadKey: string, thread: ThreadState | null,
    m: { sender: { username: string; displayName: string }; where: string; history: string; text: string; fileIds: string[] }): Promise<void> {
    const { post } = evt;
    const { sender, where, history, text, fileIds } = m;
    const attached = fileIds.length ? await this.files!.receive(member.chat, post.id, fileIds) : [];
    const outbox = this.files ? await this.files.outbox(post.id).catch(() => null) : null;
    const fromAgent = this.roster().isBot(post.user_id);
    const prompt = `${sender.displayName} (@${sender.username}${fromAgent ? ", another agent" : ""}) wrote to you (@${member.username}) in ${where} on Mattermost. Your reply is posted back there, so answer in Markdown. ` +
      `To offer choices, end your reply with one line \`choices: First | Second\` (2 to ${MAX_CHOICES} short options); they are shown as buttons, and the pick comes back as the next message. ` +
      `You can also read channels, post, message people, mention other agents and open work channels in Mattermost: GET <your Paperclip API URL>/api/plugins/mattermost-bridge/api/mm/help shows how. ` +
      `If this takes more than a minute or two, check GET …/api/plugins/mattermost-bridge/api/mm/inbox between steps: it returns anything people write in this thread meanwhile (a correction, "stop", "never mind"); act on it then, as it is not sent to you again.` +
      (history ? `\n\nEarlier in this thread (oldest first):\n${history}\n\nNew message:` : "") + `\n\n${text || "(no text, only files)"}` +
      (attached.length ? `\n\nAttached files, saved on disk (read them at these paths):\n${attached.join("\n")}` : "") +
      (outbox ? `\n\nTo send files back with your reply, save them in ${outbox}` : "");

    let reply: string | null;
    const here = { channelId: post.channel_id, rootId };
    this.active.set(member.agentId, here);
    try {
      let sessionId = thread && thread.agentId === member.agentId ? thread.sessionId : null;
      try {
        if (!sessionId) throw new Error("no session yet");
        reply = await this.agents.ask(sessionId, prompt);
      } catch (first) {
        if (sessionId) this.log("session unusable, starting a new one", { sessionId, err: String(first) });
        sessionId = await this.agents.createSession(member.agentId, `mattermost:${rootId}`);
        await this.store.set(threadKey, { agentId: member.agentId, sessionId } satisfies ThreadState);
        reply = await this.agents.ask(sessionId, prompt);
      }
    } catch (err) {
      if (this.active.get(member.agentId) === here) this.active.delete(member.agentId);
      this.inbox.delete(member.agentId);
      await member.chat.createPost(post.channel_id, rootId, `:warning: ${member.agentName} could not answer: ${String((err as Error)?.message ?? err).slice(0, 500)}`);
      return;
    }

    if (this.active.get(member.agentId) === here) this.active.delete(member.agentId);
    // Unread steering for this run goes back to being ordinary queued messages.
    this.inbox.delete(member.agentId);
    const { text: body, choices } = extractChoices(linkTasks(absoluteLinks(reply ?? "", this.linkBase), this.linkBase, this.taskPrefix));
    const origin = { channelId: post.channel_id, rootId, channelType: evt.channelType, channelName: evt.channelName };
    const buttons = choices.length && this.choiceButtons ? this.choiceButtons(origin, choices) : null;
    // Without buttons (no public URL set), the options stay readable as a list.
    const shown = choices.length && !buttons ? `${body}\n\n${choices.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : body;
    const [first, ...more] = splitMessage(shown.trim() || `_${member.agentName} finished without a reply._`);
    await member.chat.createPost(post.channel_id, rootId, first);
    for (const part of more) await member.chat.createPost(post.channel_id, rootId, part);
    if (buttons) await member.chat.createPost(post.channel_id, rootId, "", buttons);
    if (outbox) {
      await this.files!.send(member.chat, post.channel_id, rootId, outbox).catch((err) =>
        member.chat.createPost(post.channel_id, rootId, `:warning: ${member.agentName}'s files could not be attached: ${String((err as Error)?.message ?? err).slice(0, 300)}`));
    }
  }
}
