import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseEnviron, pickPublicUrl, receivePing, verifyUrl } from "../src/public-url.ts";
import { parseApprovers } from "../src/approvals.ts";

test("the public URL follows Paperclip's own order: chat-webhook URL, auth URL, public URL, config file", () => {
  const env = parseEnviron("PATH=/bin\0PAPERCLIP_PUBLIC_URL=https://os.example.com/\0PORT=3101\0");
  assert.equal(env.PORT, "3101");
  assert.equal(pickPublicUrl(env), "https://os.example.com");
  assert.equal(pickPublicUrl({ ...env, BETTER_AUTH_URL: "https://auth.example.com" }), "https://auth.example.com");
  assert.equal(pickPublicUrl({ ...env, PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL: "https://hooks.example.com" }), "https://hooks.example.com");
  assert.equal(pickPublicUrl({}, { auth: { publicBaseUrl: "https://file.example.com/" } }), "https://file.example.com");
  assert.equal(pickPublicUrl({ PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL: "https://managed.example.com" }), "https://managed.example.com");
  assert.equal(pickPublicUrl({}), null);
});

test("a URL is verified only when the ping comes back to this plugin", async () => {
  let forward = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.equal(req.url, "/api/plugins/mattermost-bridge/webhooks/actions");
      if (forward) receivePing(JSON.parse(body)); // what Paperclip does: hand it to the plugin
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.deepEqual((await verifyUrl(url + "/", "mattermost-bridge")).ok, true);
  forward = false; // a different server that answers but is not this Paperclip
  const other = await verifyUrl(url, "mattermost-bridge");
  assert.equal(other.ok, false);
  assert.match(other.detail, /never reached this plugin/);
  server.close();
  assert.equal((await verifyUrl("not a url", "x")).ok, false);
  assert.equal(receivePing({ user_id: "u1" }), false);
});

test("approvers come as a list from the settings page, or as older text lines", () => {
  assert.deepEqual([...parseApprovers([{ userId: "u1", email: "A@x.com" }, { userId: "", email: "b@x.com" }])], [["a@x.com", "u1"]]);
  assert.deepEqual([...parseApprovers("a@x.com = u1")], [["a@x.com", "u1"]]);
});
