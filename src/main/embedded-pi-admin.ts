import { utilityProcess, type UtilityProcess } from "electron";
import {
  EMBEDDED_AGENT_PROTOCOL_VERSION,
  parseAdminHelperToParent,
} from "../shared/embedded-agent-protocol";
import { parseDiscoveredModelsPayload } from "../shared/model-discovery";
import { appLog } from "./app-log";
import { getPiAgentDir } from "./pi-paths";
import { FORCE_KILL_TIMEOUT_MS, killProcessTree } from "./process-tree";
import { resolveEmbeddedWorkerPath } from "./pi-sdk-manager";

/**
 * Parent-side manager for the embedded Pi admin helper.
 *
 * The admin helper is a lazy utility process that performs the SDK work that
 * must not load into the Electron main process — package install/remove/
 * update and npm/git availability checks. There is at most one admin helper
 * per app run; it starts on first use and exits only with the app or an
 * explicit shutdown.
 *
 * Provider credentials are owned by Pi itself (models.json, auth.json,
 * environment); the desktop offers no login surface, so no secrets ever
 * traverse this manager.
 */

const ADMIN_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_ADMIN_TIMEOUT_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

export interface AdminPackageResult {
  success: boolean;
  output: string;
}

export interface AdminDeps {
  cwd(): string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EmbeddedPiAdminManager {
  private child: UtilityProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;

  constructor(private readonly deps: AdminDeps) {
    // Singleton registration for the quit path (shutdownEmbeddedPiAdmin).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeAdminInstance = this;
  }

  private async ensureStarted(): Promise<UtilityProcess> {
    if (this.child) return this.child;
    if (this.startPromise) {
      await this.startPromise;
      if (!this.child) throw new Error("admin helper failed to start");
      return this.child;
    }
    this.startPromise = this.doStart();
    await this.startPromise;
    if (!this.child) throw new Error("admin helper failed to start");
    return this.child;
  }

  private async doStart(): Promise<void> {
    const workerPath = resolveEmbeddedWorkerPath();
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: `pi-desktop-admin-${Date.now().toString(36)}`,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_DESKTOP_HELPER_MODE: "admin",
      },
    });
    child.on("message", (value: unknown) => this.handleMessage(value));
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) appLog.info("pi-admin", text.slice(0, 500));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) appLog.warn("pi-admin", text.slice(0, 500));
    });
    child.on("exit", (code) => {
      this.child = null;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("admin helper exited"));
      }
      this.pending.clear();
      if (code !== 0)
        appLog.warn("pi-admin", `helper exited with code ${code ?? "null"}`);
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      const id = "admin-init";
      const timer = setTimeout(
        () => reject(new Error("admin helper init timed out")),
        ADMIN_INIT_TIMEOUT_MS,
      );
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      this.send(
        {
          kind: "admin-init",
          protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
          agentDir: getPiAgentDir(),
          cwd: this.deps.cwd(),
        },
        id,
      );
    });
  }

  private handleMessage(value: unknown): void {
    const msg = parseAdminHelperToParent(value);
    if (!msg) {
      appLog.warn("pi-admin", "dropped malformed admin helper message");
      return;
    }
    switch (msg.kind) {
      case "adminResponse": {
        if (msg.id === "admin-init") {
          // The init entry resolves on success/failure with an explicit error.
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.success) pending.resolve(undefined);
            else pending.reject(new Error(msg.error ?? "admin init failed"));
          }
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.success) pending.resolve(msg.data as Record<string, unknown>);
        else
          pending.reject(
            new Error(msg.error ?? `command ${msg.command} failed`),
          );
        return;
      }
      case "adminPackageProgress":
        // Progress rides the output string on completion; keep logs light.
        appLog.info(
          "pi-admin",
          `[package ${msg.event.action}] ${msg.event.message ?? ""}`,
        );
        return;
      case "log":
        if (msg.level === "error") appLog.error("pi-admin", msg.message);
        else if (msg.level === "warn") appLog.warn("pi-admin", msg.message);
        else appLog.info("pi-admin", msg.message);
        return;
      case "bye":
        return;
      case "adminReady":
        return;
      default:
        return;
    }
  }

  private send(message: Record<string, unknown>, correlationId?: string): void {
    const child = this.child;
    if (!child) throw new Error("admin helper is not running");
    const payload = correlationId ? { ...message, id: correlationId } : message;
    child.postMessage(payload);
  }

  private request(
    message: Record<string, unknown> & { kind: string },
    command: string,
    timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `admin-req-${this.nextRequestId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...message, id }, id);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Package management ─────────────────────────────────────────────────

  async installPackage(source: string): Promise<AdminPackageResult> {
    await this.ensureStarted();
    try {
      await this.request(
        { kind: "adminPackageInstall", source },
        "package_install",
        300_000,
      );
      return { success: true, output: `已安装 ${source}` };
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async removePackage(source: string): Promise<AdminPackageResult> {
    await this.ensureStarted();
    try {
      await this.request(
        { kind: "adminPackageRemove", source },
        "package_remove",
        120_000,
      );
      return { success: true, output: `已移除 ${source}` };
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async updatePackage(source?: string): Promise<AdminPackageResult> {
    await this.ensureStarted();
    try {
      await this.request(
        { kind: "adminPackageUpdate", ...(source ? { source } : {}) },
        "package_update",
        300_000,
      );
      return {
        success: true,
        output: source ? `已更新 ${source}` : "已更新全部包",
      };
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async toolAvailability(): Promise<{ npm: boolean; git: boolean }> {
    await this.ensureStarted();
    const data = (await this.request(
      { kind: "adminNpmAvailable" },
      "tool_availability",
    )) as { npm?: boolean; git?: boolean } | undefined;
    return { npm: data?.npm === true, git: data?.git === true };
  }

  /**
   * Discover a provider's model list by having the helper load the TEMPORARY
   * models config at `configPath` and call the provider's /models endpoint.
   * The config file (and any draft key inside it) never crosses the wire —
   * only the path and provider id do. Resolves to bare { id, name? } rows.
   */
  async discoverModels(
    configPath: string,
    providerId: string,
  ): Promise<Array<{ id: string; name?: string }>> {
    await this.ensureStarted();
    const data = (await this.request(
      { kind: "adminDiscoverModels", configPath, providerId },
      "model_discovery",
      DISCOVERY_TIMEOUT_MS,
    )) as { models?: unknown } | undefined;
    // Validate the payload here too: the helper's data is untrusted until
    // narrowed, and credentials must not be able to hide inside it.
    return parseDiscoveredModelsPayload(data);
  }

  /** Stop the helper gracefully; used on app quit. */
  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      this.send({ kind: "adminShutdown" });
    } catch {
      // Already gone.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FORCE_KILL_TIMEOUT_MS);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.child === child && child.pid) killProcessTree(child.pid);
    this.child = null;
  }
}

/** The most recently constructed admin manager (the app creates exactly one). */
let activeAdminInstance: EmbeddedPiAdminManager | null = null;

/** Fire-and-forget admin helper shutdown for the app quit path. */
export async function shutdownEmbeddedPiAdmin(): Promise<void> {
  await activeAdminInstance?.shutdown().catch(() => undefined);
  activeAdminInstance = null;
}
