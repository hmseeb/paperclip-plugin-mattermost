import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { detached } from "../src/detach.ts";

test("work started via detached() does not inherit the invocation it was started from", async () => {
  const invocation = new AsyncLocalStorage<string>(); // stands in for the SDK's invocation store
  const seen: (string | undefined)[] = [];
  await invocation.run("onConfigChanged-123", async () => {
    setTimeout(() => seen.push(invocation.getStore()), 5); // inherits: the bug
    detached(() => setTimeout(() => seen.push(invocation.getStore()), 10)); // the fix
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, ["onConfigChanged-123", undefined]);
});
