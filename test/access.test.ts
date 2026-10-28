import { test } from "node:test";
import assert from "node:assert/strict";
import { accessCheck } from "../src/access.ts";

const users: Record<string, string> = { u1: "Team@Example.com", u2: "client@acme.com", u3: "stranger@x.com" };
const manager = { request: (async (_m: string, path: string) => ({ email: users[path.split("/").pop()!] })) as never };

test("everyone mode checks nothing", () => {
  assert.equal(accessCheck(manager, { access: "everyone" }), null);
});

test("listed people reach all agents or only theirs; others reach none", async () => {
  const can = accessCheck(manager, { access: "selected", allowedUsers: [{ email: "team@example.com" }, { email: "CLIENT@acme.com", agents: ["a-csm"] }] })!;
  assert.equal(await can("u1", "a-cto"), true);
  assert.equal(await can("u2", "a-csm"), true);
  assert.equal(await can("u2", "a-cto"), false);
  assert.equal(await can("u3", "a-csm"), false);
  assert.equal(await can("nobody", "a-csm"), false);
});
