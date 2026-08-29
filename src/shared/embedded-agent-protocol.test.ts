import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDED_AGENT_PROTOCOL_VERSION,
  parseAdminHelperToParent,
  parseHelperToParent,
  parseParentToAdminHelper,
  parseParentToHelper,
  toTransferable,
} from "./embedded-agent-protocol";

/**
 * The utility-process wire carries these messages both ways; every message is
 * structurally validated at the boundary, and anything the SDK produced is
 * JSON-rounded into structured-clone-safe plain data before posting.
 */

const VALID_INIT = {
  kind: "init",
  protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
  cwd: "/tmp/proj",
  agentDir: "/home/u/.pi/agent",
  projectTrusted: true,
  session: { kind: "new" },
  tools: ["read", "grep", "find", "ls"],
  permissionMode: "plan-readonly",
};

test("a valid init message parses with defaults applied", () => {
  const parsed = parseParentToHelper(VALID_INIT);
  assert.ok(parsed);
  assert.equal(parsed.kind, "init");
  if (parsed.kind === "init") {
    assert.equal(parsed.projectTrusted, true);
    assert.deepEqual(parsed.tools, ["read", "grep", "find", "ls"]);
    assert.equal(parsed.permissionExtensionPath, null);
  }
});

test("a protocol-version mismatch rejects init", () => {
  const parsed = parseParentToHelper({
    ...VALID_INIT,
    protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION + 1,
  });
  assert.equal(parsed, null);
});

test("the helper ready handshake parses with its required metadata", () => {
  const ready = parseHelperToParent({
    kind: "ready",
    protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
    sdkVersion: "unknown",
    pid: 42,
  });
  assert.deepEqual(ready, {
    kind: "ready",
    protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
    sdkVersion: "unknown",
    pid: 42,
  });
  assert.equal(
    parseHelperToParent({
      kind: "ready",
      protocolVersion: 99,
      sdkVersion: "x",
      pid: 42,
    }),
    null,
  );
});

test("fork init validates sourcePath rather than sessionPath", () => {
  const parsed = parseParentToHelper({
    ...VALID_INIT,
    session: { kind: "fork", sourcePath: "/sessions/source.jsonl" },
  });
  assert.ok(parsed && parsed.kind === "init");
  assert.equal(
    parseParentToHelper({
      ...VALID_INIT,
      session: { kind: "fork", sessionPath: "/sessions/source.jsonl" },
    }),
    null,
  );
});

test("malformed init variants are rejected", () => {
  assert.equal(parseParentToHelper({ ...VALID_INIT, cwd: 42 }), null);
  assert.equal(
    parseParentToHelper({ ...VALID_INIT, session: { kind: "open" } }),
    null,
  );
  assert.equal(
    parseParentToHelper({
      ...VALID_INIT,
      session: { kind: "open", sessionPath: "/x.jsonl" },
    }) !== null,
    true,
  );
  assert.equal(
    parseParentToHelper({ ...VALID_INIT, thinkingLevel: "bogus" }),
    null,
  );
  assert.equal(
    parseParentToHelper({ ...VALID_INIT, thinkingLevel: "high" }) !== null,
    true,
  );
  assert.equal(parseParentToHelper({ ...VALID_INIT, tools: "read" }), null);
});

test("correlated commands carry their ids through", () => {
  const prompt = parseParentToHelper({
    kind: "prompt",
    id: "req-1",
    message: "hi",
    images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
  });
  assert.ok(prompt);
  if (prompt.kind === "prompt") {
    assert.equal(prompt.id, "req-1");
    assert.equal(prompt.images?.length, 1);
  }

  assert.equal(
    parseParentToHelper({ kind: "prompt", id: "req-1", message: 5 }),
    null,
  );
  assert.equal(parseParentToHelper({ kind: "prompt", message: "hi" }), null);

  const model = parseParentToHelper({
    kind: "setModel",
    id: "r2",
    provider: "anthropic",
    modelId: "claude",
  });
  assert.ok(model && model.kind === "setModel");
  assert.equal(
    parseParentToHelper({ kind: "setModel", id: "r2", provider: "anthropic" }),
    null,
  );
});

test("thinking levels include max on both init and setThinkingLevel", () => {
  assert.equal(
    parseParentToHelper({ ...VALID_INIT, thinkingLevel: "max" }) !== null,
    true,
  );
  const level = parseParentToHelper({
    kind: "setThinkingLevel",
    id: "r3",
    level: "max",
  });
  assert.ok(level && level.kind === "setThinkingLevel");
  if (level.kind === "setThinkingLevel") assert.equal(level.level, "max");
  assert.equal(
    parseParentToHelper({ kind: "setThinkingLevel", id: "r3", level: "ultra" }),
    null,
  );
  assert.equal(
    parseParentToHelper({ kind: "setThinkingLevel", id: "r3" }),
    null,
  );
});

test("prompt options reject malformed payloads instead of silently dropping", () => {
  // A malformed image anywhere in the array rejects the whole message.
  assert.equal(
    parseParentToHelper({
      kind: "prompt",
      id: "r4",
      message: "hi",
      images: [
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "image" },
      ],
    }),
    null,
  );
  // streamingBehavior is a closed set; unknown values reject the message.
  assert.equal(
    parseParentToHelper({
      kind: "prompt",
      id: "r5",
      message: "hi",
      streamingBehavior: "surprise",
    }),
    null,
  );
  const steer = parseParentToHelper({
    kind: "prompt",
    id: "r6",
    message: "hi",
    streamingBehavior: "followUp",
  });
  assert.ok(steer && steer.kind === "prompt");
  if (steer.kind === "prompt")
    assert.equal(steer.streamingBehavior, "followUp");
  // Steers reject malformed image payloads the same way.
  assert.equal(
    parseParentToHelper({
      kind: "steer",
      id: "r7",
      message: "hi",
      images: "nope",
    }),
    null,
  );
});

