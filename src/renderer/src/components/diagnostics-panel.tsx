import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Stethoscope,
  XCircle,
} from "lucide-react";
import type {
  AppLogEntry,
  DiagnosticsReport,
} from "../../../shared/ipc-contracts";

import { formatRelativeTime } from "../utils/format-relative-time";
import { formatUiError, localizeIpcErrorMessage } from "../utils/ipc-error";
import { CopyButton } from "./copy-button";
import { localizedStatus } from "../utils/ui-text";
import { getPermissionModeLabel } from "./permission-mode";

type RowTone = "ok" | "warn" | "fail" | "plain";

const TONE_TEXT: Record<Exclude<RowTone, "plain">, string> = {
  ok: "text-success",
  warn: "text-warning",
  fail: "text-error",
};

/** Newest log entries shown in the Recent Errors section. */
const MAX_VISIBLE_LOG_ENTRIES = 30;

const KEY_STATE_LABELS: Record<string, { label: string; tone: RowTone }> = {
  literal: { label: "已配置密钥", tone: "ok" },
  "env-set": { label: "已设置环境变量", tone: "ok" },
  "env-missing": { label: "缺少环境变量", tone: "fail" },
  shell: { label: "Shell 命令", tone: "plain" },
  none: { label: "无密钥", tone: "plain" },
};

export function DiagnosticsPanel(): React.JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await window.piDesktop.diagnostics.get());
      setLoadError(null);
    } catch (err) {
      setLoadError(formatUiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Stethoscope size={16} className="text-muted" />
          <h2 className="text-sm font-medium text-primary">诊断</h2>
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <CopyButton
              text={JSON.stringify(report, null, 2)}
              className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
            />
          )}
          <button
            onClick={() => void load()}
            title="刷新"
            aria-label="刷新诊断"
            className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && !report ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-dim" />
          </div>
        ) : loadError !== null ? (
          <div className="flex flex-col items-center justify-center py-12 text-dim">
            <AlertTriangle size={32} className="mb-3 text-warning" />
            <p className="text-sm text-secondary">无法生成诊断报告</p>
            <p className="mt-1 max-w-md break-words px-4 text-center text-xs text-faint">
              {loadError}
            </p>
            <button
              onClick={() => void load()}
              className="mt-3 rounded bg-card px-3 py-1 text-xs text-secondary transition-colors hover:bg-surface-hover"
            >
              重试
            </button>
          </div>
        ) : report ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <DiagSection title="应用">
              <DiagRow label="应用版本" value={report.app.version} />
              <DiagRow label="Electron" value={report.app.electron} />
              <DiagRow label="Chromium" value={report.app.chrome} />
              <DiagRow label="Node" value={report.app.node} />
              <DiagRow label="平台" value={report.app.platform} />
            </DiagSection>

            <DiagSection title="内嵌 Pi 运行时">
              {!report.piRuntime.nodeSatisfied && (
                <div className="mb-2 rounded-md border border-border bg-error-bg px-3 py-2 text-xs text-error">
                  Electron 内置 Node {report.piRuntime.nodeVersion} 低于内嵌
                  SDK 要求的 {report.piRuntime.nodeRequired}，请升级应用。
                </div>
              )}
              <DiagRow
                label="SDK 版本"
                value={report.piRuntime.sdkVersion}
                tone={report.piRuntime.sdkVersion !== "unknown" ? "ok" : "warn"}
              />
              <DiagRow label="协议版本" value={String(report.piRuntime.protocolVersion)} />
              <DiagRow label="Helper 入口" value={report.piRuntime.workerPath} mono />
              <DiagRow
                label="内置 Node"
                value={report.piRuntime.nodeVersion}
                tone={report.piRuntime.nodeSatisfied ? "ok" : "fail"}
              />
            </DiagSection>

            <DiagSection title="活动 Helper">
              {report.helpers.length === 0 ? (
                <p className="text-xs text-dim">当前没有运行的会话 helper。</p>
              ) : (
                report.helpers.map((helper) => (
                  <div key={helper.runtimeId} className="flex items-center gap-2 py-1 text-xs">
                    <StatusGlyph
                      tone={
                        helper.status === "running"
                          ? "ok"
                          : helper.status === "error"
                            ? "fail"
                            : "warn"
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-faint" title={helper.sessionPath ?? undefined}>
                      {helper.sessionPath ?? helper.runtimeId}
                    </span>
                    <span className="shrink-0 text-secondary">
                      {helper.status}
                      {helper.activity ? ` · ${helper.activity}` : ""}
                    </span>
                  </div>
                ))
              )}
            </DiagSection>

            <DiagSection title="工作区">
              {report.workspaces.length === 0 ? (
                <p className="text-xs text-dim">暂无工作区。</p>
              ) : (
                report.workspaces.map((ws) => (
                  <div
                    key={ws.id}
                    className="flex items-center gap-2 py-1 text-xs"
                  >
                    <StatusGlyph tone={ws.pathExists ? "ok" : "fail"} />
                    <span className="shrink-0 text-secondary">{ws.name}</span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-faint"
                      title={ws.path}
                    >
                      {ws.path}
                    </span>
                    {!ws.pathExists && (
                      <span className="shrink-0 text-error">缺失</span>
                    )}
                    {ws.trusted && (
                      <span className="shrink-0 text-success">已信任</span>
                    )}
                    <span className="shrink-0 text-muted">
                      {localizedStatus(ws.piStatus)}
                    </span>
                  </div>
                ))
              )}
            </DiagSection>

            <DiagSection title="提供商">
              {report.providersError ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 break-words">
                    {report.providersError}
                  </span>
                </div>
              ) : !report.providers || report.providers.length === 0 ? (
                <p className="text-xs text-dim">
                  未配置自定义提供商（models.json）。
                </p>
              ) : (
                report.providers.map((provider) => {
                  const keyInfo = KEY_STATE_LABELS[provider.keyState] ?? {
                    label: provider.keyState,
                    tone: "plain" as RowTone,
                  };
                  return (
                    <div
                      key={provider.name}
                      className="flex items-center gap-2 py-1 text-xs"
                    >
                      <StatusGlyph
                        tone={keyInfo.tone === "plain" ? "ok" : keyInfo.tone}
                      />
                      <span className="shrink-0 text-secondary">
                        {provider.name}
                      </span>
                      <span className="shrink-0 text-faint">
                        {provider.modelCount} 个模型
                      </span>
                      <span
                        className={clsx(
                          "min-w-0 flex-1 truncate text-right",
                          keyInfo.tone === "plain"
                            ? "text-muted"
                            : TONE_TEXT[keyInfo.tone],
                        )}
                        title={
                          provider.envVar ? `$${provider.envVar}` : undefined
                        }
                      >
                        {keyInfo.label}
                        {provider.envVar ? ` ($${provider.envVar})` : ""}
                      </span>
                    </div>
                  );
                })
              )}
            </DiagSection>

            <DiagSection title="权限">
              <DiagRow
                label="模式"
                value={getPermissionModeLabel(report.permissions.mode)}
              />
              <DiagRow
                label="全局规则"
                value={
                  report.permissions.globalRuleCount === null
                    ? `文件无效：${localizeIpcErrorMessage(
                        report.permissions.globalRulesError ?? "未知错误",
                      )}`
                    : String(report.permissions.globalRuleCount)
                }
                tone={
                  report.permissions.globalRuleCount === null ? "fail" : "plain"
                }
              />
              <DiagRow
                label="工作区规则"
                value={
                  report.permissions.workspace.hasWorkspaceRules
                    ? `存在${report.permissions.workspace.hasAllowRules ? "，包含允许规则" : ""}`
                    : "无"
                }
              />
              {report.permissions.workspace.workspacePath && (
                <DiagRow
                  label="工作区信任状态"
                  value={
                    report.permissions.workspace.trusted ? "已信任" : "未信任"
                  }
                  tone={
                    report.permissions.workspace.hasAllowRules &&
                    !report.permissions.workspace.trusted
                      ? "warn"
                      : "plain"
                  }
                />
              )}
            </DiagSection>

            <DiagSection title="存储">
              <DiagRow
                label="GUI 数据目录"
                value={report.storage.guiDataDir}
                mono
              />
              <DiagRow
                label="设置文件"
                value={report.storage.settingsPath}
                mono
              />
              <DiagRow
                label="会话根目录"
                value={report.storage.sessionsRoot}
                mono
                tone={report.storage.sessionsRootExists ? "plain" : "warn"}
              />
            </DiagSection>

            <DiagSection title="最近错误">
              {report.recentErrors.length === 0 ? (
                <p className="text-xs text-dim">本次运行没有记录警告或错误。</p>
              ) : (
                <div className="space-y-1">
                  {report.recentErrors
                    .slice(-MAX_VISIBLE_LOG_ENTRIES)
                    .map((entry, index) => (
                      <LogEntryRow
                        key={`${entry.ts}-${index}`}
                        entry={entry}
                        now={report.generatedAt}
                      />
                    ))}
                </div>
              )}
            </DiagSection>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DiagSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
        {title}
      </h3>
      <div className="rounded-md border border-border bg-surface/50 px-3 py-2">
        {children}
      </div>
    </section>
  );
}

