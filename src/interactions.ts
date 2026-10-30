// Decision cards agents raise on Paperclip tasks ("issue-thread interactions"),
// mirrored into the raising agent's decisions channel (its own, else the approvals channel). Confirmations and suggested tasks get Accept /
// Reject buttons; a click is resolved as the clicker's Paperclip user. Questions get a
// button per option; plugins cannot submit answers to a question card, so once every
// question has a pick the answers are posted on the task as a comment from the person
// who picked, which wakes the agent like a comment typed in Paperclip. The rarer kinds
// are posted with a link. Paperclip sends plugins no event when a card is created, so
// open tasks are polled.
import { sign, type ApprovalPoster, type ChannelFor } from "./approvals.ts";

export interface Card {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  title?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string | Date;
  createdByAgentId?: string | null;
  resolvedByUserId?: string | null;
}

export interface OpenIssue { id: string; identifier?: string | null; title: string; assigneeAgentId?: string | null }

export interface CardDeps {
  poster: ApprovalPoster;
  openIssues(): Promise<OpenIssue[]>;
  cards(issueId: string): Promise<Card[]>;
  respond(issueId: string, cardId: string, action: "accept" | "reject", actorUserId: string, reason: string): Promise<void>;
  /** A comment on the task attributed to a person (it wakes the task's agent). */
  comment(issueId: string, body: string, actorUserId: string): Promise<void>;
  agentName(agentId: string | null): string;
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  actionUrl: string;
  key: string;
  paperclipUrl: string;
  channelFor: ChannelFor;
  approvers: Map<string, string>;
  now?: () => Date;
}

interface Picked { optionId: string; label: string; by: string }
/** A posted card; for questions, the picks so far and who sent the answers. */
interface Tracked { postId: string; issueId: string; by?: string; picks?: Record<string, Picked>; sent?: string }
interface Question { id: string; prompt?: string; helpText?: string; selectionMode?: string; allowOther?: boolean; options?: { id: string; label?: string }[] }

/** Questions answerable with buttons: every one single-choice with options to click. */
function buttonQuestions(c: Card): Question[] | null {
  const qs = Array.isArray(c.payload?.questions) ? (c.payload!.questions as Question[]) : [];
  if (!qs.length || qs.some((q) => !q.id || q.selectionMode === "multi" || !(q.options ?? []).some((o) => o.id && str(o.label)))) return null;
  return qs;
}
type Posted = Record<string, Tracked>;

/** Kinds a plugin can resolve; the rest are shown with a link. */
const ANSWERABLE = new Set(["request_confirmation", "suggest_tasks"]);
const OUTCOME: Record<string, string> = { accepted: ":white_check_mark: Accepted", rejected: ":x: Rejected", answered: ":white_check_mark: Answered", expired: "Expired", cancelled: "Withdrawn" };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const sig = (key: string, c: { issueId: string; cardId: string }, action: string) => sign(key, `card:${c.issueId}:${c.cardId}`, action);

type RenderDeps = { actionUrl: string; key: string; paperclipUrl: string };

