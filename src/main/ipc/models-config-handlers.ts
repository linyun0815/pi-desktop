import { secureIpcMain as ipcMain } from "./validation";
import type {
  ModelCatalogLookupRequest,
  ModelCatalogLookupResult,
  ModelDiscoveryRequest,
  ModelDiscoveryResult,
  ModelsConfig,
  ModelsReadResult,
} from "../../shared/ipc-contracts";
import { IPC_CHANNELS } from "../../shared/ipc-contracts";
import { validateModelsConfig } from "../../shared/models-config";
import { isDiscoverableApi } from "../../shared/model-discovery";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { getPiAgentDir } from "../pi-paths";
import { appLog } from "../app-log";
import { lookupModelInCatalog } from "../model-catalog";
import type { IpcContext } from "./context";

function modelsConfigPaths(): { dir: string; file: string } {
  const root = getPiAgentDir();
  return { dir: root, file: join(root, "models.json") };
}

export async function readModelsConfigFile(): Promise<ModelsReadResult> {
  const { file } = modelsConfigPaths();
  if (!existsSync(file)) return { config: { providers: {} } };
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    return {
      error: `Could not read models.json: ${err instanceof Error ? err.message : String(err)}`,
      raw: "",
    };
  }
  try {
    const parsed = JSON.parse(raw) as ModelsConfig;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.providers !== "object" ||
      parsed.providers === null ||
      Array.isArray(parsed.providers)
    ) {
      return {
        error: 'models.json is not a valid models config (missing "providers")',
        raw,
      };
    }
    return { config: parsed };
  } catch (err) {
    return {
      error: `models.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    };
  }
}

/** True for plain http/https URLs; discovery never talks to other schemes. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerModelsConfigHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    IPC_CHANNELS.MODELS_READ,
    async (): Promise<ModelsReadResult> => {
      return readModelsConfigFile();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MODELS_CATALOG_LOOKUP,
    async (
      _event,
      request: unknown,
    ): Promise<ModelCatalogLookupResult> => {
      const req = request as ModelCatalogLookupRequest | null;
      if (
        typeof req !== "object" ||
        req === null ||
        typeof req.modelId !== "string" ||
        req.modelId.trim().length === 0
      ) {
        return { ok: false, error: "缺少模型 ID" };
      }
      return lookupModelInCatalog({
        modelId: req.modelId,
        providerId:
          typeof req.providerId === "string" && req.providerId.trim().length > 0
            ? req.providerId
            : undefined,
        baseUrl:
          typeof req.baseUrl === "string" && req.baseUrl.trim().length > 0
            ? req.baseUrl
            : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MODELS_DISCOVER,
    async (_event, request: unknown): Promise<ModelDiscoveryResult> => {
      const req = request as ModelDiscoveryRequest | null;
      if (
        typeof req !== "object" ||
        req === null ||
        typeof req.providerId !== "string" ||
        req.providerId.trim().length === 0
      ) {
        return { ok: false, error: "缺少提供商 ID" };
      }
      const baseUrl =
        typeof req.baseUrl === "string" && req.baseUrl.trim().length > 0
          ? req.baseUrl
          : undefined;
      if (baseUrl && !isHttpUrl(baseUrl)) {
        return { ok: false, error: "Base URL 必须是 http(s) 地址" };
      }
      const api =
        typeof req.api === "string" && req.api.trim().length > 0
          ? req.api
          : undefined;
      if (api && !isDiscoverableApi(api)) {
        return { ok: false, error: `API 类型“${api}”不支持自动发现` };
      }
      try {
        return await discoverProviderModels(ctx, {
          providerId: req.providerId,
          baseUrl,
          api,
          apiKey:
            typeof req.apiKey === "string" && req.apiKey.length > 0
              ? req.apiKey
              : null,
        });
      } catch (err) {
        // Structured failure only; never echo request details like keys.
        appLog.warn(
          "models",
          `model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, error: "模型发现失败，请稍后重试" };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MODELS_WRITE,
    async (
      _event,
      config: unknown,
    ): Promise<{ success: boolean; error?: string }> => {
      const providers = (config as ModelsConfig | null)?.providers;
      if (
        typeof config !== "object" ||
        config === null ||
        typeof providers !== "object" ||
        providers === null ||
        Array.isArray(providers)
      ) {
        return { success: false, error: "Invalid models config" };
      }
      // Re-run the shared deep validation at the trust boundary: cost rates,
      // tiers, thinking maps, ids. Errors carry field locations only — never
      // apiKey values or raw JSON fragments.
      const validationErrors = validateModelsConfig(config as ModelsConfig);
      if (validationErrors.length > 0) {
        return { success: false, error: validationErrors.join("；") };
      }
      const { dir, file } = modelsConfigPaths();
      try {
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf-8");
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // Idle helpers pick up the new models.json immediately; a helper that is
      // mid-turn defers to its next start so saving never interrupts work.
      for (const runtime of ctx.workspaceManager.getSessionRuntimes()) {
        if (runtime.activity === "working" || runtime.activity === "needs-approval") continue;
        const manager = ctx.workspaceManager.getSessionRuntimeManager(runtime.runtimeId);
        if (!manager || manager.getStatus().status !== "running") continue;
        await manager.reloadModelConfig().catch((err) => {
          appLog.warn("models", `reloadModelConfig failed for runtime ${runtime.runtimeId}`, err);
        });
      }
      return { success: true };
    },
  );
}

/**
 * Run one provider /models discovery through the admin helper.
 *
 * The helper reads a GUI-owned TEMPORARY models.json built by merging the
 * SAVED provider entry (headers, authHeader, and other unexposed fields plus
 * its persisted key, which may be a `$ENV`/`!cmd` reference only Pi knows how
 * to resolve) with the editor draft's key/baseUrl/api. The draft key exists
 * solely inside this temp file — it never crosses the helper protocol, is
 * never logged, and the file is removed in `finally` on every path.
 * (Exported for tests.)
 */
export async function discoverProviderModels(
  ctx: IpcContext,
  request: {
    providerId: string;
    baseUrl?: string;
    api?: string;
    apiKey: string | null;
  },
): Promise<ModelDiscoveryResult> {
  const read = await readModelsConfigFile();
  const config = "config" in read ? read.config : undefined;
  const savedProvider =
    config && typeof config === "object"
      ? config.providers?.[request.providerId]
      : undefined;

  const merged: Record<string, unknown> =
    typeof savedProvider === "object" && savedProvider !== null
      ? { ...savedProvider }
      : {};
  delete merged.models; // discovery only needs provider-level fields
  if (request.baseUrl !== undefined) merged.baseUrl = request.baseUrl;
  if (request.api !== undefined) merged.api = request.api;
  // Draft key wins when supplied; null means "use the saved key as-is".
  if (request.apiKey !== null) merged.apiKey = request.apiKey;

  const tempModelsConfig: ModelsConfig = {
    providers: { [request.providerId]: merged as ModelsConfig["providers"][string] },
  };

  const tempDir = await mkdtemp(join(tmpdir(), "pi-desktop-models-"));
  const configPath = join(tempDir, "models.json");
  try {
    await writeFile(configPath, JSON.stringify(tempModelsConfig), "utf-8");
    const models = await ctx.adminManager.discoverModels(
      configPath,
      request.providerId,
    );
    return { ok: true, models };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      appLog.warn(
        "models",
        `failed to clean temp discovery config: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
