// Paperclip approvals as Mattermost posts with Approve / Reject buttons. Covers every
// approval Paperclip raises: an agent asking the board (`request_board_approval`),
// a high-risk tool held by the tool gateway, a hire, a budget override. Every approval
// goes to the approvals channel, and also into the Mattermost thread the requesting
// agent is answering; deciding on either card updates both. A click comes back through the plugin's webhook, signed so a forged click
// is refused, and is decided as the Paperclip user mapped to the clicker's email.
// A decision made in Paperclip itself updates the post too.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ApprovalInfo {
  id: string;
  type: string;
  status: string;
  requestedByAgentId: string | null;
  payload: Record<string, unknown>;
  decidedByUserId: string | null;
}

export interface ApprovalPoster {
  /** Posts as the agent's bot (or the manager when the agent has none); returns the post id. */
  post(agentId: string | null, where: { channelId: string; rootId: string }, message: string, props: Record<string, unknown>): Promise<string>;
  patch(postId: string, message: string, props: Record<string, unknown>): Promise<void>;
  /** Where a fallback channel name resolves to, or null. */
  channel(name: string): Promise<string | null>;
  /** The clicker's email, through the manager account. */
  email(mattermostUserId: string): Promise<string | null>;
}

export interface ApprovalDeps {
  poster: ApprovalPoster;
  /** The Mattermost thread an agent is answering right now, if any. */
  activeThread(agentId: string): { channelId: string; rootId: string } | null;
  agentName(agentId: string | null): string;
  get(approvalId: string): Promise<ApprovalInfo | null>;
  decide(approvalId: string, action: "approve" | "reject", actorUserId: string, note: string): Promise<void>;
  store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  /** Absolute URL of this plugin's `actions` webhook. */
  actionUrl: string;
  /** Signing key for button contexts. */
  key: string;
  fallbackChannel: string;
  /** Lower-cased email -> Paperclip user id. */
  approvers: Map<string, string>;
}

export interface ActionRequest {
  user_id?: string;
  user_name?: string;
  post_id?: string;
  context?: { approvalId?: string; action?: string; sig?: string };
}

const TYPE_LABEL: Record<string, string> = {
  request_board_approval: "Approval requested",
  hire_agent: "Hire request",
  approve_ceo_strategy: "Strategy approval",
  budget_override_required: "Budget override",
};

export interface Approver { userId: string; email: string; name?: string }

/** The settings page's list of approvers; also reads the older `email = id` lines. */
export function parseApprovers(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const a of value as Partial<Approver>[]) if (a?.email && a.userId) map.set(a.email.toLowerCase(), a.userId);
    return map;
  }
  for (const raw of String(value ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^(\S+@\S+)\s*[=:]\s*(\S+)$/);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  return map;
}

export function sign(key: string, approvalId: string, action: string): string {
  return createHmac("sha256", key).update(`${approvalId}:${action}`).digest("hex");
}

