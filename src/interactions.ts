// Decision cards agents raise on Paperclip tasks ("issue-thread interactions"),
// mirrored into the raising agent's decisions channel (its own, else the approvals channel), and into the
// Mattermost thread the task was asked for in, where the person is waiting. Confirmations and suggested tasks get Accept /
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
  /** The person the agent addressed the card to, if it named one. */
  addresseeUserId?: string | null;
}

export interface OpenIssue { id: string; identifier?: string | null; title: string; assigneeAgentId?: string | null; /** Whom the task is done for (usually who asked). */ responsibleUserId?: string | null }

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
  /** The Mattermost thread a task was asked for in, and the agent that thread is with. */
  threadOf(issueId: string): Promise<{ channelId: string; rootId: string; agentId?: string } | null>;
  approvers: Map<string, string>;
  /** A Paperclip user as an @mention (or their name when they have no Mattermost account), or null. */
  mention?(userId: string): Promise<string | null>;
  /** Opens a Mattermost form (interactive dialog) for the click with this trigger id. */
  openDialog?(triggerId: string, dialog: Record<string, unknown>): Promise<void>;
  now?: () => Date;
}

interface Picked { optionId: string; label: string; by: string; typed?: boolean }
/** A posted card; for questions, the picks so far and who sent the answers. */
interface Tracked { postId: string; issueId: string; by?: string; picks?: Record<string, Picked>; sent?: string; /** Who the card is for, as written on it ("@jasmin"). */ for?: string; /** The same card in the thread the task was asked for in. */ threadPostId?: string }
interface Question { id: string; prompt?: string; helpText?: string; selectionMode?: string; allowOther?: boolean; options?: { id: string; label?: string; freeText?: boolean }[] }

/** Questions answerable with buttons: every one single-choice with options to click. */
function buttonQuestions(c: Card): Question[] | null {
  const qs = Array.isArray(c.payload?.questions) ? (c.payload!.questions as Question[]) : [];
  if (!qs.length || qs.some((q) => !q.id || q.selectionMode === "multi" || !(q.allowOther || (q.options ?? []).some((o) => o.id && str(o.label))))) return null;
  return qs;
}
type Posted = Record<string, Tracked>;

/** Kinds a plugin can resolve; the rest are shown with a link. */
const ANSWERABLE = new Set(["request_confirmation", "suggest_tasks"]);
const OUTCOME: Record<string, string> = { accepted: ":white_check_mark: Accepted", rejected: ":x: Rejected", answered: ":white_check_mark: Answered", expired: "Expired", cancelled: "Withdrawn" };

/** How old a card already in the decisions channel may be and still be copied to its thread. */
const CATCH_UP_MS = 24 * 60 * 60 * 1000;

