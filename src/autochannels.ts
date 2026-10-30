// Work channels opened by the plugin itself, for tasks where people and agents work together:
//   1. an agent's task that a person is assigned to, or reviews or approves;
//   2. a task whose subtasks are with at least two other agents.
// The channel is a normal work channel (comments mirrored, archived when the task is done or
// cancelled). Its members are the task's agent, the other agents on it and the people involved,
// including whoever asked for it; ones who join the task later are added as they appear. A subtask
// finishing, blocking or being cancelled is noted there. Subtasks are learnt from task events, so
// only ones created after this feature are counted.

export interface AutoTask {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  responsibleUserId?: string | null;
  executionPolicy?: { stages?: { participants?: { type?: string; userId?: string | null; agentId?: string | null }[] }[] } | null;
}

export interface AutoDeps {
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  task(issueId: string): Promise<AutoTask | null>;
  comments(issueId: string): Promise<{ body: string }[]>;
  hasBot(agentId: string): boolean;
  agentName(agentId: string): string;
  /** Opens the task's work channel as `owner`'s bot; returns its id. */
  open(owner: string, task: AutoTask): Promise<string>;
  /** Adds agents (by id) and people (by Paperclip user id) to a channel; returns the people it could not find in Mattermost. */
  add(channelId: string, agentIds: string[], userIds: string[]): Promise<string[]>;
  post(agentId: string, channelId: string, text: string): Promise<void>;
}

interface Opened { channelId: string; owner: string; members: string[] }

const CLOSED = new Set(["done", "cancelled"]);
const SUBTASK_REPORTS: Record<string, string> = { done: ":white_check_mark:", blocked: ":pause_button:", cancelled: ":no_entry_sign:" };
/** Rule 2: this many agents on its subtasks besides the task's own. */
export const OTHER_AGENTS = 2;

export class AutoChannels {
  private d: AutoDeps;
  private queue = new Map<string, Promise<unknown>>();

  constructor(deps: AutoDeps) {
    this.d = deps;
  }

  /** A task was created or changed. One task at a time, as its events arrive in bursts. */
  changed(issueId: string): Promise<void> {
    const prev = this.queue.get("all") ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.consider(issueId));
    this.queue.set("all", next);
    return next;
  }

  private async consider(issueId: string): Promise<void> {
    const t = await this.d.task(issueId);
    if (!t) return;
    if (t.parentId) {
      const kids = (await this.d.store.get<Record<string, string | null>>(`autokids:${t.parentId}`)) ?? {};
      if (kids[t.id] !== (t.assigneeAgentId ?? null)) {
        kids[t.id] = t.assigneeAgentId ?? null;
        await this.d.store.set(`autokids:${t.parentId}`, kids);
      }
      await this.subtaskNote(t);
      const parent = await this.d.task(t.parentId);
      if (parent) await this.evaluate(parent);
    }
    await this.evaluate(t);
  }

  private async evaluate(t: AutoTask): Promise<void> {
    if (CLOSED.has(t.status)) return;
    const owner = [t.assigneeAgentId, t.createdByAgentId].find((a): a is string => Boolean(a && this.d.hasBot(a)));
    if (!owner) return;
    const people = new Set<string>();
    if (t.assigneeUserId) people.add(t.assigneeUserId);
    for (const stage of t.executionPolicy?.stages ?? []) for (const p of stage.participants ?? []) if (p.type === "user" && p.userId) people.add(p.userId);
    const kids = (await this.d.store.get<Record<string, string | null>>(`autokids:${t.id}`)) ?? {};
    const others = new Set(Object.values(kids).filter((a): a is string => Boolean(a && a !== owner && this.d.hasBot(a))));
    const why = people.size ? "people and agents are working on it together" : others.size >= OTHER_AGENTS ? "several agents are working on it" : null;
    if (!why) return;
    const asker = t.createdByUserId ?? t.responsibleUserId;
    if (asker) people.add(asker);
    const agents = [owner, ...others];

    const opened = await this.d.store.get<Opened>(`autochannel:${t.id}`);
    if (opened) {
      // People and agents who joined the task since: add them.
      const fresh = [...agents, ...people].filter((m) => !opened.members.includes(m));
      if (!fresh.length) return;
      await this.d.add(opened.channelId, fresh.filter((m) => agents.includes(m)), fresh.filter((m) => people.has(m)));
      await this.d.store.set(`autochannel:${t.id}`, { ...opened, members: [...opened.members, ...fresh] });
      return;
    }
    if (await this.d.store.get<string>(`taskchannel:${t.id}`)) return; // an agent opened one already
    const channelId = await this.d.open(owner, t);
    await this.d.store.set(`autochannel:${t.id}`, { channelId, owner, members: [...agents, ...people] } satisfies Opened);
    const missing = await this.d.add(channelId, agents, [...people]);
    const label = t.identifier ?? "this task";
    await this.d.post(owner, channelId,
      `Channel for **${label}** ${t.title}, opened because ${why}. Task comments appear here, and it is archived when ${label} is done or cancelled.` +
      (missing.length ? `\n\n_Could not add ${missing.join(", ")}: not matched to a Mattermost account (add them to the plugin's approvers or people list)._` : ""));
  }

  private async subtaskNote(t: AutoTask): Promise<void> {
    const opened = await this.d.store.get<Opened>(`autochannel:${t.parentId}`);
    if (!opened) return;
    const last = await this.d.store.get<string>(`autosub:${t.id}`);
    if (last === t.status) return;
    await this.d.store.set(`autosub:${t.id}`, t.status);
    const icon = SUBTASK_REPORTS[t.status];
    if (!icon) return;
    const outcome = (await this.d.comments(t.id)).at(-1)?.body?.trim();
    const by = t.assigneeAgentId ? ` _(${this.d.agentName(t.assigneeAgentId)})_` : "";
    await this.d.post(opened.owner, opened.channelId,
      `${icon} Subtask **${t.identifier ?? t.title}** ${t.identifier ? t.title : ""} is ${t.status}${by}.${outcome ? `\n\n${outcome.length > 1500 ? outcome.slice(0, 1500) + "…" : outcome}` : ""}`);
  }
}
