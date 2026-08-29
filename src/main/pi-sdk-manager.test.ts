import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PiSdkManager } from "./pi-sdk-manager";

/**
 * Pending prompt requests must never hang: a helper exit or a teardown
 * (stop/restart) rejects every in-flight correlated response. The Electron
 * utility process is faked through the manager's internals — the cleanup
 * paths under test are the private handlers the real child events drive.
 */
interface Internals {
  child: unknown;
  status: string;
  handleExit: (code: number | undefined) => void;
  teardown: () => void;
}

function withFakeChild(manager: PiSdkManager): Internals {
  const internals = manager as unknown as Internals;
  // teardown() detaches listeners and kills the tree; handleExit() settles
  // waiters. Shape the fake so both paths run their full cleanup.
  internals.child = {
    postMessage: () => undefined,
    removeAllListeners: () => undefined,
    stdout: null,
    stderr: null,
    pid: undefined,
  };
  internals.status = "running";
  return internals;
}

beforeEach(() => {
  // Each test builds its own manager; nothing global to reset.
});

test("a pending prompt is rejected when the helper exits", async () => {
  const manager = new PiSdkManager();
  const internals = withFakeChild(manager);

  const pending = manager.request({ kind: "prompt", message: "hi" }, "prompt");
  internals.handleExit(1);

  await assert.rejects(pending, /helper exited/);
  assert.equal(manager.getStatus().status, "stopped");
});

test("a pending prompt is rejected when the manager tears down", async () => {
  const manager = new PiSdkManager();
  const internals = withFakeChild(manager);

  const pending = manager.request({ kind: "prompt", message: "hi" }, "prompt");
  internals.teardown();

  await assert.rejects(pending, /stopped/);
});

test("a send failure rejects the request instead of leaking the timer", async () => {
  const manager = new PiSdkManager();
  const internals = manager as unknown as Internals;
  internals.child = {
    postMessage: () => {
      throw new Error("pipe gone");
    },
  };
  internals.status = "running";

  await assert.rejects(
    manager.request({ kind: "abort" }, "abort"),
    /pipe gone/,
  );
});
