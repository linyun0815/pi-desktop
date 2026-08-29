import {
  normalizeThinkingLevelMap,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "../../../shared/model-thinking";
import {
  normalizeModelCost,
  type CustomModel,
  type CustomModelCost,
  type CustomModelCostTier,
  type ModelsConfig,
  type ProviderConfig,
} from "../../../shared/models-config";
import type {
  ModelCatalogLookupResult,
  ModelDiscoveryModel,
  ModelMetadataSuggestion,
} from "../../../shared/ipc-contracts";

/**
 * Editor-side cost draft: any of the four base rates may be unset — an empty
 * price input means "not configured", distinct from the legal 0 (free).
 * Tiers pass through untouched until save.
 */
export interface ModelCostDraft {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** SDK tiered pricing; passes through untouched. */
  tiers?: CustomModelCostTier[];
}

/**
 * CustomModel minus its typed `cost` field. A homomorphic mapped type (not
 * `Omit`, which collapses declared props of index-signature interfaces into
 * `unknown`) so ModelRow keeps id/name/... fully typed and stays in sync with
 * CustomModel automatically.
 */
type WithoutCost<T> = {
  [K in keyof T as K extends "cost" ? never : K]: T[K];
};

/**
 * One editable model row: a CustomModel whose cost may be a partially filled
 * draft, plus a local-only stable React key (never written to models.json).
 */
export interface ModelRow extends WithoutCost<CustomModel> {
  cost?: ModelCostDraft;
  /** Local-only stable React key; stripped by rowsToConfig. */
  rowId: string;
}

/**
 * Editor-side row model for one provider. Rows are the dense editable form of
 * the models.json config; `configToRows`/`rowsToConfig` convert in and out,
 * keeping unknown provider fields out of the rows (they survive via the merge
 * in models-config.saveCustomModels) and local-only UI state out of the file.
 */
export interface ProviderRow {
  /** Local-only stable React key; stripped by rowsToConfig. */
  rowId: string;
  key: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  compat: ProviderConfig["compat"];
  models: ModelRow[];
}

let rowIdCounter = 0;

/**
 * Allocate a fresh local-only row key. Providers and models share one counter
 * space so keys never collide; ids are regenerated per load and re-stabilized
 * by `withStableRowIds`.
 */
export function allocateRowId(): string {
  rowIdCounter += 1;
  return `row-${rowIdCounter}`;
}

/**
 * Reuse the previous rows' local ids where content still matches (provider
 * key, then model id within the matched provider), so a save-then-reload does
 * not collapse what the user had open while genuinely new rows (e.g. models
 * inserted via discovery) keep the fresh keys they were created with.
 */
export function withStableRowIds(
  next: ProviderRow[],
  prev: ProviderRow[] | undefined,
): ProviderRow[] {
  if (!prev || prev.length === 0) return next;
  const usedProviders = new Set<string>();
  const prevProviders = new Map(
    prev
      .filter((r) => r.key.trim().length > 0)
      .map((r) => [r.key.trim(), r] as const),
  );
  return next.map((row) => {
    const prevRow = prevProviders.get(row.key.trim());
    // Duplicate keys in the draft must never share one id.
    if (!prevRow || usedProviders.has(prevRow.rowId)) return row;
    usedProviders.add(prevRow.rowId);
    const usedModels = new Set<string>();
    const prevModels = new Map(
      prevRow.models
        .filter((m) => m.id.trim().length > 0)
        .map((m) => [m.id.trim(), m] as const),
    );
    return {
      ...row,
      rowId: prevRow.rowId,
      models: row.models.map((m) => {
        const id = m.id.trim();
        const prevModel = id.length > 0 ? prevModels.get(id) : undefined;
        if (!prevModel || usedModels.has(prevModel.rowId)) return m;
        usedModels.add(prevModel.rowId);
        return { ...m, rowId: prevModel.rowId };
      }),
    };
  });
}

const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

export { API_OPTIONS };

export function configToRows(config: ModelsConfig | null): ProviderRow[] {
  if (!config || typeof config !== "object") return [];
  const providers = config.providers;
  if (typeof providers !== "object" || providers === null) return [];
  const rows: ProviderRow[] = [];
  // Hand-edited JSON can contain null/garbage provider entries; those are
  // skipped (not fatal) so the rest of the file stays editable.
  for (const [key, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const p = entry as ProviderConfig;
    const models: ModelRow[] = [];
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (typeof m !== "object" || m === null || Array.isArray(m)) continue;
      const { thinkingLevelMap, ...rest } = m as CustomModel;
      const normalized = normalizeThinkingLevelMap(thinkingLevelMap);
      const row: ModelRow = { ...rest, rowId: allocateRowId() };
      if (normalized) row.thinkingLevelMap = normalized;
      models.push(row);
    }
    rows.push({
      rowId: allocateRowId(),
      key,
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
      api: typeof p.api === "string" ? p.api : "",
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      compat: p.compat,
      models,
    });
  }
  return rows;
}

export function rowsToConfig(rows: ProviderRow[]): ModelsConfig {
  const providers: ModelsConfig["providers"] = {};
  for (const r of rows) {
    const models: CustomModel[] = r.models.map((m) => {
      const { rowId: _rowId, thinkingLevelMap, cost, ...rest } = m;
      // Cost is editor-owned end to end (see mergeModelsConfig): a present-
      // but-blank draft (all four rates cleared) reaches the merge as an
      // explicit `cost: {}` removal signal — omitting the key would keep the
      // original cost. A partially typed draft is filled to the full
      // four-rate shape (missing rates become 0); no draft simply omits the
      // key.
      const normalizedCost = normalizeCostDraft(cost);
      const base: CustomModel = { ...rest };
      if (cost !== undefined) {
        // The `{}` removal signal cannot be spelled in CustomModelCost's
        // narrowed field type; mergeModelsConfig documents and handles it.
        base.cost = (normalizedCost ?? {}) as CustomModelCost;
      }
      if (!thinkingLevelMap) return base;
      // Only writable entries reach the file: a draft custom value left empty
      // (validation blocks the save, this is the belt) is dropped here.
      const writable = Object.fromEntries(
        Object.entries(thinkingLevelMap).filter(
          ([, v]) =>
            v === null || (typeof v === "string" && v.trim().length > 0),
        ),
      );
      if (Object.keys(writable).length === 0) return base;
      return { ...base, thinkingLevelMap: writable };
    });
    providers[r.key.trim()] = {
      ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      ...(r.api ? { api: r.api } : {}),
      ...(r.apiKey ? { apiKey: r.apiKey } : {}),
      ...(r.compat ? { compat: r.compat } : {}),
      models,
    };
  }
  return { providers };
}

/** The four base price rates of a cost draft, in editor display order. */
export const COST_RATES = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;
export type CostRateKey = (typeof COST_RATES)[number];

const COST_RATE_LABELS: Record<CostRateKey, string> = {
  input: "输入价",
  output: "输出价",
  cacheRead: "缓存读",
  cacheWrite: "缓存写",
};

/** Chinese label for one price input (all labeled 美元/百万 token). */
export function costRateLabel(rate: CostRateKey): string {
  return COST_RATE_LABELS[rate];
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Normalize a draft cost into the full four-rate shape for saving: missing or
 * invalid base rates fill as 0 (zero is a legal free price), tiers pass
 * through. Returns undefined when no base rate is configured — callers treat
 * that as "remove the cost field" (rowsToConfig emits the `cost: {}` removal
 * signal understood by mergeModelsConfig). A cost carrying only tiers (no
 * base rates) counts as blank: the four price inputs are the editor's source
 * of truth.
 */
export function normalizeCostDraft(
  cost: ModelCostDraft | undefined,
): CustomModelCost | undefined {
  if (typeof cost !== "object" || cost === null || Array.isArray(cost)) {
    return undefined;
  }
  const hasRate = COST_RATES.some((rate) => isNonNegativeFinite(cost[rate]));
  if (!hasRate) return undefined;
  return normalizeModelCost(cost as CustomModelCost) ?? undefined;
}

function isBlankText(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Fill ONLY the blank fields of a model row from a catalog suggestion, field
 * by field: a blank name (undefined or empty), missing reasoning/input/
 * contextWindow/maxTokens, and missing base cost rates. Explicit values —
 * `reasoning: false`, a `0` rate, existing names and windows — plus
 * thinkingLevelMap and unknown fields are never overwritten. Prices are only
 * taken from `suggestion.cost`, so a caller dealing with unreliable prices
 * strips `cost` before calling; this function injects nothing on its own.
 */
export function fillBlankModelMetadata(
  model: ModelRow,
  suggestion: ModelMetadataSuggestion,
): ModelRow {
  const next: ModelRow = { ...model };
  if (
    isBlankText(next.name) &&
    typeof suggestion.name === "string" &&
    suggestion.name.trim().length > 0
  ) {
    next.name = suggestion.name;
  }
  if (
    next.reasoning === undefined &&
    typeof suggestion.reasoning === "boolean"
  ) {
    next.reasoning = suggestion.reasoning;
  }
  if (
    next.input === undefined &&
    Array.isArray(suggestion.input) &&
    suggestion.input.length > 0
  ) {
    next.input = [...suggestion.input];
  }
  if (
    next.contextWindow === undefined &&
    isNonNegativeFinite(suggestion.contextWindow)
  ) {
    next.contextWindow = suggestion.contextWindow;
  }
  if (
    next.maxTokens === undefined &&
    isNonNegativeFinite(suggestion.maxTokens)
  ) {
    next.maxTokens = suggestion.maxTokens;
  }
  const suggestedCost = suggestion.cost;
  if (
    typeof suggestedCost === "object" &&
    suggestedCost !== null &&
    !Array.isArray(suggestedCost)
  ) {
    const current =
      typeof next.cost === "object" &&
      next.cost !== null &&
      !Array.isArray(next.cost)
        ? next.cost
        : undefined;
    const filledRates: ModelCostDraft = {};
    let changed = false;
    for (const rate of COST_RATES) {
      const sug = suggestedCost[rate];
      // A present current value — including the legal 0 (free) — stays.
      if (current?.[rate] === undefined && isNonNegativeFinite(sug)) {
        filledRates[rate] = sug;
        changed = true;
      }
    }
    if (changed) {
      // Spread keeps the draft's existing rates and tiers untouched.
      next.cost = current ? { ...current, ...filledRates } : filledRates;
    }
  }
  return next;
}

/** How many fields a fill actually changed (drives the status message). */
function countFilledFields(before: ModelRow, after: ModelRow): number {
  let count = 0;
  if (before.name !== after.name) count += 1;
  if (before.reasoning !== after.reasoning) count += 1;
  if (before.input !== after.input) count += 1;
  if (before.contextWindow !== after.contextWindow) count += 1;
  if (before.maxTokens !== after.maxTokens) count += 1;
  for (const rate of COST_RATES) {
    if (before.cost?.[rate] !== after.cost?.[rate]) count += 1;
  }
  return count;
}

/** Does the suggestion carry at least one usable field? */
function hasSuggestedContent(meta: ModelMetadataSuggestion): boolean {
  const cost = meta.cost;
  const hasCostRate =
    typeof cost === "object" &&
    cost !== null &&
    !Array.isArray(cost) &&
    COST_RATES.some((rate) => isNonNegativeFinite(cost[rate]));
  return (
    (typeof meta.name === "string" && meta.name.trim().length > 0) ||
    typeof meta.reasoning === "boolean" ||
    (Array.isArray(meta.input) && meta.input.length > 0) ||
    isNonNegativeFinite(meta.contextWindow) ||
    isNonNegativeFinite(meta.maxTokens) ||
    hasCostRate
  );
}

/** Local UI state for one row's catalog lookup (never saved). */
export type CatalogLookupStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "success"; message: string }
  | { state: "no-match"; message: string }
  | { state: "unreliable"; message: string }
  | { state: "error"; message: string };

export interface CatalogApplyOutcome {
  rows: ProviderRow[];
  status: CatalogLookupStatus;
}

/**
 * Merge one catalog lookup response into the CURRENT rows: the row is read
 * fresh by its stable ids (indices shift while a request is in flight), blank
 * fields are filled via fillBlankModelMetadata, and the user's edits made
 * during the request are never overwritten. Returns the (possibly unchanged)
 * rows plus the status to show on the row. Pure — the editor calls this
 * inside its row-mutation path.
 */
export function applyCatalogLookupResult(
  rows: ProviderRow[],
  providerRowId: string,
  modelRowId: string,
  result: ModelCatalogLookupResult,
): CatalogApplyOutcome {
  if (!result.ok) {
    return {
      rows,
      status: {
        state: "error",
        message: result.error || "目录查询失败",
      },
    };
  }
  const { match } = result;
  if (match.match === "none" || !hasSuggestedContent(match.metadata)) {
    return {
      rows,
      status: {
        state: "no-match",
        message: "模型目录中没有该模型的可用信息",
      },
    };
  }
  const providerIndex = rows.findIndex((r) => r.rowId === providerRowId);
  const modelIndex =
    providerIndex >= 0
      ? rows[providerIndex]!.models.findIndex((m) => m.rowId === modelRowId)
      : -1;
  if (providerIndex < 0 || modelIndex < 0) {
    return {
      rows,
      status: { state: "error", message: "该模型行已不存在，未应用建议" },
    };
  }
  // Unreliable prices are never injected; the reliable (non-price) fields are.
  const effective: ModelMetadataSuggestion = match.priceReliable
    ? match.metadata
    : { ...match.metadata, cost: undefined };
  const before = rows[providerIndex]!.models[modelIndex]!;
  const after = fillBlankModelMetadata(before, effective);
  const filled = countFilledFields(before, after);
  const nextRows = rows.map((r, i) =>
    i === providerIndex
      ? {
          ...r,
          models: r.models.map((m, j) => (j === modelIndex ? after : m)),
        }
      : r,
  );
  const warnings = match.warnings
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  const suffix = warnings.length > 0 ? `；${warnings.join("；")}` : "";
  const status: CatalogLookupStatus = match.priceReliable
    ? {
        state: "success",
        message:
          filled > 0
            ? `已从目录填充 ${filled} 项空白字段${suffix}`
            : `模型信息已完整，无需填充${suffix}`,
      }
    : {
        state: "unreliable",
        message:
          filled > 0
            ? `已填充 ${filled} 项可靠字段；目录价格来源不一致，未填充价格${suffix}`
            : `目录价格来源不一致，未填充价格${suffix}`,
      };
  return { rows: nextRows, status };
}

/** How many discovered models render before narrowing or showing more. */
export const DISCOVERY_LIST_LIMIT = 50;

/**
 * Local tokenized filter over a discovered model list: every whitespace-
 * separated token must appear in the id or display name (case-insensitive).
 */
export function filterDiscoveryModels(
  models: ModelDiscoveryModel[],
  query: string,
): ModelDiscoveryModel[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return models;
  return models.filter((m) => {
    const haystack = `${m.id} ${m.name ?? ""}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

/** The three states one map row can be edited into. */
export type MapLevelState = "default" | "unsupported" | "custom";

/** Read the edit state of one level from a draft map. */
export function mapLevelState(
  map: ThinkingLevelMap | undefined,
  level: ThinkingLevel,
): MapLevelState {
  const value = map?.[level];
  if (value === null) return "unsupported";
  if (typeof value === "string") return "custom";
  return "default";
}

/**
 * Write one level's edit state into a draft map (pure). `custom` with an
 * empty value stores the empty string so the in-progress draft survives
 * keystrokes; validation flags it and rowsToConfig drops it on save.
 */
export function withMapLevel(
  map: ThinkingLevelMap | undefined,
  level: ThinkingLevel,
  state: MapLevelState,
  customValue = "",
): ThinkingLevelMap {
  const next: ThinkingLevelMap = { ...(map ?? {}) };
  if (state === "default") delete next[level];
  else if (state === "unsupported") next[level] = null;
  else next[level] = customValue;
  return next;
}

/**
 * Editor-layer validation: what the object form of models.json cannot express
 * (duplicate/empty provider keys) plus per-model id, price and thinking-map
 * problems. Empty custom values are flagged so the user sees them before
 * saving, even though rowsToConfig would drop them defensively.
 */
export function validateRows(rows: ProviderRow[]): string[] {
  const errors: string[] = [];
  const keys = rows.map((r) => r.key.trim());
  if (keys.some((k) => k.length === 0))
    errors.push("每个提供商都必须填写非空键名");
  if (new Set(keys).size !== keys.length)
    errors.push("提供商键名必须唯一");

  rows.forEach((row, providerIndex) => {
    const key = keys[providerIndex] || `#${providerIndex + 1}`;
    const seen = new Set<string>();
    row.models.forEach((model, modelIndex) => {
      const id = (model.id ?? "").trim();
      // Label for map errors even when the id itself is missing.
      const label = id || `#${modelIndex + 1}`;
      if (id.length === 0) {
        errors.push(`提供商“${key}”：某个模型缺少 ID`);
      } else if (seen.has(id)) {
        errors.push(`提供商“${key}”：模型 ID 重复：“${id}”`);
      }
      if (id.length > 0) seen.add(id);
      // Price drafts: unset (blank) is fine and means "not configured"; a
      // typed value must be finite and non-negative (0 = legal free price).
      const cost =
        typeof model.cost === "object" &&
        model.cost !== null &&
        !Array.isArray(model.cost)
          ? model.cost
          : undefined;
      if (cost) {
        for (const rate of COST_RATES) {
          const value = cost[rate];
          if (
            value !== undefined &&
            (typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0)
          ) {
            errors.push(
              `提供商“${key}”、模型“${label}”：${COST_RATE_LABELS[rate]}必须是有限且非负的数字（美元/百万 token）`,
            );
          }
        }
      }
      for (const level of THINKING_LEVELS) {
        const value = model.thinkingLevelMap?.[level];
        if (typeof value === "string" && value.trim().length === 0) {
          errors.push(
            `提供商“${key}”、模型“${label}”：思考级别“${level}”的自定义值不能为空（请填写实际值或改回默认/不支持）`,
          );
        }
      }
    });
  });
  return errors;
}

/**
 * Stable per-model map reset: clears every explicit entry back to defaults,
 * keeping every other field (including the cost draft and unknown fields).
 * Generic so the inferred rest shape stays a valid Partial<ModelRow> patch at
 * the call site.
 */
export function resetModelMap<
  T extends { thinkingLevelMap?: ThinkingLevelMap },
>(model: T) {
  const { thinkingLevelMap: _dropped, ...rest } = model;
  return rest;
}
