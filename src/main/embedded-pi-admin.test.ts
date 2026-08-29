import { test } from "node:test";
import assert from "node:assert/strict";
import { EmbeddedPiAdminManager } from "./embedded-pi-admin";

/**
 * discoverModels() correlation over the admin helper. The Electron utility
 * process is faked through the manager's internals (as in pi-sdk-manager.test
 * .ts): the real child events drive the same private handlers under test.
 */

interface AdminInternals {
  child: { postMessage: (value: unknown) => void } | null;
  startPromise: Promise<void> | null;
  handleMessage: (value: unknown) => void;
  request: (
    message: Record<string, unknown> & { kind: string },
    command: string,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

function withFakeChild(manager: EmbeddedPiAdminManager): {
  internals: AdminInternals;
  sent: Array<Record<string, unknown>>;
} {
  const internals = manager as unknown as AdminInternals;
  const sent: Array<Record<string, unknown>> = [];
  internals.child = {
    postMessage: (value: unknown) => sent.push(value as Record<string, unknown>),
  };
  internals.startPromise = Promise.resolve();
  return { internals, sent };
}

/** Flush microtasks so the async discoverModels body reaches its send(). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("discoverModels correlates the response and narrows the payload", async () => {
  const manager = new EmbeddedPiAdminManager({ cwd: () => "/tmp" });
  const { internals, sent } = withFakeChild(manager);

  const promise = manager.discoverModels("/tmp/temp/models.json", "my-provider");
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "adminDiscoverModels");
  assert.equal(sent[0].configPath, "/tmp/temp/models.json");
  assert.equal(sent[0].providerId, "my-provider");
  // The wire contract carries a path, never a key.
  assert.equal("apiKey" in sent[0], false);

  internals.handleMessage({
    kind: "adminResponse",
    id: sent[0].id,
    command: "model_discovery",
    success: true,
    // Credential-looking extras must not survive the narrowing.
    data: {
      models: [
        { id: "m1", name: "Model One", apiKey: "sk-leak", headers: {} },
        { id: "m2" },
        "junk",
      ],
      apiKey: "sk-root-leak",
    },
  });

  const models = await promise;
  assert.deepEqual(models, [
    { id: "m1", name: "Model One" },
    { id: "m2" },
  ]);
});

test("discoverModels rejects when the helper reports failure", async () => {
  const manager = new EmbeddedPiAdminManager({ cwd: () => "/tmp" });
  const { internals, sent } = withFakeChild(manager);

  const promise = manager.discoverModels("/tmp/temp/models.json", "my-provider");
  await settle();
  internals.handleMessage({
    kind: "adminResponse",
    id: sent[0].id,
    command: "model_discovery",
    success: false,
    error: "模型列表请求失败：HTTP 401",
  });
  await assert.rejects(promise, /HTTP 401/);
});

test("a timed-out request rejects and cannot be completed afterwards", async () => {
  const manager = new EmbeddedPiAdminManager({ cwd: () => "/tmp" });
  const { internals, sent } = withFakeChild(manager);

  const promise = internals.request(
    { kind: "adminNpmAvailable" },
    "tool_availability",
    15,
  );
  await assert.rejects(promise, /timed out/);
  // A late response for the same id finds no pending entry: no double settle.
  internals.handleMessage({
    kind: "adminResponse",
    id: sent[sent.length - 1]?.id ?? "admin-req-1",
    command: "tool_availability",
    success: true,
    data: { npm: true, git: true },
  });
});
