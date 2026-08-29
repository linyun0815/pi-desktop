import { secureIpcMain as ipcMain } from "./validation";
import { IPC_CHANNELS, type PromptImage } from "../../shared/ipc-contracts";
import { access } from "fs/promises";
import { isString, isObject } from "./validation";
import {
  validateStartOptions,
  applyResumePreference,
  applyPermissionModeToStartOptions,
} from "./pi-start-options";
import { loadAppSettings } from "./settings";
import type { IpcContext } from "./context";

/** Structural guard for one image block crossing the prompt IPC. */
function isPromptImage(value: unknown): value is PromptImage {
  if (!isObject(value)) return false;
  return (
    value.type === "image" && isString(value.mimeType) && isString(value.data)
  );
}

/**
 * Validate prompt options strictly: reject malformed images and unknown
 * streaming behaviors instead of casting and letting the helper silently
 * drop them. Returns the narrowed options or throws with the offending path.
 */
function validatePromptOptions(options: unknown): {
  images?: PromptImage[];
  streamingBehavior?: "steer" | "followUp";
} {
  if (options === undefined || options === null) return {};
  if (!isObject(options)) throw new Error("options must be an object");
  const out: { images?: PromptImage[]; streamingBehavior?: "steer" | "followUp" } = {};
  if (options.images !== undefined) {
    if (!Array.isArray(options.images))
      throw new Error("options.images must be an array");
    options.images.forEach((image, index) => {
      if (!isPromptImage(image))
        throw new Error(
          `options.images[${index}] must be an image block (type/mimeType/data)`,
        );
    });
    out.images = options.images as PromptImage[];
  }
  if (options.streamingBehavior !== undefined) {
    if (
      options.streamingBehavior !== "steer" &&
      options.streamingBehavior !== "followUp"
    ) {
      throw new Error(
        'options.streamingBehavior must be "steer" or "followUp"',
      );
    }
    out.streamingBehavior = options.streamingBehavior;
  }
  return out;
}

export function registerPiHandlers(ctx: IpcContext): void {
  const { workspaceManager, getActivePi } = ctx;

  // ─── Pi Runtime Lifecycle ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PI_START, async (_event, options?: unknown) => {
    const opts = validateStartOptions(options);
    const settings = await loadAppSettings(workspaceManager);
    const activeWs = workspaceManager.getActiveWorkspace();
    if (!activeWs) throw new Error("No active workspace");

    // Validate cwd exists; fall back to home directory if not
    let cwd = activeWs.path;
    try {
      await access(cwd);
    } catch {
      cwd = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    }

    // Prefer explicit start options, else last model chosen in the GUI.
    const withDefaults = {
      ...opts,
      cwd,
      provider: opts.provider ?? settings.defaultProvider ?? undefined,
      model: opts.model ?? settings.defaultModel ?? undefined,
    };
    await workspaceManager.startPiForWorkspace(
      activeWs.id,
      applyPermissionModeToStartOptions(
        applyResumePreference(withDefaults, settings),
        settings,
      ),
    );
    const pi = workspaceManager.getPiManager(activeWs.id);
    if (!pi) throw new Error("Failed to create Pi manager");

    return pi.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.PI_STOP, async () => {
    const activeWs = workspaceManager.getActiveWorkspace();
    if (activeWs) {
      workspaceManager.stopPiForWorkspace(activeWs.id);
    }
    return { status: "stopped", pid: null, error: null };
  });

  ipcMain.handle(IPC_CHANNELS.PI_RESTART, async (_event, options?: unknown) => {
    const opts = validateStartOptions(options);
    const settings = await loadAppSettings(workspaceManager);
    const activeWs = workspaceManager.getActiveWorkspace();
    if (!activeWs) throw new Error("No active workspace");

    const pi = workspaceManager.getPiManager(activeWs.id);
    if (!pi) throw new Error("No Pi manager for workspace");

    // Restart the runtime, not just its process: the runtime owns the session
    // binding, and restartSessionRuntime re-applies it. Starting the manager
    // directly would drop the binding and open a blank session.
    const runtimeId = workspaceManager.runtimeIdFor(pi);
    const runtime = runtimeId
      ? workspaceManager.getSessionRuntime(runtimeId)
      : null;
    const startOptions = applyPermissionModeToStartOptions(
      applyResumePreference({ cwd: activeWs.path, ...opts }, settings),
      settings,
    );
    if (runtime) {
      const info = await workspaceManager.restartSessionRuntime(
        runtime.runtimeId,
        startOptions,
      );
      return { status: info.status, pid: info.pid, error: info.error };
    }

    pi.stop();
    return pi.start(startOptions);
  });

  ipcMain.handle(IPC_CHANNELS.PI_STATUS, async () => {
    const pi = workspaceManager.getActivePiManager();
    // No manager yet is the normal state at launch.
    if (!pi) return { status: "stopped", pid: null, error: null };
    return pi.getStatus();
  });

  // ─── Pi Commands ────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.PI_PROMPT,
    async (_event, message: unknown, options?: unknown) => {
      if (!isString(message)) throw new Error("message must be a string");
      const opts = validatePromptOptions(options);
      return getActivePi().prompt(message, opts);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_STEER,
    async (_event, message: unknown, images?: unknown) => {
      if (!isString(message)) throw new Error("message must be a string");
      let promptImages: PromptImage[] | undefined;
      if (images !== undefined) {
        if (!Array.isArray(images))
          throw new Error("images must be an array");
        images.forEach((image, index) => {
          if (!isPromptImage(image))
            throw new Error(
              `images[${index}] must be an image block (type/mimeType/data)`,
            );
        });
        promptImages = images as PromptImage[];
      }
      return getActivePi().steer(message, promptImages);
    },
  );

  ipcMain.handle(IPC_CHANNELS.PI_FOLLOW_UP, async (_event, message: unknown) => {
    if (!isString(message)) throw new Error("message must be a string");
    return getActivePi().followUp(message);
  });

  ipcMain.handle(IPC_CHANNELS.PI_ABORT, async () => {
    return getActivePi().abort();
  });

  ipcMain.handle(IPC_CHANNELS.PI_BASH, async (_event, command: unknown) => {
    if (!isString(command)) throw new Error("command must be a string");
    return getActivePi().bash(command);
  });

  ipcMain.handle(IPC_CHANNELS.PI_ABORT_BASH, async () => {
    return getActivePi().abortBash();
  });
}
