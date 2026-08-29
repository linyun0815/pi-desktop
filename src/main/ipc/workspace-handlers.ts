import { IPC_CHANNELS } from "../../shared/ipc-contracts";
import {
  isObject,
  isString,
  isOptionalBoolean,
  isOptionalString,
  secureIpcMain as ipcMain,
} from "./validation";
import {
  validateStartOptions,
  applyResumePreference,
  applyPermissionModeToStartOptions,
} from "./pi-start-options";
import { loadAppSettings } from "./settings";
import type { WorkspaceTabOptions, WorkspaceTrustStatus } from "../../shared/ipc-contracts";
import { isWithinSessionRoots } from "../pi-paths";
import { existsSync } from "fs";
import type { IpcContext } from "./context";
import { appLog } from "../app-log";
import { workspaceTrustStore } from "../workspace-trust";

function validateWorkspaceTabOptions(value: unknown): WorkspaceTabOptions {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error("Tab options must be an object");
  if (!isOptionalString(value.name))
    throw new Error("tab name must be a string");
  if (!isOptionalString(value.sourceWorkspaceId))
    throw new Error("sourceWorkspaceId must be a string");
  if (!isOptionalString(value.forkSessionPath))
    throw new Error("forkSessionPath must be a string");
  if (!isOptionalString(value.taskPrompt))
    throw new Error("taskPrompt must be a string");
  if (!isOptionalBoolean(value.startPi))
    throw new Error("startPi must be a boolean");

  return {
    ...(isString(value.name) ? { name: value.name } : {}),
    ...(isString(value.sourceWorkspaceId)
      ? { sourceWorkspaceId: value.sourceWorkspaceId }
      : {}),
    ...(isString(value.forkSessionPath)
      ? { forkSessionPath: value.forkSessionPath }
      : {}),
    ...(isString(value.taskPrompt) ? { taskPrompt: value.taskPrompt } : {}),
    ...(typeof value.startPi === "boolean" ? { startPi: value.startPi } : {}),
  };
}

