import {
  AlertCircle,
  CheckCircle2,
  FileSearch,
  GitCompare,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import {
  DEFAULT_AGENT_ENGINE_LABEL,
  agentEngineLabel,
} from "../../../shared/agent-engine-label";
import { PermissionSelector } from "./permission-selector";
import { formatUiError } from "../utils/ipc-error";
import type { GitFileStatus } from "../../../shared/ipc-contracts";

interface ChangedFile {
  path: string;
  status: GitFileStatus;
}

export function ReviewRail(): React.JSX.Element | null {
  const reviewOpen = useAppStore((state) => state.reviewOpen);
  const settings = useAppStore((state) => state.settings);
  const setPermissionMode = useAppStore((state) => state.setPermissionMode);
  const pendingSteering = useAppStore((state) => state.pendingSteering);
  const pendingFollowUp = useAppStore((state) => state.pendingFollowUp);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const isStreaming = useAppStore((state) => state.isStreaming);
  const engineLabel = useAppStore(
    (state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL,
  );
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const messages = useAppStore((state) => state.messages);
  const [gitStatus, setGitStatus] = useState<Record<string, GitFileStatus>>({});
  const [gitError, setGitError] = useState<string | null>(null);

  const pendingCount = pendingSteering.length + pendingFollowUp.length;
  const changedFiles = useMemo<ChangedFile[]>(
    () =>
      Object.entries(gitStatus)
        .map(([path, status]) => ({ path, status }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [gitStatus],
  );

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const status = await window.piDesktop.files.getGitStatus();
        if (!cancelled) {
          setGitStatus(status);
          setGitError(null);
        }
      } catch (err) {
        // Keep polling — a transient git failure (index lock, etc.) heals on
        // the next tick; the notice below tells the user why the list is empty.
        if (!cancelled) {
          setGitStatus({});
          setGitError(formatUiError(err));
        }
      }
    };

    loadStatus();
    const interval = window.setInterval(loadStatus, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWorkspace?.id, messages.length, isStreaming]);

  if (!reviewOpen) return null;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-app">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-success" />
          <h2 className="text-sm font-semibold text-primary">审查</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-dim">
          在改动继续推进前，控制 Pi 可以执行的操作。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
            权限
          </div>
          <PermissionSelector
            value={settings?.permissionMode}
            onChange={setPermissionMode}
          />
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-dim">
              待处理审批
            </div>
            <span className="rounded-full bg-card px-2 py-0.5 text-[10px] text-muted">
              {pendingCount}
            </span>
          </div>
          <div className="rounded-md border border-border bg-surface/50 p-3">
            {pendingCount > 0 ? (
              <div className="flex items-start gap-2 text-sm text-warning">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>有 {pendingCount} 个项目等待当前会话处理。</span>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm text-muted">
                <CheckCircle2
                  size={15}
                  className="mt-0.5 shrink-0 text-success"
                />
                <span>没有等待处理的审批请求。</span>
              </div>
            )}
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-dim">
              已修改文件
            </div>
            <span className="rounded-full bg-card px-2 py-0.5 text-[10px] text-muted">
              {changedFiles.length}
            </span>
          </div>
          <div className="mb-2 overflow-hidden rounded-md border border-border bg-surface/50">
            {gitError !== null ? (
              <div
                className="flex items-center gap-2 px-3 py-3 text-xs text-warning"
                title={gitError}
              >
                <AlertCircle size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  无法获取 Git 状态
                </span>
              </div>
            ) : changedFiles.length === 0 ? (
              <div className="px-3 py-3 text-sm text-dim">
                工作区没有未提交的改动。
              </div>
            ) : (
              <div className="max-h-44 overflow-y-auto py-1">
                {changedFiles.slice(0, 8).map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setCurrentView("diff")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary transition-colors hover:bg-surface-hover"
                    title={file.path}
                  >
                    <span className="shrink-0 rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {formatGitStatus(file.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  </button>
                ))}
                {changedFiles.length > 8 && (
                  <div className="px-3 py-1.5 text-xs text-dim">
                    还有 {changedFiles.length - 8} 项
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCurrentView("diff")}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface/50 px-3 py-2 text-left text-sm text-secondary transition-colors hover:border-border-strong hover:bg-surface"
          >
            <GitCompare size={15} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1">
              <span className="block">打开差异审查</span>
              <span className="mt-0.5 block text-xs text-dim">
                查看工作区改动。
              </span>
            </span>
          </button>
        </section>

        <section className="mt-6">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
            会话状态
          </div>
          <div className="rounded-md border border-border bg-surface/50 p-3 text-sm text-muted">
            <div className="flex items-center gap-2">
              <FileSearch size={15} className="text-dim" />
              <span>
                {isStreaming
                  ? `${engineLabel} 正在当前会话中工作。`
                  : `${engineLabel} 当前会话处于空闲状态。`}
              </span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}

export function formatGitStatus(status: GitFileStatus): string {
  if (status.index === "?" && status.worktree === "?") return "NEW";
  if (status.index === "D" || status.worktree === "D") return "DEL";
  if (status.index === "A") return "ADD";
  if (status.index === "R") return "REN";
  if (status.index === "M" || status.worktree === "M")
    return status.isStaged ? "STG" : "MOD";
  return "CHG";
}
