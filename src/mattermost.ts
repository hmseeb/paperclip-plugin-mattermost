// Mattermost REST + websocket client for the bridge. The websocket is outbound from
// the Paperclip host, so a server behind NAT needs no inbound port.
import type { ChatApi, Post, PostedEvent } from "./bridge.ts";

type Log = (msg: string, meta?: Record<string, unknown>) => void;

export class MattermostClient implements ChatApi {
  botUserId = "";
  botUsername = "";
  connected = false;
  lastError: string | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private seq = 1;
  private retry = 0;
  private lastSeen = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private users = new Map<string, { username: string; displayName: string }>();
  private base: string;
  private token: string;
  private log: Log;

  constructor(url: string, token: string, log: Log) {
    this.base = url.replace(/\/+$/, "");
    this.token = token;
    this.log = log;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Object.assign(new Error(`Mattermost ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return (r.status === 204 ? null : await r.json()) as T;
  }

  async init(): Promise<void> {
    const me = await this.request<{ id: string; username: string; is_bot?: boolean }>("GET", "/users/me");
    this.botUserId = me.id;
    this.botUsername = me.username;
  }

  async createPost(channelId: string, rootId: string, message: string, props?: Record<string, unknown>): Promise<{ id: string }> {
    return this.request("POST", "/posts", { channel_id: channelId, root_id: rootId, message, ...(props ? { props } : {}) });
  }

  async download(fileId: string): Promise<{ name: string; data: Uint8Array }> {
    const info = await this.request<{ name: string }>("GET", `/files/${fileId}/info`);
    const r = await fetch(`${this.base}/api/v4/files/${fileId}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Mattermost GET /files/${fileId}: ${r.status}`);
    return { name: info.name, data: new Uint8Array(await r.arrayBuffer()) };
  }

  async upload(channelId: string, rootId: string, message: string, files: { name: string; data: Uint8Array }[]): Promise<void> {
    const form = new FormData();
    form.set("channel_id", channelId);
    for (const f of files) form.append("files", new Blob([f.data]), f.name);
    const r = await fetch(`${this.base}/api/v4/files`, { method: "POST", headers: { Authorization: `Bearer ${this.token}` }, body: form, signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`Mattermost POST /files: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const { file_infos } = (await r.json()) as { file_infos: { id: string }[] };
    await this.request("POST", "/posts", { channel_id: channelId, root_id: rootId, message, file_ids: file_infos.map((f) => f.id) });
  }

  async setProfileImage(userId: string, png: Uint8Array): Promise<void> {
    const form = new FormData();
    form.set("image", new Blob([png], { type: "image/png" }), "avatar.png");
    const r = await fetch(`${this.base}/api/v4/users/${userId}/image`, { method: "POST", headers: { Authorization: `Bearer ${this.token}` }, body: form, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Mattermost POST /users/${userId}/image: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async react(postId: string, emoji: string): Promise<void> {
    await this.request("POST", "/reactions", { user_id: this.botUserId, post_id: postId, emoji_name: emoji });
  }

  async patchPost(postId: string, message: string): Promise<void> {
    await this.request("PUT", `/posts/${postId}/patch`, { message });
  }

  async typing(channelId: string, rootId: string): Promise<void> {
    await this.request("POST", "/users/me/typing", { channel_id: channelId, parent_id: rootId });
  }

  async userName(userId: string): Promise<{ username: string; displayName: string }> {
    const hit = this.users.get(userId);
    if (hit) return hit;
    const u = await this.request<{ username: string; first_name?: string; last_name?: string; nickname?: string }>("GET", `/users/${userId}`);
    const full = [u.first_name, u.last_name].filter(Boolean).join(" ");
    const value = { username: u.username, displayName: full || u.nickname || u.username };
    this.users.set(userId, value);
    return value;
  }

  async threadPosts(rootId: string): Promise<Post[]> {
    const t = await this.request<{ order: string[]; posts: Record<string, Post & { create_at: number }> }>("GET", `/posts/${rootId}/thread`);
    return Object.values(t.posts).sort((a, b) => a.create_at - b.create_at);
  }

  /** Connects and keeps reconnecting until close(). Calls onPosted for every new post. */
  connect(onPosted: (evt: PostedEvent) => void): void {
    if (this.stopped) return;
    const url = `${this.base.replace(/^http/, "ws")}/api/v4/websocket`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ seq: this.seq++, action: "authentication_challenge", data: { token: this.token } }));
      this.lastSeen = Date.now();
    };
    ws.onmessage = (m) => {
      this.lastSeen = Date.now();
      let msg: { event?: string; status?: string; data?: Record<string, unknown> };
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.event === "hello") {
        this.connected = true;
        this.retry = 0;
        this.lastError = null;
        this.log("connected to Mattermost", { url: this.base, bot: this.botUsername });
      }
      if (msg.event === "posted" && msg.data) {
        try {
          onPosted({
            post: JSON.parse(String(msg.data.post)),
            channelType: String(msg.data.channel_type ?? ""),
            channelName: String(msg.data.channel_name ?? ""),
          });
        } catch (err) {
          this.log("bad posted event", { err: String(err) });
        }
      }
    };
    ws.onerror = () => { this.lastError = "websocket error"; };
    ws.onclose = (e) => {
      this.connected = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.stopped) return;
      const wait = Math.min(60, 2 ** this.retry++) * 1000;
      this.lastError = `disconnected (${e.code}); retrying in ${wait / 1000}s`;
      this.log("Mattermost websocket closed", { code: e.code, retryInMs: wait });
      setTimeout(() => this.connect(onPosted), wait);
    };
    // Mattermost answers pings, so silence for 90s means a dead connection.
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSeen > 90000) { ws.close(); return; }
      ws.send(JSON.stringify({ seq: this.seq++, action: "ping" }));
    }, 30000);
  }

  close(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    this.connected = false;
  }
}
