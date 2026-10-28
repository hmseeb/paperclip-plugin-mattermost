// Options an agent offers in a Mattermost conversation, shown as buttons. The agent
// ends its reply with one line, `choices: A | B | C`; the plugin removes the line and
// posts the options as buttons. A click answers in the thread as the person who
// clicked: the agent receives the option as their next message.
import { sign } from "./approvals.ts";

export const MAX_CHOICES = 5;
const MAX_LABEL = 80;
const LINE = /^\s*choices:\s*(.+?)\s*$/i;

/** Splits a reply into its text and the options on its last `choices:` line, if any. */
export function extractChoices(reply: string): { text: string; choices: string[] } {
  const lines = reply.trimEnd().split("\n");
  const m = lines.at(-1)?.match(LINE);
  if (!m) return { text: reply, choices: [] };
  const choices = [...new Set(m[1].split("|").map((c) => c.trim().replace(/^[`*_"]+|[`*_"]+$/g, "").slice(0, MAX_LABEL)).filter(Boolean))].slice(0, MAX_CHOICES);
  if (choices.length < 2) return { text: reply, choices: [] };
  return { text: lines.slice(0, -1).join("\n").trimEnd(), choices };
}

/** What a click carries back; signed, so a forged click is refused. */
export interface ChoiceContext { kind: "choice"; channelId: string; rootId: string; channelType: string; channelName: string; choice: string; sig?: string }

const payload = (c: ChoiceContext) => `${c.channelId}:${c.rootId}:${c.channelType}:${c.channelName}:${c.choice}`;

export function choiceProps(key: string, actionUrl: string, base: Omit<ChoiceContext, "kind" | "choice" | "sig">, choices: string[]): Record<string, unknown> {
  return {
    attachments: [{
      text: "Choose one, or just reply in the thread:",
      actions: choices.map((choice, i) => {
        const context: ChoiceContext = { kind: "choice", ...base, choice };
        return { id: `choice${i}`, name: choice, type: "button", style: i === 0 ? "primary" : "default", integration: { url: actionUrl, context: { ...context, sig: sign(key, "choice", payload(context)) } } };
      }),
    }],
  };
}

export function verifyChoice(key: string, c: Partial<ChoiceContext> | undefined): c is ChoiceContext {
  if (!c || c.kind !== "choice" || typeof c.sig !== "string") return false;
  for (const f of ["channelId", "rootId", "channelType", "channelName", "choice"] as const) if (typeof c[f] !== "string") return false;
  return sign(key, "choice", payload(c as ChoiceContext)) === c.sig;
}

/** The card after a click: the options are gone, the pick is shown. */
export function chosenProps(choice: string, who: string): Record<string, unknown> {
  return { attachments: [{ text: `${who} chose **${choice}**`, actions: [] }] };
}
