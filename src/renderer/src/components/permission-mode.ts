import type { PermissionMode } from "../../../shared/ipc-contracts";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask-edits";

export const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  description: string;
  tone: "safe" | "review" | "command" | "trusted";
}> = [
  {
    value: "plan-readonly",
    label: "规划 / 只读",
    description: "仅启用读取、搜索和列表工具，文件编辑及 Shell 命令会被阻止。",
    tone: "safe",
  },
  {
    value: "ask-edits",
    label: "编辑前询问",
    description: "Pi 在编辑文件或执行可能改变文件的 Shell 命令前会询问。",
    tone: "review",
  },
  {
    value: "ask-commands",
    label: "命令前询问",
    description: "Pi 在执行 Shell 命令前会询问。",
    tone: "command",
  },
  {
    value: "trusted",
    label: "信任模式",
    description: "对你信任的工作流启用所有 Pi 工具。",
    tone: "trusted",
  },
];

const PERMISSION_MODE_VALUES = new Set<PermissionMode>(
  PERMISSION_MODE_OPTIONS.map((option) => option.value),
);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    PERMISSION_MODE_VALUES.has(value as PermissionMode)
  );
}

export function getPermissionModeLabel(mode: PermissionMode): string {
  return (
    PERMISSION_MODE_OPTIONS.find((option) => option.value === mode)?.label ??
    "编辑前询问"
  );
}

export function getPermissionModeDescription(mode: PermissionMode): string {
  return (
    PERMISSION_MODE_OPTIONS.find((option) => option.value === mode)
      ?.description ?? "Pi 在编辑文件或执行可能改变文件的 Shell 命令前会询问。"
  );
}
