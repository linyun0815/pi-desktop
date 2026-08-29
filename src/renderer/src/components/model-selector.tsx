import { useState, useEffect, useRef, useMemo } from "react";
import { useAppStore } from "../store";
import { DEFAULT_AGENT_ENGINE_LABEL } from "../../../shared/agent-engine-label";
import type { ModelInfo } from "../../../shared/ipc-contracts";
import { filterModels } from "../utils/model-search";
import { clsx } from "clsx";
import {
  Cpu,
  ChevronDown,
  ChevronUp,
  Check,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react";

interface ModelSelectorProps {
  className?: string;
  /** Compact status-bar trigger (opens upward). */
  compact?: boolean;
  /**
   * `status` (default) renders the status-bar picker; `home` renders the
   * Home launcher block with the same searchable body, opening downward.
   */
  variant?: "status" | "home";
}

/**
 * Searchable model picker shared by the status bar and the Home launcher.
 * States per surface: no workspace → pick a project; starting → loading;
 * error → the startup failure; running → the searchable list (empty list
 * explains how models.json / env vars provide models).
 */
export function ModelSelector({
  className,
  compact = false,
  variant = "status",
}: ModelSelectorProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  const close = (): void => setIsOpen(false);

  const home = variant === "home";

  return (
    <div ref={ref} className={clsx("relative", className)}>
      <ModelTrigger
        home={home}
        compact={compact}
        isOpen={isOpen}
        onToggle={() => setIsOpen((open) => !open)}
      />
      {isOpen && <ModelPickerBody home={home} onClose={close} />}
    </div>
  );
}

function ModelTrigger({
  home,
  compact,
  isOpen,
  onToggle,
}: {
  home: boolean;
  compact: boolean;
  isOpen: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState);
  const piStatus = useAppStore((state) => state.piStatus);
  const settings = useAppStore((state) => state.settings);
  // The desktop embeds Pi; the label is a constant.
  const engineLabel: string = DEFAULT_AGENT_ENGINE_LABEL;

  const currentModel = sessionState?.model;
  const label =
    currentModel?.name ??
    (settings?.defaultModel
      ? settings.defaultProvider
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : settings.defaultModel
      : "选择模型");

  if (home) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-lg border border-border-strong bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong-hover hover:bg-surface-hover"
        title={`选择模型（${engineLabel} 运行时按 Ctrl+P 切换）`}
        aria-label="选择模型"
        aria-expanded={isOpen}
      >
        <Cpu size={16} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-primary">
            {label}
          </div>
          <div className="truncate text-xs text-dim">
            {currentModel
              ? `${currentModel.provider} · ${currentModel.id}`
              : piStatus === "running"
                ? "选择此会话使用的模型"
                : "默认模型 — 启动后可随时切换"}
          </div>
        </div>
        <ChevronDown
          size={14}
          className={clsx(
            "shrink-0 text-dim transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      className={clsx(
        "flex h-6 max-w-52 items-center gap-1 rounded-md px-2 text-[11px] transition-colors active:scale-[0.98]",
        isOpen
          ? "bg-surface-hover text-primary"
          : "text-dim hover:bg-surface-hover hover:text-secondary",
        compact && "max-w-36",
      )}
      title={`选择模型（${engineLabel} 运行时按 Ctrl+P 切换）`}
      aria-label="选择模型"
      aria-expanded={isOpen}
    >
      <Cpu size={10} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <ChevronUp
        size={10}
        className={clsx(
          "shrink-0 transition-transform",
          isOpen && "rotate-180",
        )}
      />
    </button>
  );
}

