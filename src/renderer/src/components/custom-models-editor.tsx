import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  EyeOff,
  Layers,
  ListPlus,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../store";
import { withImageInput } from "../../../shared/models-config";
import type {
  ModelCatalogLookupResult,
  ModelDiscoveryModel,
  ModelDiscoveryResult,
} from "../../../shared/ipc-contracts";
import { formatIpcError } from "../utils/ipc-error";
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../../shared/model-thinking";
import {
  API_OPTIONS,
  COST_RATES,
  DISCOVERY_LIST_LIMIT,
  allocateRowId,
  applyCatalogLookupResult,
  configToRows,
  costRateLabel,
  filterDiscoveryModels,
  mapLevelState,
  resetModelMap,
  rowsToConfig,
  validateRows,
  withMapLevel,
  withStableRowIds,
  type CatalogLookupStatus,
  type CostRateKey,
  type MapLevelState,
  type ModelCostDraft,
  type ModelRow,
  type ProviderRow,
} from "./custom-models-editor-helpers";

/**
 * Custom models editor (~/.pi/agent/models.json).
 *
 * Providers render as collapsed cards (name, API, base URL, model count,
 * delete); each model lays out in aligned rows — required id/name, numeric
 * windows + capability toggles, four optional price inputs (USD per million
 * tokens), then a collapsible per-level thinking map. Every row carries a
 * catalog-fill button (models.dev lookup, blanks only) and every provider a
 * discovery panel (its /models endpoint, searchable, batch-filled with
 * bounded concurrency). All conversion and validation lives in
 * custom-models-editor-helpers.ts and is unit-tested; this component holds
 * only expand/collapse, lookup and discovery UI state, which never reaches
 * the written file.
 */

// Expand/collapse, key visibility, lookup and discovery state are keyed by the
// rows' stable local ids, so inserts/deletes/reorders (and a save that re-reads
// the file) do not misplace what the user had open.
const inputClass =
  "rounded border border-border-strong bg-surface px-2 py-1 text-sm text-primary focus:border-focus focus:outline-none";

const IDLE_LOOKUP: CatalogLookupStatus = { state: "idle" };
const IDLE_DISCOVERY: DiscoveryState = { state: "idle" };

/** Concurrent catalog lookups while batch-filling discovered models. */
const LOOKUP_CONCURRENCY = 4;

/** Per-provider discovery panel state (local UI only; never saved). */
type DiscoveryState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      models: ModelDiscoveryModel[];
      query: string;
      selected: Set<string>;
      limit: number;
      /** Catalog lookups still running for the last batch of added models. */
      pending: number;
      /** Size of the last batch. */
      total: number;
    };

type ReadyDiscovery = Extract<DiscoveryState, { state: "ready" }>;

function lookupStatusClass(status: CatalogLookupStatus): string {
  switch (status.state) {
    case "success":
      return "text-success";
    case "no-match":
      return "text-dim";
    case "unreliable":
      return "text-warning";
    case "error":
      return "text-error";
    default:
      return "text-dim";
  }
}

