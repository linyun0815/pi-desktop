import {
  normalizeThinkingLevelMap,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "../../../shared/model-thinking";
import type {
  CustomModel,
  ModelsConfig,
  ProviderConfig,
} from "../../../shared/models-config";

/**
 * Editor-side row model for one provider. Rows are the dense editable form of
 * the models.json config; `configToRows`/`rowsToConfig` convert in and out,
 * keeping unknown provider fields out of the rows (they survive via the merge
 * in models-config.saveCustomModels) and local-only UI state out of the file.
 */
export interface ProviderRow {
  key: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  compat: ProviderConfig["compat"];
  models: CustomModel[];
}

const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

export { API_OPTIONS };

export function configToRows(config: ModelsConfig | null): ProviderRow[] {
  if (!config) return [];
  return Object.entries(config.providers ?? {}).map(([key, p]) => ({
    key,
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
    api: typeof p.api === "string" ? p.api : "",
    apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
    compat: p.compat,
    models: (Array.isArray(p.models) ? p.models : []).map((m) => {
      const { thinkingLevelMap, ...rest } = m;
      const normalized = normalizeThinkingLevelMap(thinkingLevelMap);
      return normalized ? { ...rest, thinkingLevelMap: normalized } : rest;
    }),
  }));
}

export function rowsToConfig(rows: ProviderRow[]): ModelsConfig {
  const providers: ModelsConfig["providers"] = {};
  for (const r of rows) {
    const models: CustomModel[] = r.models.map((m) => {
      const { thinkingLevelMap, ...rest } = m;
      if (!thinkingLevelMap) return rest;
      // Only writable entries reach the file: a draft custom value left empty
      // (validation blocks the save, this is the belt) is dropped here.
      const writable = Object.fromEntries(
        Object.entries(thinkingLevelMap).filter(
          ([, v]) =>
            v === null || (typeof v === "string" && v.trim().length > 0),
        ),
      );
      if (Object.keys(writable).length === 0) return rest;
      return { ...rest, thinkingLevelMap: writable };
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
 * (duplicate/empty provider keys) plus per-model id and thinking-map
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

/** Stable per-model map reset: clears every explicit entry back to defaults. */
export function resetModelMap(model: CustomModel): CustomModel {
  const { thinkingLevelMap: _dropped, ...rest } = model;
  return rest;
}
