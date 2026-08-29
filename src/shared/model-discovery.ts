import type { ModelDiscoveryModel } from "./ipc-contracts";
import { MODEL_API_TYPES, type ModelApiType } from "./models-config";

/**
 * Pure helpers for provider /models discovery: endpoint construction, response
 * parsing, and an auth-header-safe redirect guard. Everything here is
 * side-effect free (the redirect guard takes a fetch implementation) so the
 * HTTP edge cases are unit-testable without a network.
 *
 * Credentials never pass through these helpers' outputs: parsing returns model
 * ids and display names only, and error strings never embed HTTP bodies.
 */

/** Hard caps so a hostile or broken provider cannot blow up the helper. */
export const DISCOVERY_MAX_MODELS = 1000;
export const DISCOVERY_MAX_REDIRECTS = 3;
/** Cap on the response body we are willing to read, in bytes. */
export const DISCOVERY_MAX_BODY_BYTES = 5 * 1024 * 1024;

export type DiscoveredModels =
  | { ok: true; models: ModelDiscoveryModel[] }
  | { ok: false; error: string };

/**
 * Build the provider's model-list endpoint from its base URL and API family.
 * Normalizes the trailing slash, inserts the API's version segment when the
 * base URL does not already end with one, and appends `/models`. Returns null
 * for anything but http/https URLs.
 */
export function buildModelsEndpoint(
  baseUrl: string,
  api: string,
): URL | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const versionByApi: Record<string, string> = {
    "openai-completions": "/v1",
    "openai-responses": "/v1",
    "anthropic-messages": "/v1",
    "google-generative-ai": "/v1beta",
  };
  const version = versionByApi[api];
  if (!version) return null;

  let path = url.pathname.replace(/\/+$/, "");
  // A base URL that already ends in a version segment (…/v1, …/v1beta) is
  // used as-is; anything else gets the API's canonical segment.
  if (!/\/v\d+[a-z]*$/.test(path)) path += version;
  url.pathname = `${path}/models`;
  url.search = "";
  url.hash = "";
  return url;
}

/** True when the string is a plausible non-empty model id. */
function isModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256
  );
}

/** Strip a provider path prefix ("models/…") some APIs include in ids. */
function stripModelPrefix(id: string): string {
  return id.replace(/^models\//, "");
}

/**
 * Parse a /models response body (already JSON-decoded). Accepts a bare array
 * or an object wrapping one under `data` / `models` / `results` / `items`.
 * Items may be plain strings or objects carrying `id` / `model` /
 * `display_name` / `name`. Output is prefix-stripped, deduplicated, sorted by
 * id, and capped at `maxModels`.
 */
export function parseModelsListResponse(
  payload: unknown,
  maxModels: number = DISCOVERY_MAX_MODELS,
): DiscoveredModels {
  let list: unknown;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (typeof payload === "object" && payload !== null) {
    const wrapper = payload as Record<string, unknown>;
    list = ["data", "models", "results", "items"]
      .map((key) => wrapper[key])
      .find((value) => Array.isArray(value));
  }
  if (!Array.isArray(list)) {
    return { ok: false, error: "模型列表响应格式无法识别" };
  }

  const seen = new Set<string>();
  const models: ModelDiscoveryModel[] = [];
  for (const item of list) {
    if (models.length >= maxModels) break;
    let id: unknown;
    let name: unknown;
    if (typeof item === "string") {
      id = item;
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      id = obj.id ?? obj.model;
      name = obj.display_name ?? obj.name;
    }
    if (!isModelId(id)) continue;
    const cleanId = stripModelPrefix(id).trim();
    if (cleanId.length === 0 || seen.has(cleanId)) continue;
    seen.add(cleanId);
    models.push(
      isModelId(name) && typeof name === "string" && name.trim().length > 0
        ? { id: cleanId, name: name.trim() }
        : { id: cleanId },
    );
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, models };
}

/**
 * Validate the admin-helper discovery response payload. The wire contract is
 * `{ models: Array<{ id: string, name?: string }> }`; anything else —
 * including payloads with extra credential-like fields — is reduced to the
 * validated model list so no unvalidated data crosses back to the parent.
 */
export function parseDiscoveredModelsPayload(
  data: unknown,
): ModelDiscoveryModel[] {
  if (typeof data !== "object" || data === null) return [];
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: ModelDiscoveryModel[] = [];
  for (const item of models) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (!isModelId(id)) continue;
    out.push(
      typeof name === "string" && name.trim().length > 0
        ? { id: id.trim(), name: name.trim() }
        : { id: id.trim() },
    );
  }
  return out;
}

export interface RedirectGuardOptions {
  maxRedirects?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
}

/**
 * Fetch a URL while guarding redirects: follows up to `maxRedirects` hops and
 * re-attaches the original headers ONLY on same-origin redirects — a redirect
 * to a different origin is followed without the auth-bearing headers so a
 * provider cannot leak credentials to a third party. Returns the response of
 * the final hop (not followed further). Body size is capped by the caller
 * reading at most `maxBodyBytes` from the returned response.
 */
export async function fetchWithAuthRedirectGuard(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  options: RedirectGuardOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DISCOVERY_MAX_REDIRECTS;
  let currentUrl = new URL(url);
  let currentHeaders = headers;

  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;

  try {
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(currentUrl, {
        headers: currentHeaders,
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      const isRedirect =
        response.status >= 300 &&
        response.status < 400 &&
        location !== null;
      if (!isRedirect || hop >= maxRedirects) return response;

      const nextUrl = new URL(location, currentUrl);
      // Same origin (scheme + host + port): keep headers. Cross origin:
      // drop every caller header — they may carry credentials.
      const sameOrigin =
        nextUrl.protocol === currentUrl.protocol &&
        nextUrl.host === currentUrl.host;
      currentHeaders = sameOrigin ? currentHeaders : {};
      currentUrl = nextUrl;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Build the per-API request headers for a /models call. */
export function buildDiscoveryRequestHeaders(
  api: ModelApiType,
  apiKey: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (api === "google-generative-ai") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  return headers;
}

/** Query parameters some providers require for their model listing. */
export function buildDiscoveryQuery(api: string): Record<string, string> {
  if (api === "anthropic-messages") return { limit: String(DISCOVERY_MAX_MODELS) };
  if (api === "google-generative-ai") return { pageSize: String(DISCOVERY_MAX_MODELS) };
  return {};
}

/** Is this API family supported by discovery? */
export function isDiscoverableApi(api: string): api is ModelApiType {
  return (MODEL_API_TYPES as readonly string[]).includes(api);
}
