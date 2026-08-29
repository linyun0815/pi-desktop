import { useState, useEffect } from "react";
import { DEFAULT_AGENT_ENGINE_LABEL } from "../../../shared/agent-engine-label";
import {
  useAppStore,
  countPromptsWaitingElsewhere,
  formatPromptsWaiting,
} from "../store";
import { localizedStatus } from "../utils/ui-text";
import { clsx } from "clsx";
import {
  PanelLeft,
  PanelLeftClose,
  Terminal,
  DollarSign,
  Layers,
  Minimize2,
  Settings,
  Loader2,
  GitBranch,
  Workflow as WorkflowIcon,
} from "lucide-react";

export function StatusBar(): React.JSX.Element {
  const piStatus = useAppStore((state) => state.piStatus);
  const piPid = useAppStore((state) => state.piPid);
  // The desktop embeds Pi; the label is a constant.
  const engineLabel: string = DEFAULT_AGENT_ENGINE_LABEL;
  const sessionStats = useAppStore((state) => state.sessionStats);
  const isStreaming = useAppStore((state) => state.isStreaming);
  const pendingSteering = useAppStore((state) => state.pendingSteering);
  const pendingFollowUp = useAppStore((state) => state.pendingFollowUp);
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const compactContext = useAppStore((state) => state.compactContext);
  const isCompacting = useAppStore(
    (state) => state.sessionState?.isCompacting ?? false,
  );
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const pendingPromptCounts = useAppStore((state) => state.pendingPromptCounts);
  const workflowPanelOpen = useAppStore((state) => state.workflowPanelOpen);
  const workflowRuns = useAppStore((state) => state.workflowRuns);
  const activeWorkflowCount = workflowRuns.filter(
    (run) =>
      (!activeWorkspace || run.workspaceId === activeWorkspace.id) &&
      (run.status === "running" || run.status === "paused"),
  ).length;

  // Blocking prompts held for OTHER workspaces (any extension's select/
  // confirm/input/editor) — the active workspace's prompt is already on screen.
  const promptsWaitingElsewhere = countPromptsWaitingElsewhere(
    pendingPromptCounts,
    activeWorkspace?.id ?? null,
  );

  // Current git branch of the active workspace. Refreshed when the workspace
  // changes and when the window regains focus (branch switches outside the app).
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      window.piDesktop.files
        .getGitBranch()
        .then((b) => {
          if (!cancelled) setGitBranch(b);
        })
        .catch(() => {
          if (!cancelled) setGitBranch(null);
        });
    };
    load();
    const onFocus = (): void => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [activeWorkspace?.id]);

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-app px-3 text-xs">
      {/* Left section */}
      <div className="flex items-center gap-3">
        {/* Pi Status */}
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              piStatus === "running" && "bg-success",
              piStatus === "starting" && "bg-warning animate-pulse",
              piStatus === "error" && "bg-error",
              piStatus === "stopped" && "bg-elevated",
            )}
          />
          <span className="text-dim">
            {piStatus === "running"
              ? `${engineLabel} 运行中（PID：${piPid}）`
              : `${engineLabel} ${localizedStatus(piStatus)}`}
          </span>
        </div>

        {/* Git branch of the active workspace */}
        {gitBranch && (
          <div
            className="flex items-center gap-1 text-dim"
            title={`Git 分支：${gitBranch}`}
          >
            <GitBranch size={11} />
            <span>{gitBranch}</span>
          </div>
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-1 text-accent-fg">
            <Loader2 size={10} className="animate-spin" />
            <span>生成中</span>
          </div>
        )}

        {/* Queue indicators */}
        {pendingSteering.length > 0 && (
          <span className="text-warning">
            {pendingSteering.length} 条引导消息排队
          </span>
        )}
        {pendingFollowUp.length > 0 && (
          <span className="text-warning">
            {pendingFollowUp.length} 条后续消息排队
          </span>
        )}

        {/* Prompts held for other workspaces (switch back to answer them) */}
        {promptsWaitingElsewhere > 0 && (
          <span
            className="text-warning"
            title={`${engineLabel} 正在其他工作区等待提示，请切换过去回答`}
          >
            {formatPromptsWaiting(promptsWaitingElsewhere)}
          </span>
        )}
      </div>

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Dedicated workflow navigator */}
        <button
          data-workflow-toggle="true"
          onClick={() => {
            // Session-surface button: opens the active session's runs (scoped by
            // Pi's header UUID, the exact identifier persisted runs carry). The
            // global list is only a fallback for the no-session state; closing
            // preserves the scope so a close/reopen stays in-session.
            const state = useAppStore.getState();
            if (state.workflowPanelOpen) state.setWorkflowPanelOpen(false);
            else if (state.sessionState?.sessionId)
              state.openWorkflowRunsForSession(state.sessionState.sessionId);
            else state.setWorkflowPanelOpen(true);
          }}
          className={clsx(
            "flex items-center gap-1 transition-colors",
            workflowPanelOpen || activeWorkflowCount > 0
              ? "text-accent-fg"
              : "text-dim hover:text-secondary",
          )}
          title="打开工作流运行记录"
          aria-label="打开工作流运行记录"
        >
          <WorkflowIcon size={11} />
          <span>
            {activeWorkflowCount > 0
              ? `${activeWorkflowCount} 个工作流`
              : "工作流"}
          </span>
        </button>

        {/* Token usage */}
        {sessionStats?.contextUsage && (
          <div
            className="flex items-center gap-1 text-dim"
            title={`上下文：${sessionStats.contextUsage.tokens?.toLocaleString() ?? "?"} / ${sessionStats.contextUsage.contextWindow.toLocaleString()} 个 token`}
          >
            <Layers size={10} />
            <span>
              {Number.isFinite(sessionStats.contextUsage.percent)
                ? `${Math.round(sessionStats.contextUsage.percent as number)}%`
                : "0%"}
            </span>
          </div>
        )}

        {/* Compact context */}
        {sessionStats?.contextUsage && (
          <button
            onClick={() => compactContext()}
            disabled={isCompacting}
            className="flex items-center gap-1 text-dim hover:text-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="压缩上下文，概括对话以释放空间"
          >
            {isCompacting ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Minimize2 size={10} />
            )}
            <span>{isCompacting ? "压缩中…" : "压缩上下文"}</span>
          </button>
        )}

        {/* Cost */}
        {sessionStats?.cost !== undefined && sessionStats.cost > 0 && (
          <div className="flex items-center gap-1 text-dim">
            <DollarSign size={10} />
            <span>${sessionStats.cost.toFixed(2)}</span>
          </div>
        )}

        {/* Toggle sidebar */}
        <button
          onClick={toggleSidebar}
          className="rounded p-0.5 text-dim hover:text-secondary transition-colors"
          title={sidebarOpen ? "隐藏侧边栏" : "显示侧边栏"}
          aria-label={sidebarOpen ? "隐藏侧边栏" : "显示侧边栏"}
        >
          {sidebarOpen ? <PanelLeftClose size={12} /> : <PanelLeft size={12} />}
        </button>

        {/* Toggle terminal */}
        <button
          onClick={toggleTerminal}
          className={clsx(
            "rounded p-0.5 transition-colors",
            terminalOpen ? "text-accent-fg" : "text-dim hover:text-secondary",
          )}
          title={terminalOpen ? "隐藏终端" : "显示终端"}
          aria-label={terminalOpen ? "隐藏终端" : "显示终端"}
        >
          <Terminal size={12} />
        </button>

        {/* Settings */}
        <button
          onClick={() => setCurrentView("settings")}
          className="rounded p-0.5 text-dim hover:text-secondary transition-colors"
          title="设置"
          aria-label="设置"
        >
          <Settings size={12} />
        </button>
      </div>
    </div>
  );
}
