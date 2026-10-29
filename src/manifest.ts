import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { SKILL } from "./help.ts";

const route = (routeKey: string, method: "GET" | "POST", path: string) => ({ routeKey, method, path, auth: "agent" as const, capability: "api.routes.register" as const });

const manifest: PaperclipPluginManifestV1 = {
  id: "mattermost-bridge",
  apiVersion: 1,
  version: "0.18.0",
  displayName: "Mattermost",
  description:
    "Every agent becomes its own Mattermost bot. DM an agent or mention it in a channel and it answers in the thread, showing its steps as it works; follow-ups continue the conversation. Paperclip approvals arrive with Approve / Reject buttons.",
  author: "Haseeb Azhar",
  categories: ["connector"],
  capabilities: [
    "agents.read",
    "companies.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.list",
    "agent.sessions.close",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "events.subscribe",
    "events.emit",
    "webhooks.receive",
    "approvals.read",
    "approvals.respond",
    "instance.settings.register",
    "issues.read",
    "issue.interactions.read",
    "issue.interactions.respond",
    "issue.comments.create",
    "issue.comments.create_human_attributed",
    "issue.comments.read",
    "api.routes.register",
    "skills.managed",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  // Replaces the generated form: approvers picked from members, URL detected and checked.
  ui: { slots: [{ type: "settingsPage", id: "mattermost-settings", displayName: "Mattermost", exportName: "SettingsPage" }] },
  // What agents do in Mattermost as their own bot (src/actions.ts). Agent-only: the host
  // checks the caller is an agent and scopes it to that agent's company.
  apiRoutes: [
    route("help", "GET", "/mm/help"),
    route("inbox", "GET", "/mm/inbox"),
    route("channels", "GET", "/mm/channels"),
    route("channel-posts", "GET", "/mm/channels/:channel/posts"),
    route("thread", "GET", "/mm/posts/:postId/thread"),
    route("channel-members", "GET", "/mm/channels/:channel/members"),
    route("search", "GET", "/mm/search"),
    route("people", "GET", "/mm/people"),
    route("request", "GET", "/mm/requests/:id"),
    route("post", "POST", "/mm/post"),
    route("react", "POST", "/mm/react"),
    route("dm", "POST", "/mm/dm"),
    route("create-channel", "POST", "/mm/channels"),
    route("invite", "POST", "/mm/channels/:channel/invite"),
    route("update-channel", "POST", "/mm/channels/:channel/update"),
    route("archive", "POST", "/mm/channels/:channel/archive"),
  ],
  // Installed in each company's skill library; the settings page adds it to every agent with a bot.
  skills: [{ skillKey: "mattermost", displayName: "Mattermost", slug: "mattermost", description: "Talk to people and agents in Mattermost as your own bot.", markdown: SKILL }],
  webhooks: [
    { endpointKey: "actions", displayName: "Mattermost buttons", description: "Approve / Reject clicks on approval posts. Every click carries a signature the plugin checks." },
  ],
  instanceConfigSchema: {
    type: "object",
    required: ["mattermostUrl", "botToken"],
    properties: {
      mattermostUrl: {
        type: "string",
        title: "Mattermost URL",
        description: "Your Mattermost address, for example https://chat.example.com",
      },
      botToken: {
        // No "type": the picker saves a { type: "secret_ref", secretId } object and the
        // server validates with plain Ajv, so type "string" rejects it. The form picks
        // the secret picker from `format` alone.
        format: "secret-ref",
        title: "Mattermost admin token",
        description:
          "A Paperclip secret holding a personal access token of a Mattermost System Admin user (Profile, Security, Personal Access Tokens). Bot accounts cannot be used: Mattermost does not let bots create bots. It creates one bot per agent, keeps them in sync, and listens in every public channel of its teams.",
      },
      paperclipUrl: {
        type: "string",
        title: "Paperclip public URL",
        description: "This Paperclip's address as Mattermost can reach it, for example https://paperclip.example.com. Turns on approval buttons; leave empty to turn them off.",
      },
      approvalsChannel: {
        type: "string",
        title: "Approvals channel",
        description: "Channel name (as in its URL, e.g. approvals) where every approval is posted; one raised during a Mattermost conversation also appears in that thread.",
      },
      agentsMode: {
        type: "string",
        enum: ["all", "selected"],
        title: "Agents in Mattermost",
        description: "all: every agent gets a bot, new ones included. selected: only the agents listed in `agents`.",
      },
      agents: { type: "array", title: "Selected agents", items: { type: "string" } },
      access: {
        type: "string",
        enum: ["everyone", "selected"],
        title: "Who can talk to agents",
        description: "everyone: anyone in this Mattermost. selected: only the people in `allowedUsers`, matched by Mattermost email.",
      },
      allowedUsers: {
        type: "array",
        title: "People who can talk to agents",
        description: "Each person by email, with `agents` listing the agent ids they may talk to (absent: all agents). People outside Paperclip have no userId.",
        items: { type: "object", properties: { userId: { type: "string" }, email: { type: "string" }, name: { type: "string" }, agents: { type: "array", items: { type: "string" } } }, required: ["email"] },
      },
      agentTurnLimit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 10,
        title: "Agent-to-agent turns",
        description: "How many messages agents may trade in one thread, mentioning each other, before a person must reply.",
      },
      approvers: {
        type: "array",
        title: "Approvers",
        description: "Who may decide approvals from Mattermost, picked on the settings page: their click is decided as their Paperclip user, matched by Mattermost email.",
        items: { type: "object", properties: { userId: { type: "string" }, email: { type: "string" }, name: { type: "string" } }, required: ["userId", "email"] },
      },
    },
  },
};

export default manifest;