test("an unknown kind is rejected", () => {
  assert.equal(parseParentToHelper({ kind: "teleport", id: "x" }), null);
  assert.equal(parseParentToHelper(null), null);
  assert.equal(parseParentToHelper("prompt"), null);
});

test("helper events and ui requests round-trip", () => {
  const event = parseHelperToParent({
    kind: "event",
    event: { type: "agent_start" },
  });
  assert.ok(event && event.kind === "event");

  // An event without a type is not a renderer event.
  assert.equal(
    parseHelperToParent({ kind: "event", event: { payload: true } }),
    null,
  );

  const ui = parseHelperToParent({
    kind: "uiRequest",
    request: { id: "u1", method: "confirm", title: "Allow?" },
  });
  assert.ok(ui && ui.kind === "uiRequest");
  // Missing request id is rejected — the router correlates on it.
  assert.equal(
    parseHelperToParent({ kind: "uiRequest", request: { method: "confirm" } }),
    null,
  );
});

test("sessionBound tolerates absent fields as null", () => {
  const bound = parseHelperToParent({ kind: "sessionBound" });
  assert.deepEqual(bound, {
    kind: "sessionBound",
    sessionFile: null,
    sessionId: null,
    sessionName: null,
  });
});

test("admin messages parse in both directions", () => {
  const init = parseParentToAdminHelper({
    kind: "admin-init",
    protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
    agentDir: "/u/.pi/agent",
    cwd: "/tmp",
  });
  assert.ok(init && init.kind === "admin-init");

  const install = parseParentToAdminHelper({
    kind: "adminPackageInstall",
    id: "a1",
    source: "pi-proxy",
  });
  assert.ok(install && install.kind === "adminPackageInstall");

  // Auth commands are gone from the protocol: no login surface, no secret relay.
  assert.equal(
    parseParentToAdminHelper({
      kind: "adminLogin",
      id: "a2",
      loginId: "l1",
      providerId: "anthropic",
    }),
    null,
  );
  assert.equal(
    parseParentToAdminHelper({
      kind: "adminPromptAnswer",
      id: "a3",
      loginId: "l1",
      value: "sk-test",
    }),
    null,
  );
  assert.equal(
    parseAdminHelperToParent({
      kind: "authPrompt",
      loginId: "l1",
      prompt: { type: "secret", message: "API key" },
    }),
    null,
  );
  assert.equal(
    parseAdminHelperToParent({
      kind: "authNotify",
      loginId: "l1",
      event: { type: "progress", message: "x" },
    }),
    null,
  );

  const progress = parseAdminHelperToParent({
    kind: "adminPackageProgress",
    id: "a4",
    event: { type: "info", action: "install", source: "pi-proxy" },
  });
  assert.ok(progress && progress.kind === "adminPackageProgress");

  assert.equal(
    parseParentToAdminHelper({ kind: "adminPackageInstall", id: "a5" }),
    null,
  );
});

test("toTransferable JSON-rounds class-shaped values and rejects cycles", () => {
  class Box {
    value = 3;
    hidden = (): number => 1;
  }
  const plain = toTransferable({ box: new Box(), when: new Date(0) });
  assert.ok(plain);
  assert.deepEqual((plain as { box: { value: number } }).box, { value: 3 });
  // Dates serialize like the old JSONL pipe did.
  assert.equal(typeof (plain as { when: unknown }).when, "string");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(toTransferable(cyclic), null);
});

test("adminDiscoverModels round-trips with path and provider only", () => {
  const message = {
    kind: "adminDiscoverModels",
    id: "d1",
    configPath: "/tmp/pi-desktop-models-x/models.json",
    providerId: "my-provider",
  };
  const parsed = parseParentToAdminHelper(message);
  assert.deepEqual(parsed, message);
  // No credentials field is part of the message contract: an injected one is
  // dropped by the validator (it only forwards known fields).
  const withKey = parseParentToAdminHelper({
    ...message,
    apiKey: "sk-leaky",
  }) as Record<string, unknown> | null;
  assert.ok(withKey);
  assert.equal("apiKey" in withKey, false);
});

test("adminDiscoverModels rejects missing path/provider and bad types", () => {
  assert.equal(
    parseParentToAdminHelper({ kind: "adminDiscoverModels", id: "d2" }),
    null,
  );
  assert.equal(
    parseParentToAdminHelper({
      kind: "adminDiscoverModels",
      id: "d2",
      configPath: "  ",
      providerId: "p",
    }),
    null,
  );
  assert.equal(
    parseParentToAdminHelper({
      kind: "adminDiscoverModels",
      id: "d2",
      configPath: "/tmp/models.json",
      providerId: 42,
    }),
    null,
  );
  assert.equal(parseParentToAdminHelper({ kind: "adminDiscoverModels" }), null);
});

test("admin discover response payload is narrowed to id/name rows", () => {
  // The adminResponse envelope itself is generic (data: unknown); narrowing
  // happens via parseDiscoveredModelsPayload, which drops any extra fields.
  const envelope = parseAdminHelperToParent({
    kind: "adminResponse",
    id: "d3",
    command: "model_discovery",
    success: true,
    data: { models: [{ id: "m1", name: "Model One" }] },
  });
  assert.ok(envelope && envelope.kind === "adminResponse");
  assert.equal(envelope.success, true);

  assert.equal(
    parseAdminHelperToParent({
      kind: "adminResponse",
      id: "d3",
      command: "model_discovery",
      success: "yes",
    }),
    null,
  );
});
