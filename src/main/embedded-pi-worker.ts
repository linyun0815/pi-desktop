/**
 * Embedded Pi SDK helper. One utility process per live session.
 *
 * The helper owns an AgentSessionRuntime created from the Pi SDK
 * (`@earendil-works/pi-coding-agent`), which it loads dynamically so the
 * Electron main process never hosts extension code. It speaks the versioned
 * protocol in `shared/embedded-agent-protocol.ts` over `process.parentPort`,
 * converts SDK events into the renderer's established event shapes, and
 * mirrors the SDK RPC mode's extension bindings (UI dialogs, command context
 * actions) over the utility-process transport instead of stdin/stdout.
 *
 * Process identity: the helper sets its own cwd, PI_CODING_AGENT=true and
 * AI_AGENT=pi, exactly like the SDK's own rpc-entry does, so extensions and
 * resource discovery behave as under the real CLI.
 */
import type {
  AgentSession,
  ModelRuntime,
  SessionManager,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type {
  HelperInitMessage,
  ParentToHelperMessage,
  SessionTarget,
} from "../shared/embedded-agent-protocol";
import {
  EMBEDDED_AGENT_PROTOCOL_VERSION,
  parseParentToAdminHelper,
  parseParentToHelper,
  toTransferable,
} from "../shared/embedded-agent-protocol";
import {
  DISCOVERY_MAX_BODY_BYTES,
  buildDiscoveryQuery,
  buildDiscoveryRequestHeaders,
  buildModelsEndpoint,
  fetchWithAuthRedirectGuard,
  isDiscoverableApi,
  parseModelsListResponse,
} from "../shared/model-discovery";
import { readFile } from "node:fs/promises";
import { createDeferredPrompt } from "./prompt-acceptance";

type ParentPort = {
  postMessage(value: unknown): void;
  on(type: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
};

// SAFETY: Electron exposes `process.parentPort` only inside a utility
// process; this cast narrows the runtime-provided port to the methods used
// below without exposing Node APIs to the renderer.
const parentPort = (process as unknown as { parentPort?: ParentPort })
  .parentPort;
if (!parentPort) {
  // Not launched as a utility process — nothing to serve.
  process.exit(1);
}

// Dynamically resolved specifier: a computed string keeps the bundler from
// resolving (and inlining) the ESM-only SDK into the CJS worker bundle. The
// runtime `import()` below is a real dynamic import executed by Node.
const SDK_SPECIFIER = ["@earendil-works", "pi-coding-agent"].join("/");

type SdkModule = typeof import("@earendil-works/pi-coding-agent");
let sdk: SdkModule | null = null;

async function loadSdk(): Promise<SdkModule> {
  if (!sdk) sdk = (await import(/* @vite-ignore */ SDK_SPECIFIER)) as SdkModule;
  return sdk;
}

// ─── Outbound helpers ───────────────────────────────────────────────────────

function post(message: unknown): void {
  parentPort!.postMessage(message);
}

function postLog(level: "info" | "warn" | "error", message: string): void {
  post({ kind: "log", level, message });
}

function postEvent(event: unknown): void {
  const transferable = toTransferable(event);
  if (transferable === null) return;
  post({ kind: "event", event: transferable });
}

function postResponse(id: string, command: string, data?: unknown): void {
  post({
    kind: "response",
    id,
    command,
    success: true,
    ...(data !== undefined ? { data: toTransferable(data) } : {}),
  });
}

function postError(id: string, command: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  post({ kind: "response", id, command, success: false, error: message });
}

// ─── Runtime state ──────────────────────────────────────────────────────────

interface RuntimeState {
  init: HelperInitMessage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime: any; // AgentSessionRuntime
  settingsManager: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRuntime: any; // ModelRuntime
}

let state: RuntimeState | null = null;
const unsubscribers: Array<() => void> = [];
let shuttingDown = false;
/** Request id -> resolver for in-flight blocking extension-UI dialogs. */
const uiResponseResolvers = new Map<
  string,
  (payload: Record<string, unknown>) => void
>();

function currentSession(): AgentSession | null {
  return (state?.runtime?.session as AgentSession | undefined) ?? null;
}

/** Correlation ids for extension-UI dialogs and auth prompts. */
function randomId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Event mapping (SDK -> renderer shapes) ─────────────────────────────────

/**
 * Strip the SDK's `partial` from a streaming assistant event and re-attach the
 * toolCall block the renderer's streaming UI expects. The old CLI's JSONL pipe
 * delivered exactly these fields; the renderer contract is unchanged.
 */
function convertAssistantMessageEvent(
  ame: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: ame.type };
  if (typeof ame.contentIndex === "number") out.contentIndex = ame.contentIndex;
  if (typeof ame.delta === "string") out.delta = ame.delta;
  if (typeof ame.content === "string") out.content = ame.content;
  if (typeof ame.reason === "string") out.reason = ame.reason;
  if (typeof ame.type === "string" && ame.type.startsWith("toolcall")) {
    const toolCall =
      (ame.toolCall as Record<string, unknown> | undefined) ??
      extractToolCallFromPartial(ame);
    if (toolCall) {
      out.toolCall = {
        id: toolCall.id,
        name: toolCall.name,
        ...(toolCall.arguments !== undefined
          ? { arguments: toolCall.arguments }
          : {}),
      };
    }
  }
  return out;
}

function extractToolCallFromPartial(
  ame: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const partial = ame.partial as
    | { content?: Array<Record<string, unknown>> }
    | undefined;
  const index = typeof ame.contentIndex === "number" ? ame.contentIndex : -1;
  const block = partial?.content?.[index];
  return block && block.type === "toolCall" ? block : undefined;
}

/** Map one SDK AgentSessionEvent to the renderer-established event shape. */
function convertSdkEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end", messages: event.messages ?? [] };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return {
        type: "turn_end",
        message: event.message,
        toolResults: event.toolResults ?? [],
      };
    case "message_start":
      return { type: "message_start", message: event.message };
    case "message_end":
      return { type: "message_end", message: event.message };
    case "message_update":
      return {
        type: "message_update",
        message: event.message,
        assistantMessageEvent: convertAssistantMessageEvent(
          event.assistantMessageEvent as Record<string, unknown>,
        ),
      };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError === true,
      };
    case "queue_update":
      return {
        type: "queue_update",
        steering: [
          ...((event.steering as readonly string[] | undefined) ?? []),
        ],
        followUp: [
          ...((event.followUp as readonly string[] | undefined) ?? []),
        ],
      };
    case "compaction_start":
      return { type: "compaction_start", reason: event.reason };
    case "compaction_end":
      return {
        type: "compaction_end",
        reason: event.reason,
        result: event.result,
        aborted: event.aborted === true,
        willRetry: event.willRetry === true,
        ...(typeof event.errorMessage === "string"
          ? { errorMessage: event.errorMessage }
          : {}),
      };
    case "auto_retry_start":
      return {
        type: "auto_retry_start",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };
    case "auto_retry_end":
      return {
        type: "auto_retry_end",
        success: event.success === true,
        attempt: event.attempt,
        ...(typeof event.finalError === "string"
          ? { finalError: event.finalError }
          : {}),
      };
    case "session_info_changed":
      return { type: "session_info_changed", name: event.name ?? null };
    case "thinking_level_changed":
      return { type: "config_update", thinkingLevel: event.level };
    case "extension_error":
      return {
        type: "extension_error",
        extensionPath:
          (event as { extensionPath?: string }).extensionPath ?? "",
        event: (event as { event?: string }).event ?? "",
        error: (event as { error?: string }).error ?? "",
      };
    // Renderer has no handlers for these SDK-only events.
    case "agent_settled":
    case "entry_appended":
    case "bash_execution_update":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return null;
    default:
      return null;
  }
}

