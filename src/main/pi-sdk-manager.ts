import { app, utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { join, sep } from "path";
import type {
  PiProcessStatus,
  PiResponseEvent,
  PiRpcEvent,
  PiStartOptions,
  PiStatus,
  PromptImage,
} from "../shared/ipc-contracts";
import {
  EMBEDDED_AGENT_PROTOCOL_VERSION,
  parseHelperToParent,
  type HelperInitMessage,
  type ProtocolThinkingLevel,
  type SessionTarget,
} from "../shared/embedded-agent-protocol";
import { appLog } from "./app-log";
import { getGuiDataPath } from "./app-data-paths";
import { getPiAgentDir } from "./pi-paths";
import { FORCE_KILL_TIMEOUT_MS, killProcessTree } from "./process-tree";

/**
 * Manages one embedded Pi SDK helper (utility process) per session runtime.
 * Replaces the old PiRpcManager: instead of spawning the Pi CLI and speaking
 * JSONL RPC over stdin/stdout, it forks `out/main/embedded-pi-worker.js` via
 * Electron's utilityProcess and drives the versioned protocol in
 * `shared/embedded-agent-protocol.ts`.
 *
 * Responsibilities (mirrors the old manager's public surface so the event
 * router, workspace manager and handlers keep their wiring):
 * - Fork/kill the helper; startup readiness via the helper's `ready` frame
 *   followed by the correlated `init` response and first `sessionBound`.
 * - Route helper events to subscribers (same `event` / `status-change` /
 *   `exit` emissions as before).
 * - Correlate request/response with per-command timeouts.
 * - Extension-UI requests surface as ordinary `extension_ui_request` events;
 *   answers go back through `sendExtensionUiResponse`.
 * - Graceful shutdown first (abort -> dispose -> bye), then PID-tree cleanup.
 */

const SPAWN_STARTUP_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
/** Long-running operations the user waits on deliberately. */
const RESPONSE_TIMEOUTS_MS: Record<string, number> = {
  prompt: 60_000,
  bash: 600_000,
  compact: 600_000,
  exportHtml: 300_000,
  sessionMessages: 60_000,
  sessionState: 30_000,
};
/** Node floor for the embedded SDK (build gate re-checks it at package time). */
export const MIN_HELPER_NODE_VERSION = "22.19.0";
/** Keep enough stderr/stdout for diagnostics without retaining a full log. */
export const HELPER_MAX_PIPE_BYTES = 2 * 1024 * 1024;

export function appendBoundedTail(
  current: string,
  incoming: string,
  maxBytes = HELPER_MAX_PIPE_BYTES,
): string {
  const combined = Buffer.from(current + incoming, "utf8");
  if (combined.byteLength <= maxBytes) return combined.toString("utf8");
  return combined.subarray(combined.byteLength - maxBytes).toString("utf8");
}

/**
 * Writable temp directory for the helper on Windows only. Prefer the GUI data
 * dir so extensions (pi-subagents, etc.) don't depend on a locked %TEMP% tree.
 */
function resolveHelperTempDir(): string {
  try {
    const dir = getGuiDataPath("tmp");
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    const dir = join(home, ".pi", "tmp");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Last resort: leave system TEMP as-is.
    }
    return dir;
  }
}

/** Windows-only TEMP/TMP override for the helper. Empty on other OSes. */
function buildHelperTempEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return {};
  const tmp = resolveHelperTempDir();
  return { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

/**
 * Best-effort wipe of the GUI-owned helper temp dir (Windows). Called on app
 * quit so extension scratch does not grow without bound.
 */
export function cleanupHelperTempDir(): void {
  if (process.platform !== "win32") return;
  try {
    const dir = getGuiDataPath("tmp");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
      } catch {
        // In use or locked — leave for next quit.
      }
    }
  } catch {
    // Ignore — quit path must not throw.
  }
}

/**
 * The built worker entry. Dev builds and packaged builds both emit it next to
 * the main entry (`out/main/`); packaging unpacks it beside app.asar because
 * utility processes must load the module from a real path.
 */
