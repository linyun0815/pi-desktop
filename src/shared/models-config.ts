import {
  validateThinkingLevelMap,
  type ThinkingLevelMap,
} from "./model-thinking";

/**
 * Model API families the desktop's model discovery understands. Unknown API
 * strings remain saveable (Pi owns the full set); they just cannot run
 * provider /models discovery.
 */
export const MODEL_API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ModelApiType = (typeof MODEL_API_TYPES)[number];

/** USD per million tokens for one tier band. */
export interface CustomModelCostTier {
  /** The tier applies to inputs above this many tokens. */
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CustomModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** SDK tiered pricing; the editor keeps existing tiers untouched. */
  tiers?: CustomModelCostTier[];
}

/**
 * Aggregate key for per-model usage stats: provider + model id, so the same
 * model id under two providers stays separate. Records without a provider
 * (legacy data) fall back to the bare model id.
 */
export function modelUsageKey(provider: string | null, modelId: string): string {
  const id = modelId.trim();
  const prov = provider?.trim();
  return prov ? `${prov}/${id}` : id;
}

export interface ModelCompat {
  supportsReasoningEffort?: boolean;
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
  [key: string]: unknown;
}

export interface CustomModel {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  /** Pi-native per-model thinking-level mapping (missing = provider default, null = unsupported). */
  thinkingLevelMap?: ThinkingLevelMap;
  cost?: CustomModelCost;
  // Preserve fields the editor does not expose (compat, ...).
  [key: string]: unknown;
}

export interface ProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: CustomModel[];
  compat?: ModelCompat;
  // Preserve headers, authHeader, modelOverrides, compat, ...
  [key: string]: unknown;
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

const NUMERIC_MODEL_FIELDS: Array<keyof CustomModel> = [
  "contextWindow",
  "maxTokens",
];

const COST_RATE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;

/** All four base rates present and finite/non-negative? */
function isValidRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate one cost object (base rates + tiers); returns error strings. */
function validateModelCost(
  cost: unknown,
  label: string,
): string[] {
  if (typeof cost !== "object" || cost === null || Array.isArray(cost)) {
    return [`${label}：cost 必须是对象`];
  }
  const errors: string[] = [];
  const c = cost as Record<string, unknown>;
  for (const field of COST_RATE_FIELDS) {
    if (c[field] !== undefined && !isValidRate(c[field])) {
      errors.push(`${label}：cost.${field} 必须是有限且非负的数字`);
    }
  }
  if (c.tiers !== undefined) {
    if (!Array.isArray(c.tiers)) {
      errors.push(`${label}：cost.tiers 必须是数组`);
    } else {
      c.tiers.forEach((tier, i) => {
        if (typeof tier !== "object" || tier === null || Array.isArray(tier)) {
          errors.push(`${label}：cost.tiers[${i}] 必须是对象`);
          return;
        }
        const t = tier as Record<string, unknown>;
        if (!isValidRate(t.inputTokensAbove)) {
          errors.push(
            `${label}：cost.tiers[${i}].inputTokensAbove 必须是有限且非负的数字`,
          );
        }
        for (const field of COST_RATE_FIELDS) {
          if (t[field] !== undefined && !isValidRate(t[field])) {
            errors.push(
              `${label}：cost.tiers[${i}].${field} 必须是有限且非负的数字`,
            );
          }
        }
      });
    }
  }
  return errors;
}

/**
 * Validate a models config. Returns human-readable error strings; an empty array
 * means valid. Provider keys are inherently unique in the object, so duplicate-key
 * detection belongs to the editor (array) layer.
 */
export function validateModelsConfig(config: ModelsConfig): string[] {
  const errors: string[] = [];
  const providers = config.providers ?? {};
  for (const [key, provider] of Object.entries(providers)) {
    if (key.trim().length === 0) {
      errors.push("提供商键名不能为空");
    }
    const models = provider.models ?? [];
    const seen = new Set<string>();
    for (const model of models) {
      const id = (model.id ?? "").trim();
      if (id.length === 0) {
        errors.push(`提供商“${key}”：某个模型缺少 ID`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`提供商“${key}”：模型 ID 重复：“${id}”`);
      }
      seen.add(id);
      for (const field of NUMERIC_MODEL_FIELDS) {
        const value = model[field];
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isFinite(value))
        ) {
          errors.push(`提供商“${key}”、模型“${id}”：${field} 必须是有限数字`);
        }
      }
      if (model.cost !== undefined) {
        errors.push(
          ...validateModelCost(
            model.cost,
            `提供商“${key}”、模型“${id}”`,
          ),
        );
      }
      errors.push(
        ...validateThinkingLevelMap(
          model.thinkingLevelMap,
          `提供商“${key}”、模型“${id}”`,
        ),
      );
    }
  }
  return errors;
}

/**
 * Fill a partial cost draft into the full four-rate shape the SDK expects:
 * missing base rates become 0 (zero is a legal free price). Tiers pass
 * through untouched. Returns null for a non-object cost.
 */
export function normalizeModelCost(
  cost: CustomModelCost,
): CustomModelCost | null {
  if (typeof cost !== "object" || cost === null || Array.isArray(cost)) {
    return null;
  }
  const c = cost as unknown as Record<string, unknown>;
  const filled: CustomModelCost = {
    input: isValidRate(c.input) ? (c.input as number) : 0,
    output: isValidRate(c.output) ? (c.output as number) : 0,
    cacheRead: isValidRate(c.cacheRead) ? (c.cacheRead as number) : 0,
    cacheWrite: isValidRate(c.cacheWrite) ? (c.cacheWrite as number) : 0,
  };
  if (Array.isArray(c.tiers) && c.tiers.length > 0) {
    filled.tiers = c.tiers as CustomModelCostTier[];
  }
  return filled;
}

