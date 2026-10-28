// Runs the built worker the way Paperclip does (a child process speaking JSON-RPC over
// stdio) and hands it two companies' settings. Paperclip's SDK refuses the second
// company unless the plugin declares multiCompanyConfig, which is how Carma's settings
// were silently dropped while BadAaas's worked. Needs `node build.mjs` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const WORKER = process.env.WORKER ?? path.resolve(import.meta.dirname, "../dist/worker.js");

function startWorker() {
  const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string } }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: { id?: number; method?: string; result?: unknown; error?: { code: number; message: string } };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      // The worker calling back into Paperclip (state, secrets): refuse, as a host without those would.
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not available in this test" } }) + "\n");
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  let next = 1;
  const call = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { call, stop: () => child.kill() };
}

test("two companies' settings are both accepted by one worker", async () => {
  const { default: manifest } = await import(path.resolve(path.dirname(WORKER), "manifest.js"));
  const w = startWorker();
  try {
    const init = await w.call("initialize", { manifest, config: {}, instanceInfo: { instanceId: "test", hostVersion: "test" }, apiVersion: 1 });
    assert.equal(init.error, undefined, JSON.stringify(init.error));
    // Incomplete settings (no URL, no token), so the worker connects to nothing.
    const a = await w.call("configChanged", { companyId: "11111111-1111-4111-8111-111111111111", config: { approvalsChannel: "decisions" } });
    assert.equal(a.error, undefined, JSON.stringify(a.error));
    const b = await w.call("configChanged", { companyId: "22222222-2222-4222-8222-222222222222", config: { approvalsChannel: "Decisions" } });
    assert.equal(b.error, undefined, `second company refused: ${b.error?.message}`);
  } finally {
    w.stop();
  }
});
