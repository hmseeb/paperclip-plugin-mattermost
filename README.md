# paperclip-plugin-mattermost

Your [Paperclip](https://github.com/paperclipai/paperclip) agents as Mattermost teammates. Every agent gets its own Mattermost bot, with its Paperclip portrait. DM an agent or @mention it in a channel, and it answers in the thread. Follow-ups in the thread continue the same conversation.

## What it does

- **A bot per agent.** Bots are created, renamed and switched off as agents change (every 5 minutes). Choose all agents, or only the ones you pick.
- **You see it working.** The agent's bot reacts 👀 to your message straight away, and shows Mattermost's "is typing…" indicator until its answer arrives.
- **Files both ways.** Attach files to a message and the agent can read them. Files the agent saves are attached to its reply.
- **Choices as buttons.** An agent can offer options (`choices: A | B | C` on its last line), which appear as buttons. A click is sent back as your answer.
- **Approvals with buttons.** Every Paperclip approval is posted in an approvals channel with Approve / Reject buttons, including hires, budget overrides, board approvals and high-risk tool calls. An approval raised during a conversation also appears in that thread.
- **Task decision cards.** When an agent asks something on a task, the card is posted in the approvals channel:
  - **Confirmations and suggested tasks** get Accept / Reject buttons.
  - **Single-choice questions** get a button per option. Your pick is posted on the task as a comment from you, which wakes the agent.
- **Access control.** Choose who may talk to agents: everyone, or only the people you pick. Each person can be limited to some agents, and people outside Paperclip can be added by email.
- **Agents work in Mattermost themselves.** Through plugin API routes that only agents can call, each agent reads the channels its bot is in, posts, reacts, searches, and DMs the people allowed to talk to it, always as its own bot. Each company gets a Mattermost skill that tells agents how, and saving the settings adds it to every agent with a bot, so they can message people from tasks and scheduled runs too.
- **Agents work with agents.** An agent mentioning another agent starts it, and it answers in the thread. After a set number of agent-to-agent messages in a thread (10 by default, set in settings), they pause until a person replies.
- **Work channels.** For an investigation, incident or project, an agent opens a private channel (`inc-checkout-5xx`), pulls in the people and agents it needs, and ties it to a Paperclip task. Task comments and status changes show up in the channel. When the task is done or cancelled, the channel is archived and the outcome is posted back where the work was asked for.
- **Ask first.** Some actions wait for an approver to click Approve: `@channel`, `@all` and `@here`, public channels, and adding people to a channel the agent didn't create. Agents can't change or archive channels they didn't create, remove anyone, or touch team and server settings.
- **Agent computer requests.** With the Agent computer plugin installed, an agent that needs a person in its browser (a login, 2FA, a password) posts in the thread it is working in, or the approvals channel, with a link to take over.
- **One install, many companies.** Each Paperclip company connects its own Mattermost, with its own settings, bots and state.

## Requirements

- **Paperclip** with plugin support. The plugin is built against a specific Paperclip commit (see `PAPERCLIP_REF` in `build.mjs`). If your server runs a different one, the settings page and the plugin's health say so. Most features keep working.
- **Mattermost** (Team Edition is fine) with bot accounts and personal access tokens enabled: *System Console → Integrations → Bot Accounts* and *Integration Management*.
- **A Mattermost System Admin personal access token.** The plugin uses it to create and manage the agent bots. A bot token won't work, because Mattermost doesn't let bots create bots.
- For buttons: **Mattermost must be able to reach Paperclip** at a public address.
- For files: the plugin and your agents must run on the **same machine or container**, as in the standard Docker setup, because files are exchanged through `/tmp/paperclip-mattermost`.

## Install

As a Paperclip instance admin:

```bash
paperclipai plugin install paperclip-plugin-mattermost
```

Or install it from **Settings → Plugins** in Paperclip.

## Set up (per company)

1. **In Mattermost**, signed in as a System Admin, go to **Profile → Security → Personal Access Tokens → Create Token** and copy the token.
2. **In Paperclip**, open the company, then **Settings → Secrets**, and save the token as a secret.
3. **Settings → Plugins → Mattermost**, then fill in:
   - **Mattermost URL**, e.g. `https://chat.example.com`.
   - **Mattermost admin token**: pick the secret from step 2.
   - **Paperclip public URL**: filled in from Paperclip's own settings. The page checks it by sending a test click through it.
   - **Approvals channel**: where approvals and decision cards are posted.
   - **Agents in Mattermost**: all agents, or the ones you pick.
   - **Who can talk to agents**: everyone, or the people you pick, each with all agents or some.
   - **Approvers**: who may decide approvals and cards from Mattermost. Their clicks count as their Paperclip decisions, matched to Mattermost by email.
4. **Save.** Within a minute every agent appears as a bot in your Mattermost teams.

## Security

- **Every button is signed** with a key derived from the company's admin token. A forged or altered click is refused, and rotating the token voids old buttons.
- **Decisions are made as real people.** Approvals, card answers and question comments are recorded as the clicker's Paperclip user. Paperclip itself checks that user is an active member allowed to decide.
- **Agent bot tokens** are minted at startup, held in memory only, and revoked on the next start.
- **The admin token** has System Admin rights in Mattermost. Keep it in a Paperclip secret, and rotate it if it leaks.

## Limits

- **Paperclip doesn't notify plugins of new decision cards**, so open tasks are checked every minute. A card can take up to a minute to appear.
- **Multi-choice questions** and free-text "Other" answers are answered in Paperclip; the card links there.
- **Mattermost can't hide bots** from particular people. Someone without access can still DM an agent bot; they get a private note and the agent doesn't run.
- **Agents with a custom uploaded portrait** keep the default bot picture, because those images need a Paperclip login to download.

## Development

```bash
npm install
node build.mjs          # bundles the Paperclip SDK at PAPERCLIP_REF (cloned into .paperclip-src/)
npm test                # unit tests
PAPERCLIP_REF=<commit> node build.mjs   # build for another Paperclip version
```

- `scripts/deploy-remote.sh` copies a build to a Paperclip running in Docker on another machine over ssh, and reloads it with Paperclip's CLI.
- `test/live-mattermost.ts` and `test/live-roster.ts` run against a real Mattermost.

## Releasing

Bump `version` in `package.json` and `src/manifest.ts`, commit, then tag and push:

```bash
git tag -a v0.15.0 -m v0.15.0 && git push origin main v0.15.0
```

GitHub Actions builds, tests and publishes to npm through npm trusted publishing, so no npm token is involved.

## License

MIT
