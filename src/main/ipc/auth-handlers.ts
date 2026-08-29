import { secureIpcMain as ipcMain, isString } from "./validation";
import {
  IPC_CHANNELS,
  type AuthProvidersResult,
} from "../../shared/ipc-contracts";
import type { IpcContext } from "./context";

/**
 * Provider credential IPC for the embedded SDK.
 *
 * Secrets appear only in the renderer's temporary modal state, one relay
 * message into the admin helper, and Pi's own auth.json. They never reach the
 * app log, diagnostics, settings, or the model list.
 */
export function registerAuthHandlers(ctx: IpcContext): void {
  const { adminManager } = ctx;

  ipcMain.handle(
    IPC_CHANNELS.AUTH_LIST_PROVIDERS,
    async (): Promise<AuthProvidersResult> => {
      return { providers: await adminManager.listProviders() };
    },
  );

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async (_event, providerId: unknown) => {
    if (!isString(providerId)) throw new Error("providerId must be a string");
    const loginId = `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await adminManager.login(providerId, loginId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, canceled: /取消|cancel|abort/i.test(message) };
    } finally {
      // The flow ended either way; a stale helper-side abort controller dies.
      await adminManager.cancelLogin(loginId).catch(() => undefined);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (_event, providerId: unknown) => {
    if (!isString(providerId)) throw new Error("providerId must be a string");
    try {
      await adminManager.logout(providerId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTH_PROMPT_RESPONSE,
    async (_event, loginId: unknown, value: unknown) => {
      if (!isString(loginId)) throw new Error("loginId must be a string");
      adminManager.answerAuthPrompt(loginId, {
        value: isString(value) ? value : undefined,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.AUTH_CANCEL_LOGIN, async (_event, loginId: unknown) => {
    if (!isString(loginId)) throw new Error("loginId must be a string");
    adminManager.answerAuthPrompt(loginId, { canceled: true });
    await adminManager.cancelLogin(loginId).catch(() => undefined);
    return { ok: true };
  });
}
