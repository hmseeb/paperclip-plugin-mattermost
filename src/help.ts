// How an agent works in Mattermost and the calls it can make: served at GET …/mm/help,
// and installed as every company's "Mattermost" skill (SKILL below).
export const HELP = `# Working in Mattermost

You have your own Mattermost account (a bot). Everything below runs as you, in your company's
Mattermost, and you can only see and use channels you are a member of. Use it whenever you need
to reach a person or another agent in Mattermost, including from a task or a scheduled run: to
ping someone, DM them, or post in a channel. Call it with your Paperclip API credentials:

  B="\${PAPERCLIP_API_URL%/}"; B="\${B%/api}/api/plugins/mattermost-bridge/api"
  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$B/mm/channels"
  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "content-type: application/json" \\
    -d '{"person":"username","text":"..."}' "$B/mm/dm"

Answers are JSON. A 202 with "waiting_for_approval" means a person has been asked to approve;
tell whoever you are working with and carry on. A 403 says why something is not allowed.

## How to work

- **Work within Paperclip tasks.** A quick question: answer in the thread. Anything you are asked to
  do: create a Paperclip task first (assign it to yourself or delegate it) and say so in the thread
  with its number. Do the work in the task and end with the outcome as its last comment: when the
  task is done, cancelled or blocked, that comment is posted back in the thread it was asked in. An
  investigation, incident or project, or anything involving several agents or more than a day: also
  open a work channel for it (below), with the person who asked and whoever you need. Name it for
  what it is: "inc checkout 5xx", "inv q3 conversion drop", "proj crm migration".
- **Announce a work channel where the request came in**, in one message: what it is for, who you
  pulled in, and that you will report back there. When the task is done or cancelled the plugin
  archives the channel and posts the outcome back where you asked; you do not need to.
- **Hand work to another agent by mentioning it** (@cto) in a channel or thread it is in; invite it
  first if it is not. Give it the context it needs in that message. It replies in the thread.
  Mention an agent only when you want it to act: every mention starts it.
- **Say something before going quiet.** If an answer will take a while, post one line ("On it,
  checking what shipped this morning") and then do the work.
- Do not write @channel, @all or @here unless everyone in the channel must be notified: it needs
  approval.

## While you work

If people write in the thread you are answering while you work (a correction, "stop", "never mind"),
it reaches you: GET /mm/inbox returns those messages, and any other /mm call you make carries them
as \`newMessages\`. Check /mm/inbox between steps of anything that takes more than a minute or two,
and act on what you find then. Each message is handed to you once; it is not sent again afterwards.

## Calls

Reading (GET):
- /mm/channels                              channels you are in
- /mm/channels/{channel}/posts?limit=30     recent posts in a channel (oldest first)
- /mm/posts/{postId}/thread                 a whole thread
- /mm/channels/{channel}/members            who is in a channel (people and agents)
- /mm/search?q=words                        search messages in your channels
- /mm/people?q=name                         find people and agents by name
- /mm/requests/{id}                         an approval request you made
- /mm/inbox                                 what people wrote in your thread while you were working

Talking (POST, JSON body):
- /mm/post      {"channel": "...", "text": "...", "threadId": "optional post id to reply to"}
- /mm/react     {"postId": "...", "emoji": "white_check_mark"}
- /mm/dm        {"person": "username", "text": "..."}   only people allowed to talk to you

Channels (POST, JSON body):
- /mm/channels                   {"name": "inc checkout 5xx", "purpose": "...", "people": ["username"],
                                  "agents": ["cto"], "taskId": "BAD-123 or task id", "private": true}
  Private by default. A public channel needs approval. With taskId, the channel is tied to the
  task: its comments and status show up there, and it is archived when the task closes.
- /mm/channels/{channel}/invite  {"people": [...], "agents": [...]}   free on channels you created
- /mm/channels/{channel}/update  {"purpose": "...", "header": "...", "name": "..."}  yours only
- /mm/channels/{channel}/archive {}                                   yours only

{channel} is a channel's id, its URL name (inc-checkout-5xx) or its display name.
`;

export const SKILL = `---
name: mattermost
description: >
  Use to talk to people and agents in Mattermost as your own bot: DM someone, post or reply in
  a channel, read and search channels you are in, hand work to another agent by mentioning it,
  and open a work channel for an investigation, incident or project tied to a Paperclip task.
---

${HELP}`;