function handleSdkEvent(raw: unknown): void {
  try {
    const converted = convertSdkEvent(raw as Record<string, unknown>);
    if (converted) postEvent(converted);
  } catch (err) {
    postLog(
      "warn",
      `event conversion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Extension UI bridge ────────────────────────────────────────────────────

function serializeRequest(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const transferable = toTransferable(request);
  return (transferable ?? request) as Record<string, unknown>;
}

/**
 * Mirror of the SDK RPC mode's UI context: blocking dialogs wait for a
 * `extensionUiResponse` correlated by request id; fire-and-forget methods post
 * and return immediately. Field names match the old CLI's extension_ui_request
 * events, so the desktop router and renderer dialogs need no changes.
 */
function createExtensionUIContext(): Record<string, unknown> {
  function dialog(
    request: Record<string, unknown>,
    defaultValue: unknown,
    parse: (payload: Record<string, unknown>) => unknown,
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.resolve(defaultValue);
    const id = randomId();
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        uiResponseResolvers.delete(id);
      };
      const settle = (value: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onAbort = (): void => settle(defaultValue);
      signal?.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeout) {
        timer = setTimeout(() => settle(defaultValue), timeout);
      }
      uiResponseResolvers.set(id, (payload) => settle(parse(payload)));
      post({
        kind: "uiRequest",
        request: serializeRequest({ id, ...request }),
      });
    });
  }

  return {
    select: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number },
    ) =>
      dialog(
        {
          method: "select",
          title,
          options,
          ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        },
        undefined,
        (payload) =>
          payload.cancelled === true
            ? undefined
            : typeof payload.value === "string"
              ? payload.value
              : undefined,
        opts?.signal,
        opts?.timeout,
      ),
    confirm: (
      title: string,
      message: string,
      opts?: { signal?: AbortSignal; timeout?: number },
    ) =>
      dialog(
        {
          method: "confirm",
          title,
          message,
          ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        },
        false,
        (payload) =>
          payload.cancelled === true ? false : payload.confirmed === true,
        opts?.signal,
        opts?.timeout,
      ),
    input: (
      title: string,
      placeholder?: string,
      opts?: { signal?: AbortSignal; timeout?: number },
    ) =>
      dialog(
        {
          method: "input",
          title,
          ...(placeholder ? { placeholder } : {}),
          ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        },
        undefined,
        (payload) =>
          payload.cancelled === true
            ? undefined
            : typeof payload.value === "string"
              ? payload.value
              : undefined,
        opts?.signal,
        opts?.timeout,
      ),
    notify: (message: string, type?: "info" | "warning" | "error") => {
      post({
        kind: "uiRequest",
        request: serializeRequest({
          id: randomId(),
          method: "notify",
          message,
          notifyType: type,
        }),
      });
    },
    onTerminalInput: () => () => undefined,
    setStatus: (key: string, text: string | undefined) => {
      post({
        kind: "uiRequest",
        request: serializeRequest({
          id: randomId(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        }),
      });
    },
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: (
      key: string,
      content: unknown,
      options?: { placement?: string },
    ) => {
      if (content === undefined || Array.isArray(content)) {
        post({
          kind: "uiRequest",
          request: serializeRequest({
            id: randomId(),
            method: "setWidget",
            widgetKey: key,
            widgetLines: content,
            ...(options?.placement
              ? { widgetPlacement: options.placement }
              : {}),
          }),
        });
      }
    },
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: (title: string) => {
      post({
        kind: "uiRequest",
        request: serializeRequest({
          id: randomId(),
          method: "setTitle",
          title,
        }),
      });
    },
    custom: async () => undefined,
    pasteToEditor: function (
      this: { setEditorText?: (text: string) => void },
      text: string,
    ) {
      this.setEditorText?.(text);
    },
    setEditorText: (text: string) => {
      post({
        kind: "uiRequest",
        request: serializeRequest({
          id: randomId(),
          method: "set_editor_text",
          text,
        }),
      });
    },
    getEditorText: () => "",
    editor: (title: string, prefill?: string) =>
      dialog(
        {
          method: "editor",
          title,
          ...(prefill !== undefined ? { prefill } : {}),
        },
        undefined,
        (payload) =>
          payload.cancelled === true
            ? undefined
            : typeof payload.value === "string"
              ? payload.value
              : undefined,
      ),
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };
}

// ─── Session binding (mirrors RPC rebindSession) ────────────────────────────

async function rebindSession(st: RuntimeState): Promise<void> {
  const session = st.runtime.session as AgentSession;
  // Each rebinding replaces the previous UI context; drop dialogs the old
  // context was still waiting on so a stale answer can never settle twice.
  uiResponseResolvers.clear();
  // The context is shaped like the SDK's ExtensionUIContext; the parts the
  // SDK may optionally call that a headless helper cannot serve are no-ops.
  await session.bindExtensions({
    uiContext: createExtensionUIContext() as never,
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async (options?: unknown) =>
        st.runtime.newSession(options as never),
      fork: async (entryId: string | undefined, forkOptions?: unknown) => {
        const result = await st.runtime.fork(
          entryId ?? session.sessionManager.getLeafId(),
          forkOptions as never,
        );
        return { cancelled: result.cancelled };
      },
      navigateTree: async (
        targetId: string,
        options?: Record<string, unknown>,
      ) => {
        const result = await session.navigateTree(targetId, options as never);
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath: string, options?: unknown) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        st.runtime.switchSession(sessionPath, options as any),
      reload: async () => {
        await session.reload();
      },
    },
    shutdownHandler: () => {
      void gracefulShutdown();
    },
    onError: (err: {
      extensionPath?: string;
      event?: string;
      error?: string;
    }) => {
      postEvent({
        type: "extension_error",
        extensionPath: err?.extensionPath ?? "",
        event: err?.event ?? "",
        error: err?.error ?? "unknown extension error",
      });
    },
  });

  const unsubscribe = session.subscribe((event: unknown) =>
    handleSdkEvent(event),
  );
  unsubscribers.push(unsubscribe);

  postSessionBound(st);
}

function postSessionBound(st: RuntimeState): void {
  const session = st.runtime.session as AgentSession | null;
  if (!session) return;
  post({
    kind: "sessionBound",
    sessionFile: session.sessionFile ?? null,
    sessionId: session.sessionId ?? null,
    sessionName: session.sessionName ?? null,
  });
}

// ─── Init ───────────────────────────────────────────────────────────────────

type SdkModel = ReturnType<ModelRuntime["getModels"]>[number];

function buildSessionManager(
  msg: HelperInitMessage,
  Sdk: SdkModule,
): SessionManager {
  const { SessionManager } = Sdk;
  const target: SessionTarget = msg.session;
  switch (target.kind) {
    case "new":
      return SessionManager.create(msg.cwd);
    case "open":
      return SessionManager.open(target.sessionPath);
    case "continue":
      return SessionManager.continueRecent(msg.cwd);
    case "fork":
      return SessionManager.forkFrom(target.sourcePath, msg.cwd);
    case "inMemory":
      return SessionManager.inMemory(msg.cwd);
  }
}

async function initialize(msg: HelperInitMessage): Promise<void> {
  const Sdk = await loadSdk();
  const {
    SettingsManager,
    ModelRuntime,
    DefaultResourceLoader,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
  } = Sdk;

  process.chdir(msg.cwd);
  process.title = "pi-desktop-embedded-agent";
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";

  // Without npm on PATH the SDK's package resolver cannot install a missing
  // configured package. Existing global/project resources keep loading, and
  // missing ones surface as loader diagnostics instead of a hard failure
  // (explicit installs report the missing tool through the admin helper).
  if (!npmAvailable()) {
    process.env.PI_OFFLINE = "1";
    postLog(
      "warn",
      "npm not found on PATH; missing Pi packages are skipped (offline mode)",
    );
  }

  const settingsManager = await SettingsManager.create(msg.cwd, msg.agentDir, {
    projectTrusted: msg.projectTrusted,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(msg.agentDir, "auth.json"),
    modelsPath: join(msg.agentDir, "models.json"),
  });

  const additionalExtensionPaths = [...(msg.extensionPaths ?? [])];
  if (msg.permissionExtensionPath)
    additionalExtensionPaths.push(msg.permissionExtensionPath);

  const resourceLoader = new DefaultResourceLoader({
    cwd: msg.cwd,
    agentDir: msg.agentDir,
    settingsManager,
    ...(additionalExtensionPaths.length > 0
      ? { additionalExtensionPaths }
      : {}),
  });
  await resourceLoader.reload({
    resolveProjectTrust: async () => msg.projectTrusted,
  });

  const sessionManager = buildSessionManager(msg, Sdk);

  const createRuntime = async (factoryOptions: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
  }) => {
    const services = await createAgentSessionServices({
      cwd: factoryOptions.cwd,
      agentDir: factoryOptions.agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        ...(additionalExtensionPaths.length > 0
          ? { additionalExtensionPaths }
          : {}),
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async () => msg.projectTrusted,
      },
    });
    let model: SdkModel | undefined;
    if (msg.provider && msg.modelId) {
      model = modelRuntime
        .getModels()
        .find((m) => m.provider === msg.provider && m.id === msg.modelId);
      if (!model) {
        // A stale desktop default must not prevent the helper from starting:
        // the SDK can fall back to its normal initial-model resolution, and the
        // user can choose a replacement from the model picker before sending.
        postLog(
          "warn",
          `Configured model not found: ${msg.provider}/${msg.modelId}; using SDK model selection`,
        );
      }
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: factoryOptions.sessionManager,
      ...(factoryOptions.sessionStartEvent
        ? { sessionStartEvent: factoryOptions.sessionStartEvent }
        : {}),
      ...(model ? { model } : {}),
      ...(msg.thinkingLevel ? { thinkingLevel: msg.thinkingLevel } : {}),
      ...(msg.tools && msg.tools.length > 0 ? { tools: msg.tools } : {}),
    });
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: msg.cwd,
    agentDir: msg.agentDir,
    sessionManager,
  });

  state = { init: msg, runtime, settingsManager, modelRuntime };
  await rebindSession(state);
}

// ─── Command handlers ───────────────────────────────────────────────────────

type Handler = (msg: ParentToHelperMessage) => Promise<unknown> | unknown;

function requireSession(): AgentSession {
  const session = currentSession();
  if (!session) throw new Error("Session runtime not initialized");
  return session;
}

function buildHandlers(): Record<string, Handler> {
  return {
    prompt: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "prompt" }>;
      const session = requireSession();
      // Mirrors RPC mode: the authoritative success is emitted by the
      // preflight hook (queued prompts count as accepted). Exactly one
      // response per request — preflight accept, preflight reject, or async
      // throw, whichever lands first; later endings are ignored.
      const deferred = createDeferredPrompt((outcome) => {
        if (outcome.kind === "accepted") postResponse(m.id, "prompt");
        else postError(m.id, "prompt", new Error(outcome.error));
      });
      void session
        .prompt(m.message, {
          ...(m.images ? { images: m.images } : {}),
          ...(m.streamingBehavior
            ? { streamingBehavior: m.streamingBehavior }
            : {}),
          source: "rpc",
          preflightResult: deferred.preflightResult,
        })
        .catch((err: unknown) => {
          deferred.onAsyncFailure(err);
        });
      return "deferred";
    },
    steer: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "steer" }>;
      await requireSession().steer(m.message, m.images);
      return undefined;
    },
    followUp: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "followUp" }>;
      await requireSession().followUp(m.message);
      return undefined;
    },
    abort: async () => {
      await requireSession().abort();
      return undefined;
    },
    bash: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "bash" }>;
      const session = requireSession();
      // Mirror RPC mode: extension user_bash handlers may satisfy or adapt.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eventResult = await (session as any).extensionRunner.emitUserBash({
        type: "user_bash",
        command: m.command,
        excludeFromContext: false,
        cwd: session.sessionManager.getCwd(),
      });
      if (eventResult?.result) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session.recordBashResult(m.command, eventResult.result, {} as any);
        return eventResult.result;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (session as any).executeBash(m.command, undefined, {
        excludeFromContext: false,
        ...(eventResult?.operations
          ? { operations: eventResult.operations }
          : {}),
      });
    },
    abortBash: async () => {
      requireSession().abortBash();
      return undefined;
    },
    setModel: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "setModel" }>;
      const session = requireSession();
      const st = state!;
      const model = st.modelRuntime.getModels().find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (candidate: any) =>
          candidate.provider === m.provider && candidate.id === m.modelId,
      );
      if (!model)
        throw new Error(`Model not found: ${m.provider}/${m.modelId}`);
      await session.setModel(model);
      return model;
    },
    cycleModel: async () => {
      return await requireSession().cycleModel();
    },
    setThinkingLevel: async (msg) => {
      const m = msg as Extract<
        ParentToHelperMessage,
        { kind: "setThinkingLevel" }
      >;
      requireSession().setThinkingLevel(m.level);
      return undefined;
    },
    cycleThinkingLevel: async () => {
      return requireSession().cycleThinkingLevel() ?? null;
    },
    sessionState: async () => {
      const session = requireSession();
      return {
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        isStreaming: session.isStreaming,
        isCompacting: session.isCompacting,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        autoCompactionEnabled: session.autoCompactionEnabled,
        messageCount: session.messages.length,
        pendingMessageCount: session.pendingMessageCount,
      };
    },
    sessionMessages: async () => {
      return { messages: requireSession().messages };
    },
    listModels: async () => {
      return { models: requireSession().modelRuntime.getAvailableSnapshot() };
    },
    sessionStats: async () => {
      return requireSession().getSessionStats();
    },
    listCommands: async () => {
      const session = requireSession();
      const commands: Array<{
        name: string;
        description: string;
        source: string;
      }> = [];
      for (const registered of session.extensionRunner.getRegisteredCommands()) {
        commands.push({
          name: String(registered.invocationName ?? ""),
          description: registered.description ?? "",
          source: "extension",
        });
      }
      for (const template of session.promptTemplates) {
        commands.push({
          name: String(template.name ?? ""),
          description: template.description ?? "",
          source: "prompt",
        });
      }
      for (const skill of session.resourceLoader.getSkills().skills) {
        commands.push({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
        });
      }
      return { commands };
    },
    getForkMessages: async () => {
      return { messages: requireSession().getUserMessagesForForking() };
    },
    setSessionName: async (msg) => {
      const m = msg as Extract<
        ParentToHelperMessage,
        { kind: "setSessionName" }
      >;
      const name = m.name.trim();
      if (!name) throw new Error("Session name cannot be empty");
      requireSession().setSessionName(name);
      return undefined;
    },
    sessionNew: async () => {
      const st = state!;
      const result = await st.runtime.newSession();
      if (!result?.cancelled) await rebindSession(st);
      return result ?? { cancelled: false };
    },
    sessionSwitch: async (msg) => {
      const m = msg as Extract<
        ParentToHelperMessage,
        { kind: "sessionSwitch" }
      >;
      const st = state!;
      const result = await st.runtime.switchSession(m.sessionPath);
      if (!result?.cancelled) await rebindSession(st);
      return result ?? { cancelled: false };
    },
    sessionFork: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "sessionFork" }>;
      const st = state!;
      const session = st.runtime.session as AgentSession;
      const entryId = m.entryId ?? session.sessionManager.getLeafId();
      const result = await st.runtime.fork(entryId);
      if (!result?.cancelled) await rebindSession(st);
      return {
        cancelled: result?.cancelled ?? false,
        text: result?.selectedText,
      };
    },
    sessionClone: async () => {
      const st = state!;
      const session = st.runtime.session as AgentSession;
      const leafId = session.sessionManager.getLeafId();
      if (!leafId)
        throw new Error("Cannot clone session: no current entry selected");
      const result = await st.runtime.fork(leafId, { position: "at" });
      if (!result?.cancelled) await rebindSession(st);
      return { cancelled: result?.cancelled ?? false };
    },
    compact: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "compact" }>;
      return await requireSession().compact(m.customInstructions);
    },
    exportHtml: async (msg) => {
      const m = msg as Extract<ParentToHelperMessage, { kind: "exportHtml" }>;
      const path = await requireSession().exportToHtml(m.outputPath);
      return { path };
    },
    reloadModelConfig: async () => {
      // Swap in a fresh ModelRuntime so models.json edits reach idle helpers.
      const Sdk = await loadSdk();
      const st = state!;
      const previous = st.modelRuntime;
      const next = await Sdk.ModelRuntime.create();
      st.modelRuntime = next;
      // The old runtime is dropped; sessions keep running on the SDK snapshot.
      void previous;
      return { ok: true };
    },
  };
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) {
    process.exit(0);
  }
  shuttingDown = true;
  try {
    await requireSession().abort();
  } catch {
    // Nothing running or already disposed.
  }
  for (const unsubscribe of unsubscribers.splice(0)) {
    try {
      unsubscribe();
    } catch {
      // Already detached.
    }
  }
  try {
    await state?.runtime?.dispose();
  } catch (err) {
    postLog(
      "warn",
      `dispose failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  post({ kind: "bye" });
  // Give the pipe a moment to flush before the process disappears.
  setTimeout(() => process.exit(0), 50);
}

process.on("SIGTERM", () => {
  void gracefulShutdown();
});

process.on("uncaughtException", (err) => {
  postLog("error", `uncaught exception: ${err?.stack ?? String(err)}`);
  if (!state) process.exit(1);
});

// ─── Message loop ───────────────────────────────────────────────────────────

const COMMAND_NAMES: Record<string, string> = {
  prompt: "prompt",
  steer: "steer",
  followUp: "follow_up",
  abort: "abort",
  bash: "bash",
  abortBash: "abort_bash",
  setModel: "set_model",
  cycleModel: "cycle_model",
  setThinkingLevel: "set_thinking_level",
  cycleThinkingLevel: "cycle_thinking_level",
  sessionState: "get_state",
  sessionMessages: "get_messages",
  sessionStats: "get_session_stats",
  listCommands: "get_commands",
  getForkMessages: "get_fork_messages",
  setSessionName: "set_session_name",
  sessionNew: "new_session",
  sessionSwitch: "switch_session",
  sessionFork: "fork",
  sessionClone: "clone",
  compact: "compact",
  exportHtml: "export_html",
  reloadModelConfig: "reload_model_config",
  listModels: "get_available_models",
};

const handlers = buildHandlers();

function dispatchUiResponse(payload: Record<string, unknown>): void {
  const responseId = payload.responseId;
  if (typeof responseId !== "string") return;
  const resolver = uiResponseResolvers.get(responseId);
  if (!resolver) return;
  uiResponseResolvers.delete(responseId);
  const rest: Record<string, unknown> = { ...payload };
  delete rest.responseId;
  resolver(rest);
}

/**
 * Worker modes. One utility process kind, two personalities: the first message
 * decides whether this helper hosts a session runtime or the admin runtime
 * (package management). A helper never switches modes afterwards.
 */
type WorkerMode = "undecided" | "session" | "admin";
let workerMode: WorkerMode = "undecided";

async function handleMessage(value: unknown): Promise<void> {
  if (workerMode === "undecided") {
    const probe = value as { kind?: unknown } | null;
    workerMode = probe && probe.kind === "admin-init" ? "admin" : "session";
  }
  if (workerMode === "admin") {
    await handleAdminMessage(value);
    return;
  }

  const msg = parseParentToHelper(value);
  if (!msg) {
    postLog("warn", "dropped malformed parent message");
    return;
  }
  if (msg.kind === "init") {
    try {
      await initialize(msg);
      post({ kind: "response", id: "init", command: "init", success: true });
    } catch (err) {
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      post({ kind: "fatal", message });
      setTimeout(() => process.exit(1), 50);
    }
    return;
  }
  if (msg.kind === "extensionUiResponse") {
    dispatchUiResponse({ responseId: msg.responseId, ...msg.payload });
    return;
  }
  if (msg.kind === "shutdown") {
    await gracefulShutdown();
    return;
  }
  const handler = handlers[msg.kind];
  if (!handler) {
    postLog("warn", `no handler for ${msg.kind}`);
    return;
  }
  const command = COMMAND_NAMES[msg.kind] ?? msg.kind;
  try {
    const result = await handler(msg);
    // prompt resolves through its preflight hook instead.
    if (result !== "deferred") {
      postResponse((msg as { id: string }).id, command, result);
    }
  } catch (err) {
    postError((msg as { id: string }).id, command, err);
  }
}

parentPort!.on("message", (event) => {
  void handleMessage(event?.data).catch((err) => {
    postLog(
      "error",
      `message dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
});
parentPort!.start();

// The session parent waits for this handshake before sending init. It must be
// emitted before the first parent message is handled; otherwise the manager
// waits until its startup timeout and the helper never reaches initialize().
// The shared worker is also used by the package-admin parent, so select the
// matching frame to keep the other protocol parser from logging a false error.
// The SDK version is reported by the main-process diagnostics path; the worker
// only needs a protocol-valid string at this phase.
const readyKind =
  process.env.PI_DESKTOP_HELPER_MODE === "admin" ? "adminReady" : "ready";
post({
  kind: readyKind,
  protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
  sdkVersion: "unknown",
  pid: process.pid,
});

// ─── Admin mode (package management) ────────────────────────────────────────
//
// The admin helper runs the SDK package manager so neither the Electron main
// process nor session helpers have to. It holds no session and never loads
// extensions beyond Pi's own defaults. Credentials stay with Pi's own config
// files; the desktop has no login surface.

interface AdminState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packageManager: any | null; // DefaultPackageManager (lazy)
  agentDir: string;
  cwd: string;
}

let adminState: AdminState | null = null;

function toolAvailable(command: string, args: string[]): boolean {
  try {
    const { spawnSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:child_process") as typeof import("node:child_process");
    const probe = spawnSync(command, args, {
      encoding: "utf-8",
      timeout: 10_000,
      shell: process.platform === "win32",
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function npmAvailable(): boolean {
  return toolAvailable("npm", ["--version"]);
}

function gitAvailable(): boolean {
  return toolAvailable("git", ["--version"]);
}

function adminError(id: string, command: string, error: unknown): void {
  postError(id, command, error);
}

async function handleAdminMessage(value: unknown): Promise<void> {
  const msg = parseParentToAdminHelper(value);
  if (!msg) {
    postLog("warn", "dropped malformed admin message");
    return;
  }
  if (msg.kind === "admin-init") {
    try {
      await loadSdk();
      process.env.PI_CODING_AGENT = "true";
      process.env.AI_AGENT = "pi";
      process.title = "pi-desktop-embedded-admin";
      try {
        process.chdir(msg.cwd);
      } catch {
        // cwd may have vanished; package ops still work against agentDir.
      }
      adminState = {
        packageManager: null,
        agentDir: msg.agentDir,
        cwd: msg.cwd,
      };
      post({
        kind: "adminResponse",
        id: "admin-init",
        command: "admin-init",
        success: true,
      });
    } catch (err) {
      post({
        kind: "fatal",
        message:
          err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      setTimeout(() => process.exit(1), 50);
    }
    return;
  }
  if (msg.kind === "adminShutdown") {
    post({ kind: "bye" });
    setTimeout(() => process.exit(0), 50);
    return;
  }

  const command = msg.kind;
  try {
    let result: unknown;
    switch (msg.kind) {
      case "adminPackageInstall":
      case "adminPackageRemove":
      case "adminPackageUpdate": {
        const st = adminState!;
        const needsNpm = npmAvailable();
        const needsGit = /^git:/.test(
          "source" in msg &&
            typeof (msg as { source?: unknown }).source === "string"
            ? (msg as { source: string }).source
            : "",
        );
        if (!needsNpm || (needsGit && !gitAvailable())) {
          throw new Error(
            "可选包管理功能需要对应的构建工具：安装/更新需要 npm" +
              (needsGit ? "，git 源还需要 git" : "") +
              "。未找到时基本聊天能力不受影响。",
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const packageManager: any = await ensurePackageManager(st);
        packageManager.setProgressCallback((event: Record<string, unknown>) => {
          const sanitized = toTransferable(event);
          if (sanitized)
            post({
              kind: "adminPackageProgress",
              id: (msg as { id: string }).id,
              event: sanitized,
            });
        });
        if (msg.kind === "adminPackageInstall") {
          await packageManager.installAndPersist(
            (msg as { source: string }).source,
          );
          result = { ok: true };
        } else if (msg.kind === "adminPackageRemove") {
          await packageManager.removeAndPersist(
            (msg as { source: string }).source,
          );
          result = { ok: true };
        } else {
          await packageManager.update((msg as { source?: string }).source);
          result = { ok: true };
        }
        break;
      }
      case "adminPackagesConfigured": {
        const st = adminState!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const packageManager: any = await ensurePackageManager(st);
        result = { packages: packageManager.listConfiguredPackages() };
        break;
      }
      case "adminNpmAvailable": {
        result = { npm: npmAvailable(), git: gitAvailable() };
        break;
      }
      case "adminDiscoverModels": {
        result = await discoverProviderModels(msg.configPath, msg.providerId);
        break;
      }
      default:
        return;
    }
    post({
      kind: "adminResponse",
      id: (msg as { id: string }).id,
      command,
      success: true,
      ...(result !== undefined ? { data: toTransferable(result) } : {}),
    });
  } catch (err) {
    adminError((msg as { id: string }).id, command, err);
  }
}

async function ensurePackageManager(st: AdminState): Promise<unknown> {
  if (st.packageManager) return st.packageManager;
  const Sdk = await loadSdk();
  const settingsManager = await Sdk.SettingsManager.create(st.cwd, st.agentDir);
  st.packageManager = new Sdk.DefaultPackageManager({
    cwd: st.cwd,
    agentDir: st.agentDir,
    settingsManager,
  });
  return st.packageManager;
}

/**
 * Discover one provider's model list over its /models endpoint (admin mode).
 *
 * The provider is loaded from the GUI-owned TEMPORARY models config at
 * `configPath`, so Pi's own models.json value resolution (`$ENV`/`!cmd`
 * references), auth.json, and environment all apply without the desktop ever
 * seeing a resolved credential: the draft API key travels via the temp file,
 * never the protocol, and the resolved key is used only to build request
 * headers. Errors and responses carry model ids/names only — no keys, no
 * response bodies.
 */
async function discoverProviderModels(
  configPath: string,
  providerId: string,
): Promise<{ models: Array<{ id: string; name?: string }> }> {
  const Sdk = await loadSdk();
  const st = adminState!;
  const runtime = await Sdk.ModelRuntime.create({
    authPath: join(st.agentDir, "auth.json"),
    modelsPath: configPath,
    // allowModelNetwork defaults to false: discovery performs its own single
    // HTTP call and no catalog refresh happens at create time.
  });

  // The composed Provider carries baseUrl/headers but not the API family, so
  // the api comes from the temp config we wrote ourselves.
  const rawConfig = JSON.parse(await readFile(configPath, "utf-8")) as {
    providers?: Record<string, { api?: unknown; headers?: unknown }>;
  };
  const providerEntry = rawConfig.providers?.[providerId];
  const api = providerEntry?.api;
  if (!providerEntry || typeof api !== "string" || !isDiscoverableApi(api)) {
    throw new Error(
      `不支持自动发现：API 类型“${typeof api === "string" ? api : "未知"}”不在支持列表中`,
    );
  }

  const provider = runtime.getProvider(providerId);
  const baseUrl = provider?.baseUrl ?? "";
  const endpoint = buildModelsEndpoint(baseUrl, api);
  if (!endpoint) {
    throw new Error("提供商 Base URL 缺失或不是有效的 http(s) 地址");
  }

  // Resolve the credential through Pi (auth.json + env + models.json value
  // resolution). An unresolvable key is not fatal: some providers are local
  // or keyless — the request just goes out without auth headers.
  let apiKey: string | null = null;
  try {
    const auth = await runtime.getAuth(providerId);
    if (auth?.auth?.apiKey) apiKey = auth.auth.apiKey;
  } catch {
    // Unconfigured provider — proceed without auth.
  }

  const extraHeaders: Record<string, string> = {};
  const configHeaders = providerEntry.headers;
  if (typeof configHeaders === "object" && configHeaders !== null) {
    for (const [key, value] of Object.entries(
      configHeaders as Record<string, unknown>,
    )) {
      if (typeof value === "string") extraHeaders[key] = value;
    }
  }
  const headers = {
    ...extraHeaders,
    ...buildDiscoveryRequestHeaders(api, apiKey),
  };
  const query = buildDiscoveryQuery(api);
  for (const [key, value] of Object.entries(query)) {
    endpoint.searchParams.set(key, value);
  }

  const response = await fetchWithAuthRedirectGuard(
    fetch,
    endpoint.toString(),
    headers,
    { timeoutMs: 25_000 },
  );
  if (!response.ok) {
    throw new Error(`模型列表请求失败：HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > DISCOVERY_MAX_BODY_BYTES) {
    throw new Error("模型列表响应过大");
  }
  const text = await response.text();
  if (text.length > DISCOVERY_MAX_BODY_BYTES) {
    throw new Error("模型列表响应过大");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("模型列表响应不是有效 JSON");
  }
  const parsed = parseModelsListResponse(payload);
  if (!parsed.ok) throw new Error(parsed.error);
  return { models: parsed.models };
}
