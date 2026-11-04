// Routine runs work in silence and speak up only when someone is needed, in their agent's channel
// (or the approvals channel):
//   - a run that ends blocked, with the person it needs @mentioned and the agent's latest comment;
//   - a routine that missed its usual time (its rhythm is learnt from its recent runs), which also
//     catches runs that never happened because Paperclip or this machine was down.
// A finished run is posted only for agents whose channel is set to post routine results.
// Routine tasks are the ones Paperclip marks `routine_execution`; tasks asked for in a Mattermost
// thread report there instead (WorkLinks).
import { finalComment, type TaskComment } from "./worklinks.ts";

export const ROUTINE = "routine_execution";
const HOUR = 3_600_000;
const MAX_POST = 15000;

export interface RoutineTask {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  originKind?: string | null;
  originId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  responsibleUserId?: string | null;
  createdAt?: string | Date;
}

export interface RoutineDeps {
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  task(issueId: string): Promise<RoutineTask | null>;
  /** Oldest first. */
  comments(issueId: string): Promise<TaskComment[]>;
  /** Recent routine tasks, any order. */
  runs(): Promise<RoutineTask[]>;
  channelFor(agentId: string): Promise<{ channelId: string } | null>;
  /** Whether this agent's finished routine runs are posted too. */
  postsResults(agentId: string): boolean;
  post(agentId: string, channelId: string, text: string): Promise<void>;
  /** `@username` for a Paperclip user, or their name; null if unknown. */
  mention(userId: string): Promise<string | null>;
  agentName(agentId: string): string;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export class RoutineReports {
  private d: RoutineDeps;
  private queue = new Map<string, Promise<unknown>>();

  constructor(deps: RoutineDeps) {
    this.d = deps;
  }

  /** A task changed: a routine run that just got blocked (or finished, if asked for) is posted once. */
  updated(issueId: string): Promise<void> {
    const next = (this.queue.get(issueId) ?? Promise.resolve()).catch(() => {}).then(() => this.report(issueId));
    this.queue.set(issueId, next);
    void next.catch(() => {}).finally(() => { if (this.queue.get(issueId) === next) this.queue.delete(issueId); });
    return next;
  }

  private async report(issueId: string): Promise<void> {
    const t = await this.d.task(issueId);
    const agentId = t?.assigneeAgentId;
    if (!t || t.originKind !== ROUTINE || !agentId) return;
    const key = `routinereport:${issueId}`;
    const before = await this.d.store.get<string>(key);
    if (before === t.status) return;
    await this.d.store.set(key, t.status);
    const blocked = t.status === "blocked";
    if (!blocked && !(t.status === "done" && this.d.postsResults(agentId))) return;
    const where = await this.d.channelFor(agentId);
    if (!where) return;
    const latest = (await finalComment(() => this.d.comments(issueId), this.d.sleep))?.body?.trim() ?? "";
    const head = `${blocked ? ":pause_button: Blocked" : ":white_check_mark: Done"} · **${t.identifier ?? "Routine run"}** ${t.title} · ${this.d.agentName(agentId)}`;
    let text: string;
    if (blocked) {
      const who = t.assigneeUserId ?? t.responsibleUserId;
      const needs = (who && (await this.d.mention(who).catch(() => null))) || "a person";
      const quote = latest ? `\n\n> ${(latest.length > 1500 ? latest.slice(0, 1500) + "…" : latest).replace(/\n+/g, "\n> ")}` : "";
      text = `${head}\n_Routine run, needs ${needs}._${quote}\n\nReply in this thread; the agent passes it on to the task.`;
    } else {
      text = `${head}${latest ? `\n\n${latest.length > MAX_POST ? latest.slice(0, MAX_POST) + "…" : latest}` : ""}`;
    }
    try {
      await this.d.post(agentId, where.channelId, text);
    } catch (err) {
      await this.d.store.set(key, before); // not posted: the next update tries again
      throw err;
    }
  }

  /** Routines past their usual time, each warned about once per missed run. */
  async checkMissed(): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    const byRoutine = new Map<string, RoutineTask[]>();
    for (const r of await this.d.runs()) {
      if (r.originKind !== ROUTINE || !r.originId || !r.createdAt) continue;
      byRoutine.set(r.originId, [...(byRoutine.get(r.originId) ?? []), r]);
    }
    for (const [routineId, runs] of byRoutine) {
      const missed = lateBy(runs.map((r) => new Date(r.createdAt!).getTime()), now);
      if (!missed) continue;
      const last = runs.reduce((a, b) => (new Date(b.createdAt!).getTime() > new Date(a.createdAt!).getTime() ? b : a));
      const agentId = last.assigneeAgentId;
      const key = `routinemissed:${routineId}`;
      if (!agentId || (await this.d.store.get<number>(key)) === missed.last) continue;
      const where = await this.d.channelFor(agentId);
      if (!where) continue;
      await this.d.post(agentId, where.channelId,
        `:warning: **${last.title}** has not run. It usually runs every ${every(missed.interval)}; the last run was ${utc(missed.last)} (**${last.identifier ?? "its last task"}**). ` +
        `Check the routine in Paperclip; if it was paused on purpose, ignore this.`);
      await this.d.store.set(key, missed.last);
    }
  }
}

/**
 * When a routine with a steady rhythm (at least 4 runs, gaps within 1.5x of each other) is overdue by
 * more than an eighth of its interval (at least an hour): its interval and last run. Routines idle for
 * over three intervals are taken as stopped on purpose.
 */
export function lateBy(times: number[], now: number): { interval: number; last: number } | null {
  const t = [...new Set(times)].sort((a, b) => a - b).slice(-5);
  if (t.length < 4) return null;
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  const min = Math.min(...gaps), max = Math.max(...gaps);
  if (min <= 0 || max > min * 1.5) return null;
  const interval = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const last = t.at(-1)!;
  const overdue = now - (last + interval);
  if (overdue < Math.max(HOUR, interval / 8) || now - last > interval * 3) return null;
  return { interval, last };
}

function every(ms: number): string {
  const h = ms / HOUR;
  const near = (x: number) => Math.abs(h - x) <= x * 0.1;
  if (near(1)) return "hour";
  if (near(24)) return "day";
  if (near(168)) return "week";
  return h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
