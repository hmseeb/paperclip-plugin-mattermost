// A work channel follows its Paperclip task: new task comments are mirrored into it,
// status changes are noted, and when the task is done or cancelled the outcome is posted
// back where the work was requested; the channel stays open. Posts made here
// carry `from_paperclip`, so the bridge never treats them as agents addressing agents.
import type { WorkLink } from "./actions.ts";

export const FROM_PAPERCLIP = { from_paperclip: "true" };
const CLOSED = new Set(["done", "cancelled"]);
/** Mattermost refuses posts over 16383 characters. */
const MAX_POST = 15000;
/** A comment this recent counts as written with the status change. */
const FRESH_MS = 15_000;
const THREAD_REPORTS: Record<string, string> = { done: ":white_check_mark: Done:", cancelled: ":no_entry_sign: Cancelled:", blocked: ":pause_button: Blocked:" };
const PROGRESS: Record<string, string> = {
  backlog: ":inbox_tray: Backlog", todo: ":hourglass_flowing_sand: Queued", in_progress: ":arrows_counterclockwise: In progress",
  in_review: ":eyes: In review", blocked: ":pause_button: Blocked", done: ":white_check_mark: Done", cancelled: ":no_entry_sign: Cancelled",
};

/** The progress card: status, task, who is on it; its latest comment while it runs, a pointer to the result once it ends. */
export function progressText(task: { identifier?: string | null; title: string; status: string; assigneeAgentId?: string | null }, latest: TaskComment | undefined, agentName: (id: string) => string): string {
  const who = task.assigneeAgentId ? ` · ${agentName(task.assigneeAgentId)}` : "";
  const head = `${PROGRESS[task.status] ?? task.status} · **${task.identifier ?? "The task"}** ${task.title}${who}`;
  if (THREAD_REPORTS[task.status]) return `${head}\n_The result is below._`;
  const body = latest?.body?.trim();
  if (!body) return head;
  const author = latest!.authorAgentId ? agentName(latest!.authorAgentId) : "A team member";
  const excerpt = body.length > 600 ? body.slice(0, 600) + "…" : body;
  return `${head}\n> **${author}:** ${excerpt.replace(/\n+/g, "\n> ")}`;
}

const STATUS_WORDS: Record<string, string> = {
  todo: "to do", in_progress: "in progress", in_review: "in review", blocked: "blocked", backlog: "in the backlog", done: "done", cancelled: "cancelled",
};

/**
 * A task's last comment, waiting a few seconds for one written with the status change: an agent
 * finishing with "done + comment" in one call has the status saved (and announced) before the comment.
 */