export function registerWorkspaceHandlers(ctx: IpcContext): void {
  const { workspaceManager, notesManager } = ctx;

  // ─── Workspace Management ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    return workspaceManager.getWorkspaces();
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CREATE,
    async (_event, name: unknown, path: unknown) => {
      if (!isString(name)) throw new Error("name must be a string");
      if (!isString(path)) throw new Error("path must be a string");
      return workspaceManager.createWorkspace(name, path);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_REMOVE,
    async (_event, workspaceId: unknown) => {
      if (!isString(workspaceId))
        throw new Error("workspaceId must be a string");
      const result = await workspaceManager.removeWorkspace(workspaceId);
      // Notes scoped to the removed workspace fall back to global so they survive.
      await notesManager.reassignToGlobal(workspaceId);
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_RENAME,
    async (_event, workspaceId: unknown, name: unknown) => {
      if (!isString(workspaceId))
        throw new Error("workspaceId must be a string");
      if (!isString(name)) throw new Error("name must be a string");
      await workspaceManager.renameWorkspace(workspaceId, name);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CHANGE_PATH,
    async (_event, workspaceId: unknown, newPath: unknown) => {
      if (!isString(workspaceId))
        throw new Error("workspaceId must be a string");
      if (!isString(newPath)) throw new Error("newPath must be a string");
      await workspaceManager.changeWorkspacePath(workspaceId, newPath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_PATH_EXISTS,
    async (): Promise<boolean> => {
      return workspaceManager.activeWorkspacePathExists();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SET_ACTIVE,
    async (_event, workspaceId: unknown) => {
      if (!isString(workspaceId))
        throw new Error("workspaceId must be a string");
      return workspaceManager.setActiveWorkspace(workspaceId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_ACTIVE, async () => {
    return workspaceManager.getActiveWorkspace();
  });

  // ─── Workspace Trust ────────────────────────────────────────────────────
  //
  // One unified switch: trusting a workspace authorizes its project Pi
  // resources, its permission-rules allow entries, and its interactive HTML
  // preview. Legacy trust records surface as pendingReconfirmation until the
  // user re-confirms. Trusting (or revoking) restarts the workspace's live
  // helpers so the three capability classes take effect together.

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_TRUST_STATUS,
    async (_event, workspaceId?: unknown): Promise<WorkspaceTrustStatus> => {
      const workspace = isString(workspaceId)
        ? workspaceManager.getWorkspaces().find((item) => item.id === workspaceId)
        : workspaceManager.getActiveWorkspace();
      if (!workspace) {
        return { workspacePath: null, trusted: false, pendingReconfirmation: false };
      }
      return {
        workspacePath: workspace.path,
        ...workspaceTrustStore.status(workspace.path),
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SET_TRUST,
    async (
      _event,
      workspaceId: unknown,
      trusted: unknown,
    ): Promise<WorkspaceTrustStatus> => {
      if (typeof trusted !== "boolean")
        throw new Error("trusted must be a boolean");
      const workspace =
        workspaceManager.getWorkspaces().find((item) => item.id === workspaceId) ??
        workspaceManager.getActiveWorkspace();
      if (!workspace) throw new Error("Workspace not found");
      if (trusted) {
        await workspaceTrustStore.trust(workspace.path);
        appLog.info("workspaces", `Workspace trusted: ${workspace.path}`);
      } else {
        await workspaceTrustStore.revoke(workspace.path);
        appLog.info("workspaces", `Workspace trust revoked: ${workspace.path}`);
      }
      // The trust decision is baked into each helper's environment at start
      // (projectTrusted + PI_DESKTOP_WORKSPACE_TRUSTED), so live helpers
      // restart in both directions: confirming makes project resources,
      // allow rules, and interactive preview take effect together; revoking
      // stops an already-trusted helper from lingering with elevated trust.
      for (const runtime of workspaceManager.getSessionRuntimes(workspace.id)) {
        void workspaceManager.restartSessionRuntime(runtime.runtimeId).catch(() => undefined);
      }
      return {
        workspacePath: workspace.path,
        ...workspaceTrustStore.status(workspace.path),
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_START_PI,
    async (_event, workspaceId: unknown, options?: unknown) => {
      if (!isString(workspaceId))
        throw new Error("workspaceId must be a string");
      const opts = validateStartOptions(options);
      const settings = await loadAppSettings(workspaceManager);
      const workspace = workspaceManager
        .getWorkspaces()
        .find((w) => w.id === workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      await workspaceManager.startPiForWorkspace(
        workspaceId,
        applyPermissionModeToStartOptions(
          applyResumePreference({ cwd: workspace.path, ...opts }, settings),
          settings,
        ),
      );
      const pi = workspaceManager.getPiManager(workspaceId);
      return pi?.getStatus() ?? { status: "stopped", pid: null, error: null };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_STOP_PI,
    async (_event, workspaceId: unknown) => {
      if (!isString(workspaceId))
        throw new Error("workspaceId must be a string");
      workspaceManager.stopPiForWorkspace(workspaceId);
      return { status: "stopped", pid: null, error: null };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CREATE_TAB,
    async (_event, value: unknown) => {
      const options = validateWorkspaceTabOptions(value);
      if (options.forkSessionPath) {
        if (
          !isWithinSessionRoots(options.forkSessionPath) ||
          !existsSync(options.forkSessionPath)
        ) {
          throw new Error(
            "forkSessionPath must point to an existing Pi session file",
          );
        }
      }

      const settings = await loadAppSettings(workspaceManager);
      const workspace = await workspaceManager.createWorktreeWorkspace(options);
      // Return the new project tab immediately. Its session runtime starts in the
      // background so the tab/file contents are usable before Pi is ready. A task
      // launch may explicitly skip this default runtime to avoid two Pi processes
      // in the freshly-created worktree.
      if (options.startPi !== false)
        void workspaceManager
          .startPiForWorkspace(
            workspace.id,
            applyPermissionModeToStartOptions(
              applyResumePreference(
                {
                  cwd: workspace.path,
                  provider: settings.defaultProvider ?? undefined,
                  model: settings.defaultModel ?? undefined,
                  forkSessionPath: options.forkSessionPath,
                },
                settings,
              ),
              settings,
            ),
          )
          .catch((error) =>
            appLog.warn(
              "workspaces",
              "Background worktree Pi start failed",
              error,
            ),
          );
      return workspace;
    },
  );
}
