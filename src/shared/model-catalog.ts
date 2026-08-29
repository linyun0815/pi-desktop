import type {
  ModelCatalogMatch,
  ModelMetadataSuggestion,
} from "./ipc-contracts";
import type { CustomModelCost } from "./models-config";

/**
 * Pure helpers for the models.dev catalog (https://models.dev/api.json):
 * parse the raw document into a bounded, normalized shape and match a user's
 * model against it. Fetching/caching lives in src/main/model-catalog.ts.
 *
 * Catalog data is third-party content: every field is boundary-checked and
 * malformed entries are skipped, never fatal. The matcher never invents
 * prices — unreliable or conflicting prices are omitted, not guessed.
 */

/** Boundary caps on the third-party document. */
const MAX_PROVIDERS = 2000;
const MAX_MODELS_PER_PROVIDER = 2000;
const MAX_STRING = 256;
const MAX_RATE = 1_000_000; // $1M per Mtok is nonsense; reject above
const MAX_WINDOW = 1e9;

export interface CatalogModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: CustomModelCost;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  models: CatalogModel[];
}

export interface ModelCatalog {
  providers: CatalogProvider[];
  /** provider id (lowercased) -> providers, for exact matching. */
  byProviderId: Map<string, CatalogProvider[]>;
  /** base URL host -> providers, for host matching. */
  byHost: Map<string, CatalogProvider[]>;
  /** model id -> providers carrying it, for consensus matching. */
  byModelId: Map<string, Array<{ provider: CatalogProvider; model: CatalogModel }>>;
}

function boundedString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function boundedRate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  return value <= MAX_RATE ? value : undefined;
}

function boundedWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return value <= MAX_WINDOW ? Math.round(value) : undefined;
}

function parseModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value.slice(0, 8)) {
    const modality = boundedString(item, 32);
    if (modality) out.push(modality);
  }
  return out.length > 0 ? out : undefined;
}

function parseCatalogCost(value: unknown): CustomModelCost | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const c = value as Record<string, unknown>;
  const input = boundedRate(c.input);
  const output = boundedRate(c.output);
  if (input === undefined || output === undefined) return undefined;
  const cost: CustomModelCost = {
    input,
    output,
    cacheRead: boundedRate(c.cache_read) ?? 0,
    cacheWrite: boundedRate(c.cache_write) ?? 0,
  };
  return cost;
}

function parseCatalogModel(id: string, raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const model: CatalogModel = { id };
  const name = boundedString(m.name);
  if (name) model.name = name;
  if (m.reasoning === true) model.reasoning = true;
  const input = parseModalities(
    typeof m.modalities === "object" && m.modalities !== null
      ? (m.modalities as Record<string, unknown>).input
      : undefined,
  );
  if (input) model.input = input;
  const limit =
    typeof m.limit === "object" && m.limit !== null
      ? (m.limit as Record<string, unknown>)
      : undefined;
  const contextWindow = boundedWindow(limit?.context);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxTokens = boundedWindow(limit?.output);
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const cost = parseCatalogCost(m.cost);
  if (cost) model.cost = cost;
  return model;
}

