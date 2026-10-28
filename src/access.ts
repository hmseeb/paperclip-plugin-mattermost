import type { MattermostClient } from "./mattermost.ts";

/**
 * Who may talk to which agents: everyone, or the people listed in settings (by
 * Mattermost email), each to all agents or only to the ones listed for them.
 */
export function accessCheck(manager: Pick<MattermostClient, "request">, config: Record<string, unknown>): ((userId: string, agentId: string) => Promise<boolean>) | null {
  if (config.access !== "selected") return null;
  const allowed = new Map<string, Set<string> | null>();
  for (const g of Array.isArray(config.allowedUsers) ? (config.allowedUsers as { email?: string; agents?: unknown }[]) : []) {
    if (g?.email) allowed.set(g.email.toLowerCase(), Array.isArray(g.agents) ? new Set(g.agents as string[]) : null);
  }
  const emails = new Map<string, { email: string; at: number }>();
  return async (userId, agentId) => {
    let hit = emails.get(userId);
    if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
      hit = { email: ((await manager.request<{ email?: string }>("GET", `/users/${userId}`).catch(() => ({ email: "" }))).email ?? "").toLowerCase(), at: Date.now() };
      emails.set(userId, hit);
    }
    if (!hit.email || !allowed.has(hit.email)) return false;
    const agents = allowed.get(hit.email);
    return !agents || agents.has(agentId);
  };
}