type ClickRequest = {
  user_id?: string; user_name?: string; trigger_id?: string;
  context?: { issueId?: string; cardId?: string; action?: string; sig?: string };
  /** A form's fields, when this is a typed answer being sent. */
  submission?: Record<string, unknown>;
};
const NOT_APPROVER = "You are not set up to decide from Mattermost. Ask an admin to tick you under Approvers in the plugin settings.";

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
    text: [`**${str(q.prompt)}**`, str(q.helpText), picks[q.id] && !open ? (picks[q.id].typed ? `Answer:\n> ${picks[q.id].label.replace(/\n/g, "\n> ")}` : `Answer: **${picks[q.id].label}**`) : ""].filter(Boolean).join("\n"),
    ...(i === qs.length - 1 ? { footer } : {}),
    actions: open ? [
      ...(q.options ?? []).filter((o) => o.id && str(o.label)).map((o) => {
        const picked = picks[q.id]?.optionId === o.id;
        // Paperclip's "Type an answer" option stands for a text box: it opens one here too.
        const action = o.freeText ? `text:${q.id}:${o.id}` : `pick:${q.id}:${o.id}`;
        const label = o.freeText ? `${str(o.label)}…` : str(o.label);
        return {
          id: `q${i}${o.id}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 60), name: picked ? `✓ ${o.freeText ? picks[q.id].label.slice(0, 40) : label}` : label, type: "button", style: picked ? "primary" : "default",
          integration: { url: d.actionUrl, context: { kind: "card", issueId: c.issueId, cardId: c.id, action, sig: sig(d.key, { issueId: c.issueId, cardId: c.id }, action) } },
        };
      }),
      ...(q.allowOther && !(q.options ?? []).some((o) => o.freeText) ? [{
        id: `q${i}other`, name: picks[q.id]?.optionId === "other" ? `✓ ${picks[q.id].label.slice(0, 40)}` : "Other…", type: "button", style: picks[q.id]?.optionId === "other" ? "primary" : "default",
        integration: { url: d.actionUrl, context: { kind: "card", issueId: c.issueId, cardId: c.id, action: `text:${q.id}:other`, sig: sig(d.key, { issueId: c.issueId, cardId: c.id }, `text:${q.id}:other`) } },
      }] : []),
    ] : [],
  }));
  return { message, props: { attachments: blocks } };
}

export function renderCard(c: Card, issue: OpenIssue, agentName: string, d: RenderDeps, by?: string, t?: Pick<Tracked, "picks" | "sent" | "for">): { message: string; props: Record<string, unknown> } {
  const p = c.payload ?? {};
  const forWhom = t?.for ? `${t.for}: ` : "";
  const link = `${d.paperclipUrl}/issues/${encodeURIComponent(issue.identifier || issue.id)}`;
  const qs = c.kind === "ask_user_questions" && c.status === "pending" ? buttonQuestions(c) : null;
  if (qs) return renderQuestions(c, qs, `${forWhom}**Question** from ${agentName} on [${issue.identifier ?? "a task"}: ${issue.title}](${link})`, d, t);
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
    message: `${forWhom}**${c.kind === "ask_user_questions" ? "Question" : "Decision needed"}** from ${agentName} on [${issue.identifier ?? "a task"}: ${issue.title}](${link})`,
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
          if (c.status !== "pending") { await this.close(c, posted[c.id]); delete posted[c.id]; continue; }
          // Posted before it was also sent to threads (or before the thread was known): copy it there once,
          // if it is recent; an old card turning up in an old thread surprises more than it helps.
          const t = posted[c.id];
          if (!t.threadPostId && now.getTime() - new Date(c.createdAt).getTime() < CATCH_UP_MS) {
            const thread = await d.threadOf(issue.id);
            const agentId = c.createdByAgentId ?? issue.assigneeAgentId ?? null;
            if (thread && thread.channelId !== (await home(agentId))?.channelId) {
              const { message, props } = renderCard(c, issue, d.agentName(agentId), d, undefined, t);
              t.threadPostId = await d.poster.post(thread.agentId ?? agentId, { channelId: thread.channelId, rootId: thread.rootId }, message, props);
            }
          }
        } else if (c.status === "pending" && new Date(c.createdAt).getTime() > Date.parse(since)) {
          const agentId = c.createdByAgentId ?? issue.assigneeAgentId ?? null;
          const where = await home(agentId);
          // Also where the person is waiting: the thread the task was asked for in, posted by the agent that
          // thread is with (another agent's bot cannot post in that DM).
          const thread = await d.threadOf(issue.id);
          if (!where && !thread) continue; // nowhere to post: tried again on the next pass
          // Only the person the decision is for is pinged: whom the agent addressed, else whom the task is for.
          const who = c.addresseeUserId ?? issue.responsibleUserId;
          const mention = who && d.mention ? (await d.mention(who).catch(() => null)) ?? undefined : undefined;
          const { message, props } = renderCard(c, issue, d.agentName(agentId), d, undefined, { for: mention });
          const inThread = thread && thread.channelId !== where?.channelId
            ? await d.poster.post(thread.agentId ?? agentId, { channelId: thread.channelId, rootId: thread.rootId }, message, props) : undefined;
          const postId = where ? await d.poster.post(agentId, { channelId: where.channelId, rootId: "" }, where.note ? `${message}\n_${where.note}_` : message, props) : inThread!;
          posted[c.id] = { postId, issueId: issue.id, ...(inThread ? { threadPostId: inThread } : {}), ...(mention ? { for: mention } : {}) };
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
    await this.patchAll(t, message, props);
  }

  private async patchAll(t: Tracked, message: string, props: Record<string, unknown>): Promise<void> {
    for (const id of new Set([t.postId, t.threadPostId])) if (id) await this.d.poster.patch(id, message, props).catch(() => {});
  }

  /**
   * A button click, or a typed answer sent from the form a text button opened. Returns the text shown
   * only to the clicker, if any.
   */
  async click(req: ClickRequest): Promise<string | null> {
    // A form must open within seconds of the click (its trigger id expires), so not behind a poll.
    if (req.submission === undefined && (req.context?.action?.startsWith("text:") || (await this.oldTextButton(req)))) return this.openText(req);
    return this.serial(() => this.decide(req));
  }

  /** A "Type an answer" button on a card posted before typed answers: it opened nothing and sent those words. */
  private async oldTextButton(req: ClickRequest): Promise<boolean> {
    const { issueId, cardId, action } = req.context ?? {};
    if (!issueId || !cardId || !action?.startsWith("pick:")) return false;
    const [, questionId, optionId] = action.split(":");
    const c = (await this.d.cards(issueId).catch(() => [] as Card[])).find((x) => x.id === cardId);
    return Boolean(c && (buttonQuestions(c) ?? []).find((q) => q.id === questionId)?.options?.find((o) => o.id === optionId)?.freeText);
  }

  private async openText(req: ClickRequest): Promise<string | null> {
    const d = this.d;
    const { issueId, cardId, action, sig: given } = req.context ?? {};
    if (!issueId || !cardId || !action || given !== sig(d.key, { issueId, cardId }, action)) return "This button is not valid.";
    if (!(await this.approver(req))) return NOT_APPROVER;
    if (!req.trigger_id || !d.openDialog) return "Type your answer in Paperclip (the task link above): this Mattermost cannot open a form.";
    const c = (await d.cards(issueId)).find((x) => x.id === cardId);
    if (!c || c.status !== "pending") return "This question has already been answered.";
    const q = (buttonQuestions(c) ?? []).find((x) => x.id === action.split(":")[1]);
    await d.openDialog(req.trigger_id, {
      callback_id: `card-text:${cardId}`,
      title: "Your answer",
      introduction_text: str(q?.prompt).slice(0, 3000),
      elements: [{ display_name: "Answer", name: "answer", type: "textarea", max_length: 3000, optional: false }],
      submit_label: "Send",
      state: JSON.stringify(req.context),
    });
    return null;
  }

  private async approver(req: ClickRequest): Promise<string | undefined> {
    const email = req.user_id ? (await this.d.poster.email(req.user_id))?.toLowerCase() : null;
    return email ? this.d.approvers.get(email) : undefined;
  }

  private async decide(req: ClickRequest): Promise<string | null> {
    const d = this.d;
    const { issueId, cardId, action, sig: given } = req.context ?? {};
    const typed = req.submission !== undefined ? str(req.submission.answer) : "";
    if (req.submission !== undefined && !typed) return "Type an answer first.";
    const isPick = typeof action === "string" && (action.startsWith("pick:") || action.startsWith("text:"));
    if (!issueId || !cardId || (action !== "accept" && action !== "reject" && !isPick) || given !== sig(d.key, { issueId, cardId }, action!)) return "This button is not valid.";
    const email = req.user_id ? (await d.poster.email(req.user_id))?.toLowerCase() : null;
    const actor = email ? d.approvers.get(email) : undefined;
    if (!actor) return NOT_APPROVER;
    const who = req.user_name ? `@${req.user_name}` : email!;
    if (isPick) return this.pick(issueId, cardId, action!, actor, who, typed);
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
  private async pick(issueId: string, cardId: string, action: string, actor: string, who: string, typed = ""): Promise<string | null> {
    const d = this.d;
    const [, questionId, optionId] = action.split(":");
    const posted = (await d.store.get<Posted>("cards:posted")) ?? {};
    const t = posted[cardId];
    const c = (await d.cards(issueId)).find((x) => x.id === cardId);
    if (!t || !c) return "This question is no longer open here.";
    if (c.status !== "pending" || t.sent) return "This question has already been answered.";
    const qs = buttonQuestions(c) ?? [];
    const question = qs.find((q) => q.id === questionId);
    const option = optionId === "other" && question?.allowOther ? { id: "other", label: "" } : question?.options?.find((o) => o.id === optionId);
    if (!option) return "That option is no longer on the question.";
    t.picks = { ...t.picks, [questionId]: { optionId, label: typed || str(option.label), by: who, ...(typed ? { typed: true } : {}) } };
    if (qs.every((q) => t.picks![q.id])) {
      const title = str(c.title) || str(c.payload?.title) || "your question";
      const lines = qs.map((q) => {
        const p = t.picks![q.id];
        return p.typed ? `- ${str(q.prompt)}\n\n  ${p.label.replace(/\n/g, "\n  ")}` : `- ${str(q.prompt)} **${p.label}**`;
      });
      await d.comment(issueId, `Answer to "${title}" (question ${c.id}), sent from Mattermost:\n\n${lines.join("\n")}`, actor);
      t.sent = who;
    }
    posted[cardId] = t;
    await d.store.set("cards:posted", posted);
    const issue = this.issues.get(issueId) ?? { id: issueId, title: "task" };
    const { message, props } = renderCard(c, issue, d.agentName(c.createdByAgentId ?? issue.assigneeAgentId ?? null), d, undefined, t);
    await this.patchAll(t, message, props);
    return null;
  }
}
