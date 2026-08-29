const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
  error: "错误",
  done: "完成",
  pending: "等待中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
  cancelled: "已取消",
  unknown: "未知",
  working: "工作中",
  "needs-approval": "等待审批",
  contributed: "已贡献",
  "timed-out": "已超时",
  errored: "出错",
  idle: "空闲",
};

const SOURCE_LABELS: Record<string, string> = {
  skill: "技能",
  prompt: "提示词",
  builtin: "命令",
  extension: "扩展",
};

const COMMAND_GROUP_LABELS: Record<string, string> = {
  Skills: "技能",
  Prompts: "提示词",
  Commands: "命令",
  Extensions: "扩展",
  Other: "其他",
};

const TOKEN_LABELS: Record<string, string> = {
  app: "应用背景",
  surface: "表面",
  "surface-hover": "悬停表面",
  card: "卡片",
  elevated: "提升层",
  highlight: "高亮",
  "highlight-strong": "强高亮",
  primary: "主要文本",
  secondary: "次要文本",
  muted: "弱化文本",
  dim: "暗淡文本",
  faint: "淡色文本",
  ghost: "幽灵文本",
  inverse: "反色文本",
  border: "边框",
  "border-strong": "强边框",
  "border-strong-hover": "悬停强边框",
  focus: "焦点",
  accent: "强调色",
  "accent-hover": "悬停强调色",
  "accent-fg": "强调前景",
  "accent-bg": "强调背景",
  success: "成功",
  "success-bg": "成功背景",
  warning: "警告",
  "warning-bg": "警告背景",
  error: "错误",
  "error-hover": "悬停错误",
  "error-bg": "错误背景",
  info: "信息",
  "info-bg": "信息背景",
  special: "特殊色",
  "special-bg": "特殊背景",
  "chat-column": "聊天区域",
  "chat-column-border": "聊天区域边框",
  scrollbar: "滚动条",
  "scrollbar-hover": "悬停滚动条",
  "md-code": "Markdown 代码",
  "md-pre-bg": "Markdown 代码背景",
  keyword: "关键字",
  string: "字符串",
  comment: "注释",
  function: "函数",
  type: "类型",
  number: "数字",
  operator: "运算符",
  property: "属性",
  tag: "标签",
  variable: "变量",
  constant: "常量",
  heading: "标题",
  link: "链接",
  list: "列表",
  quote: "引用",
  meta: "元信息",
  mark: "标记",
  invalid: "无效内容",
  "active-line-bg": "当前行背景",
  "selection-bg": "选中背景",
  "selection-match-bg": "匹配背景",
};

export function localizedStatus(value: string): string {
  return STATUS_LABELS[value] ?? value;
}

export function localizedSource(value: string): string {
  return SOURCE_LABELS[value] ?? value;
}

export function localizedCommandGroup(value: string): string {
  return COMMAND_GROUP_LABELS[value] ?? value;
}

export function localizedTokenLabel(value: string): string {
  return TOKEN_LABELS[value] ?? value.replace(/-/g, " ");
}

const BUILTIN_THEME_NAMES: Record<string, string> = {
  dark: "深色",
  light: "浅色",
  nord: "Nord",
  gruvbox: "Gruvbox",
  "breeze-dark": "Breeze 深色",
  "breeze-light": "Breeze 浅色",
  "breeze-claudius": "Breeze Claudius",
};

export function localizedThemeKind(value: string): string {
  if (value === "dark") return "深色";
  if (value === "light") return "浅色";
  return value;
}

export function localizedThemeName(id: string, fallback: string): string {
  return BUILTIN_THEME_NAMES[id] ?? fallback;
}

export function localizedPackageType(value: string): string {
  if (value === "extension") return "扩展";
  if (value === "skill") return "技能";
  return value;
}

export function localizedScope(value: string): string {
  if (value === "global") return "全局";
  if (value === "project") return "项目";
  if (value === "package") return "包";
  if (value === "cli") return "命令行";
  return value;
}

export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}数`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
