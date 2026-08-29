import { secureIpcMain as ipcMain } from "./validation";
import { WorkspaceManager } from "../workspace-manager";
import { getGuiDataPath } from "../app-data-paths";
import type { AppSettings } from "../../shared/ipc-contracts";
import { IPC_CHANNELS } from "../../shared/ipc-contracts";
import { DEFAULT_SETTINGS } from "../../shared/default-settings";
import { applyRunOnStartup } from "../startup-launch";
import { setTrayEnabled } from "../tray-manager";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { isObject } from "./validation";
import { appLog } from "../app-log";
import type { IpcContext } from "./context";

// ─── App Settings Persistence ────────────────────────────────────────────────

const SETTINGS_FILE_NAME = "settings.json";

/**
 * Fields removed by the embedded-SDK migration. They are ignored on read and
 * stripped on first save so the file converges on the current schema.
 */
const LEGACY_SETTING_KEYS = ["piExecutablePath", "piEngine", "defaultArgs"] as const;

function stripLegacyKeys(record: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...record };
  for (const key of LEGACY_SETTING_KEYS) delete cleaned[key];
  return cleaned;
}

/** Also consumed by the diagnostics report. */
export function getSettingsPath(): string {
  return getGuiDataPath(SETTINGS_FILE_NAME);
}

export async function loadAppSettings(
  workspaceManager: WorkspaceManager,
): Promise<AppSettings> {
  try {
    const settingsPath = getSettingsPath();
    if (existsSync(settingsPath)) {
      const data = await readFile(settingsPath, "utf-8");
      const parsed = stripLegacyKeys(JSON.parse(data) as Record<string, unknown>);
      // `merged as AppSettings` is safe for the known fields; unknown leftover
      // keys are inert and dropped on the next save.
      const merged = { ...DEFAULT_SETTINGS, ...parsed } as AppSettings;
      return merged;
    }
  } catch {
    // Fall through to defaults
  }

  return {
    ...DEFAULT_SETTINGS,
    defaultCwd:
      workspaceManager.getActiveWorkspace()?.path ??
      process.env.HOME ?? process.env.USERPROFILE ??
      process.cwd(),
  };
}

export async function saveAppSettings(
  settings: Partial<AppSettings>,
): Promise<void> {
  const settingsPath = getSettingsPath();
  const dir = join(settingsPath, "..");

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Merge with existing
  let existing: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  try {
    if (existsSync(settingsPath)) {
      const data = await readFile(settingsPath, "utf-8");
      existing = { ...DEFAULT_SETTINGS, ...stripLegacyKeys(JSON.parse(data) as Record<string, unknown>) };
    }
  } catch {
    // Use defaults
  }

  const merged = stripLegacyKeys({ ...existing, ...settings });
  try {
    await writeFile(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
  } catch (err) {
    // Still propagate to the caller (the Settings panel surfaces it); the log
    // keeps a trace for diagnostics in packaged builds.
    appLog.error("settings", "Failed to save settings.json", err);
    throw err;
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx;

  // ─── Settings ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
    return loadAppSettings(workspaceManager);
  });

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE,
    async (_event, settings: unknown) => {
      if (!isObject(settings)) throw new Error("settings must be an object");
      await saveAppSettings(settings as Partial<AppSettings>);
      // Reflect a "run on startup" change to the OS immediately (login item on
      // macOS/Windows, autostart entry on Linux). Only applied when the field is
      // part of this save to avoid redundant OS writes.
      if ("runOnStartup" in settings) {
        await applyRunOnStartup(
          Boolean((settings as Partial<AppSettings>).runOnStartup),
        );
      }
      // Reflect a "minimize to tray" change immediately: create/destroy the tray
      // icon so the close behavior matches the new setting without a restart.
      if ("minimizeToTrayOnClose" in settings) {
        setTrayEnabled(
          Boolean((settings as Partial<AppSettings>).minimizeToTrayOnClose),
        );
      }
      return loadAppSettings(workspaceManager);
    },
  );

  // Reconcile the OS-level "run on startup" state with the saved preference on
  // launch. Self-healing: repairs a stale Linux autostart Exec path after an
  // app update/move and re-asserts the login item on macOS/Windows. Runs in the
  // background so a failure never blocks handler registration.
  void loadAppSettings(workspaceManager)
    .then((settings) => applyRunOnStartup(settings.runOnStartup))
    .catch((err) =>
      console.error("[startup] Failed to reconcile run-on-startup:", err),
    );
}
