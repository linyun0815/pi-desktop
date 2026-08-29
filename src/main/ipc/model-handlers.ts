import { IPC_CHANNELS } from "../../shared/ipc-contracts";
import { isString, secureIpcMain as ipcMain } from "./validation";
import type { IpcContext } from "./context";
import type { ProtocolThinkingLevel } from "../../shared/embedded-agent-protocol";

export function registerModelHandlers(ctx: IpcContext): void {
  const { getActivePi } = ctx;

  // ─── Model Management ───────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.MODEL_SET,
    async (_event, provider: unknown, modelId: unknown) => {
      if (!isString(provider)) throw new Error("provider must be a string");
      if (!isString(modelId)) throw new Error("modelId must be a string");
      return getActivePi().setModel(provider, modelId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MODEL_CYCLE, async () => {
    return getActivePi().cycleModel();
  });

  ipcMain.handle(IPC_CHANNELS.MODEL_LIST_AVAILABLE, async () => {
    return getActivePi().listModels();
  });

  ipcMain.handle(
    IPC_CHANNELS.THINKING_SET_LEVEL,
    async (_event, level: unknown) => {
      if (!isString(level)) throw new Error("level must be a string");
      return getActivePi().setThinkingLevel(level as ProtocolThinkingLevel);
    },
  );

  ipcMain.handle(IPC_CHANNELS.THINKING_CYCLE_LEVEL, async () => {
    return getActivePi().cycleThinkingLevel();
  });
}
