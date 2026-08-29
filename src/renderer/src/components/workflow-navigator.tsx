import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  Code2,
  Copy,
  FileText,
  GitBranch,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  ScrollText,
  Square,
  Workflow as WorkflowIcon,
  X,
  XCircle,
} from "lucide-react";
import type {
  WorkflowAgentDetail,
  WorkflowAgentStatus,
  WorkflowControlAction,
  WorkflowControlReason,
  WorkflowHistoryEntry,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from "../../../shared/ipc-contracts";
import { useAppStore } from "../store";
import { DEFAULT_AGENT_ENGINE_LABEL } from "../../../shared/agent-engine-label";
import {
  canAbortRun,
  canResumeRun,
  filterRunsBySession,
  filterRunsByWorkspace,
  isTerminalRun,
  runActiveAgentCount,
} from "../utils/workflow-runs";
import { MarkdownRenderer } from "./markdown-renderer";
import { localizedStatus } from "../utils/ui-text";
import { formatUiError } from "../utils/ipc-error";

function formatTokens(total: number | undefined): string {
  if (!total || total <= 0) return "";
  if (total < 1000) return `${total} Token`;
  return `${(total / 1000).toFixed(total >= 10_000 ? 0 : 1)}k Token`;
}

function formatCost(cost: number | undefined): string {
  if (!cost || cost <= 0) return "";
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusLabel(status: WorkflowRunStatus): string {
  return status === "aborted" ? "已停止" : localizedStatus(status);
}

function statusClass(status: WorkflowRunStatus): string {
  if (status === "running") return "text-accent-fg";
  if (status === "failed" || status === "aborted") return "text-error";
  if (status === "completed") return "text-success";
  if (status === "paused") return "text-warning";
  return "text-muted";
}

function RunStatus({
  status,
}: {
  status: WorkflowRunStatus;
}): React.JSX.Element {
  if (status === "running")
    return <Loader2 size={15} className="animate-spin text-accent-fg" />;
  if (status === "completed")
    return <Check size={15} className="text-success" />;
  if (status === "failed" || status === "aborted")
    return <XCircle size={15} className="text-error" />;
  return <Circle size={13} className={statusClass(status)} />;
}

function AgentStatus({
  status,
  runStatus,
}: {
  status: WorkflowAgentStatus;
  runStatus: WorkflowRunStatus;
}): React.JSX.Element {
  // A terminal run's persisted agents can be frozen at 'running' (the extension
  // never flips them when it aborts/fails a run). Never show those as active.
  if (status === "running" && !isTerminalRun(runStatus))
    return <Loader2 size={13} className="animate-spin text-accent-fg" />;
  if (status === "done") return <Check size={13} className="text-success" />;
  if (status === "error") return <XCircle size={13} className="text-error" />;
  return <Circle size={10} className="text-faint" />;
}

function AgentCounts({ run }: { run: WorkflowRunSummary }): {
  done: number;
  running: number;
  total: number;
  percent: number;
} {
  const done = run.agents.filter(
    (agent) => agent.status === "done" || agent.status === "skipped",
  ).length;
  const running = runActiveAgentCount(run.agents, run.status);
  const total = run.agents.length;
  return {
    done,
    running,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}

function RunCard({
  run,
  onOpen,
}: {
  run: WorkflowRunSummary;
  onOpen: () => void;
}): React.JSX.Element {
  const counts = AgentCounts({ run });
  const tokenText = formatTokens(run.tokenUsage?.total);
  const costText = formatCost(run.tokenUsage?.cost);
  const terminal = isTerminalRun(run.status);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full border-b border-border/70 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-highlight/50"
    >
      <div className="flex items-start gap-2">
        <RunStatus status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-primary">
              {run.workflowName}
            </span>
            <span
              className={clsx(
                "shrink-0 text-[10px] uppercase tracking-wide",
                statusClass(run.status),
              )}
            >
              {statusLabel(run.status)}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-dim">
            <span
              className="flex min-w-0 items-center gap-1 truncate"
              title={run.cwd}
            >
              <GitBranch size={11} className="shrink-0 text-faint" />
              {run.workspaceName}
            </span>
            <span className="shrink-0 tabular-nums">
              {counts.done}/{counts.total} 个代理
            </span>
            {counts.running > 0 && (
              <span className="shrink-0 text-accent-fg">
                · {counts.running} 个活动实例
              </span>
            )}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-card">
            <div
              className={clsx(
                "h-full rounded-full transition-all",
                terminal
                  ? "bg-muted"
                  : run.status === "failed"
                    ? "bg-error"
                    : "bg-accent",
              )}
              style={{ width: `${counts.percent}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-faint">
            {run.currentPhase && (
              <span
                className={clsx(
                  "truncate",
                  terminal ? "text-faint" : "text-accent-fg",
                )}
              >
                {run.currentPhase}
              </span>
            )}
            {tokenText && <span className="shrink-0">{tokenText}</span>}
            {costText && <span className="shrink-0">{costText}</span>}
            {run.pauseReason && (
              <span className="truncate text-warning">{run.pauseReason}</span>
            )}
          </div>
        </div>
        <ChevronRight
          size={15}
          className="mt-0.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted"
        />
      </div>
    </button>
  );
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="rounded p-1.5 text-faint hover:bg-highlight hover:text-primary"
      title="复制"
      aria-label="复制"
    >
      {copied ? (
        <Check size={13} className="text-success" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
}

type ResultRecord = Record<string, unknown>;

function isResultRecord(value: unknown): value is ResultRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultLabel(key: string): string {
  const label = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : key;
}

function isLongResultText(value: string): boolean {
  return (
    value.length > 140 ||
    /[\r\n]/.test(value) ||
    /^#{1,6}\s|[*_`]{2}/.test(value)
  );
}

function ResultScalar({ value }: { value: unknown }): React.JSX.Element {
  if (typeof value === "string") {
    return isLongResultText(value) ? (
      <div className="text-xs leading-relaxed text-secondary">
        <MarkdownRenderer content={value} />
      </div>
    ) : (
      <span className="inline-flex max-w-full rounded-md bg-card px-2 py-1 text-xs text-secondary">
        {value || "空"}
      </span>
    );
  }

  if (value === null || value === undefined) {
    return <span className="text-xs italic text-faint">无</span>;
  }

  return (
    <span
      className={clsx(
        "inline-flex rounded-md px-2 py-1 text-xs",
        typeof value === "boolean"
          ? value
            ? "bg-success-bg text-success"
            : "bg-card text-muted"
          : "bg-card text-secondary",
      )}
    >
      {typeof value === "boolean" ? (value ? "是" : "否") : String(value)}
    </span>
  );
}

const resultIdentityKeys = ["title", "name", "label", "id", "key", "slug"];

function resultItemTitle(item: ResultRecord, index: number): string {
  for (const key of resultIdentityKeys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return `项目 ${index + 1}`;
}

function resultItemFields(item: ResultRecord): Array<[string, unknown]> {
  return Object.entries(item).filter(
    ([key]) => !resultIdentityKeys.includes(key.toLowerCase()),
  );
}

function ResultField({
  label,
  value,
  depth,
}: {
  label: string;
  value: unknown;
  depth: number;
}): React.JSX.Element {
  if (typeof value === "string" && isLongResultText(value)) {
    return (
      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
          {resultLabel(label)}
        </div>
        <div className="text-xs leading-relaxed text-secondary">
          <MarkdownRenderer content={value} />
        </div>
      </div>
    );
  }

  if (!Array.isArray(value) && !isResultRecord(value)) {
    return (
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 py-1.5 last:border-0">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-faint">
          {resultLabel(label)}
        </span>
        <ResultScalar value={value} />
      </div>
    );
  }

  return (
    <details className="rounded-lg border border-border/70 bg-card/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-secondary marker:hidden">
        <span className="font-medium text-primary">{resultLabel(label)}</span>
        <span className="text-[10px] text-faint">{resultShape(value)}</span>
      </summary>
      <div className="border-t border-border/70 px-3 py-2">
        <ResultValue value={value} depth={depth + 1} />
      </div>
    </details>
  );
}

function ResultObjectList({
  items,
  depth = 0,
}: {
  items: ResultRecord[];
  depth?: number;
}): React.JSX.Element {
  const [openItems, setOpenItems] = useState<Record<number, boolean>>(
    (): Record<number, boolean> => (depth === 0 ? { 0: true } : {}),
  );
  const shown = items.slice(0, 40);
  return (
    <div className="space-y-2">
      {shown.map((item, index) => {
        const fields = resultItemFields(item);
        return (
          <details
            key={index}
            open={openItems[index] ?? false}
            onToggle={(event) => {
              const isOpen = event.currentTarget.open;
              setOpenItems((previous) =>
                previous[index] === isOpen
                  ? previous
                  : { ...previous, [index]: isOpen },
              );
            }}
            className="overflow-hidden rounded-lg border border-border/80 bg-card/20"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 marker:hidden">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent-bg/40 text-[10px] font-semibold tabular-nums text-accent-fg">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-xs font-medium text-primary"
                title={resultItemTitle(item, index)}
              >
                {resultItemTitle(item, index)}
              </span>
              <span className="shrink-0 text-[10px] text-faint">
                {fields.length ? `${fields.length} 项详情` : "无详情"}
              </span>
            </summary>
            <div className="border-t border-border/70 px-3 pb-3 pt-2.5">
              {fields.length === 0 ? (
                <div className="text-xs italic text-faint">没有更多详情。</div>
              ) : (
                <div className="space-y-2">
                  {fields.map(([key, value]) => (
                    <ResultField
                      key={key}
                      label={key}
                      value={value}
                      depth={depth}
                    />
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
      {items.length > shown.length && (
        <div className="px-1 text-xs italic text-dim">
          还有 {items.length - shown.length} 项
        </div>
      )}
    </div>
  );
}

function ResultValue({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}): React.JSX.Element {
  if (depth >= 6)
    return <span className="text-xs italic text-faint">嵌套详情已隐藏</span>;
  if (!Array.isArray(value) && !isResultRecord(value))
    return <ResultScalar value={value} />;

  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="text-xs italic text-faint">没有项目</span>;
    if (value.every(isResultRecord))
      return <ResultObjectList items={value} depth={depth} />;
    const shown = value.slice(0, 40);
    return (
      <div className="flex flex-wrap gap-1.5">
        {shown.map((item, index) =>
          isResultRecord(item) || Array.isArray(item) ? (
            <details
              key={index}
              className="w-full rounded-lg border border-border/70 bg-card/20"
            >
              <summary className="cursor-pointer list-none px-3 py-2 text-xs text-secondary marker:hidden">
                项目 {index + 1}
              </summary>
              <div className="border-t border-border/70 px-3 py-2">
                <ResultValue value={item} depth={depth + 1} />
              </div>
            </details>
          ) : (
            <ResultScalar key={index} value={item} />
          ),
        )}
        {value.length > shown.length && (
          <div className="w-full px-1 text-xs italic text-dim">
            还有 {value.length - shown.length} 项
          </div>
        )}
      </div>
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0)
    return <span className="text-xs italic text-faint">无详情</span>;
  return (
    <div className="space-y-2">
      {entries.map(([key, item]) => (
        <ResultField key={key} label={key} value={item} depth={depth} />
      ))}
    </div>
  );
}

function resultShape(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} 项`;
  if (isResultRecord(value)) {
    const count = Object.keys(value).length;
    return `${count} 个字段`;
  }
  if (typeof value === "string") return `${value.length} 个字符`;
  if (value === null || value === undefined) return "空";
  return typeof value;
}

function ResultSection({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): React.JSX.Element {
  const isMarkdown = typeof value === "string" && isLongResultText(value);
  return (
    <section className="border-b border-border/70 pb-4 last:border-0 last:pb-0">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <h3 className="text-xs font-semibold text-primary">
          {resultLabel(label)}
        </h3>
        <span className="shrink-0 text-[10px] text-faint">
          {resultShape(value)}
        </span>
      </div>
      {isMarkdown ? (
        <div className="rounded-lg bg-card/20 px-3 py-3 text-xs leading-relaxed text-secondary">
          <MarkdownRenderer content={value} />
        </div>
      ) : (
        <ResultValue value={value} />
      )}
    </section>
  );
}

function WorkflowResult({ text }: { text: string }): React.JSX.Element {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <div className="text-xs font-semibold text-primary">工作流输出</div>
            <div className="mt-0.5 text-[11px] text-dim">Markdown 报告</div>
          </div>
          <CopyButton text={text} />
        </div>
        <div className="text-xs leading-relaxed text-secondary">
          <MarkdownRenderer content={text} />
        </div>
      </div>
    );
  }

  const entries = isResultRecord(value) ? Object.entries(value) : null;
  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-bg/50 text-accent-fg">
            <FileText size={14} />
          </div>
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-primary">工作流输出</h3>
            <p className="text-[11px] text-dim">
              {entries ? `${entries.length} 个部分` : resultShape(value)}
            </p>
          </div>
        </div>
        <CopyButton text={text} />
      </header>

      {entries ? (
        entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-dim">
            工作流返回了空对象。
          </div>
        ) : (
          <div className="space-y-5">
            {entries.map(([key, item]) => (
              <ResultSection key={key} label={key} value={item} />
            ))}
          </div>
        )
      ) : (
        <ResultSection label="输出" value={value} />
      )}
    </div>
  );
}

function PhaseStepper({
  run,
}: {
  run: WorkflowRunDetail;
}): React.JSX.Element | null {
  if (run.phases.length === 0) return null;
  const terminal = isTerminalRun(run.status);
  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {run.phases.map((phase, index) => {
        const agents = run.agents.filter((agent) => agent.phase === phase);
        const done = agents.filter(
          (agent) => agent.status === "done" || agent.status === "skipped",
        ).length;
        const active = run.currentPhase === phase;
        const complete = agents.length > 0 && done === agents.length;
        return (
          <div
            key={phase}
            className={clsx(
              "min-w-28 rounded-lg border px-2.5 py-2",
              active
                ? "border-accent-bg/70 bg-accent-bg/15"
                : "border-border bg-card/50",
            )}
          >
            <div className="flex items-center gap-1.5 text-[10px] text-faint">
              <span>{index + 1}</span>
              {complete ? (
                <Check size={11} className="text-success" />
              ) : active && !terminal ? (
                <Loader2 size={11} className="animate-spin text-accent-fg" />
              ) : null}
            </div>
            {/* The active border stays on terminal runs — it marks where the run halted —
                but the name must read as stopped, not in-flight. */}
            <div
              className={clsx(
                "mt-1 truncate text-xs font-medium",
                active
                  ? terminal
                    ? "text-secondary"
                    : "text-accent-fg"
                  : "text-secondary",
              )}
              title={phase}
            >
              {phase}
            </div>
            <div className="mt-0.5 text-[10px] text-faint">
              {done}/{agents.length || "—"} 个代理
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgentGrid({
  run,
  onSelect,
}: {
  run: WorkflowRunDetail;
  onSelect: (agent: WorkflowAgentDetail) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {run.agents.map((agent) => (
        <button
          key={`${run.runId}:${agent.id}`}
          type="button"
          onClick={() => onSelect(agent)}
          className="min-w-0 rounded-lg border border-border bg-card/50 p-2.5 text-left transition-colors hover:border-border-strong hover:bg-highlight/50"
        >
          <div className="flex items-center gap-2">
            <AgentStatus status={agent.status} runStatus={run.status} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-primary">
              {agent.label}
            </span>
            <ChevronRight size={13} className="shrink-0 text-faint" />
          </div>
          <div className="mt-1.5 flex items-center gap-2 truncate text-[10px] text-faint">
            {agent.phase && <span className="truncate">{agent.phase}</span>}
            {agent.model && (
              <span className="truncate" title={agent.model}>
                {agent.model.split("/").pop()}
              </span>
            )}
            {agent.tokens ? (
              <span className="shrink-0">{formatTokens(agent.tokens)}</span>
            ) : null}
          </div>
          {agent.error && (
            <div
              className="mt-1 truncate text-[10px] text-error"
              title={agent.error}
            >
              {agent.error}
            </div>
          )}
          <div className="mt-1.5 text-[10px] text-accent-fg">
            {agent.hasHistory ? "打开记录" : "没有可用记录"}
          </div>
        </button>
      ))}
    </div>
  );
}

function HistoryEntry({
  entry,
}: {
  entry: WorkflowHistoryEntry;
}): React.JSX.Element {
  const isCode =
    entry.kind === "toolCall" ||
    entry.kind === "toolResult" ||
    entry.kind === "error";
  return (
    <div
      className={clsx(
        "rounded-lg border p-2.5",
        entry.isError
          ? "border-error/50 bg-error-bg/20"
          : "border-border bg-card/40",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-faint">
        <span>{entry.role}</span>
        <span>·</span>
        <span>{entry.kind}</span>
        {entry.toolName && (
          <span className="truncate normal-case text-accent-fg">
            {entry.toolName}
          </span>
        )}
        {entry.path && (
          <span className="truncate normal-case" title={entry.path}>
            {entry.path}
          </span>
        )}
        {entry.timestamp && (
          <span className="ml-auto shrink-0 normal-case">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
      {entry.text &&
        (isCode ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-app/70 p-2 font-jetbrains text-[11px] leading-relaxed text-secondary">
            {entry.text}
          </pre>
        ) : (
          <div className="text-xs leading-relaxed text-secondary">
            <MarkdownRenderer content={entry.text} />
          </div>
        ))}
      {entry.diff && (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-app/70 p-2 font-jetbrains text-[11px] leading-relaxed text-secondary">
          {entry.diff}
        </pre>
      )}
    </div>
  );
}

function AgentTranscript({
  agent,
  onBack,
}: {
  agent: WorkflowAgentDetail;
  onBack: () => void;
}): React.JSX.Element {
  const [persistenceMessage, setPersistenceMessage] = useState<string | null>(
    null,
  );
  const transcriptText = agent.history
    .map((entry) => `${entry.role} · ${entry.kind}\n${entry.text}`)
    .join("\n\n");
  const enablePersistence = async (): Promise<void> => {
    try {
      await window.piDesktop.workflows.setPersistAgentSessions(true);
      setPersistenceMessage("已全局启用，请在下次运行工作流前重新加载 Pi。");
    } catch (error) {
      setPersistenceMessage(formatUiError(error));
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded p-1.5 text-muted hover:bg-highlight hover:text-primary"
          title="返回运行记录"
          aria-label="返回运行记录"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-primary">
            {agent.label}
          </div>
          <div className="text-[10px] text-dim">
            {agent.phase ?? "工作流步骤"} ·{" "}
            {agent.transcriptSource === "persisted-session"
              ? "完整会话记录"
              : agent.transcriptSource === "run-history"
                ? "已捕获的工作流历史"
                : "无记录"}
          </div>
        </div>
        {transcriptText && <CopyButton text={transcriptText} />}
      </div>
      {!agent.transcriptComplete &&
        agent.transcriptSource === "run-history" && (
          <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning-bg/20 px-3 py-2 text-[11px] text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div>
                当前显示工作流捕获的历史记录。后续运行可以保留每条原始 Pi
                消息和工具结果。
              </div>
              {persistenceMessage ? (
                <div className="mt-1 text-success">{persistenceMessage}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => void enablePersistence()}
                  className="mt-1 rounded border border-warning/50 px-2 py-1 text-[10px] text-warning hover:bg-warning-bg/30"
                >
                  为后续运行启用完整记录
                </button>
              )}
            </div>
          </div>
        )}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {agent.prompt && (
          <div className="rounded-lg border border-accent-bg/40 bg-accent-bg/10 p-2.5">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-accent-fg">
              步骤提示词
            </div>
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-secondary">
              {agent.prompt}
            </div>
          </div>
        )}
        {agent.history.length === 0 ? (
          <div className="py-8 text-center text-xs text-dim">
            此步骤没有保存记录。
          </div>
        ) : (
          agent.history.map((entry, index) => (
            <HistoryEntry
              key={`${entry.id ?? "entry"}-${index}`}
              entry={entry}
            />
          ))
        )}
        {agent.resultText && (
          <div className="rounded-lg border border-success/40 bg-success-bg/15 p-2.5">
            <div className="mb-2 text-[10px] uppercase tracking-wide text-success">
              步骤结果
            </div>
            <WorkflowResult text={agent.resultText} />
          </div>
        )}
      </div>
    </div>
  );
}

type DetailTab = "overview" | "script" | "logs" | "result";

function controlFailureText(
  action: WorkflowControlAction,
  reason: WorkflowControlReason | undefined,
  agent: string,
): string {
  switch (reason) {
    case "no-pi":
    case "pi-not-running":
      return `${agent} 未在此工作区运行，因此无法从这里控制该运行记录。`;
    case "extension-missing":
      return `此工作区的 ${agent} 进程未加载工作流扩展。`;
    case "status-not-permitted":
      return action === "stop"
        ? "此运行记录在当前状态下无法中止。"
        : "此运行记录在当前状态下无法恢复。";
    case "timeout":
      return `${agent} 没有响应。运行记录的状态可能已改变，请刷新查看最新状态。`;
    case "dispatch-failed":
      return `无法向 ${agent} 发送控制命令。`;
    default:
      return "当前无法控制此工作区的工作流。";
  }
}

function RunDetail({
  run,
  onBack,
  onRefresh,
  onSelectAgent,
}: {
  run: WorkflowRunDetail;
  onBack: () => void;
  onRefresh: () => void;
  onSelectAgent: (agent: WorkflowAgentDetail) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [controlBusy, setControlBusy] = useState<WorkflowControlAction | null>(
    null,
  );
  const [controlFeedback, setControlFeedback] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const feedbackTimer = useRef<number | null>(null);
  // The desktop embeds Pi; the label is a constant.
  const engineLabel: string = DEFAULT_AGENT_ENGINE_LABEL;
  const counts = AgentCounts({ run });

  const clearFeedback = (): void => {
    if (feedbackTimer.current !== null)
      window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = null;
    setControlFeedback(null);
  };

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null)
        window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  // Dispatch a REAL control to the run's owning workspace Pi process (the
  // extension's `/workflows stop|resume`). The persisted status flips on disk;
  // the navigator's poll picks it up. Nothing is faked locally.
  const runControl = async (action: WorkflowControlAction): Promise<void> => {
    if (controlBusy) return;
    setControlBusy(action);
    clearFeedback();
    try {
      const result = await window.piDesktop.workflows.control(
        run.workspaceId,
        run.runId,
        action,
      );
      if (result.ok) {
        setControlFeedback({
          kind: "ok",
          text:
            action === "stop"
              ? "已请求中止，正在停止工作区中的运行记录…"
              : "已请求恢复，正在重启工作区中的运行记录…",
        });
        feedbackTimer.current = window.setTimeout(clearFeedback, 4000);
        // The extension writes the transition to disk; refresh a beat later so
        // the status flip is visible even before the next poll tick.
        window.setTimeout(() => void onRefresh(), 1200);
      } else {
        setControlFeedback({
          kind: "error",
          text: controlFailureText(action, result.reason, engineLabel),
        });
        feedbackTimer.current = window.setTimeout(clearFeedback, 6000);
      }
    } catch {
      setControlFeedback({
        kind: "error",
        text: "无法连接到此工作区的工作流控制通道。",
      });
      feedbackTimer.current = window.setTimeout(clearFeedback, 6000);
    } finally {
      setControlBusy(null);
    }
  };

  const abortable = canAbortRun(run.status);
  const resumable = canResumeRun(run.status);
  const tabs: Array<{
    id: DetailTab;
    label: string;
    icon: React.JSX.Element;
    visible: boolean;
  }> = [
    {
      id: "overview",
      label: "概览",
      icon: <WorkflowIcon size={12} />,
      visible: true,
    },
    {
      id: "script",
      label: "脚本",
      icon: <Code2 size={12} />,
      visible: !!run.script,
    },
    {
      id: "logs",
      label: "日志",
      icon: <ScrollText size={12} />,
      visible: run.logs.length > 0,
    },
    {
      id: "result",
      label: "结果",
      icon: <FileText size={12} />,
      visible: !!run.resultText,
    },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded p-1.5 text-muted hover:bg-highlight hover:text-primary"
            title="全部工作流运行记录"
            aria-label="全部工作流运行记录"
          >
            <ArrowLeft size={15} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <RunStatus status={run.status} />
              <span className="truncate text-sm font-semibold text-primary">
                {run.workflowName}
              </span>
              <span
                className={clsx(
                  "text-[10px] uppercase tracking-wide",
                  statusClass(run.status),
                )}
              >
                {statusLabel(run.status)}
              </span>
            </div>
            <div
              className="mt-1 flex items-center gap-1.5 truncate text-[10px] text-dim"
              title={run.cwd}
            >
              <GitBranch size={11} className="shrink-0" />
              {run.workspaceName} · {run.cwd}
            </div>
          </div>
          {(abortable || resumable) && (
            <div className="flex shrink-0 items-center gap-1">
              {abortable && (
                <button
                  type="button"
                  onClick={() => void runControl("stop")}
                  disabled={controlBusy !== null}
                  className="flex items-center gap-1 rounded border border-error/40 px-2 py-1 text-[10px] text-error hover:bg-error-bg/30 disabled:cursor-not-allowed disabled:opacity-50"
                  title="停止工作区中的工作流"
                  aria-label="中止运行记录"
                >
                  {controlBusy === "stop" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Square size={11} />
                  )}
                  中止
                </button>
              )}
              {resumable && (
                <button
                  type="button"
                  onClick={() => void runControl("resume")}
                  disabled={controlBusy !== null}
                  className="flex items-center gap-1 rounded border border-success/40 px-2 py-1 text-[10px] text-success hover:bg-success-bg/30 disabled:cursor-not-allowed disabled:opacity-50"
                  title="恢复工作区中的工作流"
                  aria-label="恢复运行记录"
                >
                  {controlBusy === "resume" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Play size={11} />
                  )}
                  恢复
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1.5 text-muted hover:bg-highlight hover:text-primary"
            title="刷新运行记录"
            aria-label="刷新运行记录"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        {(run.pauseReason || run.resetHint) && (
          <div className="mt-2 rounded border border-warning/40 bg-warning-bg/20 px-2 py-1.5 text-[11px] text-warning">
            {run.pauseReason ?? "已暂停"}
            {run.resetHint ? ` · ${run.resetHint}` : ""}
          </div>
        )}
        {controlFeedback && (
          <div
            className={clsx(
              "mt-2 rounded border px-2 py-1.5 text-[11px]",
              controlFeedback.kind === "ok"
                ? "border-success/40 bg-success-bg/20 text-success"
                : "border-error/40 bg-error-bg/20 text-error",
            )}
            role="status"
          >
            {controlFeedback.text}
          </div>
        )}
        <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
          <div className="rounded bg-card/60 px-1.5 py-1.5">
            <div className="text-sm tabular-nums text-primary">
              {counts.done}/{counts.total}
            </div>
            <div className="text-[9px] uppercase text-faint">代理</div>
          </div>
          <div className="rounded bg-card/60 px-1.5 py-1.5">
            <div className="text-sm tabular-nums text-primary">
              {formatTokens(run.tokenUsage?.total) || "—"}
            </div>
            <div className="text-[9px] uppercase text-faint">Token</div>
          </div>
          <div className="rounded bg-card/60 px-1.5 py-1.5">
            <div className="text-sm tabular-nums text-primary">
              {formatCost(run.tokenUsage?.cost) ||
                formatDuration(run.durationMs) ||
                "—"}
            </div>
            <div className="text-[9px] uppercase text-faint">费用/时间</div>
          </div>
        </div>
        <div className="mt-2 flex gap-1 overflow-x-auto">
          {tabs
            .filter((item) => item.visible)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={clsx(
                  "flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px]",
                  tab === item.id
                    ? "bg-accent-bg/30 text-accent-fg"
                    : "text-muted hover:bg-highlight hover:text-primary",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "overview" && (
          <div className="space-y-3">
            <PhaseStepper run={run} />
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-faint">
                <WorkflowIcon size={12} /> 步骤
              </div>
              <AgentGrid run={run} onSelect={onSelectAgent} />
            </div>
          </div>
        )}
        {tab === "script" && run.script && (
          <div className="relative">
            <div className="absolute right-1 top-1">
              <CopyButton text={run.script} />
            </div>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-app/70 p-3 pr-10 font-jetbrains text-[11px] leading-relaxed text-secondary">
              {run.script}
            </pre>
          </div>
        )}
        {tab === "logs" && (
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-app/70 p-3 font-jetbrains text-[11px] leading-relaxed text-secondary">
            {run.logs.join("\n")}
          </pre>
        )}
        {tab === "result" && run.resultText && (
          <WorkflowResult text={run.resultText} />
        )}
      </div>
    </div>
  );
}

export function WorkflowNavigator({
  embedded = false,
}: {
  embedded?: boolean;
}): React.JSX.Element | null {
  const open = useAppStore((state) => state.workflowPanelOpen);
  const setOpen = useAppStore((state) => state.setWorkflowPanelOpen);
  const filterSessionId = useAppStore((state) => state.workflowPanelFilter);
  const scopeWorkspaceId = useAppStore(
    (state) => state.workflowPanelWorkspaceId,
  );
  const workspaces = useAppStore((state) => state.workspaces);
  const runs = useAppStore((state) => state.workflowRuns);
  const refresh = useAppStore((state) => state.refreshWorkflowRuns);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [selectedAgent, setSelectedAgent] =
    useState<WorkflowAgentDetail | null>(null);
  const detailRef = useRef<WorkflowRunDetail | null>(null);
  const selectedAgentRef = useRef<WorkflowAgentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  // A workspace scope pointing at a workspace that was removed would leave a
  // dead-end empty panel; treat it as global instead (the runs are still in
  // the journal, just no longer reachable through a project).
  const workspaceScopeId = useMemo(() => {
    if (!scopeWorkspaceId) return null;
    return workspaces.some((ws) => ws.id === scopeWorkspaceId)
      ? scopeWorkspaceId
      : null;
  }, [scopeWorkspaceId, workspaces]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);
  useEffect(() => {
    // Clicking a session's runs icon or the project-scoped entry can change the
    // scope while this panel is already open. Do not leave a detail view from
    // the previous scope visible.
    setDetail(null);
    setSelectedAgent(null);
  }, [filterSessionId, workspaceScopeId]);

  const loadRun = async (run: WorkflowRunSummary): Promise<void> => {
    setLoading(true);
    setSelectedAgent(null);
    try {
      setDetail(
        await window.piDesktop.workflows.getRun(run.workspaceId, run.runId),
      );
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  };

  const refreshDetail = useCallback(async (): Promise<void> => {
    const current = detailRef.current;
    if (!current || isTerminalRun(current.status)) return;
    try {
      const next = await window.piDesktop.workflows.getRun(
        current.workspaceId,
        current.runId,
      );
      setDetail(next);
      const selected = selectedAgentRef.current;
      if (selected)
        setSelectedAgent(
          next.agents.find((agent) => agent.id === selected.id) ?? null,
        );
    } catch {
      // Keep the last readable detail if a live run is being atomically persisted.
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      setSelectedAgent(null);
      return;
    }
    const handleOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-workflow-toggle]"))
        return;
      if (target instanceof Node && !panelRef.current?.contains(target)) {
        setMaximized(false);
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      setSelectedAgent(null);
      return;
    }
    const tick = async (): Promise<void> => {
      await refresh();
      await refreshDetail();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 900);
    return () => window.clearInterval(timer);
  }, [open, refresh, refreshDetail]);

  const visibleRuns = useMemo(
    () =>
      filterRunsByWorkspace(
        filterRunsBySession(runs, filterSessionId),
        workspaceScopeId,
      ),
    [runs, filterSessionId, workspaceScopeId],
  );
  const scopeWorkspace = useMemo(
    () =>
      workspaceScopeId
        ? (workspaces.find((ws) => ws.id === workspaceScopeId) ?? null)
        : null,
    [workspaceScopeId, workspaces],
  );
  const activeCount = useMemo(
    () =>
      visibleRuns.filter(
        (run) => run.status === "running" || run.status === "paused",
      ).length,
    [visibleRuns],
  );

  if (!open) return null;

  return (
    <section
      ref={panelRef}
      className={clsx(
        "flex min-h-0 flex-col overflow-hidden border border-border-strong bg-surface/95",
        embedded
          ? "relative h-full w-full rounded-none border-0 bg-surface shadow-none backdrop-blur-none"
          : "absolute z-40 shadow-2xl shadow-black/30 backdrop-blur-md",
        !embedded &&
          (maximized
            ? "inset-4 rounded-xl"
            : "right-4 top-14 max-h-[calc(100vh-7rem)] w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl"),
      )}
      aria-label="工作流运行记录"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <WorkflowIcon size={16} className="text-accent-fg" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-primary">
            {selectedAgent
              ? "步骤记录"
              : detail
                ? "工作流详情"
                : "工作流运行记录"}
          </div>
          <div className="text-[11px] text-dim">
            {selectedAgent
              ? selectedAgent.label
              : detail
                ? `${detail.workflowName} · ${detail.workspaceName}`
                : activeCount > 0
                  ? `${activeCount} 个活动实例`
                  : visibleRuns.length
                    ? `${visibleRuns.length} 条记录`
                    : filterSessionId
                      ? "此会话没有运行记录"
                      : workspaceScopeId
                        ? "此项目没有运行记录"
                        : "暂无运行记录"}
          </div>
        </div>
        {!detail && (
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1.5 text-muted hover:bg-highlight hover:text-primary"
            title="刷新工作流运行记录"
            aria-label="刷新工作流运行记录"
          >
            <RefreshCw size={14} />
          </button>
        )}
        {!embedded && (
          <button
            type="button"
            onClick={() => setMaximized((value) => !value)}
            className="rounded p-1.5 text-muted hover:bg-highlight hover:text-primary"
            title={maximized ? "还原工作流面板" : "最大化工作流面板"}
            aria-label={maximized ? "还原工作流面板" : "最大化工作流面板"}
            aria-pressed={maximized}
          >
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setMaximized(false);
            setOpen(false);
          }}
          className="rounded p-1.5 text-muted hover:bg-highlight hover:text-primary"
          title="关闭工作流运行记录"
          aria-label="关闭工作流运行记录"
        >
          <X size={16} />
        </button>
      </header>
      {selectedAgent && (
        <AgentTranscript
          agent={selectedAgent}
          onBack={() => setSelectedAgent(null)}
        />
      )}
      {!selectedAgent && detail && (
        <RunDetail
          run={detail}
          onBack={() => setDetail(null)}
          onRefresh={() => void refreshDetail()}
          onSelectAgent={setSelectedAgent}
        />
      )}
      {!selectedAgent && !detail && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-5 py-10 text-xs text-dim">
              <Loader2 size={14} className="animate-spin" />
              正在加载工作流…
            </div>
          ) : visibleRuns.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-dim">
              {filterSessionId ? (
                <>
                  <WorkflowIcon size={26} className="mx-auto mb-2 text-faint" />
                  此会话没有工作流运行记录。较早会话的记录显示在全部列表中。
                </>
              ) : workspaceScopeId ? (
                <>
                  <WorkflowIcon size={26} className="mx-auto mb-2 text-faint" />
                  {scopeWorkspace?.name ?? "此项目"}
                  没有工作流运行记录。其他项目的记录显示在全部列表中。
                </>
              ) : (
                <>
                  <WorkflowIcon size={26} className="mx-auto mb-2 text-faint" />
                  请在聊天中运行{" "}
                  <span className="font-jetbrains text-xs text-secondary">
                    /workflows run …
                  </span>
                  。
                </>
              )}
            </div>
          ) : (
            visibleRuns.map((run) => (
              <RunCard
                key={`${run.workspaceId}:${run.runId}`}
                run={run}
                onOpen={() => void loadRun(run)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
