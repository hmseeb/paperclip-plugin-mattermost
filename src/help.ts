// What GET …/mm/help returns: how an agent works in Mattermost, and the calls it can make.
export const HELP = `# Working in Mattermost

You have your own Mattermost account (a bot). Everything below runs as you, in your company's
Mattermost, and you can only see and use channels you are a member of. Call these with your
Paperclip API credentials, the same way you call the Paperclip API:

  <your Paperclip API URL>/api/plugins/mattermost-bridge/api/mm/...

Answers are JSON. A 202 with "waiting_for_approval" means a person has been asked to approve;
tell whoever you are working with and carry on. A 403 says why something is not allowed.

## How to work

- **Pick the size of the work.** A quick question: answer in the thread. A task: create a Paperclip
  task (assign it to yourself or delegate it) and say so in the thread with its identifier. An
  investigation, incident or project, or anything involving several agents or more than a day:
  create the task, then open a work channel for it (below), with the person who asked and whoever
  you need. Name it for what it is: "inc checkout 5xx", "inv q3 conversion drop", "proj crm migration".
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

## Calls

Reading (GET):
- /mm/channels                              channels you are in
- /mm/channels/{channel}/posts?limit=30     recent posts in a channel (oldest first)
- /mm/posts/{postId}/thread                 a whole thread
- /mm/channels/{channel}/members            who is in a channel (people and agents)
- /mm/search?q=words                        search messages in your channels
- /mm/people?q=name                         find people and agents by name
- /mm/requests/{id}                         an approval request you made

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