/** Parse the raw models.dev api.json document; malformed entries are skipped. */
export function parseModelCatalog(raw: unknown): ModelCatalog {
  const catalog: ModelCatalog = {
    providers: [],
    byProviderId: new Map(),
    byHost: new Map(),
    byModelId: new Map(),
  };
  if (typeof raw !== "object" || raw === null) return catalog;

  let count = 0;
  for (const [providerId, rawProvider] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (count >= MAX_PROVIDERS) break;
    const id = boundedString(providerId, 128);
    if (!id || typeof rawProvider !== "object" || rawProvider === null) continue;
    const p = rawProvider as Record<string, unknown>;
    const provider: CatalogProvider = { id, models: [] };
    const name = boundedString(p.name);
    if (name) provider.name = name;
    const baseUrl = boundedString(
      typeof p.api === "string" ? p.api : p.baseUrl,
      512,
    );
    if (baseUrl && /^https?:\/\//.test(baseUrl)) provider.baseUrl = baseUrl;

    const models = p.models;
    if (typeof models === "object" && models !== null) {
      let modelCount = 0;
      for (const [modelId, rawModel] of Object.entries(
        models as Record<string, unknown>,
      )) {
        if (modelCount >= MAX_MODELS_PER_PROVIDER) break;
        const cleanId = boundedString(modelId, 256);
        if (!cleanId) continue;
        const model = parseCatalogModel(cleanId, rawModel);
        if (!model) continue;
        provider.models.push(model);
        modelCount += 1;
        const byModel = catalog.byModelId.get(cleanId) ?? [];
        byModel.push({ provider, model });
        catalog.byModelId.set(cleanId, byModel);
      }
    }

    catalog.providers.push(provider);
    count += 1;
    const byId = catalog.byProviderId.get(id.toLowerCase()) ?? [];
    byId.push(provider);
    catalog.byProviderId.set(id.toLowerCase(), byId);
    if (provider.baseUrl) {
      const host = hostOf(provider.baseUrl);
      if (host) {
        const byHost = catalog.byHost.get(host) ?? [];
        byHost.push(provider);
        catalog.byHost.set(host, byHost);
      }
    }
  }
  return catalog;
}

/** Host of an http(s) URL, lowercased; null for anything unparsable. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

export interface CatalogQuery {
  modelId: string;
  providerId?: string;
  baseUrl?: string;
}

/**
 * Match a model in the parsed catalog, in pi-web's order: exact
 * provider+model id, then provider base-URL host, then model-id consensus
 * across providers. Metadata is adopted per-field by majority vote; prices
 * only survive when every price-carrying source agrees.
 */
export function matchModelInCatalog(
  catalog: ModelCatalog,
  query: CatalogQuery,
): ModelCatalogMatch {
  const modelId = query.modelId.trim();
  const match: ModelCatalogMatch = {
    modelId,
    match: "none",
    metadata: {},
    priceReliable: false,
    warnings: [],
  };
  if (!modelId) return match;

  // 1) Exact provider + model id.
  let sources: Array<{ provider: CatalogProvider; model: CatalogModel }> = [];
  if (query.providerId) {
    const providers = catalog.byProviderId.get(query.providerId.toLowerCase());
    if (providers) {
      sources = providers
        .map((provider) => ({ provider, model: provider.models.find((m) => m.id === modelId) }))
        .filter((s): s is { provider: CatalogProvider; model: CatalogModel } => !!s.model);
    }
  }
  if (sources.length > 0) {
    return buildMatch(sources, match, "exact");
  }

  // 2) Same provider base-URL host. First-party catalog entries often carry
  // no base URL at all, so a query host label equal to the provider's id
  // (api.anthropic.com → "anthropic") also nominates that provider.
  const host = query.baseUrl ? hostOf(query.baseUrl) : null;
  if (host) {
    const labels = new Set(host.split("."));
    const hostCandidates = new Set(catalog.byHost.get(host) ?? []);
    if (hostCandidates.size === 0) {
      for (const provider of catalog.providers) {
        if (!provider.baseUrl && labels.has(provider.id.toLowerCase())) {
          hostCandidates.add(provider);
        }
      }
    }
    sources = [...hostCandidates]
      .map((provider) => ({ provider, model: provider.models.find((m) => m.id === modelId) }))
      .filter((s): s is { provider: CatalogProvider; model: CatalogModel } => !!s.model);
    if (sources.length > 0) {
      return buildMatch(sources, match, "baseUrl");
    }
  }

  // 3) Consensus on the bare model id (support threshold: the id must be
  // known to the catalog at all; metadata needs agreement across sources).
  sources = catalog.byModelId.get(modelId) ?? [];
  if (sources.length > 0) {
    return buildMatch(sources, match, "consensus");
  }
  return match;
}

function voteString(
  values: Array<string | undefined>,
): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return bestCount > 0 ? best : undefined;
}

/** All present values are equal? Returns the value, or undefined on conflict. */
function agree(values: Array<number | boolean | undefined>): {
  value?: number | boolean;
  conflict: boolean;
  present: number;
} {
  const present = values.filter((v) => v !== undefined);
  if (present.length === 0) return { conflict: false, present: 0 };
  const first = present[0];
  const conflict = present.some((v) => v !== first);
  return { value: conflict ? undefined : first, conflict, present: present.length };
}

function buildMatch(
  sources: Array<{ provider: CatalogProvider; model: CatalogModel }>,
  match: ModelCatalogMatch,
  kind: ModelCatalogMatch["match"],
): ModelCatalogMatch {
  match.match = kind;
  const models = sources.map((s) => s.model);

  const metadata: ModelMetadataSuggestion = {};
  const name = voteString(models.map((m) => m.name));
  if (name) metadata.name = name;
  const reasoning = agree(models.map((m) => m.reasoning));
  if (reasoning.value !== undefined) metadata.reasoning = reasoning.value === true;
  const contextWindow = agree(models.map((m) => m.contextWindow));
  if (contextWindow.value !== undefined)
    metadata.contextWindow = contextWindow.value as number;
  const maxTokens = agree(models.map((m) => m.maxTokens));
  if (maxTokens.value !== undefined) metadata.maxTokens = maxTokens.value as number;
  const input = voteString(models.map((m) => m.input?.join(",")));
  if (input) metadata.input = input.split(",");

  const priceSources = models.filter((m) => m.cost !== undefined);
  if (priceSources.length > 0) {
    const first = priceSources[0].cost!;
    const consistent =
      kind === "consensus"
        ? priceSources.every(
            (m) =>
              m.cost!.input === first.input && m.cost!.output === first.output,
          )
        : true;
    if (consistent) {
      metadata.cost = first;
      match.priceReliable = true;
    } else {
      match.warnings.push("目录中该模型价格来源不一致，已跳过自动填充价格");
    }
  }

  if (kind === "consensus" && sources.length === 1) {
    match.warnings.push("仅在目录单个提供商下匹配到该模型 ID");
  }
  match.metadata = metadata;
  return match;
}
