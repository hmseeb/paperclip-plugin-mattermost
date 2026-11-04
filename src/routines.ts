// Routine runs work in silence and speak up only when someone is needed, in their agent's channel
// (or the approvals channel):
//   - a run that ends blocked, with the person it needs @mentioned and the agent's latest comment;
//   - a routine that missed a run it made at that time the last two weeks, which also catches runs
//     that never happened because Paperclip or this machine was down.
// A finished run is posted only for agents whose channel is set to post routine results.
// Routine tasks are the ones Paperclip marks `routine_execution`; tasks asked for in a Mattermost
// thread report there instead (WorkLinks).
import { finalComment, type TaskComment } from "./worklinks.ts";

export const ROUTINE = "routine_execution";
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
/** How far off a run may be and still count as the same weekly run. */
const GRACE = 2 * HOUR;
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
  /** The agent's channel, else the approvals channel (with a note when its own channel is missing). */
  channelFor(agentId: string): Promise<{ channelId: string; note?: string } | null>;
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
      await this.d.post(agentId, where.channelId, where.note ? `${text}\n_${where.note}_` : text);
    } catch (err) {
      await this.d.store.set(key, before); // not posted: the next update tries again
      throw err;
    }
  }

  /** Routines that missed a run they make every week, each warned about once until they run again. */
  async checkMissed(): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    const byRoutine = new Map<string, RoutineTask[]>();
    for (const r of await this.d.runs()) {
      if (r.originKind !== ROUTINE || !r.originId || !r.createdAt) continue;
      byRoutine.set(r.originId, [...(byRoutine.get(r.originId) ?? []), r]);
    }
    for (const [routineId, runs] of byRoutine) {
      const times = runs.map((r) => new Date(r.createdAt!).getTime());
      const slot = missedRun(times, now);
      if (slot === null) continue;
      const last = runs[times.indexOf(Math.max(...times))];
      const lastAt = Math.max(...times);
      const agentId = last.assigneeAgentId;
      const key = `routinemissed:${routineId}`;
      if (!agentId || (await this.d.store.get<number>(key)) === lastAt) continue;
      const where = await this.d.channelFor(agentId);
      if (!where) continue;
      await this.d.post(agentId, where.channelId,
        `:warning: **${last.title}** missed its ${utc(slot, true)} run (it ran at that time the last two weeks). ` +
        `Last run: ${utc(lastAt)} (**${last.identifier ?? "its last task"}**). Check the routine in Paperclip; if it was paused on purpose, ignore this.`);
      await this.d.store.set(key, lastAt);
    }
  }
}

/**
 * The time of a run this routine should have made in the last day but did not: it ran then (within
 * two hours, enough for a clock change) one and two weeks before, and has not run since. Weekly
 * patterns keep weekday-only, business-hours and twice-daily routines from false alarms; asking for
 * two weeks in a row leaves out one-off and irregular (webhook) runs.
 */
export function missedRun(times: number[], now: number): number | null {
  const near = (x: number) => times.some((t) => Math.abs(t - x) <= GRACE);
  const last = Math.max(...times);
  let found: number | null = null;
  for (const t of times) {
    const slot = t + WEEK;
    if (slot > now - GRACE || slot < now - DAY || last >= slot - GRACE) continue;
    if (near(t - WEEK) && (found === null || slot < found)) found = slot;
  }
  return found;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const utc = (ms: number, short = false) => {
  const d = new Date(ms);
  return short ? `${DAYS[d.getUTCDay()]} ${d.toISOString().slice(11, 16)} UTC` : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