export async function finalComment(list: () => Promise<TaskComment[]>, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<TaskComment | undefined> {
  const changedAt = Date.now() - FRESH_MS;
  const fresh = (c?: TaskComment) => Boolean(c?.createdAt && new Date(c.createdAt).getTime() >= changedAt);
  let got = await list();
  for (let i = 0; i < 8 && !fresh(got.at(-1)); i++) {
    await sleep(1000);
    got = await list();
  }
  return got.at(-1);
}

export interface TaskComment { id: string; body: string; authorAgentId?: string | null; createdAt?: string | Date }
export interface WorkDeps {
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  /** Posts as the agent's bot (null: the linked agent's). */
  post(agentId: string, channelId: string, rootId: string, text: string): Promise<string | void>;
  /** Rewrites a post (the progress card); editing notifies nobody. */
  edit?(postId: string, text: string): Promise<void>;
  hasBot(agentId: string): boolean;
  agentName(agentId: string): string;
  channelName(channelId: string): Promise<string>;
  task(issueId: string): Promise<{ identifier?: string | null; title: string; status: string; assigneeAgentId?: string | null } | null>;
  comments(issueId: string): Promise<TaskComment[]>;
  sleep?(ms: number): Promise<void>;
}

/** Where a task reports: the store key of the thread, and of its progress card there. */
interface ThreadTarget { key: string; card: string }

type Linked = WorkLink & { status?: string; closed?: boolean };

export class WorkLinks {
  private d: WorkDeps;
  /** One task's updates, one at a time: Paperclip sends several at once and each would report the change. */
  private queue = new Map<string, Promise<unknown>>();

  constructor(deps: WorkDeps) {
    this.d = deps;
  }

  private async linked(issueId: string): Promise<{ channelId: string; link: Linked } | null> {
    const channelId = await this.d.store.get<string>(`taskchannel:${issueId}`);
    const link = channelId ? await this.d.store.get<Linked>(`worklink:${channelId}`) : null;
    return channelId && link && !link.closed ? { channelId, link } : null;
  }

  private label(link: Linked): string {
    return link.identifier ?? link.title;
  }

  /** A new comment on a task with a work channel. */
  async comment(issueId: string, commentId: string): Promise<void> {
    const hit = await this.linked(issueId);
    if (!hit) return;
    const c = (await this.d.comments(issueId)).find((x) => x.id === commentId);
    if (!c?.body?.trim()) return;
    const body = c.body.trim().slice(0, 12000);
    const quoted = `**${c.authorAgentId ? this.d.agentName(c.authorAgentId) : "A team member"}** commented on ${this.label(hit.link)}:\n\n${body}`;
    if (c.authorAgentId && c.authorAgentId !== hit.link.agentId && this.d.hasBot(c.authorAgentId)) {
      // As its own bot when it is in the channel; Mattermost refuses one that is not, so then quoted.
      try { return await this.d.post(c.authorAgentId, hit.channelId, "", body); } catch { /* not a member */ }
    }
    await this.d.post(hit.link.agentId, hit.channelId, "", c.authorAgentId === hit.link.agentId ? body : quoted);
  }

  private serial(key: string, run: () => Promise<void>): Promise<void> {
    const next = (this.queue.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queue.set(key, next);
    void next.catch(() => {}).finally(() => { if (this.queue.get(key) === next) this.queue.delete(key); });
    return next;
  }

  /**
   * A task asked for in a Mattermost thread (created by the agent while answering there): when it is
   * done, cancelled or blocked, its outcome (the last comment) is posted back in that thread, so the
   * result always reaches the conversation it came from.
   */
  /** The task changed, or got a comment: its progress card in the thread, then (once) its result. */
  threadUpdate(issueId: string): Promise<void> {
    return this.serial(`thread:${issueId}`, async () => {
      let failed: unknown = null;
      for (const t of await this.threads(issueId)) {
        await this.progress(issueId, t).catch(() => {}); // a card that fails to update never blocks the result
        // One thread failing does not stop the others; the first failure is still reported.
        await this.reportToThread(issueId, t).catch((err) => { failed ??= err; });
      }
      if (failed) throw failed;
    });
  }

  /** The thread a task was asked for in, then threads that follow it (nudged from there). */
  private async threads(issueId: string): Promise<ThreadTarget[]> {
    const out: ThreadTarget[] = [{ key: `issuethread:${issueId}`, card: `progress:${issueId}` }];
    for (const root of (await this.d.store.get<string[]>(`issuefollows:${issueId}`)) ?? []) {
      out.push({ key: `issuefollow:${issueId}:${root}`, card: `progress:${issueId}:${root}` });
    }
    return out;
  }

  /**
   * One card in the thread a task was asked for in, edited as the task moves: where it stands, who is on
   * it, and its latest comment. Edits notify nobody; the result itself still arrives as a new post.
   */
  private async progress(issueId: string, target: ThreadTarget): Promise<void> {
    if (!this.d.edit) return;
    const at = await this.d.store.get<{ channelId: string; rootId: string; agentId?: string }>(target.key);
    if (!at) return;
    const task = await this.d.task(issueId);
    if (!task) return;
    const card = await this.d.store.get<{ postId: string; text: string }>(target.card);
    const comments = await this.d.comments(issueId);
    const closed = Boolean(THREAD_REPORTS[task.status]);
    // Started: picked up (out of the queue) or commented on. A task that finishes before that needs no card.
    if (!card && (closed || (["backlog", "todo"].includes(task.status) && !comments.length))) return;
    const by = [at.agentId, task.assigneeAgentId].find((a): a is string => Boolean(a && this.d.hasBot(a)));
    if (!by) return;
    const text = progressText(task, closed ? undefined : comments.at(-1), (id) => this.d.agentName(id));
    if (card?.text === text) return;
    if (card) {
      await this.d.edit(card.postId, text);
      await this.d.store.set(target.card, { ...card, text });
    } else {
      const postId = await this.d.post(by, at.channelId, at.rootId, text);
      if (postId) await this.d.store.set(target.card, { postId, text });
    }
  }

  private async reportToThread(issueId: string, target: ThreadTarget): Promise<void> {
    const at = await this.d.store.get<{ channelId: string; rootId: string; agentId?: string; status?: string }>(target.key);
    if (!at) return;
    const task = await this.d.task(issueId);
    if (!task || task.status === at.status || !THREAD_REPORTS[task.status]) return;
    // The agent the thread is with posts: another agent's bot is not in that DM or channel (403).
    const by = [at.agentId, task.assigneeAgentId].find((a): a is string => Boolean(a && this.d.hasBot(a)));
    if (!by) return;
    await this.d.store.set(target.key, { ...at, status: task.status });
    const last = (await this.finalComment(issueId))?.body?.trim();
    const doer = task.assigneeAgentId && task.assigneeAgentId !== by ? ` _(by ${this.d.agentName(task.assigneeAgentId)})_` : "";
    const status = `${THREAD_REPORTS[task.status]} **${task.identifier ?? "The task"}** ${task.title}${doer}`;
    // The agent's answer as written on the task, then one line saying where it stands.
    const text = last ? `${last.length > MAX_POST ? last.slice(0, MAX_POST) + "…" : last}\n\n${status}` : status;
    try {
      await this.d.post(by, at.channelId, at.rootId, text);
    } catch (err) {
      await this.d.store.set(target.key, at); // not reported: the next update tries again
      throw err;
    }
  }

  private finalComment(issueId: string): Promise<TaskComment | undefined> {
    return finalComment(() => this.d.comments(issueId), this.d.sleep);
  }

  /** The task changed: note a new status; on done or cancelled, report back (the channel stays open). */
  updated(issueId: string): Promise<void> {
    return this.serial(`link:${issueId}`, () => this.followLink(issueId));
  }

  private async followLink(issueId: string): Promise<void> {
    const hit = await this.linked(issueId);
    if (!hit) return;
    const task = await this.d.task(issueId);
    if (!task || task.status === hit.link.status) return;
    const { channelId, link } = hit;
    const known = link.status !== undefined; // the first update only records where the task stands
    link.status = task.status;
    if (!CLOSED.has(task.status)) {
      await this.d.store.set(`worklink:${channelId}`, link);
      if (known) await this.d.post(link.agentId, channelId, "", `_${this.label(link)} is now ${STATUS_WORDS[task.status] ?? task.status}._`);
      return;
    }
    link.closed = true;
    await this.d.store.set(`worklink:${channelId}`, link);
    const done = task.status === "done";
    // The channel stays open (its history and people stay put); the outcome goes back where it was asked for.
    await this.d.post(link.agentId, channelId, "", `${done ? ":white_check_mark:" : ":no_entry_sign:"} ${this.label(link)} is ${task.status}. The outcome is posted back where it was asked for; this channel stays open.`);
    // A task asked for in a thread reports there itself (threadUpdate): once is enough.
    if (!link.origin || (await this.d.store.get(`issuethread:${issueId}`))) return;
    const last = (await this.finalComment(issueId))?.body?.trim();
    const status = `${done ? ":white_check_mark: Done" : ":no_entry_sign: Cancelled"}: **${this.label(link)}** ${task.title}`;
    const name = await this.d.channelName(channelId).catch(() => "");
    const text = `${last ? `${last.length > MAX_POST ? last.slice(0, MAX_POST) + "…" : last}\n\n` : ""}${status}${name ? `\n_Discussion: ~${name}_` : ""}`;
    await this.d.post(link.agentId, link.origin.channelId, link.origin.rootId, text);
  }
}
