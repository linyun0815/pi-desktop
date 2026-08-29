import { useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  EyeOff,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../store";
import { withImageInput } from "../../../shared/models-config";
import type { CustomModel } from "../../../shared/models-config";
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../../shared/model-thinking";
import {
  API_OPTIONS,
  configToRows,
  mapLevelState,
  resetModelMap,
  rowsToConfig,
  validateRows,
  withMapLevel,
  type MapLevelState,
  type ProviderRow,
} from "./custom-models-editor-helpers";

/**
 * Custom models editor (~/.pi/agent/models.json).
 *
 * Providers render as collapsed cards (name, API, base URL, model count,
 * delete); each model lays out in aligned rows — required id/name, numeric
 * windows + capability toggles, then a collapsible per-level thinking map.
 * All conversion and validation lives in custom-models-editor-helpers.ts and
 * is unit-tested; this component holds only expand/collapse and visibility
 * UI state, which never reaches the written file.
 */

// Expand/collapse keys: provider key + model id survive config reloads, so a
// save that re-reads the file does not collapse what the user had open.
const inputClass =
  "rounded border border-border-strong bg-surface px-2 py-1 text-sm text-primary focus:border-focus focus:outline-none";

export function CustomModelsEditor(): React.JSX.Element {
  const customModels = useAppStore((s) => s.customModels);
  const customModelsError = useAppStore((s) => s.customModelsError);
  const loadCustomModels = useAppStore((s) => s.loadCustomModels);
  const saveCustomModels = useAppStore((s) => s.saveCustomModels);
  const restartPi = useAppStore((s) => s.restartPi);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  // The active runtime's activity decides the post-save message: main
  // hot-reloads idle runtimes during the write, a busy one defers to its
  // next start, so "needs restart" is per-session state, not a blanket rule.
  const activeRuntime = useAppStore((s) =>
    s.activeSessionRuntimeId
      ? s.sessionRuntimes[s.activeSessionRuntimeId]
      : undefined,
  );
  const activeBusy =
    activeRuntime?.activity === "working" ||
    activeRuntime?.activity === "needs-approval";
  const activeRunning = activeRuntime?.status === "running";

  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openProviders, setOpenProviders] = useState<Set<string>>(new Set());
  const [openMaps, setOpenMaps] = useState<Set<string>>(new Set());
  const [showKeyFor, setShowKeyFor] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadCustomModels();
  }, [loadCustomModels]);

  useEffect(() => {
    setRows(configToRows(customModels));
  }, [customModels]);

  const update = (next: ProviderRow[]): void => {
    setRows(next);
    setSaved(false);
  };

  const addProvider = (): void =>
    update([
      ...rows,
      {
        key: "",
        baseUrl: "",
        api: API_OPTIONS[0],
        apiKey: "",
        compat: undefined,
        models: [],
      },
    ]);

  const removeProvider = (index: number): void =>
    update(rows.filter((_, i) => i !== index));

  const patchProvider = (index: number, patch: Partial<ProviderRow>): void =>
    update(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const patchProviderCompat = (
    index: number,
    patch: NonNullable<ProviderRow["compat"]>,
  ): void =>
    patchProvider(index, {
      compat: { ...(rows[index].compat ?? {}), ...patch },
    });

  const addModel = (providerIndex: number): void =>
    patchProvider(providerIndex, {
      models: [...rows[providerIndex].models, { id: "" }],
    });

  const patchModel = (
    providerIndex: number,
    modelIndex: number,
    patch: Partial<CustomModel>,
  ): void =>
    patchProvider(providerIndex, {
      models: rows[providerIndex].models.map((m, i) =>
        i === modelIndex ? { ...m, ...patch } : m,
      ),
    });

  const removeModel = (providerIndex: number, modelIndex: number): void =>
    patchProvider(providerIndex, {
      models: rows[providerIndex].models.filter((_, i) => i !== modelIndex),
    });

  const toggleSet = (
    set: Set<string>,
    key: string,
    setter: (next: Set<string>) => void,
  ): void => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  const handleSave = async (): Promise<void> => {
    const localErrors = validateRows(rows);
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }
    setSaving(true);
    try {
      const result = await saveCustomModels(rowsToConfig(rows));
      if (result.ok) {
        setErrors([]);
        setSaved(true);
      } else {
        setErrors(result.errors ?? ["保存失败"]);
      }
    } finally {
      setSaving(false);
    }
  };

  if (customModelsError) {
    return (
      <div className="flex items-start gap-2 text-sm text-warning">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <p>无法安全加载 models.json，已禁用编辑以避免覆盖文件。</p>
          <p className="mt-1 text-xs text-dim">{customModelsError}</p>
          <button
            onClick={() => loadCustomModels()}
            className="mt-2 rounded border border-border-strong px-2 py-1 text-xs text-secondary hover:bg-surface-hover"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  const needsRestart = saved && activeRunning && activeBusy;

  const handleRestart = async (): Promise<void> => {
    if (activeBusy) {
      const confirmed = await requestConfirm({
        title: "重启 Pi？",
        message:
          "Pi 正在此会话中工作。重启会停止当前回合：已写入会话的内容保留，其余响应被丢弃。",
        confirmLabel: "仍要重启",
        cancelLabel: "继续工作",
        danger: true,
      });
      if (!confirmed) return;
    }
    await restartPi();
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-dim">
        <code>~/.pi/agent/models.json</code> 中的自定义提供商和模型。Pi
        重启后生效；未在下方暴露的字段（compat、headers
        等）在保存时原样保留。
      </p>

      {rows.map((row, pi) => {
        const providerKey = row.key.trim() || `#${pi + 1}`;
        const open = openProviders.has(providerKey);
        return (
          <div
            key={pi}
            className="rounded-md border border-border bg-surface/50"
          >
            {/* Provider header: identity at a glance + delete, click to expand. */}
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() =>
                  toggleSet(openProviders, providerKey, setOpenProviders)
                }
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={open}
              >
                <ChevronDown
                  size={14}
                  className={clsx(
                    "shrink-0 text-dim transition-transform",
                    !open && "-rotate-90",
                  )}
                />
                <Layers size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 truncate text-sm font-medium text-primary">
                  {row.key.trim() || "未命名提供商"}
                </span>
                <span className="shrink-0 rounded bg-card px-1.5 py-0.5 text-[10px] text-muted">
                  {row.models.length} 个模型
                </span>
                <span className="hidden shrink-0 truncate text-xs text-faint sm:inline">
                  {row.baseUrl}
                </span>
              </button>
              <IconButton
                onClick={() => removeProvider(pi)}
                title="移除提供商"
                danger
              >
                <Trash2 size={14} />
              </IconButton>
            </div>

            {open && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-[11px] text-dim">提供商键名</span>
                    <input
                      value={row.key}
                      onChange={(e) =>
                        patchProvider(pi, { key: e.target.value })
                      }
                      placeholder="例如 ollama"
                      className={inputClass}
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-dim">API</span>
                    <select
                      value={row.api}
                      onChange={(e) =>
                        patchProvider(pi, { api: e.target.value })
                      }
                      className={inputClass}
                    >
                      {API_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-dim">Base URL</span>
                    <input
                      value={row.baseUrl}
                      onChange={(e) =>
                        patchProvider(pi, { baseUrl: e.target.value })
                      }
                      placeholder="https://…"
                      className={inputClass}
                    />
                  </label>
                  <div className="grid gap-1">
                    <span className="text-[11px] text-dim">
                      API Key（可选）
                    </span>
                    <div className="flex gap-1">
                      <input
                        type={showKeyFor.has(providerKey) ? "text" : "password"}
                        value={row.apiKey}
                        onChange={(e) =>
                          patchProvider(pi, { apiKey: e.target.value })
                        }
                        placeholder="直接值、$ENV_VAR 或 !命令"
                        autoComplete="off"
                        spellCheck={false}
                        className={clsx(inputClass, "min-w-0 flex-1 font-mono")}
                      />
                      <IconButton
                        onClick={() =>
                          toggleSet(showKeyFor, providerKey, setShowKeyFor)
                        }
                        title={
                          showKeyFor.has(providerKey) ? "隐藏 Key" : "显示 Key"
                        }
                      >
                        {showKeyFor.has(providerKey) ? (
                          <EyeOff size={13} />
                        ) : (
                          <Eye size={13} />
                        )}
                      </IconButton>
                    </div>
                    <span className="text-[10px] text-faint">
                      保存后写入 models.json，不会出现在日志或状态中。
                    </span>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-[11px] text-dim">
                  <input
                    type="checkbox"
                    checked={row.compat?.supportsReasoningEffort ?? false}
                    onChange={(e) =>
                      patchProviderCompat(pi, {
                        supportsReasoningEffort: e.target.checked,
                      })
                    }
                    className="accent-accent"
                  />
                  提供商支持思考强度（reasoning effort）
                </label>

                <div className="space-y-2">
                  {row.models.map((model, mi) => {
                    const modelKey = `${providerKey}/${model.id || `#${mi + 1}`}`;
                    const mapOpen = openMaps.has(modelKey);
                    return (
                      <div
                        key={mi}
                        className="rounded border border-border bg-surface p-2.5"
                      >
                        {/* Row 1: required identity. */}
                        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                          <input
                            value={model.id ?? ""}
                            onChange={(e) =>
                              patchModel(pi, mi, { id: e.target.value })
                            }
                            placeholder="模型 ID（必填）"
                            className={clsx(inputClass, "text-xs")}
                          />
                          <input
                            value={model.name ?? ""}
                            onChange={(e) =>
                              patchModel(pi, mi, { name: e.target.value })
                            }
                            placeholder="显示名称"
                            className={clsx(inputClass, "text-xs")}
                          />
                          <IconButton
                            onClick={() => removeModel(pi, mi)}
                            title="移除模型"
                            danger
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>

                        {/* Row 2: windows + capabilities, fixed-width inputs. */}
                        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <label className="flex items-center gap-1.5 text-[11px] text-dim">
                            上下文窗口
                            <NumberInput
                              value={model.contextWindow}
                              onValue={(v) =>
                                patchModel(pi, mi, { contextWindow: v })
                              }
                            />
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] text-dim">
                            最大输出
                            <NumberInput
                              value={model.maxTokens}
                              onValue={(v) =>
                                patchModel(pi, mi, { maxTokens: v })
                              }
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[11px] text-dim">
                            <input
                              type="checkbox"
                              checked={model.reasoning ?? false}
                              onChange={(e) =>
                                patchModel(pi, mi, {
                                  reasoning: e.target.checked,
                                })
                              }
                              className="accent-accent"
                            />
                            思考
                          </label>
                          <label className="flex items-center gap-1 text-[11px] text-dim">
                            <input
                              type="checkbox"
                              checked={model.input?.includes("image") ?? false}
                              onChange={(e) =>
                                patchModel(pi, mi, {
                                  input: withImageInput(
                                    model.input,
                                    e.target.checked,
                                  ),
                                })
                              }
                              className="accent-accent"
                            />
                            视觉
                          </label>
                        </div>

                        {/* Row 3: collapsible thinking-level map. */}
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() =>
                              toggleSet(openMaps, modelKey, setOpenMaps)
                            }
                            className="flex items-center gap-1 text-[11px] text-muted hover:text-primary"
                            aria-expanded={mapOpen}
                          >
                            <ChevronDown
                              size={11}
                              className={clsx(
                                "transition-transform",
                                !mapOpen && "-rotate-90",
                              )}
                            />
                            思考级别映射
                            {model.thinkingLevelMap &&
                              Object.keys(model.thinkingLevelMap).length > 0 && (
                                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-muted">
                                  {Object.keys(model.thinkingLevelMap).length}{" "}
                                  项
                                </span>
                              )}
                          </button>
                          {mapOpen && (
                            <div className="mt-2 space-y-2 rounded bg-card/60 p-2">
                              <p className="text-[10px] text-faint">
                                默认映射使用供应商内置值；不支持
                                （null）隐藏该级别；自定义值是发送给供应商的实际字符串。xhigh/max
                                仅在配置为自定义值时才会出现在选择器中。
                              </p>
                              {THINKING_LEVELS.map((level) => (
                                <ThinkingMapRow
                                  key={level}
                                  level={level}
                                  model={model}
                                  onChange={(state, value) =>
                                    patchModel(pi, mi, {
                                      thinkingLevelMap: withMapLevel(
                                        model.thinkingLevelMap,
                                        level,
                                        state,
                                        value,
                                      ),
                                    })
                                  }
                                />
                              ))}
                              {model.thinkingLevelMap && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    patchModel(pi, mi, resetModelMap(model))
                                  }
                                  className="flex items-center gap-1 text-[11px] text-dim hover:text-secondary"
                                >
                                  <RotateCcw size={10} /> 全部恢复默认映射
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => addModel(pi)}
                    className="flex items-center gap-1 text-xs text-muted hover:text-primary"
                  >
                    <Plus size={12} /> 添加模型
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button
        onClick={addProvider}
        className="flex items-center gap-1 text-sm text-muted hover:text-primary"
      >
        <Plus size={14} /> 添加提供商
      </button>

      {errors.length > 0 && (
        <ul className="space-y-1 text-xs text-error">
          {errors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors disabled:opacity-60"
        >
          <Save size={14} />
          {saving ? "保存中…" : "保存 models.json"}
        </button>
        {saved && !needsRestart && (
          <span className="flex items-center gap-1.5 text-xs text-success">
            <RefreshCw size={12} />
            {activeRunning
              ? "已保存，空闲会话已应用"
              : "已保存，Pi 启动时生效"}
          </span>
        )}
        {saved && needsRestart && (
          <button
            onClick={() => void handleRestart()}
            className={clsx(
              "flex items-center gap-2 rounded-md border border-border-strong px-3 py-2 text-sm",
              "text-secondary hover:bg-surface-hover transition-colors",
            )}
          >
            <RefreshCw size={14} />
            已保存 — 当前会话忙碌，重启后生效
          </button>
        )}
      </div>
    </div>
  );
}

/** One level's three-state editor: default mapping / unsupported / custom value. */
function ThinkingMapRow({
  level,
  model,
  onChange,
}: {
  level: ThinkingLevel;
  model: CustomModel;
  onChange: (state: MapLevelState, value: string) => void;
}): React.JSX.Element {
  const state = mapLevelState(model.thinkingLevelMap, level);
  const value = typeof model.thinkingLevelMap?.[level] === "string"
    ? (model.thinkingLevelMap[level] as string)
    : "";
  const reasoningOff = model.reasoning !== true;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-16 shrink-0 font-mono text-muted">{level}</span>
      <select
        value={state}
        onChange={(e) => {
          const next = e.target.value as MapLevelState;
          // Keep the previous custom text when switching to 自定义 so an
          // accidental toggle does not wipe a typed value.
          onChange(next, value);
        }}
        className="rounded border border-border-strong bg-surface px-1.5 py-0.5 text-xs text-primary focus:border-focus focus:outline-none"
      >
        <option value="default">默认映射</option>
        <option value="unsupported">不支持</option>
        <option value="custom">自定义值</option>
      </select>
      {state === "custom" && (
        <input
          value={value}
          onChange={(e) => onChange("custom", e.target.value)}
          placeholder="发送给供应商的值"
          spellCheck={false}
          className={clsx(
            "min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-xs text-primary focus:border-focus focus:outline-none",
            value.trim().length === 0 && "border-warning",
          )}
        />
      )}
      {reasoningOff && (
        <span className="text-[10px] text-faint">
          模型未启用 reasoning 时仅 off 生效（映射保留）
        </span>
      )}
      {(level === "xhigh" || level === "max") && state === "default" && (
        <span className="text-[10px] text-faint">默认不可用</span>
      )}
    </div>
  );
}

function NumberInput({
  value,
  onValue,
}: {
  value: number | undefined;
  onValue: (value: number | undefined) => void;
}): React.JSX.Element {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) =>
        onValue(e.target.value === "" ? undefined : Number(e.target.value))
      }
      className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-xs text-primary focus:border-focus focus:outline-none"
    />
  );
}

function IconButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={clsx(
        "rounded p-1 text-dim hover:bg-surface-hover",
        danger ? "hover:text-error" : "hover:text-secondary",
      )}
    >
      {children}
    </button>
  );
}