export function resolveEmbeddedWorkerPath(): string {
  const direct = join(__dirname, "embedded-pi-worker.js");
  if (existsSync(direct)) return direct;
  const unpacked = direct
    .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    .replace("app.asar/", "app.asar.unpacked/");
  if (existsSync(unpacked)) return unpacked;
  return direct;
}

let cachedSdkVersion: string | null = null;

/**
 * The installed Pi SDK's version, read from its package.json on disk (the
 * SDK's exports map blocks require of that subpath). Cached; 'unknown' when
 * unreadable.
 */
export function getEmbeddedPiSdkVersion(): string {
  if (cachedSdkVersion !== null) return cachedSdkVersion;
  try {
    // app.getAppPath() is the project root in dev and app.asar when packaged;
    // Electron's fs hooks read package.json through the archive either way.
    const candidate = join(
      app.getAppPath(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: string;
    };
    cachedSdkVersion = pkg.version ?? "unknown";
  } catch {
    cachedSdkVersion = "unknown";
  }
  return cachedSdkVersion;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

interface PendingResponse {
  command: string;
  resolve: (event: PiResponseEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Readiness =
  | { kind: "ready" }
  | { kind: "fatal"; message: string }
  | { kind: "crashed"; reason: string }
  | { kind: "timeout" }
  | { kind: "aborted" };

export class PiSdkManager extends EventEmitter {
  private child: UtilityProcess | null = null;
  private status: PiProcessStatus = "stopped";
  private pipeTail = "";
  private pendingResponses = new Map<string, PendingResponse>();
  private nextRequestId = 1;
  private startInFlight: Promise<PiStatus> | null = null;
  private startOptions: PiStartOptions | null = null;
  private readonly exitWaiters = new Map<UtilityProcess, Set<() => void>>();
  // Set while an awaitReady() is pending; settled by ready/fatal/exit.
  private settleStartup: ((outcome: Readiness) => void) | null = null;
  private settleInit:
    | ((result: { ok: boolean; error?: string }) => void)
    | null = null;
  private sessionBoundPending: (() => void) | null = null;

  sessionPath: string | null = null;
  sessionId: string | null = null;
  sessionName: string | null = null;

  getStatus(): PiStatus {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      // Only report a captured pipe tail as an error when we're actually in
      // the 'error' state — helper log lines while running are informational.
      error: this.status === "error" ? this.pipeTail || null : null,
    };
  }

  /** The live runtime is always Pi in the embedded architecture. */
  getEngineKind(): "pi" {
    return "pi";
  }

  async start(options: PiStartOptions = {}): Promise<PiStatus> {
    if (this.status === "running") return this.getStatus();
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.doStart(options).finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async doStart(options: PiStartOptions): Promise<PiStatus> {
    this.teardown();
    this.setStatus("starting");
    this.pipeTail = "";
    this.startOptions = options;
    this.sessionPath = options.sessionPath ?? null;
    this.sessionId = null;
    this.sessionName = null;

    const preflight = this.preflight();
    if (preflight) {
      this.pipeTail = preflight;
      this.setStatus("error");
      console.error("[PiSDK] Pre-flight failed:", preflight);
      appLog.error("pi-sdk", "Pre-flight failed", preflight);
      return this.getStatus();
    }

    const workerPath = resolveEmbeddedWorkerPath();
    const serviceName = `pi-desktop-agent-${Date.now().toString(36)}`;
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(workerPath, [], {
        serviceName,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...buildHelperTempEnv(),
          ...(options.env ?? {}),
          // The shared worker also serves the package-admin helper; keep its
          // startup handshake unambiguous for the selected parent.
          PI_DESKTOP_HELPER_MODE: "session",
        },
      });
    } catch (err) {
      this.pipeTail = appendBoundedTail(
        this.pipeTail,
        (err instanceof Error ? err.message : String(err)) + "\n",
      );
      this.setStatus("error");
      return this.getStatus();
    }

    this.child = child;
    this.attachChild(child);

    // Phase 1: wait for the helper's ready frame (SDK import + process boot).
    const readiness = await this.awaitReady(SPAWN_STARTUP_TIMEOUT_MS);
    if (readiness.kind === "aborted") return this.getStatus();
    // A deliberate stop()/teardown() during startup already resolved the
    // status; report it without stamping an error over the initiator's choice.
    if (this.status !== "starting") return this.getStatus();
    if (readiness.kind !== "ready") {
      const reason =
        readiness.kind === "fatal"
          ? readiness.message
          : readiness.kind === "timeout"
            ? `内嵌 Pi helper 在 ${SPAWN_STARTUP_TIMEOUT_MS / 1000} 秒内没有就绪。`
            : readiness.reason;
      this.fail(reason);
      return this.getStatus();
    }

    // Phase 2: initialize the runtime and wait for the first session binding.
    const initMessage = this.buildInitMessage(options);
    const initOutcome = await new Promise<{ ok: boolean; error?: string }>(
      (resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `helper init timed out after ${INIT_TIMEOUT_MS}ms`,
            }),
          INIT_TIMEOUT_MS,
        );
        timer.unref?.();
        this.settleInit = (result) => {
          clearTimeout(timer);
          this.settleInit = null;
          resolve(result);
        };
        this.send(initMessage);
      },
    );
    if (this.status !== "starting") return this.getStatus();
    if (!initOutcome.ok) {
      this.fail(initOutcome.error ?? "helper init failed");
      return this.getStatus();
    }
    // sessionBound usually rides with the init response; give it a short
    // grace window but never block readiness on a sessionless edge case.
    if (!this.sessionId && this.sessionPath === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        this.sessionBoundPending = () => {
          if (settled) return;
          settled = true;
          this.sessionBoundPending = null;
          resolve();
        };
        setTimeout(() => {
          if (settled) return;
          settled = true;
          this.sessionBoundPending = null;
          resolve();
        }, 5_000);
      });
    }

    if (this.status === "starting") {
      console.log(
        "[PiSDK] Helper ready:",
        this.child?.pid,
        "session:",
        this.sessionPath,
      );
      this.setStatus("running");
    }
    return this.getStatus();
  }

  private preflight(): string | null {
    const nodeVersion = process.versions.node;
    if (compareVersions(nodeVersion, MIN_HELPER_NODE_VERSION) < 0) {
      return (
        `内嵌 Pi SDK 需要 Electron 内置 Node >= ${MIN_HELPER_NODE_VERSION}，` +
        `当前为 ${nodeVersion}。请升级 Electron。`
      );
    }
    const workerPath = resolveEmbeddedWorkerPath();
    if (!existsSync(workerPath)) {
      return `内嵌 Pi helper 入口不存在：\n  ${workerPath}`;
    }
    const cwd = this.startOptions?.cwd;
    if (cwd) {
      try {
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
          return `Pi 工作目录不存在或不是目录：\n  ${cwd}`;
        }
      } catch {
        return `Pi 工作目录不存在或不是目录：\n  ${cwd}`;
      }
    }
    return null;
  }

  private buildInitMessage(options: PiStartOptions): HelperInitMessage {
    const session: SessionTarget = options.noSession
      ? { kind: "inMemory" }
      : options.forkSessionPath
        ? { kind: "fork", sourcePath: options.forkSessionPath }
        : options.sessionPath
          ? { kind: "open", sessionPath: options.sessionPath }
          : options.continueSession
            ? { kind: "continue" }
            : { kind: "new" };
    return {
      kind: "init",
      protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
      cwd: options.cwd ?? process.cwd(),
      agentDir: getPiAgentDir(),
      projectTrusted: options.projectTrusted === true,
      session,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { modelId: options.model } : {}),
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools }
        : {}),
      ...(options.permissionMode
        ? { permissionMode: options.permissionMode }
        : {}),
      ...(options.permissionRulesPath
        ? { permissionRulesPath: options.permissionRulesPath }
        : {}),
      ...(options.agentLabel ? { agentLabel: options.agentLabel } : {}),
      ...(options.extensionPaths && options.extensionPaths.length > 0
        ? { extensionPaths: options.extensionPaths }
        : {}),
    };
  }

  private attachChild(child: UtilityProcess): void {
    child.on("message", (value: unknown) => {
      try {
        this.handleHelperMessage(value);
      } catch (err) {
        appLog.error("pi-sdk", "helper message handling failed", err);
      }
    });
    const capture = (chunk: unknown): void => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8");
      this.pipeTail = appendBoundedTail(this.pipeTail, text);
      console.log("[PiSDK HELPER]:", text.slice(0, 200));
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("exit", (code) => {
      this.handleExit(code);
    });
  }

  private awaitReady(timeoutMs: number): Promise<Readiness> {
    return new Promise<Readiness>((resolve) => {
      let settled = false;
      const finish = (outcome: Readiness): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.settleStartup = null;
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      this.settleStartup = finish;
    });
  }

  private handleHelperMessage(value: unknown): void {
    const msg = parseHelperToParent(value);
    if (!msg) {
      appLog.warn("pi-sdk", "dropped malformed helper message");
      return;
    }
    switch (msg.kind) {
      case "ready":
        // Protocol negotiation is implicit: a mismatched worker fails init.
        this.settleStartup?.({ kind: "ready" });
        return;
      case "fatal":
        this.settleStartup?.({ kind: "fatal", message: msg.message });
        if (this.status === "starting") {
          this.pipeTail = appendBoundedTail(this.pipeTail, msg.message + "\n");
        }
        return;
      case "response":
        this.handleResponse(msg.id, {
          type: "response",
          command: msg.command,
          success: msg.success,
          ...(msg.data !== undefined ? { data: msg.data } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        });
        return;
      case "event":
        this.emit("event", msg.event);
        this.emit(msg.event.type, msg.event);
        return;
      case "uiRequest":
        // Extension-UI requests ride the ordinary event stream so the router
        // and renderer dialogs keep their existing wiring.
        {
          // SAFETY: `uiRequest` has already been validated as a plain request
          // with an id; the renderer event contract intentionally adds only
          // the discriminating type field here.
          const event = {
            ...msg.request,
            type: "extension_ui_request",
          } as unknown as PiRpcEvent;
          this.emit("event", event);
          this.emit("extension_ui_request", event);
        }
        return;
      case "sessionBound":
        this.sessionPath = msg.sessionFile ?? this.sessionPath;
        this.sessionId = msg.sessionId ?? this.sessionId;
        this.sessionName = msg.sessionName ?? this.sessionName;
        this.sessionBoundPending?.();
        this.emit("session-bound", {
          sessionPath: this.sessionPath,
          sessionId: this.sessionId,
          sessionName: this.sessionName,
        });
        return;
      case "log":
        if (msg.level === "error") appLog.error("pi-sdk", msg.message);
        else if (msg.level === "warn") appLog.warn("pi-sdk", msg.message);
        else appLog.info("pi-sdk", msg.message);
        return;
      case "bye":
        // Exit event is authoritative; nothing to do here.
        return;
    }
  }

  private handleResponse(id: string, response: PiResponseEvent): void {
    if (id === "init") {
      const settle = this.settleInit;
      this.settleInit = null;
      settle?.(
        response.success
          ? { ok: true }
          : { ok: false, error: response.error ?? "helper init failed" },
      );
      return;
    }
    const pending = this.pendingResponses.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingResponses.delete(id);
    pending.resolve(response);
  }

  private handleExit(code: number | undefined): void {
    const wasStarting = this.status === "starting";
    const child = this.child;
    this.child = null;
    if (child) this.settleExitWaiters(child);

    if (this.status === "running" || this.status === "starting") {
      this.setStatus("stopped");
      if (!wasStarting) this.emit("exit", { code });
    }
    // A startup-phase exit is settled as a crash so doStart can report it.
    this.settleStartup?.({
      kind: "crashed",
      reason: `helper exited with code ${code ?? "null"}`,
    });
    this.settleInit?.({
      ok: false,
      error: `helper exited with code ${code ?? "null"} during init`,
    });
    this.sessionBoundPending?.();
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi helper exited"));
    }
    this.pendingResponses.clear();
  }

  private fail(reason: string): void {
    const child = this.child;
    if (child?.pid) killProcessTree(child.pid);
    this.teardown();
    this.pipeTail = appendBoundedTail(this.pipeTail, reason + "\n");
    this.setStatus("error");
  }

  /**
   * Detach listeners and clear transient state, killing the previous helper.
   * Restart and pre-start cleanup both mean "this child must not outlive the
   * runtime": two helpers appending to one session JSONL corrupt it.
   */
  private teardown(): void {
    const child = this.child;
    if (child) {
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      this.settleExitWaiters(child);
      // Unconditional tree kill: a graceful shutdown was either already in
      // flight (stop()) or is not wanted (restart). Killing an already-dead
      // pid is the success case and must not throw.
      if (child.pid) killProcessTree(child.pid);
    }
    this.child = null;
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi helper stopped"));
    }
    this.pendingResponses.clear();
    this.settleStartup?.({ kind: "aborted" });
    this.settleInit?.({ ok: false, error: "stopped" });
    this.sessionBoundPending?.();
  }

  private settleExitWaiters(child: UtilityProcess): void {
    const waiters = this.exitWaiters.get(child);
    if (!waiters) return;
    this.exitWaiters.delete(child);
    for (const waiter of waiters) waiter();
  }

  stop(): void {
    const child = this.child;
    if (!child) {
      if (this.status !== "starting") this.setStatus("stopped");
      return;
    }
    const pid = child.pid;
    // Flip to stopped synchronously: UI navigation and a follow-up start()
    // must never short-circuit on a helper that is on its way out (the old
    // manager's kill() had the same synchronous guarantee).
    this.setStatus("stopped");
    // Ordered shutdown first: abort -> dispose -> bye -> exit. The helper may
    // still be mid-import (starting), in which case the message sits unread
    // and the escalation below does the work.
    try {
      this.send({ kind: "shutdown", id: `stop-${this.nextRequestId++}` });
    } catch {
      // Pipe already gone — the escalation handles cleanup.
    }
    setTimeout(() => {
      // If the helper missed its graceful window, escalate to a tree kill.
      if (this.child === child && pid) killProcessTree(pid);
    }, FORCE_KILL_TIMEOUT_MS + 1_000);
  }

  async stopAndWait(timeoutMs = FORCE_KILL_TIMEOUT_MS + 1_500): Promise<void> {
    const child = this.child;
    if (!child) {
      this.stop();
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.exitWaiters.get(child) ?? new Set<() => void>();
      waiters.add(resolve);
      this.exitWaiters.set(child, waiters);
      const timer = setTimeout(() => {
        waiters.delete(resolve);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.stop();
    });
  }

  restart(options: PiStartOptions = {}): Promise<PiStatus> {
    this.teardown();
    return this.start(options);
  }

  // ─── Wire primitives ────────────────────────────────────────────────────

  private send(message: unknown): void {
    if (!this.child) throw new Error("Pi helper is not running");
    try {
      this.child.postMessage(message);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private timeoutFor(command: string): number {
    return RESPONSE_TIMEOUTS_MS[command] ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  }

  /**
   * Send one protocol command and await its correlated response. `command` is
   * the renderer-facing command name in the response envelope.
   */
  async request(
    message: Record<string, unknown> & { kind: string },
    command: string,
  ): Promise<PiResponseEvent> {
    if (!this.child || this.status !== "running") {
      throw new Error("Pi helper is not running");
    }
    const id = `req-${this.nextRequestId++}`;
    return new Promise<PiResponseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(
          new Error(
            `Command ${command} timed out after ${this.timeoutFor(command)}ms`,
          ),
        );
      }, this.timeoutFor(command));
      this.pendingResponses.set(id, {
        command,
        resolve,
        reject,
        timer,
      });
      try {
        this.send({ ...message, id });
      } catch (err) {
        clearTimeout(timer);
        this.pendingResponses.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Typed SDK methods ──────────────────────────────────────────────────

  async prompt(
    message: string,
    options?: {
      images?: PromptImage[];
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<PiResponseEvent> {
    return this.request(
      {
        kind: "prompt",
        message,
        ...(options?.images ? { images: options.images } : {}),
        ...(options?.streamingBehavior
          ? { streamingBehavior: options.streamingBehavior }
          : {}),
      },
      "prompt",
    );
  }

  async steer(
    message: string,
    images?: PromptImage[],
  ): Promise<PiResponseEvent> {
    return this.request(
      { kind: "steer", message, ...(images ? { images } : {}) },
      "steer",
    );
  }

  async followUp(message: string): Promise<PiResponseEvent> {
    return this.request({ kind: "followUp", message }, "follow_up");
  }

  async abort(): Promise<PiResponseEvent> {
    return this.request({ kind: "abort" }, "abort");
  }

  async bash(command: string): Promise<PiResponseEvent> {
    return this.request({ kind: "bash", command }, "bash");
  }

  async abortBash(): Promise<PiResponseEvent> {
    return this.request({ kind: "abortBash" }, "abort_bash");
  }

  async setModel(provider: string, modelId: string): Promise<PiResponseEvent> {
    return this.request({ kind: "setModel", provider, modelId }, "set_model");
  }

  async cycleModel(): Promise<PiResponseEvent> {
    return this.request({ kind: "cycleModel" }, "cycle_model");
  }

  async setThinkingLevel(
    level: ProtocolThinkingLevel,
  ): Promise<PiResponseEvent> {
    return this.request(
      { kind: "setThinkingLevel", level },
      "set_thinking_level",
    );
  }

  async cycleThinkingLevel(): Promise<PiResponseEvent> {
    return this.request({ kind: "cycleThinkingLevel" }, "cycle_thinking_level");
  }

  async getState(): Promise<PiResponseEvent> {
    return this.request({ kind: "sessionState" }, "get_state");
  }

  async getMessages(): Promise<PiResponseEvent> {
    return this.request({ kind: "sessionMessages" }, "get_messages");
  }

  async listModels(): Promise<PiResponseEvent> {
    return this.request({ kind: "listModels" }, "get_available_models");
  }

  async getStats(): Promise<PiResponseEvent> {
    return this.request({ kind: "sessionStats" }, "get_session_stats");
  }

  async listCommands(): Promise<PiResponseEvent> {
    return this.request({ kind: "listCommands" }, "get_commands");
  }

  async getForkMessages(): Promise<PiResponseEvent> {
    return this.request({ kind: "getForkMessages" }, "get_fork_messages");
  }

  async setSessionName(name: string): Promise<PiResponseEvent> {
    return this.request({ kind: "setSessionName", name }, "set_session_name");
  }

  async sessionNew(): Promise<PiResponseEvent> {
    return this.request({ kind: "sessionNew" }, "new_session");
  }

  async sessionSwitch(sessionPath: string): Promise<PiResponseEvent> {
    return this.request(
      { kind: "sessionSwitch", sessionPath },
      "switch_session",
    );
  }

  async sessionFork(entryId?: string): Promise<PiResponseEvent> {
    return this.request(
      { kind: "sessionFork", ...(entryId ? { entryId } : {}) },
      "fork",
    );
  }

  async sessionClone(): Promise<PiResponseEvent> {
    return this.request({ kind: "sessionClone" }, "clone");
  }

  async compact(customInstructions?: string): Promise<PiResponseEvent> {
    return this.request(
      {
        kind: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      "compact",
    );
  }

  async exportHtml(outputPath?: string): Promise<PiResponseEvent> {
    return this.request(
      { kind: "exportHtml", ...(outputPath ? { outputPath } : {}) },
      "export_html",
    );
  }

  async reloadModelConfig(): Promise<PiResponseEvent> {
    return this.request({ kind: "reloadModelConfig" }, "reload_model_config");
  }

  /**
   * Answer an extension-UI request. Fire-and-forget, exactly like the old
   * RPC path — the helper resolves the dialog by request id.
   */
  sendExtensionUiResponse(
    responseId: string,
    response: Record<string, unknown>,
  ): void {
    if (!this.child || this.status !== "running") return;
    try {
      this.send({ kind: "extensionUiResponse", responseId, payload: response });
    } catch {
      // Helper gone mid-answer — its pending dialog died with it.
    }
  }

  private setStatus(status: PiProcessStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit("status-change", status);
    }
  }
}