/** Read one price rate out of a (possibly junk) cost draft for the input. */
function costDraftRate(
  cost: ModelCostDraft | undefined,
  rate: CostRateKey,
): number | undefined {
  if (typeof cost !== "object" || cost === null) return undefined;
  const value = (cost as Record<string, unknown>)[rate];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

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
  // Mirrored ref every mutation updates synchronously: a catalog response
  // arriving after further edits merges into the LATEST row values, not the
  // snapshot from when the request was issued.
  const rowsRef = useRef<ProviderRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openProviders, setOpenProviders] = useState<Set<string>>(new Set());
  const [openMaps, setOpenMaps] = useState<Set<string>>(new Set());
  const [showKeyFor, setShowKeyFor] = useState<Set<string>>(new Set());
  // Per-model-row catalog lookup status, keyed by the model row's stable id.
  const [lookupStates, setLookupStates] = useState<
    Record<string, CatalogLookupStatus>
  >({});
  // Per-provider discovery panel state, keyed by the provider row's stable id.
  const [discoveries, setDiscoveries] = useState<
    Record<string, DiscoveryState>
  >({});

  useEffect(() => {
    loadCustomModels();
  }, [loadCustomModels]);

  useEffect(() => {
    // Rebuilding from a (re)loaded file reuses previous row ids where the
    // provider key / model id still match, so saving does not collapse what
    // the user had open; genuinely new rows keep the fresh ids they got.
    const next = withStableRowIds(configToRows(customModels), rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  }, [customModels]);

  const setRowsNext = (next: ProviderRow[]): void => {
    rowsRef.current = next;
    setRows(next);
    setSaved(false);
  };

  const mutateRows = (fn: (prev: ProviderRow[]) => ProviderRow[]): void =>
    setRowsNext(fn(rowsRef.current));

  const addProvider = (): void =>
    mutateRows((prev) => [
      ...prev,
      {
        rowId: allocateRowId(),
        key: "",
        baseUrl: "",
        api: API_OPTIONS[0],
        apiKey: "",
        compat: undefined,
        models: [],
      },
    ]);

  const removeProvider = (rowId: string): void => {
    const removed = rowsRef.current.find((r) => r.rowId === rowId);
    mutateRows((prev) => prev.filter((r) => r.rowId !== rowId));
    if (removed) {
      setLookupStates((prev) => {
        const next = { ...prev };
        for (const m of removed.models) delete next[m.rowId];
        return next;
      });
    }
    setDiscoveries((prev) => {
      if (!(rowId in prev)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    setOpenProviders((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
    setShowKeyFor((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
  };

  const patchProvider = (rowId: string, patch: Partial<ProviderRow>): void =>
    mutateRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );

  const patchProviderCompat = (
    rowId: string,
    patch: NonNullable<ProviderRow["compat"]>,
  ): void =>
    mutateRows((prev) =>
      prev.map((r) =>
        r.rowId === rowId
          ? { ...r, compat: { ...(r.compat ?? {}), ...patch } }
          : r,
      ),
    );

  const addModel = (providerRowId: string): void =>
    mutateRows((prev) =>
      prev.map((r) =>
        r.rowId === providerRowId
          ? { ...r, models: [...r.models, { id: "", rowId: allocateRowId() }] }
          : r,
      ),
    );

  const patchModel = (
    providerRowId: string,
    modelRowId: string,
    patch: Partial<ModelRow>,
  ): void =>
    mutateRows((prev) =>
      prev.map((r) =>
        r.rowId === providerRowId
          ? {
              ...r,
              models: r.models.map((m) =>
                m.rowId === modelRowId ? { ...m, ...patch } : m,
              ),
            }
          : r,
      ),
    );

  const removeModel = (providerRowId: string, modelRowId: string): void => {
    mutateRows((prev) =>
      prev.map((r) =>
        r.rowId === providerRowId
          ? { ...r, models: r.models.filter((m) => m.rowId !== modelRowId) }
          : r,
      ),
    );
    setLookupStates((prev) => {
      if (!(modelRowId in prev)) return prev;
      const next = { ...prev };
      delete next[modelRowId];
      return next;
    });
    setOpenMaps((prev) => {
      if (!prev.has(modelRowId)) return prev;
      const next = new Set(prev);
      next.delete(modelRowId);
      return next;
    });
  };

  const setCostRate = (
    providerRowId: string,
    modelRowId: string,
    rate: CostRateKey,
    value: number | undefined,
  ): void =>
    mutateRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== providerRowId) return r;
        return {
          ...r,
          models: r.models.map((m) => {
            if (m.rowId !== modelRowId) return m;
            // An empty input means "not configured" (the rate is deleted);
            // the draft object itself stays so clearing every rate still
            // reaches the merge as an explicit cost removal.
            const base: ModelCostDraft =
              typeof m.cost === "object" &&
              m.cost !== null &&
              !Array.isArray(m.cost)
                ? m.cost
                : {};
            const nextCost: ModelCostDraft = { ...base };
            if (value === undefined) delete nextCost[rate];
            else nextCost[rate] = value;
            return { ...m, cost: nextCost };
          }),
        };
      }),
    );

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

  /** Apply one lookup response to the current rows + record the row status. */
  const applyLookupResult = (
    providerRowId: string,
    modelRowId: string,
    result: ModelCatalogLookupResult,
  ): void => {
    const outcome = applyCatalogLookupResult(
      rowsRef.current,
      providerRowId,
      modelRowId,
      result,
    );
    if (outcome.rows !== rowsRef.current) setRowsNext(outcome.rows);
    setLookupStates((prev) => ({ ...prev, [modelRowId]: outcome.status }));
  };

  const lookupProviderId = (providerRowId: string): string | undefined => {
    const provider = rowsRef.current.find((r) => r.rowId === providerRowId);
    const key = provider?.key.trim() ?? "";
    return key.length > 0 ? key : undefined;
  };

  const lookupBaseUrl = (providerRowId: string): string | undefined => {
    const provider = rowsRef.current.find((r) => r.rowId === providerRowId);
    const baseUrl = provider?.baseUrl.trim() ?? "";
    return baseUrl.length > 0 ? baseUrl : undefined;
  };

  /** Catalog fill for one model row: idle → loading → status. */
  const lookupModel = async (
    providerRowId: string,
    modelRowId: string,
  ): Promise<void> => {
    if (lookupStates[modelRowId]?.state === "loading") return;
    const provider = rowsRef.current.find((r) => r.rowId === providerRowId);
    const model = provider?.models.find((m) => m.rowId === modelRowId);
    const modelId = model?.id.trim() ?? "";
    if (modelId.length === 0) return;
    setLookupStates((prev) => ({
      ...prev,
      [modelRowId]: { state: "loading" },
    }));
    let result: ModelCatalogLookupResult;
    try {
      result = await window.piDesktop.models.catalogLookup({
        modelId,
        providerId: lookupProviderId(providerRowId),
        baseUrl: lookupBaseUrl(providerRowId),
      });
    } catch (err) {
      result = { ok: false, error: formatIpcError(err) };
    }
    applyLookupResult(providerRowId, modelRowId, result);
  };

  const patchDiscovery = (
    providerRowId: string,
    patch: (state: DiscoveryState) => DiscoveryState,
  ): void =>
    setDiscoveries((prev) => {
      const current = prev[providerRowId];
      if (!current) return prev;
      return { ...prev, [providerRowId]: patch(current) };
    });

  /** Discover a provider's model list via its /models endpoint. */
  const discoverModels = async (providerRowId: string): Promise<void> => {
    const provider = rowsRef.current.find((r) => r.rowId === providerRowId);
    if (!provider) return;
    const providerId = provider.key.trim();
    if (providerId.length === 0) {
      setDiscoveries((prev) => ({
        ...prev,
        [providerRowId]: { state: "error", message: "请先填写提供商键名" },
      }));
      return;
    }
    setDiscoveries((prev) => ({
      ...prev,
      [providerRowId]: { state: "loading" },
    }));
    let result: ModelDiscoveryResult;
    try {
      result = await window.piDesktop.models.discover({
        providerId,
        baseUrl: lookupBaseUrl(providerRowId),
        api: provider.api.trim().length > 0 ? provider.api.trim() : undefined,
        // The draft key is handed to main for this one-off request only; it is
        // never rendered, logged, or included in any error text below.
        apiKey: provider.apiKey.length > 0 ? provider.apiKey : null,
      });
    } catch (err) {
      result = { ok: false, error: formatIpcError(err) };
    }
    if (!result.ok) {
      setDiscoveries((prev) => ({
        ...prev,
        [providerRowId]: { state: "error", message: result.error },
      }));
      return;
    }
    setDiscoveries((prev) => ({
      ...prev,
      [providerRowId]: {
        state: "ready",
        models: result.models,
        query: "",
        selected: new Set<string>(),
        limit: DISCOVERY_LIST_LIMIT,
        pending: 0,
        total: 0,
      },
    }));
  };

  /**
   * Catalog-fill every newly added model row with bounded concurrency; each
   * response merges into the current rows (see applyLookupResult).
   */
  const runBatchLookups = async (
    providerRowId: string,
    added: ModelRow[],
  ): Promise<void> => {
    const jobs = added
      .map((m) => ({ modelRowId: m.rowId, modelId: m.id.trim() }))
      .filter((j) => j.modelId.length > 0);
    if (jobs.length === 0) return;
    patchDiscovery(providerRowId, (d) =>
      d.state === "ready"
        ? { ...d, pending: jobs.length, total: jobs.length }
        : d,
    );
    const queue = [...jobs];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) break;
        let result: ModelCatalogLookupResult;
        try {
          result = await window.piDesktop.models.catalogLookup({
            modelId: job.modelId,
            providerId: lookupProviderId(providerRowId),
            baseUrl: lookupBaseUrl(providerRowId),
          });
        } catch (err) {
          result = { ok: false, error: formatIpcError(err) };
        }
        applyLookupResult(providerRowId, job.modelRowId, result);
        patchDiscovery(providerRowId, (d) =>
          d.state === "ready"
            ? { ...d, pending: Math.max(0, d.pending - 1) }
            : d,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(LOOKUP_CONCURRENCY, jobs.length) },
        worker,
      ),
    );
  };

  /** Add the selected discovered models (dedup by id) and batch-fill them. */
  const addDiscoveredModels = (providerRowId: string): void => {
    const discovery = discoveries[providerRowId];
    if (!discovery || discovery.state !== "ready") return;
    if (discovery.selected.size === 0) return;
    const picked = discovery.models.filter((m) =>
      discovery.selected.has(m.id),
    );
    const existing = new Set(
      (rowsRef.current
        .find((r) => r.rowId === providerRowId)
        ?.models.map((m) => m.id.trim()) ?? []).filter((id) => id.length > 0),
    );
    // Only ids the provider does not have yet are added; the API's display
    // name lands in the new row's blank name field.
    const fresh: ModelRow[] = picked
      .filter((m) => !existing.has(m.id.trim()))
      .map((m) => ({
        id: m.id,
        ...(typeof m.name === "string" && m.name.trim().length > 0
          ? { name: m.name }
          : {}),
        rowId: allocateRowId(),
      }));
    patchDiscovery(providerRowId, (d) =>
      d.state === "ready" ? { ...d, selected: new Set<string>() } : d,
    );
    if (fresh.length === 0) return;
    mutateRows((prev) =>
      prev.map((r) =>
        r.rowId === providerRowId
          ? { ...r, models: [...r.models, ...fresh] }
          : r,
      ),
    );
    void runBatchLookups(providerRowId, fresh);
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

      {rows.map((row) => {
        const open = openProviders.has(row.rowId);
        const discovery = discoveries[row.rowId] ?? IDLE_DISCOVERY;
        const existingIds = new Set(
          row.models.map((m) => m.id.trim()).filter((id) => id.length > 0),
        );
        return (
          <div
            key={row.rowId}
            className="rounded-md border border-border bg-surface/50"
          >
            {/* Provider header: identity at a glance + delete, click to expand. */}
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() =>
                  toggleSet(openProviders, row.rowId, setOpenProviders)
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
                onClick={() => removeProvider(row.rowId)}
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
                        patchProvider(row.rowId, { key: e.target.value })
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
                        patchProvider(row.rowId, { api: e.target.value })
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
                        patchProvider(row.rowId, { baseUrl: e.target.value })
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
                        type={showKeyFor.has(row.rowId) ? "text" : "password"}
                        value={row.apiKey}
                        onChange={(e) =>
                          patchProvider(row.rowId, { apiKey: e.target.value })
                        }
                        placeholder="直接值、$ENV_VAR 或 !命令"
                        autoComplete="off"
                        spellCheck={false}
                        className={clsx(inputClass, "min-w-0 flex-1 font-mono")}
                      />
                      <IconButton
                        onClick={() =>
                          toggleSet(showKeyFor, row.rowId, setShowKeyFor)
                        }
                        title={
                          showKeyFor.has(row.rowId) ? "隐藏 Key" : "显示 Key"
                        }
                      >
                        {showKeyFor.has(row.rowId) ? (
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
                      patchProviderCompat(row.rowId, {
                        supportsReasoningEffort: e.target.checked,
                      })
                    }
                    className="accent-accent"
                  />
                  提供商支持思考强度（reasoning effort）
                </label>

                <div className="space-y-2">
                  {/* Discovery: fetch the provider's model list, pick, add. */}
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void discoverModels(row.rowId)}
                      disabled={discovery.state === "loading"}
                      className="flex items-center gap-1 text-xs text-muted hover:text-primary disabled:opacity-60"
                      title="通过提供商 /models 接口获取可添加的模型列表"
                    >
                      {discovery.state === "loading" ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Radar size={12} />
                      )}
                      {discovery.state === "loading" ? "发现模型中…" : "发现模型"}
                    </button>
                    {discovery.state === "ready" && discovery.pending > 0 && (
                      <span className="flex items-center gap-1 text-[11px] text-dim">
                        <Loader2 size={11} className="animate-spin" />
                        正在查询目录 {discovery.total - discovery.pending}/
                        {discovery.total}
                      </span>
                    )}
                  </div>
                  {discovery.state === "error" && (
                    <div className="flex flex-wrap items-center gap-2 rounded border border-border-strong bg-surface px-2 py-1.5 text-xs text-warning">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 break-all">
                        {discovery.message}
                      </span>
                      <button
                        type="button"
                        onClick={() => void discoverModels(row.rowId)}
                        className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-secondary hover:bg-surface-hover"
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {discovery.state === "ready" && (
                    <DiscoveryPanel
                      discovery={discovery}
                      existingIds={existingIds}
                      onQuery={(query) =>
                        patchDiscovery(row.rowId, (d) =>
                          d.state === "ready" ? { ...d, query } : d,
                        )
                      }
                      onToggle={(id) =>
                        patchDiscovery(row.rowId, (d) => {
                          if (d.state !== "ready") return d;
                          const selected = new Set(d.selected);
                          if (selected.has(id)) selected.delete(id);
                          else selected.add(id);
                          return { ...d, selected };
                        })
                      }
                      onMore={() =>
                        patchDiscovery(row.rowId, (d) =>
                          d.state === "ready"
                            ? { ...d, limit: d.limit + DISCOVERY_LIST_LIMIT }
                            : d,
                        )
                      }
                      onAdd={() => addDiscoveredModels(row.rowId)}
                    />
                  )}

                  {row.models.map((model) => {
                    const lookup =
                      lookupStates[model.rowId] ?? IDLE_LOOKUP;
                    const mapOpen = openMaps.has(model.rowId);
                    return (
                      <div
                        key={model.rowId}
                        className="rounded border border-border bg-surface p-2.5"
                      >
                        {/* Row 1: required identity + catalog fill. */}
                        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                          <input
                            value={model.id ?? ""}
                            onChange={(e) =>
                              patchModel(row.rowId, model.rowId, {
                                id: e.target.value,
                              })
                            }
                            placeholder="模型 ID（必填）"
                            className={clsx(inputClass, "text-xs")}
                          />
                          <input
                            value={model.name ?? ""}
                            onChange={(e) =>
                              patchModel(row.rowId, model.rowId, {
                                name: e.target.value,
                              })
                            }
                            placeholder="显示名称"
                            className={clsx(inputClass, "text-xs")}
                          />
                          <div className="flex items-center gap-1">
                            {model.id.trim().length > 0 && (
                              <IconButton
                                onClick={() =>
                                  void lookupModel(row.rowId, model.rowId)
                                }
                                disabled={lookup.state === "loading"}
                                title="从模型目录填充空白字段（名称/窗口/价格等）"
                              >
                                {lookup.state === "loading" ? (
                                  <Loader2
                                    size={12}
                                    className="animate-spin"
                                  />
                                ) : (
                                  <Sparkles size={12} />
                                )}
                              </IconButton>
                            )}
                            <IconButton
                              onClick={() =>
                                removeModel(row.rowId, model.rowId)
                              }
                              title="移除模型"
                              danger
                            >
                              <Trash2 size={12} />
                            </IconButton>
                          </div>
                        </div>
                        {lookup.state !== "idle" && (
                          <p
                            className={clsx(
                              "mt-1 break-words text-[10px]",
                              lookupStatusClass(lookup),
                            )}
                          >
                            {lookup.state === "loading"
                              ? "正在查询模型目录…"
                              : lookup.message}
                          </p>
                        )}

                        {/* Row 2: windows + capabilities, fixed-width inputs. */}
                        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <label className="flex items-center gap-1.5 text-[11px] text-dim">
                            上下文窗口
                            <NumberInput
                              value={model.contextWindow}
                              onValue={(v) =>
                                patchModel(row.rowId, model.rowId, {
                                  contextWindow: v,
                                })
                              }
                            />
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] text-dim">
                            最大输出
                            <NumberInput
                              value={model.maxTokens}
                              onValue={(v) =>
                                patchModel(row.rowId, model.rowId, {
                                  maxTokens: v,
                                })
                              }
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[11px] text-dim">
                            <input
                              type="checkbox"
                              checked={model.reasoning ?? false}
                              onChange={(e) =>
                                patchModel(row.rowId, model.rowId, {
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
                                patchModel(row.rowId, model.rowId, {
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

                        {/* Row 2.5: optional prices; blank = not configured, 0 = free. */}
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-dim">
                          <span className="shrink-0">
                            价格（美元/百万 token）
                          </span>
                          {COST_RATES.map((rate) => (
                            <label
                              key={rate}
                              className="flex min-w-0 items-center gap-1"
                            >
                              {costRateLabel(rate)}
                              <NumberInput
                                value={costDraftRate(model.cost, rate)}
                                onValue={(v) =>
                                  setCostRate(
                                    row.rowId,
                                    model.rowId,
                                    rate,
                                    v,
                                  )
                                }
                              />
                            </label>
                          ))}
                        </div>

                        {/* Row 3: collapsible thinking-level map. */}
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() =>
                              toggleSet(openMaps, model.rowId, setOpenMaps)
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
                              Object.keys(model.thinkingLevelMap).length >
                                0 && (
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
                                    patchModel(row.rowId, model.rowId, {
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
                                    patchModel(
                                      row.rowId,
                                      model.rowId,
                                      resetModelMap(model),
                                    )
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
                    onClick={() => addModel(row.rowId)}
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

/** Searchable picker over one provider's discovered models (local filter). */
function DiscoveryPanel({
  discovery,
  existingIds,
  onQuery,
  onToggle,
  onMore,
  onAdd,
}: {
  discovery: ReadyDiscovery;
  existingIds: Set<string>;
  onQuery: (query: string) => void;
  onToggle: (id: string) => void;
  onMore: () => void;
  onAdd: () => void;
}): React.JSX.Element {
  const filtered = filterDiscoveryModels(discovery.models, discovery.query);
  const shown = filtered.slice(0, discovery.limit);
  return (
    <div className="space-y-2 rounded border border-border bg-card/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={discovery.query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="筛选模型 ID 或名称…"
          className={clsx(inputClass, "min-w-0 flex-1 text-xs")}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={discovery.selected.size === 0}
          className="flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50"
          title="添加所选模型（已存在的 ID 自动跳过）"
        >
          <ListPlus size={12} /> 添加所选（{discovery.selected.size}）
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-[11px] text-faint">没有匹配的模型</p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          {shown.map((m) => {
            const exists = existingIds.has(m.id.trim());
            return (
              <label
                key={m.id}
                className={clsx(
                  "flex items-center gap-2 rounded px-1.5 py-1 text-xs",
                  exists
                    ? "text-faint"
                    : "cursor-pointer hover:bg-surface-hover",
                )}
              >
                <input
                  type="checkbox"
                  checked={discovery.selected.has(m.id)}
                  disabled={exists}
                  onChange={() => onToggle(m.id)}
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-primary">
                  {m.id}
                </span>
                {m.name && (
                  <span className="hidden min-w-0 max-w-[40%] truncate text-dim sm:inline">
                    {m.name}
                  </span>
                )}
                {exists && (
                  <span className="shrink-0 text-[10px] text-faint">
                    已添加
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-faint">
        <span>
          第 1-{shown.length} / 共 {filtered.length}
        </span>
        {filtered.length > discovery.limit && (
          <button
            type="button"
            onClick={onMore}
            className="text-muted hover:text-primary"
          >
            显示更多
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
  model: ModelRow;
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
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={clsx(
        "rounded p-1 text-dim hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
        danger ? "hover:text-error" : "hover:text-secondary",
      )}
    >
      {children}
    </button>
  );
}
