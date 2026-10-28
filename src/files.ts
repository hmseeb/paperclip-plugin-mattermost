// Files between Mattermost and agents, through a folder both can reach: the plugin
// worker and local agents run as the same user in the same container, so a file the
// plugin downloads is readable by the agent at that absolute path, and a file the
// agent writes into the message's outbox is uploaded with its reply.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const MAX_IN_BYTES = 50 * 1024 * 1024;
export const MAX_OUT_FILES = 10; // Mattermost's limit per post
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface FileChat {
  download(fileId: string): Promise<{ name: string; data: Uint8Array }>;
  upload(channelId: string, rootId: string, message: string, files: { name: string; data: Uint8Array }[]): Promise<void>;
}

export interface Files {
  /** Saves a post's attachments; returns one prompt line per file. */
  receive(chat: FileChat, postId: string, fileIds: string[]): Promise<string[]>;
  /** A fresh, empty outbox folder for one message. */
  outbox(postId: string): Promise<string>;
  /** Uploads what the agent left in the outbox; returns how many were sent. */
  send(chat: FileChat, channelId: string, rootId: string, dir: string): Promise<number>;
}

const safeName = (name: string) => path.basename(name).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function diskFiles(root = path.join(os.tmpdir(), "paperclip-mattermost")): Files {
  let swept = 0;
  async function sweep() {
    if (Date.now() - swept < 60 * 60 * 1000) return;
    swept = Date.now();
    for (const kind of ["in", "out"]) {
      const base = path.join(root, kind);
      for (const d of await readdir(base).catch(() => [] as string[])) {
        const p = path.join(base, d);
        if (Date.now() - (await stat(p)).mtimeMs > KEEP_MS) await rm(p, { recursive: true, force: true });
      }
    }
  }
  return {
    async receive(chat, postId, fileIds) {
      await sweep().catch(() => {});
      const dir = path.join(root, "in", safeName(postId));
      await mkdir(dir, { recursive: true });
      const lines: string[] = [];
      for (const id of fileIds) {
        try {
          const f = await chat.download(id);
          if (f.data.byteLength > MAX_IN_BYTES) { lines.push(`- ${f.name}: not saved, larger than ${kb(MAX_IN_BYTES)}`); continue; }
          const p = path.join(dir, `${safeName(id).slice(0, 8)}-${safeName(f.name)}`);
          await writeFile(p, f.data);
          lines.push(`- ${p} (${kb(f.data.byteLength)})`);
        } catch (err) {
          lines.push(`- a file could not be downloaded: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
        }
      }
      return lines;
    },
    async outbox(postId) {
      const dir = path.join(root, "out", safeName(postId));
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o777 });
      return dir;
    },
    async send(chat, channelId, rootId, dir) {
      const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => e.name).sort();
      if (!names.length) return 0;
      const files = await Promise.all(names.slice(0, MAX_OUT_FILES).map(async (n) => ({ name: n, data: new Uint8Array(await readFile(path.join(dir, n))) })));
      const more = names.length - files.length;
      await chat.upload(channelId, rootId, more ? `_${more} more files were left out (at most ${MAX_OUT_FILES} per post)._` : "", files);
      await rm(dir, { recursive: true, force: true });
      return files.length;
    },
  };
}