function DiagRow({
  label,
  value,
  tone = "plain",
  mono = false,
}: {
  label: string;
  value: string;
  tone?: RowTone;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span
        className={clsx(
          "min-w-0 break-all text-right",
          mono && "font-mono",
          tone === "plain" ? "text-secondary" : TONE_TEXT[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}

function StatusGlyph({
  tone,
}: {
  tone: Exclude<RowTone, "plain">;
}): React.JSX.Element {
  if (tone === "ok")
    return <CheckCircle2 size={13} className="shrink-0 text-success" />;
  if (tone === "warn")
    return <AlertTriangle size={13} className="shrink-0 text-warning" />;
  return <XCircle size={13} className="shrink-0 text-error" />;
}

function LogEntryRow({
  entry,
  now,
}: {
  entry: AppLogEntry;
  now: number;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs" title={entry.detail}>
      <span
        className={clsx(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase",
          entry.level === "error"
            ? "bg-error-bg text-error"
            : "bg-warning-bg text-warning",
        )}
      >
        {entry.level === "error" ? "错误" : "警告"}
      </span>
      <span className="shrink-0 text-faint">
        {formatRelativeTime(entry.ts, now)}
      </span>
      <span className="shrink-0 text-muted">[{entry.scope}]</span>
      <span className="min-w-0 flex-1 break-words text-secondary">
        {entry.message}
      </span>
    </div>
  );
}
