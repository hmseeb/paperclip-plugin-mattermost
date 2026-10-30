// A work channel follows its Paperclip task: new task comments are mirrored into it,
// status changes are noted, and when the task is done or cancelled the channel is
// archived and the outcome posted back where the work was requested. Posts made here
// carry `from_paperclip`, so the bridge never treats them as agents addressing agents.
import type { WorkLink } from "./actions.ts";

export const FROM_PAPERCLIP = { from_paperclip: "true" };
const CLOSED = new Set(["done", "cancelled"]);
const THREAD_REPORTS: Record<string, string> = { done: ":white_check_mark: Done:", cancelled: ":no_entry_sign: Cancelled:", blocked: ":pause_button: Blocked:" };
const STATUS_WORDS: Record<string, string> = {
  todo: "to do", in_progress: "in progress", in_review: "in review", blocked: "blocked", backlog: "in the backlog", done: "done", cancelled: "cancelled",
};

export interface TaskComment { id: string; body: string; authorAgentId?: string | null }
export interface WorkDeps {
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  /** Posts as the agent's bot (null: the linked agent's). */
  post(agentId: string, channelId: string, rootId: string, text: string): Promise<void>;
  hasBot(agentId: string): boolean;
  agentName(agentId: string): string;
  archive(channelId: string): Promise<void>;
  channelName(channelId: string): Promise<string>;
  task(issueId: string): Promise<{ identifier?: string | null; title: string; status: string; assigneeAgentId?: string | null } | null>;
  comments(issueId: string): Promise<TaskComment[]>;
}

type Linked = WorkLink & { status?: string; closed?: boolean };

export class WorkLinks {
  private d: WorkDeps;

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

  /**
   * A task asked for in a Mattermost thread (created by the agent while answering there): when it is
   * done, cancelled or blocked, its outcome (the last comment) is posted back in that thread, so the
   * result always reaches the conversation it came from.
   */
  async threadUpdate(issueId: string): Promise<void> {
    const at = await this.d.store.get<{ channelId: string; rootId: string; agentId?: string; status?: string }>(`issuethread:${issueId}`);
    if (!at) return;
    const task = await this.d.task(issueId);
    if (!task || task.status === at.status || !THREAD_REPORTS[task.status]) return;
    // The agent the thread is with posts: another agent's bot is not in that DM or channel (403).
    const by = [at.agentId, task.assigneeAgentId].find((a): a is string => Boolean(a && this.d.hasBot(a)));
    if (!by) return;
    await this.d.store.set(`issuethread:${issueId}`, { ...at, status: task.status });
    const last = (await this.d.comments(issueId)).at(-1)?.body?.trim();
    const outcome = last ? `\n\n${last.length > 3000 ? last.slice(0, 3000) + "…" : last}` : "";
    const doer = task.assigneeAgentId && task.assigneeAgentId !== by ? ` _(by ${this.d.agentName(task.assigneeAgentId)})_` : "";
    try {
      await this.d.post(by, at.channelId, at.rootId, `${THREAD_REPORTS[task.status]} **${task.identifier ?? "The task"}** ${task.title}${doer}${outcome}`);
    } catch (err) {
      await this.d.store.set(`issuethread:${issueId}`, at); // not reported: the next update tries again
      throw err;
    }
  }

  /** The task changed: note a new status; on done or cancelled, archive and report back. */
  async updated(issueId: string): Promise<void> {
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
    const last = (await this.d.comments(issueId)).at(-1)?.body?.trim();
    const outcome = last ? `\n\n${last.length > 1500 ? last.slice(0, 1500) + "…" : last}` : "";
    const done = task.status === "done";
    const name = await this.d.channelName(channelId).catch(() => "the work channel");
    await this.d.post(link.agentId, channelId, "", `${done ? ":white_check_mark:" : ":no_entry_sign:"} ${this.label(link)} is ${task.status}. Archiving this channel; it stays readable under archived channels.`);
    await this.d.archive(channelId);
    if (link.origin) {
      await this.d.post(link.agentId, link.origin.channelId, link.origin.rootId,
        `${done ? ":white_check_mark: Done" : ":no_entry_sign: Cancelled"}: **${this.label(link)}** ${task.title}${outcome}\n\n_~${name} is archived._`);
    }
  }
}
