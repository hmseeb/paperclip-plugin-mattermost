import { extractChoices, MAX_CHOICES } from "./choices.ts";
import type { FileChat, Files } from "./files.ts";
import { Progress, THINKING } from "./progress.ts";

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
  patchPost(postId: string, message: string): Promise<void>;
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
  /**
   * Resolves with the final reply text (null when the agent said nothing); rejects on failure.
   * `onOutput` receives the run's live stdout as it arrives.
   */
  ask(sessionId: string, prompt: string, onOutput?: (chunk: string) => void): Promise<string | null>;
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

export const PROGRESS_EVERY_MS = 2000; // at most one progress edit per post this often
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

  constructor(roster: () => Roster, directory: Directory, agents: Agents, store: Store,
    log: (msg: string, meta?: Record<string, unknown>) => void = () => {}, files: Files | null = null,
    choiceButtons: ChoiceButtons | null = null, canTalk: ((userId: string, agentId: string) => Promise<boolean>) | null = null) {
    this.files = files;
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
    const prev = this.queues.get(rootId) ?? Promise.resolve();
    const next = prev.then(() => this.process(evt, rootId)).catch((err) => this.log("bridge error", { err: String(err) }));
    this.queues.set(rootId, next);
    void next.finally(() => { if (this.queues.get(rootId) === next) this.queues.delete(rootId); });
    return next;
  }

  /** The thread an agent is answering right now, for posts its run causes (approvals). */
  activeThread(agentId: string): { channelId: string; rootId: string } | null {
    return this.active.get(agentId) ?? null;
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
      if (p.id === currentId || p.type || !p.message.trim() || p.message.startsWith(THINKING)) continue;
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
    if (roster.isBot(post.user_id) || post.type || post.props?.from_bot === "true" || post.props?.from_webhook === "true") return;

    const threadKey = `thread:${rootId}`;
    const thread = await this.store.get<ThreadState>(threadKey);
    const member = this.target(evt, thread);
    if (!member) return;
    const text = stripMention(post.message, member.username);
    const fileIds = this.files ? post.file_ids ?? [] : [];
    if (!text && !fileIds.length) return;
    if (this.canTalk && !(await this.canTalk(post.user_id, member.agentId))) {
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

    const progress = new Progress();
    const placeholder = await member.chat.createPost(post.channel_id, rootId, progress.render());
    await member.chat.typing(post.channel_id, rootId).catch(() => {});

    const attached = fileIds.length ? await this.files!.receive(member.chat, post.id, fileIds) : [];
    const outbox = this.files ? await this.files.outbox(post.id).catch(() => null) : null;
    const prompt = `${sender.displayName} (@${sender.username}) wrote to you (@${member.username}) in ${where} on Mattermost. Your reply is posted back there, so answer in Markdown. ` +
      `To offer choices, end your reply with one line \`choices: First | Second\` (2 to ${MAX_CHOICES} short options); they are shown as buttons, and the pick comes back as the next message.` +
      (history ? `\n\nEarlier in this thread (oldest first):\n${history}\n\nNew message:` : "") + `\n\n${text || "(no text, only files)"}` +
      (attached.length ? `\n\nAttached files, saved on disk (read them at these paths):\n${attached.join("\n")}` : "") +
      (outbox ? `\n\nTo send files back with your reply, save them in ${outbox}` : "");

    // Progress edits are throttled, and the last one is awaited before the answer is
    // written, so a late progress edit can never overwrite the reply.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let edit = Promise.resolve();
    let finished = false;
    const onOutput = (chunk: string) => {
      if (finished || !progress.feed(chunk) || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (finished) return;
        edit = edit.then(() => member.chat.patchPost(placeholder.id, progress.render())).catch(() => {});
      }, PROGRESS_EVERY_MS);
    };
    const settle = async () => {
      finished = true;
      if (timer) clearTimeout(timer);
      await edit;
    };

    let reply: string | null;
    const here = { channelId: post.channel_id, rootId };
    this.active.set(member.agentId, here);
    try {
      let sessionId = thread && thread.agentId === member.agentId ? thread.sessionId : null;
      try {
        if (!sessionId) throw new Error("no session yet");
        reply = await this.agents.ask(sessionId, prompt, onOutput);
      } catch (first) {
        if (sessionId) this.log("session unusable, starting a new one", { sessionId, err: String(first) });
        sessionId = await this.agents.createSession(member.agentId, `mattermost:${rootId}`);
        await this.store.set(threadKey, { agentId: member.agentId, sessionId } satisfies ThreadState);
        reply = await this.agents.ask(sessionId, prompt, onOutput);
      }
    } catch (err) {
      if (this.active.get(member.agentId) === here) this.active.delete(member.agentId);
      await settle();
      await member.chat.patchPost(placeholder.id, `:warning: ${member.agentName} could not answer: ${String((err as Error)?.message ?? err).slice(0, 500)}`);
      return;
    }

    if (this.active.get(member.agentId) === here) this.active.delete(member.agentId);
    await settle();
    const { text: body, choices } = extractChoices(reply ?? "");
    const origin = { channelId: post.channel_id, rootId, channelType: evt.channelType, channelName: evt.channelName };
    const buttons = choices.length && this.choiceButtons ? this.choiceButtons(origin, choices) : null;
    // Without buttons (no public URL set), the options stay readable as a list.
    const shown = choices.length && !buttons ? `${body}\n\n${choices.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : body;
    const [first, ...more] = splitMessage(shown.trim() || `_${member.agentName} finished without a reply._`);
    await member.chat.patchPost(placeholder.id, first);
    for (const part of more) await member.chat.createPost(post.channel_id, rootId, part);
    if (buttons) await member.chat.createPost(post.channel_id, rootId, "", buttons);
    if (outbox) {
      await this.files!.send(member.chat, post.channel_id, rootId, outbox).catch((err) =>
        member.chat.createPost(post.channel_id, rootId, `:warning: ${member.agentName}'s files could not be attached: ${String((err as Error)?.message ?? err).slice(0, 300)}`));
    }
  }
}
