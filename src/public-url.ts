// The Paperclip address Mattermost should call for button clicks. Paperclip knows
// its own public URL from its settings, but tells plugins nothing; the worker is
// a child of the Paperclip server process, so it reads the same settings Paperclip
// does, in Paperclip's own order (the chat-webhook URL first, as its Slack
// integration uses). `verifyUrl` then proves a URL by sending a ping through it to
// this plugin's own webhook.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const ORDER = [
  "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL",
];

export function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of raw.split("\0")) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
}

export function pickPublicUrl(env: Record<string, string>, fileConfig?: { auth?: { publicBaseUrl?: string } } | null): string | null {
  for (const k of ORDER.slice(0, 5)) if (env[k]?.trim()) return env[k].trim().replace(/\/+$/, "");
  const fromFile = fileConfig?.auth?.publicBaseUrl?.trim();
  if (fromFile) return fromFile.replace(/\/+$/, "");
  return env[ORDER[5]]?.trim().replace(/\/+$/, "") || null;
}

/** Paperclip's configured public URL, or null where it cannot be read. */
export async function detectPublicUrl(): Promise<string | null> {
  try {
    const env = parseEnviron(await readFile(`/proc/${process.ppid}/environ`, "utf8"));
    const home = env.PAPERCLIP_HOME || `${env.HOME ?? ""}/.paperclip`;
    const configPath = env.PAPERCLIP_CONFIG || `${home}/instances/${env.PAPERCLIP_INSTANCE_ID || "default"}/config.json`;
    const fileConfig = await readFile(configPath, "utf8").then(JSON.parse).catch(() => null);
    return pickPublicUrl(env, fileConfig);
  } catch {
    return null; // not Linux, or not the server's child
  }
}

/** Where the Paperclip server listens inside its container, for fetching its own public images. */
export async function localBaseUrl(): Promise<string> {
  const env = await readFile(`/proc/${process.ppid}/environ`, "utf8").then(parseEnviron).catch(() => ({} as Record<string, string>));
  return `http://127.0.0.1:${env.PORT || "3100"}`;
}

const pending = new Map<string, () => void>();

/** Called by the webhook handler; true when the body was one of our pings. */
export function receivePing(body: unknown): boolean {
  const nonce = (body as { paperclipPluginPing?: unknown } | null)?.paperclipPluginPing;
  if (typeof nonce !== "string") return false;
  pending.get(nonce)?.();
  return true;
}

export async function verifyUrl(url: string, pluginKey: string): Promise<{ ok: boolean; detail: string }> {
  let base: URL;
  try { base = new URL(url); } catch { return { ok: false, detail: "Not a valid URL." }; }
  if (base.protocol !== "https:" && base.protocol !== "http:") return { ok: false, detail: "Use an http(s) URL." };
  const nonce = randomUUID();
  const arrived = new Promise<void>((resolve) => pending.set(nonce, resolve));
  try {
    const target = `${url.replace(/\/+$/, "")}/api/plugins/${pluginKey}/webhooks/actions`;
    const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paperclipPluginPing: nonce }), signal: AbortSignal.timeout(10000) }).catch((err: Error) => err);
    if (r instanceof Error) return { ok: false, detail: `Could not reach it: ${r.message}` };
    const got = await Promise.race([arrived.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 5000))]);
    if (got) return { ok: true, detail: "Reachable: a test click sent to this address arrived at this plugin." };
    return { ok: false, detail: `It answered (HTTP ${r.status}) but the test never reached this plugin, so it is not this Paperclip.` };
  } finally {
    pending.delete(nonce);
  }
}
