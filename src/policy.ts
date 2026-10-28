// What an agent may do in Mattermost, decided before anything runs. Every action runs
// as the agent's own bot, so Mattermost's membership rules apply on top: a bot cannot
// read or post in a channel it is not in. This module adds the rules Mattermost does not
// know about: which actions need a person's approval first, and which ones an agent may
// take only on channels it created itself.

export type Verdict = { ok: true } | { ok: false; askFirst: true; why: string } | { ok: false; askFirst: false; why: string };

const ALLOW: Verdict = { ok: true };
const ask = (why: string): Verdict => ({ ok: false, askFirst: true, why });
const refuse = (why: string): Verdict => ({ ok: false, askFirst: false, why });

/** `@channel`, `@all` and `@here` notify everyone in a channel. */
export function broadcastMention(text: string): string | null {
  const m = text.match(/(?:^|[^\w@])@(channel|all|here)\b/i);
  return m ? `@${m[1].toLowerCase()}` : null;
}

export function canPost(text: string): Verdict {
  const b = broadcastMention(text);
  return b ? ask(`${b} notifies everyone in the channel`) : ALLOW;
}

export function canCreateChannel(isPrivate: boolean): Verdict {
  return isPrivate ? ALLOW : ask("a public channel is visible to the whole team");
}

/** Topic, purpose, archiving, inviting: free on channels the agent created, otherwise not its call. */
export function canManage(createdByThisAgent: boolean, action: "invite" | "update" | "archive"): Verdict {
  if (createdByThisAgent) return ALLOW;
  if (action === "invite") return ask("the agent did not create this channel");
  return refuse("only the agent that created a channel may change or archive it");
}

/** A DM only to someone who may talk to the agent (the plugin's access settings). */
export function canDm(allowedToTalk: boolean): Verdict {
  return allowedToTalk ? ALLOW : refuse("that person is not allowed to talk to this agent");
}

/** Channel names: lowercase, digits and dashes, as Mattermost's URL names are. */
export function channelSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "work";
}
