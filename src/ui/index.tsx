// Settings page for the Mattermost plugin. Replaces Paperclip's generated form so
// approvers are picked from the workspace's members and the public URL fills itself
// in (and is proven to reach this plugin) instead of being typed.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { usePluginAction, usePluginData, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";

const PLUGIN = "mattermost-bridge"; // the manifest id

interface Member { principalType: string; principalId: string; status: string; membershipRole: string | null; user: { id: string; email: string | null; name: string | null } | null }
interface Secret { id: string; name: string | null; key: string | null; status?: string; deletedAt?: string | null }
/** One person allowed to talk to agents: all of them (`agents: null`) or the listed ones. */
interface Grant { userId?: string; email: string; name?: string; agents: string[] | null }
interface AgentRow { id: string; name: string; title: string | null; status: string; avatarUrl?: string }
interface Approver { userId: string; email: string; name?: string }
interface Setup { detectedUrl: string | null; connected: boolean; status: string | null; versionNote?: string | null; channels: { name: string; displayName: string }[]; accounts: Record<string, string | null> }
type Config = Record<string, unknown>;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return (await r.json()) as T;
}

const s = {
  field: { display: "grid", gap: 6, marginBottom: 22 } as CSSProperties,
  label: { fontWeight: 600, fontSize: 14 } as CSSProperties,
  help: { fontSize: 12.5, opacity: 0.65, lineHeight: 1.45 } as CSSProperties,
  input: { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" } as CSSProperties,
  row: { display: "flex", gap: 8, alignItems: "center" } as CSSProperties,
  button: { padding: "7px 14px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", whiteSpace: "nowrap" } as CSSProperties,
  primary: { padding: "8px 18px", borderRadius: 6, border: "none", background: "#e8e8e8", color: "#111", font: "inherit", fontWeight: 600, cursor: "pointer" } as CSSProperties,
  member: { display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.2)", cursor: "pointer" } as CSSProperties,
  ok: { color: "#3db887" } as CSSProperties,
  bad: { color: "#e5484d" } as CSSProperties,
};

function Field({ label, help, error, children }: { label: string; help?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div style={s.field}>
      <div style={s.label}>{label}</div>
      {children}
      {error ? <div style={{ ...s.bad, fontSize: 13 }}>{error}</div> : null}
      {help ? <div style={s.help}>{help}</div> : null}
    </div>
  );
}

function flip(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function Modes({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      {options.map(([v, label]) => (
        <label key={v} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" checked={value === v} onChange={() => onChange(v)} /> {label}
        </label>
      ))}
    </div>
  );
}

function People({ members, selected, accounts, onToggle }: { members: Member[]; selected: Set<string>; accounts?: Record<string, string | null>; onToggle: (id: string) => void }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {members.map((m) => {
        const email = m.user?.email ?? "";
        const account = email ? accounts?.[email.toLowerCase()] : undefined;
        return (
          <label key={m.principalId} style={{ ...s.member, ...(selected.has(m.principalId) ? { borderColor: "rgba(127,127,127,.55)" } : {}) }}>
            <input type="checkbox" checked={selected.has(m.principalId)} onChange={() => onToggle(m.principalId)} disabled={!email} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{m.user?.name || email}{m.membershipRole ? <span style={{ ...s.help, marginLeft: 8 }}>{m.membershipRole}</span> : null}</div>
              <div style={{ ...s.help, overflow: "hidden", textOverflow: "ellipsis" }}>{email || "no email"}</div>
            </div>
            <div style={{ ...s.help, ...(account ? s.ok : account === null ? s.bad : {}) }}>
              {account ? `@${account}` : account === null ? "no Mattermost account with this email" : ""}
            </div>
          </label>
        );
      })}
    </div>
  );
}

function grantsFrom(value: unknown): Map<string, Grant> {
  const map = new Map<string, Grant>();
  for (const g of Array.isArray(value) ? (value as Partial<Grant>[]) : []) {
    if (g?.email) map.set(g.email.toLowerCase(), { userId: g.userId || undefined, email: g.email.toLowerCase(), name: g.name, agents: Array.isArray(g.agents) ? g.agents : null });
  }
  return map;
}

function AccessList({ members, agents, grants, accounts, onChange }: { members: Member[]; agents: AgentRow[]; grants: Map<string, Grant>; accounts?: Record<string, string | null>; onChange: (next: Map<string, Grant>) => void }) {
  const [adding, setAdding] = useState("");
  const memberEmails = new Set(members.map((m) => m.user?.email?.toLowerCase()).filter(Boolean));
  const rows: { key: string; email: string; name: string; sub: string; userId?: string; outside: boolean }[] = [
    ...members.filter((m) => m.user?.email).map((m) => ({ key: m.principalId, email: m.user!.email!.toLowerCase(), name: m.user!.name || m.user!.email!, sub: m.membershipRole ?? "", userId: m.principalId, outside: false })),
    ...[...grants.values()].filter((g) => !memberEmails.has(g.email)).map((g) => ({ key: g.email, email: g.email, name: g.name || g.email, sub: "not in Paperclip", outside: true })),
  ];
  const update = (email: string, g: Grant | null) => { const next = new Map(grants); if (g) next.set(email, g); else next.delete(email); onChange(next); };
  const add = () => {
    const email = adding.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || grants.has(email)) return;
    update(email, { email, agents: null });
    setAdding("");
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((r) => {
        const g = grants.get(r.email);
        const account = accounts?.[r.email];
        return (
          <div key={r.key} style={{ ...s.member, display: "block", cursor: "default", ...(g ? { borderColor: "rgba(127,127,127,.55)" } : {}) }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="checkbox" checked={Boolean(g)} onChange={() => update(r.email, g ? null : { userId: r.userId, email: r.email, name: r.name, agents: null })} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.name}{r.sub ? <span style={{ ...s.help, marginLeft: 8 }}>{r.sub}</span> : null}</div>
                <div style={{ ...s.help, overflow: "hidden", textOverflow: "ellipsis" }}>{r.email}</div>
              </div>
              <div style={{ ...s.help, ...(account ? s.ok : account === null ? s.bad : {}) }}>
                {account ? `@${account}` : account === null ? "no Mattermost account with this email" : ""}
              </div>
              {g ? (
                <select style={{ ...s.input, width: "auto" }} value={g.agents ? "some" : "all"} onChange={(e) => update(r.email, { ...g, agents: e.target.value === "all" ? null : [] })}>
                  <option value="all">All agents</option>
                  <option value="some">Only some agents</option>
                </select>
              ) : null}
              {r.outside ? <button style={{ ...s.button, padding: "4px 9px" }} title="Remove" onClick={() => update(r.email, null)}>✕</button> : null}
            </div>
            {g?.agents ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, paddingLeft: 26 }}>
                {agents.map((a) => {
                  const on = g.agents!.includes(a.id);
                  return (
                    <label key={a.id} style={{ display: "flex", gap: 5, alignItems: "center", padding: "3px 8px", borderRadius: 999, border: `1px solid rgba(127,127,127,${on ? ".7" : ".25"})`, cursor: "pointer", fontSize: 13 }}>
                      <input type="checkbox" checked={on} onChange={() => update(r.email, { ...g, agents: on ? g.agents!.filter((x) => x !== a.id) : [...g.agents!, a.id] })} />
                      {a.name}
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
      <div style={s.row}>
        <input style={s.input} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="Add someone outside Paperclip by email (a client, a contractor)…" />
        <button style={s.button} onClick={add}>Add</button>
      </div>
    </div>
  );
}

/**
 * Mattermost hides Personal Access Tokens until a System Admin switches them on, which is
 * where most setups stall. Links go straight to the two settings when the URL is known.
 */
function TokenHelp({ mattermostUrl }: { mattermostUrl: string }) {
  const base = /^https?:\/\/\S+/.test(mattermostUrl.trim()) ? mattermostUrl.trim().replace(/\/+$/, "") : null;
  const page = (path: string, label: string) => (base ? <a href={`${base}${path}`} target="_blank" rel="noreferrer">{label}</a> : <b>{label}</b>);
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", opacity: 0.9 }}>Don't see Personal Access Tokens?</summary>
      <ol style={{ margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.6 }}>
        <li>Sign in to Mattermost as a System Admin.</li>
        <li>System Console → Integrations → {page("/admin_console/integrations/integration_management", "Integration Management")}: set <b>Enable Personal Access Tokens</b> to true and save.</li>
        <li>System Console → Integrations → {page("/admin_console/integrations/bot_accounts", "Bot Accounts")}: make sure <b>Enable Bot Account Creation</b> is true.</li>
        <li>Back in Mattermost: Profile → Security → <b>Personal Access Tokens</b> → Create Token, and copy it.</li>
        <li>In Paperclip: Settings → Secrets → add a secret with that token, then choose it above.</li>
      </ol>
      <div style={{ marginTop: 6 }}>Still missing after step 2? The account you are signed in with is not a System Admin.</div>
    </details>
  );
}

type FieldErrors = Partial<Record<"mattermostUrl" | "botToken" | "agents" | "access", string>>;

function validate(c: Config): FieldErrors {
  const errors: FieldErrors = {};
  const url = String(c.mattermostUrl ?? "").trim();
  if (!url) errors.mattermostUrl = "Enter your Mattermost address.";
  else if (!/^https?:\/\/[^\s/]+/.test(url)) errors.mattermostUrl = "Enter a full address starting with https://";
  if (!(c.botToken as { secretId?: string } | undefined)?.secretId) errors.botToken = "Choose the secret that holds the Mattermost admin token.";
  return errors;
}

/** Paperclip answers a rejected save with JSON; say it in words. */
function saveErrorText(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: string; fieldErrors?: { field?: string; message?: string }[] };
    const parts = (j.fieldErrors ?? []).map((f) => {
      const missing = f.message?.match(/required property '(\w+)'/)?.[1];
      if (missing === "botToken") return "the Mattermost admin token is missing";
      if (missing === "mattermostUrl") return "the Mattermost URL is missing";
      return `${f.field && f.field !== "/" ? f.field.replace(/^\//, "") + ": " : ""}${f.message ?? "invalid"}`;
    });
    if (parts.length) return `Not saved: ${parts.join("; ")}.`;
    if (j.error) return `Not saved: ${j.error}`;
  } catch { /* not JSON */ }
  return `Not saved: ${raw.slice(0, 300)}`;
}

/** Older installs saved approvers as `email = user id` lines. */
function savedApproverIds(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set((value as Approver[]).map((a) => a.userId));
  const ids = new Set<string>();
  for (const line of String(value ?? "").split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^\S+@\S+\s*[=:]\s*(\S+)$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId;
  const [config, setConfig] = useState<Config | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsMode, setAgentsMode] = useState<"all" | "selected">("all");
  const [pickedAgents, setPickedAgents] = useState<Set<string>>(new Set());
  const [access, setAccess] = useState<"everyone" | "selected">("everyone");
  const [grants, setGrants] = useState<Map<string, Grant>>(new Map());
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [check, setCheck] = useState<{ url: string; ok: boolean | null; detail: string } | null>(null);
  const verify = usePluginAction("verify-url");

  useEffect(() => {
    if (!companyId) return;
    Promise.all([
      api<{ configJson?: Config | null } | null>(`/api/plugins/${PLUGIN}/config?companyId=${companyId}`),
      api<{ members: Member[] }>(`/api/companies/${companyId}/members`).then((r) => r.members)
        .catch(() => api<{ users: Member[] }>(`/api/companies/${companyId}/user-directory`).then((r) => r.users.map((u) => ({ ...u, principalType: "user", membershipRole: null })))),
      api<Secret[]>(`/api/companies/${companyId}/secrets`).catch(() => [] as Secret[]),
      api<AgentRow[] | { agents: AgentRow[] }>(`/api/companies/${companyId}/agents`).then((r) => (Array.isArray(r) ? r : r.agents)).catch(() => [] as AgentRow[]),
    ]).then(([cfg, mem, sec, ags]) => {
      const c = cfg?.configJson ?? {};
      setAgents(ags.filter((a) => a.status !== "terminated"));
      setAgentsMode(c.agentsMode === "selected" ? "selected" : "all");
      setPickedAgents(new Set(Array.isArray(c.agents) ? (c.agents as string[]) : []));
      setAccess(c.access === "selected" ? "selected" : "everyone");
      setGrants(grantsFrom(c.allowedUsers));
      setConfig(c);
      setSelected(savedApproverIds(c.approvers));
      setMembers(mem.filter((m) => m.principalType === "user" && m.status === "active" && m.user && m.membershipRole !== "viewer"));
      setSecrets(sec.filter((x) => !x.deletedAt));
    }).catch((e) => setLoadError(String(e?.message ?? e)));
  }, [companyId]);

  const outsiderKey = [...grants.keys()].sort().join(",");
  const emails = useMemo(() => [...new Set([...members.map((m) => m.user?.email?.toLowerCase()).filter((e): e is string => Boolean(e)), ...outsiderKey.split(",").filter(Boolean)])], [members, outsiderKey]);
  const setup = usePluginData<Setup>("setup", { companyId, emails });
  const detected = setup.data?.detectedUrl ?? null;

  // The URL defaults to what Paperclip is configured with; the field stays editable.
  const url = typeof config?.paperclipUrl === "string" && config.paperclipUrl ? config.paperclipUrl : detected ?? "";
  useEffect(() => {
    if (!url || check?.url === url) return;
    const t = setTimeout(() => {
      setCheck({ url, ok: null, detail: "Checking that Mattermost can reach this address…" });
      verify({ url }).then((r) => {
        const res = r as { ok: boolean; detail: string };
        setCheck((cur) => (cur?.url === url ? { url, ...res } : cur));
      }).catch((e) => setCheck({ url, ok: false, detail: String(e?.message ?? e) }));
    }, 700);
    return () => clearTimeout(t);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!companyId) return <div style={s.help}>Open this page from a company to configure it.</div>;
  if (loadError) return <div style={s.bad}>Could not load the settings. Reload the page; if it keeps failing, check the plugin's Status tab. ({loadError.slice(0, 200)})</div>;
  if (!config) return <div style={s.help}>Loading…</div>;
  const set = (patch: Config) => {
    setSaved(false);
    setSaveError(null);
    setFieldErrors((fe) => { const n = { ...fe }; for (const k of Object.keys(patch)) delete n[k as keyof FieldErrors]; return n; });
    setConfig({ ...config, ...patch });
  };
  const token = config.botToken as { secretId?: string } | undefined;
  const toggle = (id: string) => { setSaved(false); const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };

  async function save() {
    setSaveError(null);
    const errors = validate(config!);
    if (agentsMode === "selected" && !pickedAgents.size) errors.agents = "Tick at least one agent, or choose All agents.";
    if (access === "selected" && !grants.size) errors.access = "Tick at least one person, or choose Everyone.";
    const empty = [...grants.values()].find((g) => g.agents && !g.agents.length);
    if (access === "selected" && empty) errors.access = `Pick at least one agent for ${empty.name || empty.email}, or give them All agents.`;
    setFieldErrors(errors);
    if (Object.keys(errors).length) { setSaveError("Fix the fields marked above, then save."); return; }
    setSaving(true);
    try {
      const approvers: Approver[] = members.filter((m) => selected.has(m.principalId) && m.user?.email)
        .map((m) => ({ userId: m.principalId, email: m.user!.email!, name: m.user!.name ?? undefined }));
      const next = { ...config!, paperclipUrl: url, approvers, agentsMode, agents: [...pickedAgents], access, allowedUsers: [...grants.values()] };
      await api(`/api/plugins/${PLUGIN}/config`, { method: "POST", body: JSON.stringify({ companyId, configJson: next }) });
      setConfig(next);
      setSaved(true);
    } catch (e) {
      setSaveError(saveErrorText(String((e as Error)?.message ?? e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ ...s.help, marginBottom: 18, ...(setup.data?.connected ? s.ok : {}) }}>
        {setup.data?.connected ? `● Connected: ${setup.data.status ?? ""}` : setup.data?.status ? `● ${setup.data.status}` : "● Not connected yet: fill in the Mattermost URL and admin token, then save."}
        {setup.data?.versionNote ? <div style={{ color: "#c98a00", marginTop: 4 }}>Note: this plugin was {setup.data.versionNote}.</div> : null}
      </div>
      <Field label="Mattermost URL" error={fieldErrors.mattermostUrl} help="Your Mattermost address, for example https://chat.example.com">
        <input style={s.input} value={String(config.mattermostUrl ?? "")} onChange={(e) => set({ mattermostUrl: e.target.value })} placeholder="https://chat.example.com" />
      </Field>

      <Field label="Mattermost admin token" error={fieldErrors.botToken} help={<>
        A Paperclip secret holding a personal access token of a Mattermost System Admin (Profile → Security → Personal Access Tokens). It creates one bot per agent and keeps them in sync.
        <TokenHelp mattermostUrl={String(config.mattermostUrl ?? "")} />
      </>}>
        <select style={s.input} value={token?.secretId ?? ""} onChange={(e) => set({ botToken: e.target.value ? { type: "secret_ref", version: "latest", secretId: e.target.value } : undefined })}>
          <option value="">Choose a secret…</option>
          {secrets.map((x) => <option key={x.id} value={x.id}>{x.name || x.key || x.id}</option>)}
        </select>
      </Field>

      <Field label="Paperclip public URL" help={<>
        Where Mattermost sends Approve / Reject clicks. Filled in from Paperclip's own settings; change it only if Mattermost reaches Paperclip at another address.
        {check ? <div style={{ marginTop: 6, ...(check.ok === true ? s.ok : check.ok === false ? s.bad : {}) }}>{check.ok === true ? "✓ " : check.ok === false ? "✗ " : ""}{check.detail}</div> : null}
      </>}>
        <div style={s.row}>
          <input style={s.input} value={url} onChange={(e) => set({ paperclipUrl: e.target.value.trim() })} placeholder={detected ?? "https://paperclip.example.com"} />
          {detected && url !== detected ? <button style={s.button} onClick={() => set({ paperclipUrl: detected })}>Use {detected}</button> : null}
        </div>
      </Field>

      <Field label="Approvals channel" help="Every approval, and every decision card agents raise on tasks, is posted here. An approval raised during a Mattermost conversation also appears in that thread; deciding on either card updates both.">
        {setup.data?.channels.length ? (
          <select style={s.input} value={String(config.approvalsChannel ?? "")} onChange={(e) => set({ approvalsChannel: e.target.value })}>
            <option value="">None: only in the agent's thread</option>
            {setup.data.channels.map((ch) => <option key={ch.name} value={ch.name}>{ch.displayName}</option>)}
          </select>
        ) : (
          <input style={s.input} value={String(config.approvalsChannel ?? "")} onChange={(e) => set({ approvalsChannel: e.target.value })} placeholder="channel name, e.g. approvals" />
        )}
      </Field>

      <Field label="Agents in Mattermost" error={fieldErrors.agents} help="Each agent shown here gets its own Mattermost bot. Unticking an agent switches its bot off but keeps it, with its history, for when you tick it again.">
        <Modes value={agentsMode} onChange={(v) => { setAgentsMode(v as "all" | "selected"); setSaved(false); }}
          options={[["all", "All agents (new agents join automatically)"], ["selected", "Only the agents I pick"]]} />
        {agentsMode === "selected" ? (
          <div style={{ display: "grid", gap: 6 }}>
            {agents.map((a) => (
              <label key={a.id} style={{ ...s.member, ...(pickedAgents.has(a.id) ? { borderColor: "rgba(127,127,127,.55)" } : {}) }}>
                <input type="checkbox" checked={pickedAgents.has(a.id)} onChange={() => { setPickedAgents(flip(pickedAgents, a.id)); setSaved(false); }} />
                {a.avatarUrl ? <img src={a.avatarUrl} alt="" width={28} height={28} style={{ borderRadius: 6 }} /> : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{a.name}</div>
                  {a.title ? <div style={s.help}>{a.title}</div> : null}
                </div>
              </label>
            ))}
          </div>
        ) : null}
      </Field>

      <Field label="Who can talk to agents" error={fieldErrors.access} help="Tick who may talk to agents, and for each person whether that is all agents or only some. Anyone else, or anyone messaging an agent outside their list, gets a private note and the agent is not run. People are matched to Mattermost by email; add people outside Paperclip by their email.">
        <Modes value={access} onChange={(v) => { setAccess(v as "everyone" | "selected"); setSaved(false); }}
          options={[["everyone", "Everyone in this Mattermost"], ["selected", "Only the people I pick"]]} />
        {access === "selected" ? <AccessList members={members} agents={agents} grants={grants} accounts={setup.data?.accounts} onChange={(next) => { setGrants(next); setSaved(false); setFieldErrors((fe) => ({ ...fe, access: undefined })); }} /> : null}
      </Field>

      <Field label="Approvers" help="Who may Approve / Reject from Mattermost. Their click counts as their Paperclip decision; they are matched to Mattermost by email.">
        <People members={members} selected={selected} accounts={setup.data?.accounts} onToggle={toggle} />
      </Field>

      <div style={s.row}>
        <button style={s.primary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        {saved ? <span style={s.ok}>Saved</span> : null}
        {saveError ? <span style={s.bad}>{saveError}</span> : null}
      </div>
    </div>
  );
}
