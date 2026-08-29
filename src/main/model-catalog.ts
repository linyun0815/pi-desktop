import { appLog } from "./app-log";
import {
  parseModelCatalog,
  matchModelInCatalog,
  type ModelCatalog,
} from "../shared/model-catalog";
import type {
  ModelCatalogLookupRequest,
  ModelCatalogLookupResult,
} from "../shared/ipc-contracts";

/**
 * Main-process accessor for the models.dev catalog. The document is fetched
 * once (fixed public URL — no user data, ids, or credentials ever become part
 * of a request), cached for an hour, and shared across concurrent callers via
 * one in-flight promise. Failures are structured and leave the previous cache
 * usable; nothing is persisted into user configuration.
 */

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type CatalogState = {
  catalog: ModelCatalog;
  fetchedAt: number;
};

let cache: CatalogState | null = null;
let inFlight: Promise<CatalogState> | null = null;

async function fetchCatalog(): Promise<CatalogState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CATALOG_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`models.dev 目录请求失败：HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) {
      throw new Error("models.dev 目录响应过大");
    }
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error("models.dev 目录响应过大");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("models.dev 目录返回的不是有效 JSON");
    }
    return { catalog: parseModelCatalog(json), fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the parsed catalog: cached within the TTL, shared while a fetch is
 * in flight, and refreshed past the TTL or when `force` is set. A failed
 * refresh keeps serving a stale cache when one exists.
 */
export async function getModelCatalog(force = false): Promise<ModelCatalog> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (cache && fresh && !force) return cache.catalog;
  if (inFlight) return (await inFlight).catalog;

  inFlight = fetchCatalog()
    .then((state) => {
      cache = state;
      return state;
    })
    .catch((err) => {
      appLog.warn(
        "model-catalog",
        `models.dev fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (cache) return cache; // stale-but-usable beats hard failure
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return (await inFlight).catalog;
}

/** Look one model up in the models.dev catalog. Structured result, no throw. */
export async function lookupModelInCatalog(
  request: ModelCatalogLookupRequest,
): Promise<ModelCatalogLookupResult> {
  const modelId = typeof request?.modelId === "string" ? request.modelId.trim() : "";
  if (!modelId) {
    return { ok: false, error: "缺少模型 ID" };
  }
  try {
    const catalog = await getModelCatalog(false);
    return {
      ok: true,
      match: matchModelInCatalog(catalog, {
        modelId,
        providerId: request.providerId,
        baseUrl: request.baseUrl,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: `无法获取模型目录：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
