import { AsyncResource } from "node:async_hooks";

// Created at module load, outside any host invocation. The SDK tags every host call
// with the invocation found in AsyncLocalStorage, so a websocket opened inside
// onConfigChanged would carry that finished invocation forever and the host rejects
// its calls ("missing, expired, or unknown invocation scope"). Work started through
// here carries no invocation, which the host allows for the plugin's configured
// company (its proactive scope).
const outside = new AsyncResource("mattermost-bridge");

export function detached<T>(fn: () => T): T {
  return outside.runInAsyncScope(fn);
}