/** A question card as one block per question, its options as buttons. */
function renderQuestions(c: Card, qs: Question[], message: string, d: RenderDeps, t?: Pick<Tracked, "picks" | "sent">): { message: string; props: Record<string, unknown> } {
  const p = c.payload ?? {};
  const picks = t?.picks ?? {};
  const open = c.status === "pending" && !t?.sent;
  const footer = t?.sent
    ? `Answered by ${t.sent} from Mattermost; sent to the agent as a comment on the task`
    : qs.length > 1 ? "Pick an answer for each question; they are sent together" : "Pick an answer";
  const blocks = qs.map((q, i) => ({
    color: t?.sent ? "#3db887" : "#f2a900",
    ...(i === 0 ? { title: str(c.title) || str(p.title) || "Question" } : {}),
    text: [`**${str(q.prompt)}**`, str(q.helpText), q.allowOther && open ? "_Or answer something else in Paperclip (link above)._" : "", picks[q.id] && !open ? `Answer: **${picks[q.id].label}**` : ""].filter(Boolean).join("\n"),
    ...(i === qs.length - 1 ? { footer } : {}),
    actions: open ? (q.options ?? []).filter((o) => o.id && str(o.label)).map((o) => {
      const picked = picks[q.id]?.optionId === o.id;
      const action = `pick:${q.id}:${o.id}`;
      return {
        id: `q${i}${o.id}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 60), name: picked ? `✓ ${str(o.label)}` : str(o.label), type: "button", style: picked ? "primary" : "default",
        integration: { url: d.actionUrl, context: { kind: "card", issueId: c.issueId, cardId: c.id, action, sig: sig(d.key, { issueId: c.issueId, cardId: c.id }, action) } },
      };
    }) : [],
  }));
  return { message, props: { attachments: blocks } };
}

export function renderCard(c: Card, issue: OpenIssue, agentName: string, d: RenderDeps, by?: string, t?: Pick<Tracked, "picks" | "sent">): { message: string; props: Record<string, unknown> } {
  const p = c.payload ?? {};
  const link = `${d.paperclipUrl}/issues/${encodeURIComponent(issue.identifier || issue.id)}`;
  const qs = c.kind === "ask_user_questions" && c.status === "pending" ? buttonQuestions(c) : null;
  if (qs) return renderQuestions(c, qs, `**Question** from ${agentName} on [${issue.identifier ?? "a task"}: ${issue.title}](${link})`, d, t);
  const lines: string[] = [];
  let title = str(c.title);
  let accept = "Accept";
  let reject = "Reject";
  if (c.kind === "request_confirmation") {
    title ||= str(p.prompt);
    if (str(p.prompt) && str(p.prompt) !== title) lines.push(str(p.prompt));
    if (str(p.detailsMarkdown)) lines.push(str(p.detailsMarkdown));
    accept = str(p.acceptLabel) || accept;
    reject = str(p.rejectLabel) || reject;
  } else if (c.kind === "suggest_tasks") {
    title ||= "Suggested tasks";
    const tasks = Array.isArray(p.tasks) ? (p.tasks as { title?: string }[]).map((t) => str(t.title)).filter(Boolean) : [];
    lines.push(tasks.map((t) => `- ${t}`).join("\n"));
    accept = "Create these tasks";
    reject = "Dismiss";
  } else if (c.kind === "ask_user_questions") {
    title ||= str(p.title) || "Questions";
    for (const q of Array.isArray(p.questions) ? (p.questions as { prompt?: string; options?: { label?: string }[]; selectionMode?: string }[]) : []) {
      const opts = (q.options ?? []).map((o) => str(o.label)).filter(Boolean);
      lines.push(`**${str(q.prompt)}**${q.selectionMode === "multi" ? " _(pick any)_" : ""}${opts.length ? "\n" + opts.map((o) => `- ${o}`).join("\n") : ""}`);
    }
  } else {
    title ||= str(p.prompt) || c.kind.replace(/_/g, " ");
    if (str(p.prompt) && str(p.prompt) !== title) lines.push(str(p.prompt));
  }
  if (str(c.summary) && !lines.length) lines.push(str(c.summary));
  const pending = c.status === "pending";
  const buttons = pending && ANSWERABLE.has(c.kind);
  const button = (id: "accept" | "reject", name: string, style: string) => ({
    id, name, style, type: "button",
    integration: { url: d.actionUrl, context: { kind: "card", issueId: c.issueId, cardId: c.id, action: id, sig: sig(d.key, { issueId: c.issueId, cardId: c.id }, id) } },
  });
  const outcome = `${OUTCOME[c.status] ?? c.status}${by ? ` by ${by}` : ""}${t?.sent && c.status === "answered" ? " (answered from Mattermost)" : ""}`;
  return {
    message: `**${c.kind === "ask_user_questions" ? "Question" : "Decision needed"}** from ${agentName} on [${issue.identifier ?? "a task"}: ${issue.title}](${link})`,
    props: {
      attachments: [{
        color: pending ? "#f2a900" : c.status === "accepted" || c.status === "answered" ? "#3db887" : "#8a8a8a",
        title: title || "Decision needed",
        text: lines.filter(Boolean).join("\n\n"),
        footer: pending ? (buttons ? "Decide here or in Paperclip" : "Answer it in Paperclip (link above)") : outcome,
        actions: buttons ? [button("accept", accept, "primary"), button("reject", reject, "danger")] : [],
      }],
    },
  };
}

export class Cards {
  private d: CardDeps;
  private issues = new Map<string, OpenIssue>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(deps: CardDeps) {
    this.d = deps;
  }

  /** Polls and clicks both rewrite the tracked list, so they take turns. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** One pass: post new cards, close the ones resolved since. */
  poll(): Promise<void> {
    return this.serial(() => this.pass());
  }

  private async pass(): Promise<void> {
    const d = this.d;
    const homes = new Map<string | null, Awaited<ReturnType<ChannelFor>>>();
    const home = async (agentId: string | null) => {
      if (!homes.has(agentId)) homes.set(agentId, await d.channelFor(agentId));
      return homes.get(agentId) ?? null;
    };
    const now = (d.now ?? (() => new Date()))();
    // Cards raised before this feature first ran stay in Paperclip only.
    let since = await d.store.get<string>("cards:since");
    if (!since) { since = now.toISOString(); await d.store.set("cards:since", since); }
    const posted = (await d.store.get<Posted>("cards:posted")) ?? {};
    const seen = new Set<string>();
    for (const issue of await d.openIssues()) {
      this.issues.set(issue.id, issue);
      for (const c of await d.cards(issue.id)) {
        seen.add(c.id);
        if (posted[c.id]) {
          if (c.status !== "pending") { await this.close(c, posted[c.id]); delete posted[c.id]; }
        } else if (c.status === "pending" && new Date(c.createdAt).getTime() > Date.parse(since)) {
          const agentId = c.createdByAgentId ?? issue.assigneeAgentId ?? null;
          const where = await home(agentId);
          if (!where) continue; // no channel to post in: tried again on the next pass
          const { message, props } = renderCard(c, issue, d.agentName(agentId), d);
          posted[c.id] = { postId: await d.poster.post(agentId, { channelId: where.channelId, rootId: "" }, where.note ? `${message}\n_${where.note}_` : message, props), issueId: issue.id };
        }
      }
    }
    // Tracked cards whose task closed since: they expired or were withdrawn with it.
    for (const [id, t] of Object.entries(posted)) {
      if (seen.has(id)) continue;
      const c = (await d.cards(t.issueId).catch(() => [] as Card[])).find((x) => x.id === id);
      if (!c || c.status !== "pending") { if (c) await this.close(c, t); delete posted[id]; }
    }
    await d.store.set("cards:posted", posted);
  }

  private async close(c: Card, t: Tracked): Promise<void> {
    const d = this.d;
    const issue = this.issues.get(c.issueId) ?? { id: c.issueId, title: "task" };
    const by = t.by ?? t.sent ?? [...d.approvers].find(([, id]) => id === c.resolvedByUserId)?.[0];
    const { message, props } = renderCard(c, issue, d.agentName(c.createdByAgentId ?? null), d, by, t);
    await d.poster.patch(t.postId, message, props);
  }

  /** A button click. Returns the text shown only to the clicker, if any. */
  click(req: { user_id?: string; user_name?: string; context?: { issueId?: string; cardId?: string; action?: string; sig?: string } }): Promise<string | null> {
    return this.serial(() => this.decide(req));
  }

  private async decide(req: Parameters<Cards["click"]>[0]): Promise<string | null> {
    const d = this.d;
    const { issueId, cardId, action, sig: given } = req.context ?? {};
    const isPick = typeof action === "string" && action.startsWith("pick:");
    if (!issueId || !cardId || (action !== "accept" && action !== "reject" && !isPick) || given !== sig(d.key, { issueId, cardId }, action!)) return "This button is not valid.";
    const email = req.user_id ? (await d.poster.email(req.user_id))?.toLowerCase() : null;
    const actor = email ? d.approvers.get(email) : undefined;
    if (!actor) return "You are not set up to decide from Mattermost. Ask an admin to tick you under Approvers in the plugin settings.";
    const who = req.user_name ? `@${req.user_name}` : email!;
    if (isPick) return this.pick(issueId, cardId, action!, actor, who);
    await d.respond(issueId, cardId, action, actor, `${action === "accept" ? "Accepted" : "Rejected"} from Mattermost by ${who}`);
    const posted = (await d.store.get<Posted>("cards:posted")) ?? {};
    const t = posted[cardId];
    if (t) {
      const c = (await d.cards(issueId)).find((x) => x.id === cardId);
      if (c) await this.close(c, { ...t, by: who });
      delete posted[cardId];
      await d.store.set("cards:posted", posted);
    }
    return null;
  }

  /** One option picked; once every question has one, the answers go to the task as the picker's comment. */
  private async pick(issueId: string, cardId: string, action: string, actor: string, who: string): Promise<string | null> {
    const d = this.d;
    const [, questionId, optionId] = action.split(":");
    const posted = (await d.store.get<Posted>("cards:posted")) ?? {};
    const t = posted[cardId];
    const c = (await d.cards(issueId)).find((x) => x.id === cardId);
    if (!t || !c) return "This question is no longer open here.";
    if (c.status !== "pending" || t.sent) return "This question has already been answered.";
    const qs = buttonQuestions(c) ?? [];
    const option = qs.find((q) => q.id === questionId)?.options?.find((o) => o.id === optionId);
    if (!option) return "That option is no longer on the question.";
    t.picks = { ...t.picks, [questionId]: { optionId, label: str(option.label), by: who } };
    if (qs.every((q) => t.picks![q.id])) {
      const title = str(c.title) || str(c.payload?.title) || "your question";
      const lines = qs.map((q) => `- ${str(q.prompt)} **${t.picks![q.id].label}**`);
      await d.comment(issueId, `Answer to "${title}" (question ${c.id}), sent from Mattermost:\n\n${lines.join("\n")}`, actor);
      t.sent = who;
    }
    posted[cardId] = t;
    await d.store.set("cards:posted", posted);
    const issue = this.issues.get(issueId) ?? { id: issueId, title: "task" };
    const { message, props } = renderCard(c, issue, d.agentName(c.createdByAgentId ?? issue.assigneeAgentId ?? null), d, undefined, t);
    await d.poster.patch(t.postId, message, props);
    return null;
  }
}
