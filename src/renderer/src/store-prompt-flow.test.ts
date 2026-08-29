import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Prompt delivery against the single-flighted startup: a send during startup
 * waits and sends once, failures keep the draft (no user bubble) and surface
 * a readable system error, and command failures clear the full turn state.
 */

let startCalls = 0;
let startResult: { status: string; pid: number | null; error: string | null } =
  {
    status: "running",
    pid: 1234,
    error: null,
  };
let startGate: Promise<void> = Promise.resolve();
let stateReads = 0;
let promptError: Error | null = null;
const prompts: string[] = [];

const piDesktopStub = {
  pi: {
    start: async () => {
      startCalls += 1;
      await startGate;
      return startResult;
    },
    stop: async () => ({ status: "stopped", pid: null, error: null }),
    restart: async () => startResult,
    getStatus: async () => ({ status: "stopped", pid: null, error: null }),
  },
  session: {
    getState: async () => {
      stateReads += 1;
      return {
        success: true,
        data: {
          model: { id: "m1", name: "M1", provider: "p1", reasoning: true },
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          sessionFile: "/s/one.jsonl",
          sessionId: "s1",
          sessionName: null,
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      };
    },
    getStats: async () => ({ success: true, data: null }),
    list: async () => [],
  },
  model: {
    set: async (_provider: string, _modelId: string) => undefined,
  },
  commands: {
    prompt: async (message: string) => {
      if (promptError) throw promptError;
      prompts.push(message);
    },
    steer: async (message: string) => prompts.push(message),
    followUp: async (message: string) => prompts.push(message),
  },
  tags: {
    add: async (_id: string, tag: string) => [tag],
    getAllUsed: async () => [],
  },
  settings: {
    getAll: async () => ({ permissionRulesAckWorkspaces: [] }),
    save: async (patch: Record<string, unknown>) => patch,
  },
  workspace: {
    trustStatus: async () => ({ pendingReconfirmation: false }),
  },
  permissionRules: {
    workspaceStatus: async () => ({ hasWorkspaceRules: false }),
  },
  themes: { list: async () => ({ themes: [], warnings: [] }) },
};

type AppStore = typeof import("./store")["useAppStore"];
let useAppStore: AppStore;

before(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    piDesktop: piDesktopStub,
  };
  ({ useAppStore } = await import("./store"));
});

beforeEach(() => {
  startCalls = 0;
  startResult = { status: "running", pid: 1234, error: null };
  startGate = Promise.resolve();
  stateReads = 0;
  promptError = null;
  prompts.length = 0;
  useAppStore.setState({
    piStatus: "stopped",
    piPid: null,
    piError: null,
    activeWorkspace: {
      id: "ws1",
      name: "W",
      path: "/w",
      color: "#000",
      lastActiveAt: 0,
      kind: "folder",
    } as ReturnType<typeof useAppStore.getState>["activeWorkspace"],
    sessionState: null,
    sessionStats: null,
    sessionList: [],
    sessionRuntimes: {},
    activeSessionRuntimeId: null,
    settings: null,
    settingsDraft: {},
    isStreaming: false,
    messages: [],
    timelineEvents: [],
    streamingContent: "",
    streamingThinking: "",
    streamingToolCalls: new Map(),
    pendingSteering: [],
    pendingFollowUp: [],
    workspaceActivity: {},
    sessionTags: {},
    autoTags: {},
    allUsedTags: [],
  });
});

function systemMessages(): string[] {
  return useAppStore
    .getState()
    .messages.filter((m) => m.role === "system")
    .map((m) => m.content);
}

test("send without an active workspace fails without a user bubble", async () => {
  useAppStore.setState({ activeWorkspace: null });
  const accepted = await useAppStore.getState().sendPrompt("hello");
  assert.equal(accepted, false);
  assert.equal(
    useAppStore.getState().messages.filter((m) => m.role === "user").length,
    0,
  );
  assert.ok(systemMessages().some((m) => m.includes("活动项目")));
});

test("a failed startup keeps the draft and reports a retryable error", async () => {
  startResult = { status: "error", pid: null, error: "helper exploded" };
  const accepted = await useAppStore.getState().sendPrompt("hello");
  assert.equal(accepted, false);
  assert.equal(useAppStore.getState().piStatus, "error");
  assert.ok(
    systemMessages().some(
      (m) => m.includes("启动失败") && m.includes("helper exploded"),
    ),
  );
  assert.equal(
    useAppStore.getState().messages.filter((m) => m.role === "user").length,
    0,
  );
  assert.equal(useAppStore.getState().isStreaming, false);
});

test("concurrent failed starts share one attempt", async () => {
  startResult = { status: "error", pid: null, error: "helper exploded" };
  const [first, second] = await Promise.all([
    useAppStore.getState().sendPrompt("first"),
    useAppStore.getState().sendPrompt("second"),
  ]);
  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(startCalls, 1);
});

test("a send during startup waits for the single-flighted start and sends once", async () => {
  let releaseStart!: () => void;
  startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });

  const sendPromise = useAppStore
    .getState()
    .sendPrompt("queued while starting");
  // The send is blocked on startup, not silently lost: no bubble yet.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    useAppStore.getState().messages.filter((m) => m.role === "user").length,
    0,
  );

  releaseStart();
  const accepted = await sendPromise;
  assert.equal(accepted, true);
  assert.equal(startCalls, 1);
  assert.deepEqual(prompts, ["queued while starting"]);
  assert.equal(
    useAppStore.getState().messages.filter((m) => m.role === "user").length,
    1,
  );
});

test("concurrent first sends start Pi exactly once", async () => {
  const [a, b] = await Promise.all([
    useAppStore.getState().sendPrompt("first"),
    useAppStore.getState().sendPrompt("second"),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(startCalls, 1);
});

test("a command failure clears the full turn state but keeps the user message", async () => {
  promptError = new Error("provider down");
  const accepted = await useAppStore.getState().sendPrompt("will fail");
  assert.equal(accepted, false);
  const state = useAppStore.getState();
  assert.equal(state.isStreaming, false);
  assert.equal(state.streamingContent, "");
  assert.equal(state.streamingToolCalls.size, 0);
  assert.equal(
    state.messages.filter((m) => m.role === "user" && m.content === "will fail")
      .length,
    1,
  );
  assert.ok(systemMessages().some((m) => m.includes("provider down")));
});

test("a reported model-less runtime blocks the send with guidance", async () => {
  // Pre-populate a session state that positively reports no model.
  useAppStore.setState({
    piStatus: "running",
    sessionState: {
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionFile: null,
      sessionId: "s1",
      sessionName: null,
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  });
  const accepted = await useAppStore.getState().sendPrompt("hello");
  assert.equal(accepted, false);
  assert.ok(systemMessages().some((m) => m.includes("没有可用模型")));
  assert.equal(prompts.length, 0);
});

test("model selection waits for the refreshed session state", async () => {
  useAppStore.setState({ piStatus: "running" });
  const applied = await useAppStore.getState().setModel("p2", "m2");
  assert.equal(applied, true);
  assert.equal(stateReads, 1);
});

test("successful send returns true and records the local echo", async () => {
  const accepted = await useAppStore.getState().sendPrompt("hello there");
  assert.equal(accepted, true);
  assert.deepEqual(prompts, ["hello there"]);
  // The echo of our own prompt must not double-render.
  useAppStore.getState().handlePiEvent({
    type: "message_start",
    message: { role: "user", content: "hello there" },
  } as never);
  assert.equal(
    useAppStore.getState().messages.filter((m) => m.role === "user").length,
    1,
  );
});