function signed(key: string, approvalId: string, action: string, sig: unknown): boolean {
  if (typeof sig !== "string") return false;
  const want = Buffer.from(sign(key, approvalId, action));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function render(a: ApprovalInfo, agentName: string, actionUrl: string, key: string, decidedBy?: string): { message: string; props: Record<string, unknown> } {
  const p = a.payload ?? {};
  const title = str(p.title) || str(p.name) || TYPE_LABEL[a.type] || a.type;
  const lines = [str(p.summary) || str(p.reason) || str(p.description)];
  if (str(p.recommendedAction)) lines.push(`**Recommended:** ${str(p.recommendedAction)}`);
  const risks = Array.isArray(p.risks) ? p.risks.map(str).filter(Boolean) : [];
  if (risks.length) lines.push(`**Risks:**\n${risks.map((r) => `- ${r}`).join("\n")}`);
  const pending = a.status === "pending";
  const outcome = a.status === "approved" ? ":white_check_mark: Approved" : a.status === "rejected" ? ":x: Rejected" : `Status: ${a.status}`;
  const button = (id: "approve" | "reject", name: string, style: string) => ({
    id, name, style, type: "button",
    integration: { url: actionUrl, context: { approvalId: a.id, action: id, sig: sign(key, a.id, id) } },
  });
  return {
    message: `**${TYPE_LABEL[a.type] ?? "Approval"}** from ${agentName}`,
    props: {
      attachments: [{
        color: pending ? "#f2a900" : a.status === "approved" ? "#3db887" : "#d24b4e",
        title,
        text: lines.filter(Boolean).join("\n\n"),
        footer: pending ? "Decide here or in Paperclip" : `${outcome}${decidedBy ? ` by ${decidedBy}` : ""}`,
        actions: pending ? [button("approve", "Approve", "primary"), button("reject", "Reject", "danger")] : [],
      }],
    },
  };
}

export class Approvals {
  private deps: ApprovalDeps;

  constructor(deps: ApprovalDeps) {
    this.deps = deps;
  }

  /** `approval.created`: post it in the approvals channel and the requester's thread. */
  async created(approvalId: string): Promise<void> {
    const d = this.deps;
    if (await d.store.get(`approval:${approvalId}`)) return;
    const a = await d.get(approvalId);
    if (!a || a.status !== "pending") return;
    const targets: { channelId: string; rootId: string }[] = [];
    const thread = a.requestedByAgentId ? d.activeThread(a.requestedByAgentId) : null;
    if (thread) targets.push(thread);
    const channelId = d.fallbackChannel ? await d.poster.channel(d.fallbackChannel) : null;
    if (channelId && channelId !== thread?.channelId) targets.push({ channelId, rootId: "" });
    if (!targets.length) return;
    const { message, props } = render(a, d.agentName(a.requestedByAgentId), d.actionUrl, d.key);
    const postIds: string[] = [];
    for (const where of targets) postIds.push(await d.poster.post(a.requestedByAgentId, where, message, props));
    await d.store.set(`approval:${approvalId}`, { postIds });
  }

  /** `approval.decided` (here or in Paperclip): drop the buttons, show the outcome. */
  async decided(approvalId: string): Promise<void> {
    const d = this.deps;
    const posted = await d.store.get<{ postId?: string; postIds?: string[]; by?: string }>(`approval:${approvalId}`);
    if (!posted) return;
    const a = await d.get(approvalId);
    if (!a) return;
    // Who clicked in Mattermost, else the Paperclip user's mapped email.
    const by = posted.by ?? [...d.approvers].find(([, id]) => id === a.decidedByUserId)?.[0];
    const { message, props } = render(a, d.agentName(a.requestedByAgentId), d.actionUrl, d.key, by);
    for (const postId of posted.postIds ?? (posted.postId ? [posted.postId] : [])) await d.poster.patch(postId, message, props);
  }

  /** A button click. Returns the text shown only to the clicker, if any. */
  async click(req: ActionRequest): Promise<string | null> {
    const d = this.deps;
    const { approvalId, action, sig } = req.context ?? {};
    if (!approvalId || (action !== "approve" && action !== "reject") || !signed(d.key, approvalId, action, sig)) {
      return "This button is not valid.";
    }
    const email = req.user_id ? (await d.poster.email(req.user_id))?.toLowerCase() : null;
    const actor = email ? d.approvers.get(email) : undefined;
    if (!actor) return "You are not set up to decide Paperclip approvals from Mattermost. Ask an admin to add your email to the plugin's approvers.";
    const who = req.user_name ? `@${req.user_name}` : email!;
    const posted = await d.store.get<Record<string, unknown>>(`approval:${approvalId}`);
    if (posted) await d.store.set(`approval:${approvalId}`, { ...posted, by: who });
    await d.decide(approvalId, action, actor, `Decided from Mattermost by ${who}`);
    await this.decided(approvalId);
    return null;
  }
}
