import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "mattermost-bridge",
  apiVersion: 1,
  version: "0.11.0",
  displayName: "Mattermost",
  description:
    "Every agent becomes its own Mattermost bot. DM an agent or mention it in a channel and it answers in the thread, showing its steps as it works; follow-ups continue the conversation. Paperclip approvals arrive with Approve / Reject buttons.",
  author: "Haseeb Azhar",
  categories: ["connector"],
  capabilities: [
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.list",
    "agent.sessions.close",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "events.subscribe",
    "webhooks.receive",
    "approvals.read",
    "approvals.respond",
    "instance.settings.register",
    "issues.read",
    "issue.interactions.read",
    "issue.interactions.respond",
    "issue.comments.create",
    "issue.comments.create_human_attributed",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  // Replaces the generated form: approvers picked from members, URL detected and checked.
  ui: { slots: [{ type: "settingsPage", id: "mattermost-settings", displayName: "Mattermost", exportName: "SettingsPage" }] },
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