function ModelPickerBody({
  home,
  onClose,
}: {
  home: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState);
  const piStatus = useAppStore((state) => state.piStatus);
  const piError = useAppStore((state) => state.piError);
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const setModel = useAppStore((state) => state.setModel);
  const ensurePiStarted = useAppStore((state) => state.ensurePiStarted);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const currentModel = sessionState?.model;

  const loadModels = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = (await window.piDesktop.model.listAvailable()) as {
        success?: boolean;
        data?: { models?: ModelInfo[] };
      } | null;
      if (response?.success && response.data?.models) {
        setModels(response.data.models);
      } else {
        setModels([]);
      }
    } catch {
      setModels([]);
      setError("无法加载模型");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (piStatus === "running") {
      void loadModels();
      return;
    }
    // Opening the picker is itself a valid first action. If the background boot
    // has not reached the helper yet, kick off the same single-flight start so
    // the user never has to send a message just to unlock model selection.
    if (activeWorkspace && piStatus === "stopped") void ensurePiStarted();
  }, [activeWorkspace, ensurePiStarted, piStatus]);

  useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const filteredModels = useMemo(
    () => filterModels(models, query),
    [models, query],
  );

  const handleSelect = async (model: ModelInfo): Promise<void> => {
    if (useAppStore.getState().piStatus === "running") {
      if (!(await setModel(model.provider, model.id))) return;
    } else {
      // Persist preferred model for the next Pi start.
      try {
        const updated = await window.piDesktop.settings.save({
          defaultProvider: model.provider,
          defaultModel: model.id,
        });
        useAppStore.setState({ settings: updated });
      } catch {
        setError("无法保存模型选择");
        return;
      }
    }
    onClose();
  };

  const notRunningHint = !activeWorkspace
    ? "选择一个项目后即可选择模型。"
    : null;

  return (
    <div
      className={clsx(
        "absolute z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40 animate-fade-in",
        home ? "left-0 top-full mt-1" : "bottom-full right-0 mb-1",
      )}
    >
      {currentModel && (
        <div className="border-b border-border px-3 py-2">
          <div className="text-xs text-muted">当前模型</div>
          <div className="text-sm font-medium text-primary">
            {currentModel.name}
          </div>
          <div className="mt-0.5 text-xs text-dim">
            {currentModel.provider} · {currentModel.id}
          </div>
        </div>
      )}

      {piStatus !== "running" && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-dim">
          {notRunningHint ? (
            <span>{notRunningHint}</span>
          ) : piStatus === "starting" ? (
            <>
              <Loader2 size={12} className="shrink-0 animate-spin" />
              <span>Pi 正在启动，就绪后即可选择模型…</span>
            </>
          ) : piStatus === "error" ? (
            <>
              <span className="min-w-0 flex-1 truncate text-error">
                {piError ?? "Pi 启动失败"}
              </span>
              <button
                type="button"
                onClick={() => void ensurePiStarted()}
                className="flex shrink-0 items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 hover:bg-surface-hover"
                title="重试启动 Pi"
              >
                <RefreshCw size={10} />
                重试
              </button>
            </>
          ) : (
            <span>启动 Pi 后才能列出并切换模型。</span>
          )}
        </div>
      )}

      {piStatus === "running" && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search size={12} className="shrink-0 text-dim" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型…"
              className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-faint"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-dim">
                <Loader2 size={12} className="animate-spin" />
                加载中…
              </div>
            )}
            {error && (
              <div className="px-3 py-2 text-xs text-error">{error}</div>
            )}
            {!loading && !error && models.length === 0 && (
              <div className="flex items-start gap-1.5 px-3 py-2 text-xs text-dim">
                <Settings2 size={12} className="mt-0.5 shrink-0" />
                <span>
                  没有可用模型。可在 设置 → 自定义模型 中编辑
                  models.json，或通过环境变量配置提供商凭据后重启 Pi。
                </span>
              </div>
            )}
            {!loading &&
              !error &&
              models.length > 0 &&
              filteredModels.length === 0 && (
                <div className="px-3 py-2 text-xs text-dim">没有匹配的模型</div>
              )}
            {filteredModels.map((model) => {
              const selected =
                currentModel?.id === model.id &&
                currentModel?.provider === model.provider;
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  onClick={() => void handleSelect(model)}
                  className={clsx(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover transition-colors",
                    selected && "bg-card",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-primary">{model.name}</div>
                    <div className="truncate text-xs text-dim">
                      {model.provider} · {model.id}
                    </div>
                  </div>
                  {selected && (
                    <Check size={12} className="shrink-0 text-success" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