/**
 * Produce the object to write to models.json. Overlays edited known fields onto
 * the original so unknown fields (top-level, per-provider, per-model) are kept.
 * Providers/models absent from `edited` are dropped; new ones are added.
 *
 * `thinkingLevelMap` is editor-owned: when the edited model carries one it
 * replaces the original outright (an empty map means "remove the optional
 * field"), so a cleared mapping cannot re-merge from the old value.
 *
 * `cost` is editor-owned the same way: absent from the edited model keeps the
 * original, a non-empty object replaces + normalizes it (missing base rates
 * fill as 0), an empty object removes it.
 */
export function mergeModelsConfig(
  original: ModelsConfig,
  edited: ModelsConfig,
): ModelsConfig {
  const result: ModelsConfig = { ...original, providers: {} };
  for (const [key, prov] of Object.entries(edited.providers ?? {})) {
    const origProv = original.providers?.[key] ?? {};
    const origModels = origProv.models ?? [];
    const mergedModels = (prov.models ?? []).map((m) => {
      const { thinkingLevelMap: editedMap, cost: editedCost, ...restEdited } = m;
      const origModel = origModels.find((o) => o.id === m.id) ?? {};
      const merged: CustomModel = { ...origModel, ...restEdited };
      if (editedMap !== undefined) {
        const normalizedEntries = Object.entries(editedMap).filter(
          ([, v]) => v !== undefined,
        );
        if (normalizedEntries.length > 0) {
          merged.thinkingLevelMap = Object.fromEntries(normalizedEntries);
        } else {
          delete merged.thinkingLevelMap;
        }
      }
      if (editedCost !== undefined) {
        if (
          typeof editedCost === "object" &&
          editedCost !== null &&
          !Array.isArray(editedCost) &&
          Object.keys(editedCost).length > 0
        ) {
          const normalized = normalizeModelCost(editedCost);
          if (normalized) {
            // Replacement, but layered over the original cost so fields the
            // editor does not expose — existing tiers, unknown extras —
            // survive unless the edit carries its own value.
            const origCost = (origModel as { cost?: unknown }).cost;
            merged.cost =
              typeof origCost === "object" &&
              origCost !== null &&
              !Array.isArray(origCost)
                ? { ...origCost, ...normalized }
                : normalized;
          } else {
            delete merged.cost;
          }
        } else {
          // Empty (or invalid) cost object means "remove the cost field".
          delete merged.cost;
        }
      }
      return merged;
    });
    result.providers[key] = { ...origProv, ...prov, models: mergedModels };
  }
  return normalizeModelsConfigForPi(result);
}

export function normalizeModelsConfigForPi(config: ModelsConfig): ModelsConfig {
  const providers: ModelsConfig["providers"] = {};
  let changed = false;

  for (const [key, provider] of Object.entries(config.providers ?? {})) {
    let nextProvider = provider;

    if (shouldEnableOllamaCloudReasoningEffort(provider)) {
      nextProvider = {
        ...nextProvider,
        compat: {
          ...(nextProvider.compat ?? {}),
          supportsReasoningEffort: true,
        },
      };
      changed = true;
    }

    providers[key] = nextProvider;
  }

  return changed ? { ...config, providers } : config;
}

function isOllamaCloudProvider(provider: ProviderConfig): boolean {
  const baseUrl = provider.baseUrl?.replace(/\/+$/, "");
  return (
    (baseUrl === "https://ollama.com" || baseUrl === "https://ollama.com/v1") &&
    provider.api === "openai-completions"
  );
}

function shouldEnableOllamaCloudReasoningEffort(
  provider: ProviderConfig,
): boolean {
  if (!isOllamaCloudProvider(provider)) return false;
  if (provider.compat?.supportsReasoningEffort === true) return false;
  return (provider.models ?? []).some((model) => model.reasoning === true);
}

const TEXT_INPUT = "text";
const IMAGE_INPUT = "image";

/**
 * Toggle image (vision) support in a model's `input` modalities while always
 * keeping text. Returns a new array; never mutates the input.
 */
export function withImageInput(
  input: string[] | undefined,
  enabled: boolean,
): string[] {
  const base = input && input.length > 0 ? input : [TEXT_INPUT];
  const withText = base.includes(TEXT_INPUT) ? base : [TEXT_INPUT, ...base];
  if (enabled) {
    return withText.includes(IMAGE_INPUT)
      ? [...withText]
      : [...withText, IMAGE_INPUT];
  }
  return withText.filter((modality) => modality !== IMAGE_INPUT);
}

/**
 * Resolve a model id to its display name from a models config, scanning every
 * provider's models. Returns the raw id when the config is missing or has no
 * matching model with a name (the caller's fallback).
 */
export function modelDisplayName(
  modelId: string,
  config: ModelsConfig | null,
): string {
  if (!modelId || !config) return modelId;
  for (const provider of Object.values(config.providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (
        model.id === modelId &&
        typeof model.name === "string" &&
        model.name.trim().length > 0
      ) {
        return model.name;
      }
    }
  }
  return modelId;
}
