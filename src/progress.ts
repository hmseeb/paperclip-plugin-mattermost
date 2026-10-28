// Turns an agent run's live output into the "Thinking…" post. Paperclip forwards
// the adapter's raw stdout in chunks; ACPX adapters (claude_local, and others run
// through ACPX) write one JSON event per line. Only tool calls are shown: the reply
// text arrives whole at the end anyway. Output that is not ACPX shows no steps.

export const THINKING = "_thinking…_";
const MAX_STEPS = 6;
const MAX_LABEL = 100;

interface Step { tool: string; label: string; status: string }

export class Progress {
  private buffer = "";
  private steps = new Map<string, Step>();

  /** Feeds one stdout chunk. Returns true when what `render` shows changed. */
  feed(chunk: string): boolean {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      let e: { type?: string; tag?: string; name?: string; toolCallId?: string; status?: string };
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "acpx.tool_call" || !e.toolCallId) continue;
      const prev = this.steps.get(e.toolCallId);
      // The first event names only the tool ("Terminal"); an update names what it
      // does ("pwd; ls"), and a later one may repeat the bare tool name: keep the detail.
      const tool = prev?.tool ?? e.name ?? "tool";
      const label = e.name && e.name !== tool ? e.name : prev?.label ?? tool;
      const status = e.status ?? prev?.status ?? "pending";
      if (prev?.label !== label || prev?.status !== status) {
        this.steps.set(e.toolCallId, { tool, label, status });
        changed = true;
      }
    }
    return changed;
  }

  render(): string {
    const head = THINKING;
    const all = [...this.steps.values()];
    if (!all.length) return head;
    const shown = all.slice(-MAX_STEPS);
    const lines = shown.map((s) => {
      const mark = s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "…";
      const label = s.label.replace(/\s+/g, " ").trim();
      return `- ${mark} \`${(label.length > MAX_LABEL ? label.slice(0, MAX_LABEL) + "…" : label).replace(/`/g, "'")}\``;
    });
    if (all.length > shown.length) lines.unshift(`- _${all.length - shown.length} earlier steps_`);
    return `${head}\n${lines.join("\n")}`;
  }
}
