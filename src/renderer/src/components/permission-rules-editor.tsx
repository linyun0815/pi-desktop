import {
  Plus,
  Trash2,
  Upload,
  Download,
  Copy,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import type {
  PermissionRule,
  PermissionRuleAction,
  PermissionRulesScope,
} from "../../../shared/ipc-contracts";
import { emptyRule } from "./permission-rules-editor-helpers";

const TOOL_SUGGESTIONS = [
  "*",
  "bash",
  "edit",
  "write",
  "read",
  "grep",
] as const;
const TOOL_DATALIST_ID = "permission-rule-tool-suggestions";

interface PermissionRulesEditorProps {
  rules: PermissionRule[];
  onChange: (rules: PermissionRule[]) => void;
  onImport: () => void;
  onExport: () => void;
  scope: PermissionRulesScope;
  workspaceExists: boolean;
  onCopyFromGlobal: () => void;
  onRemoveWorkspace: () => void;
  workspaceOverride: boolean;
  workspaceActive: boolean;
  workspaceTrusted: boolean;
  workspaceHasAllowRules: boolean;
  onSetWorkspaceTrust: (trusted: boolean) => void;
  loadError: string | null;
  actionError: string | null;
}

export function PermissionRulesEditor({
  rules,
  onChange,
  onImport,
  onExport,
  scope,
  workspaceExists,
  onCopyFromGlobal,
  onRemoveWorkspace,
  workspaceOverride,
  workspaceActive,
  workspaceTrusted,
  workspaceHasAllowRules,
  onSetWorkspaceTrust,
  loadError,
  actionError,
}: PermissionRulesEditorProps): React.JSX.Element {
  const updateRule = (index: number, patch: Partial<PermissionRule>): void => {
    onChange(
      rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
  };

  const removeRule = (index: number): void => {
    onChange(rules.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim">
          拒绝始终优先，其次是允许，最后由上面的模式决定。使用 * 表示通配符。
        </span>
        <div className="flex gap-1">
          {scope === "workspace" && (
            <button
              type="button"
              onClick={onCopyFromGlobal}
              className="flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs text-primary transition-colors hover:border-border-strong-hover"
              title="将全局规则列表复制到此工作区（保存前会替换下方列表）"
            >
              <Copy size={12} /> 从全局复制
            </button>
          )}
          <button
            type="button"
            onClick={onImport}
            className="flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs text-primary transition-colors hover:border-border-strong-hover"
            title="从 JSON 文件导入规则（保存前会替换下方列表）"
          >
            <Upload size={12} /> 导入
          </button>
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs text-primary transition-colors hover:border-border-strong-hover"
            title="将下方列表导出为 JSON 文件"
          >
            <Download size={12} /> 导出
          </button>
        </div>
      </div>

      {scope === "workspace" && workspaceActive && (
        <div className="flex flex-col gap-2">
          {workspaceTrusted ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs text-dim">
              <span className="flex items-center gap-1.5 text-primary">
                <ShieldCheck size={13} className="shrink-0" />
                已信任，此工作区的允许规则会生效，HTML 预览可以运行脚本。
              </span>
              <button
                type="button"
                onClick={() => onSetWorkspaceTrust(false)}
                className="shrink-0 rounded-md border border-border-strong px-2 py-1 text-primary transition-colors hover:border-border-strong-hover"
              >
                撤销信任
              </button>
            </div>
          ) : (
            <div
              className={`flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs ${
                workspaceHasAllowRules
                  ? "border-warning-bg bg-warning-bg text-warning"
                  : "border-border-strong bg-surface text-dim"
              }`}
            >
              <span className="flex items-start gap-1.5">
                <ShieldAlert size={13} className="mt-0.5 shrink-0" />
                {workspaceHasAllowRules
                  ? "此工作区的允许规则未生效，HTML 预览在信任前为静态模式。拒绝规则仍然生效。请只信任来源可靠的工作区。"
                  : "此工作区的 HTML 预览为静态模式（脚本已禁用）。信任后可启用交互式预览和允许规则。"}
              </span>
              <button
                type="button"
                onClick={() => onSetWorkspaceTrust(true)}
                className="shrink-0 rounded-md border border-border-strong bg-surface px-2 py-1 text-primary transition-colors hover:border-border-strong-hover"
              >
                信任工作区
              </button>
            </div>
          )}
          {workspaceExists && (
            <button
              type="button"
              onClick={onRemoveWorkspace}
              className="flex items-center gap-1 self-start rounded-md border border-error-bg px-2 py-1 text-xs text-error transition-colors hover:bg-error-bg"
              title="删除此工作区的 .pi-desktop/permission-rules.json，恢复使用全局规则"
            >
              <Trash2 size={12} /> 移除工作区规则
            </button>
          )}
        </div>
      )}

      {workspaceOverride && scope === "global" && (
        <p className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs text-dim">
          此工作区有自己的规则文件（.pi-desktop/permission-rules.json）。其拒绝规则会叠加在全局规则之上；允许规则仅在信任此工作区后生效，详见“当前工作区”标签页。
        </p>
      )}

      {loadError && (
        <p
          role="alert"
          className="rounded-md border border-error-bg bg-error-bg px-2 py-1.5 text-xs text-error"
        >
          已保存的规则文件无效，已忽略： {loadError}
        </p>
      )}

      <datalist id={TOOL_DATALIST_ID}>
        {TOOL_SUGGESTIONS.map((tool) => (
          <option key={tool} value={tool} />
        ))}
      </datalist>

      {rules.length === 0 && (
        <p className="px-1 text-xs text-dim">
          暂无规则，所有行为由上面的模式决定。
        </p>
      )}

      {rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <select
            value={rule.action}
            onChange={(e) =>
              updateRule(index, {
                action: e.target.value as PermissionRuleAction,
              })
            }
            className="rounded-md border border-border-strong bg-surface px-1.5 py-1 text-xs text-primary"
            aria-label={`规则 ${index + 1} 操作`}
          >
            <option value="allow">允许</option>
            <option value="deny">拒绝</option>
          </select>
          <input
            type="text"
            value={rule.tool}
            onChange={(e) => updateRule(index, { tool: e.target.value })}
            list={TOOL_DATALIST_ID}
            placeholder="工具（* = 任意）"
            className="w-28 rounded-md border border-border-strong bg-surface px-1.5 py-1 text-xs text-primary placeholder:text-dim"
            aria-label={`规则 ${index + 1} 工具`}
          />
          <input
            type="text"
            value={rule.match ?? ""}
            onChange={(e) => updateRule(index, { match: e.target.value })}
            placeholder="匹配模式，例如 npm test*（留空 = 任意输入）"
            className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-1.5 py-1 font-mono text-xs text-primary placeholder:text-dim"
            aria-label={`规则 ${index + 1} 匹配模式`}
          />
          <button
            type="button"
            onClick={() => removeRule(index)}
            className="shrink-0 rounded-md p-1 text-dim transition-colors hover:text-error"
            title="移除规则"
            aria-label={`移除规则 ${index + 1}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...rules, emptyRule()])}
        className="flex items-center gap-1 rounded-md border border-dashed border-border-strong px-2 py-1 text-xs text-dim transition-colors hover:border-border-strong-hover hover:text-primary"
      >
        <Plus size={12} /> 添加规则
      </button>

      {actionError && (
        <p role="alert" className="text-xs text-error">
          {actionError}
        </p>
      )}
    </div>
  );
}
