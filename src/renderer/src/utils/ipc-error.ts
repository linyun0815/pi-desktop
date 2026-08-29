/**
 * Electron prefixes errors thrown by ipcMain.handle with
 * "Error invoking remote method '<channel>': Error: " before they reach the
 * renderer's rejected promise. Strip that plumbing so callers can decide how
 * to present the underlying message.
 */
const IPC_ERROR_PREFIX_RE =
  /^Error invoking remote method '[^']+': (?:Error: )?/;

const EXACT_UI_ERRORS: Readonly<Record<string, string>> = {
  "No active workspace": "当前没有活动工作区",
  "No active workspace or Pi not running": "当前没有活动工作区或 Pi 未运行",
  "Workspace not found": "找不到工作区",
  "Workflow run not found": "找不到工作流运行记录",
  "No Pi manager for workspace": "找不到该工作区的 Pi 运行实例",
  "Failed to create Pi manager": "无法创建 Pi 运行实例",
  "Pi process is not running": "Pi 进程未运行",
  "Pi process exited": "Pi 进程已退出",
  "Pi process killed": "Pi 进程已终止",
  "Too many pending responses": "待处理响应过多",
  "Attachment path is not permitted": "不允许读取此附件路径",
  "Invalid package specification": "包规格无效",
  "Command failed": "命令执行失败",
  "Working tree is clean": "工作树没有改动",
  "Commit message is required": "提交说明不能为空",
  "Pull request title is required": "拉取请求标题不能为空",
  "No source workspace available for a new tab":
    "没有可用于新建标签页的源工作区",
  "A named branch is required to create a pull request":
    "创建拉取请求需要命名分支",
  "No tracked changes to commit in this workspace. Stage untracked files first to include them.":
    "当前工作区没有可提交的已跟踪改动。请先暂存未跟踪文件。",
  "The index contains staged files outside the active workspace":
    "暂存区包含活动工作区之外的文件",
  "Cannot commit from a detached HEAD": "无法在分离 HEAD 状态下提交",
  "Cannot push from a detached HEAD": "无法在分离 HEAD 状态下推送",
  "Commit the working tree before pushing": "请先提交工作树改动，再进行推送",
  "Push the branch before creating a pull request":
    "请先推送分支，再创建拉取请求",
  "Commit the working tree before creating a pull request":
    "请先提交工作树改动，再创建拉取请求",
  "Cannot push a branch whose upstream is the local repository":
    "无法推送上游为本地仓库的分支",
  "Cannot commit while a Git operation is in progress":
    "Git 操作正在进行，无法提交",
  "Cannot push while a Git operation is in progress":
    "Git 操作正在进行，无法推送",
  "Note title is required": "笔记标题不能为空",
  "Note body is required": "笔记正文不能为空",
  "Only http(s) URLs are allowed": "只允许使用 http(s) URL",
  "Invalid models config": "模型配置无效",
  "Arbiter timed out": "仲裁者超时",
  "Arbiter failed": "仲裁者失败",
  "Git returned an empty worktree root": "Git 返回了空的工作树目录",
  "Session file is already attached to a live runtime":
    "会话文件已绑定到正在运行的实例",
  "Session is already attached to a different workspace runtime":
    "会话已绑定到其他工作区运行实例",
  "theme URL is invalid": "主题 URL 无效",
  "gallery index is not a JSON array": "主题库索引不是 JSON 数组",
  "theme file is not valid JSON": "主题文件不是有效的 JSON",
  "Commit message must be 200 characters or fewer": "提交说明不能超过 200 个字符",
  "Commit message must be a string": "提交说明必须是字符串",
  "Pull request title, body, optional base branch, and optional draft flag are required":
    "需要提供拉取请求标题、正文，以及可选的基础分支和草稿标记",
  'models.json is not a valid models config (missing "providers")':
    'models.json 不是有效的模型配置（缺少 "providers"）',
  'scope must be "global" or "workspace"': 'scope 必须是 "global" 或 "workspace"',
  "Managed worktree tabs cannot change folder; close the tab and create another one":
    "受管理的工作树标签页无法更改文件夹；请关闭该标签页并另建一个",
  "The task references a GitHub pull request that is not checked out in a local worktree":
    "该任务引用的 GitHub 拉取请求未检出到本地工作树",
  "screenshot URL is not an allowed gallery path": "截图 URL 不是允许的主题库路径",
  "theme must be a JSON object": "主题必须是 JSON 对象",
  'kind must be "dark" or "light"': 'kind 必须是 "dark" 或 "light"',
  "Council timeout must be a finite number": "Council 超时必须是有限数字",
};

function localizeKnownUiError(message: string): string {
  const exact = Object.prototype.hasOwnProperty.call(EXACT_UI_ERRORS, message)
    ? EXACT_UI_ERRORS[message]
    : undefined;
  if (exact) return exact;

  for (const [prefix, label] of [
    ["Workspace not found: ", "找不到工作区："],
    ["Session runtime not found: ", "找不到会话运行实例："],
    ["Folder does not exist: ", "文件夹不存在："],
    ["Source folder does not exist: ", "源文件夹不存在："],
    ["theme download failed: ", "主题下载失败："],
    ["gallery index download failed: ", "主题库索引下载失败："],
    ["screenshot download failed: ", "截图下载失败："],
    ["models.json is not valid JSON: ", "models.json 不是有效的 JSON："],
    ["Could not read models.json: ", "无法读取 models.json："],
    ["Could not write theme to ", "无法写入主题文件："],
    ["invalid theme id: ", "无效的主题 ID："],
    ["cannot overwrite built-in theme id: ", "不能覆盖内置主题 ID："],
    ["Invalid path name: ", "无效的路径名称："],
  ] as const) {
    if (message.startsWith(prefix))
      return `${label}${message.slice(prefix.length)}`;
  }

  for (const [prefix, label] of [
    ["Attachment is too large (max ", "附件过大（最大 "],
    ["theme file too large (limit ", "主题文件过大（上限 "],
    ["screenshot too large (limit ", "截图过大（上限 "],
    ["rules file too large (limit ", "权限规则文件过大（上限 "],
    [
      "screenshot is not an allowed image type (content-type: ",
      "截图不是允许的图片类型（content-type：",
    ],
  ] as const) {
    if (message.startsWith(prefix)) {
      return `${label}${message.slice(prefix.length).replace(/\)$/, "）")}`;
    }
  }

  for (const [prefix, label] of [
    [
      "sessionPath must point to an existing Pi session file",
      "sessionPath 必须指向现有的 Pi 会话文件",
    ],
    [
      "sessionPath must be inside the Pi sessions directory",
      "sessionPath 必须位于 Pi 会话目录内",
    ],
    ["theme URLs must use https, got ", "主题 URL 必须使用 https，当前为 "],
    ["theme URL exceeded ", "主题 URL 重定向次数超过 "],
  ] as const) {
    if (message.startsWith(prefix))
      return `${label}${message.slice(prefix.length)}`;
  }

  if (message.startsWith("theme URL host ")) {
    return message
      .replace(
        " is blocked (local/loopback hostname)",
        " 被阻止（本地/回环主机）",
      )
      .replace(
        " is blocked (private/reserved IPv4 address)",
        " 被阻止（私有/保留 IPv4 地址）",
      )
      .replace(
        " is blocked (private/reserved IPv6 address)",
        " 被阻止（私有/保留 IPv6 地址）",
      )
      .replace(" resolved to a blocked address", "解析到了被阻止的地址");
  }

  if (message.startsWith("Command ")) {
    const timedOutAt = message.indexOf(" timed out after ");
    if (timedOutAt > "Command ".length) {
      const command = message.slice("Command ".length, timedOutAt);
      const duration = message.slice(timedOutAt + " timed out after ".length);
      return `命令 ${command} 超时（${duration}）`;
    }
  }

  if (message === "permission rules must be a JSON object")
    return "权限规则必须是 JSON 对象";
  if (message === '"rules" must be an array') return "“rules”必须是数组";
  if (message.startsWith("unsupported permission rules version (expected ")) {
    return `不支持的权限规则版本（应为 ${message.slice("unsupported permission rules version (expected ".length).replace(/\)$/, "")}）`;
  }
  if (message.startsWith('unknown key "')) {
    return message
      .replace(/^unknown key "/, "权限规则中包含未知键“")
      .replace(/" in permission rules file$/, "”")
      .replace(/" in rule (\d+)$/, "”（规则 $1）");
  }
  const rulePrefix = /^rule (\d+)(?:: )?/.exec(message);
  if (rulePrefix) {
    const detail = message.slice(rulePrefix[0].length);
    const detailLabel: Record<string, string> = {
      "must be an object": "必须是对象",
      'action must be "allow" or "deny"': '操作必须是 "allow" 或 "deny"',
      "tool must be a non-empty string": "工具必须是非空字符串",
      "match must be a string": "匹配模式必须是字符串",
    };
    return `规则 ${rulePrefix[1]}：${detailLabel[detail] ?? detail}`;
  }

  if (
    message.startsWith("Cannot commit while a Git ") ||
    message.startsWith("Cannot push while a Git ")
  ) {
    const action = message.startsWith("Cannot commit") ? "提交" : "推送";
    const operation = message
      .slice(message.indexOf("Git ") + 4)
      .replace(/ is in progress$/, "");
    return `Git ${operation} 正在进行，无法${action}`;
  }

  if (message.startsWith("Refusing to read outside the active workspace")) {
    return "拒绝读取活动工作区之外的路径";
  }
  if (message.startsWith("Refusing to write outside the active workspace")) {
    return "拒绝写入活动工作区之外的路径";
  }

  if (message.startsWith("git ")) {
    const failedAt = message.indexOf(" failed");
    if (failedAt > 4) {
      const operation = message.slice(4, failedAt);
      const detail = message
        .slice(failedAt + " failed".length)
        .replace(/^: /, "");
      return `git ${operation} 失败${detail ? `：${detail}` : ""}`;
    }
    const timedOutAt = message.indexOf(" timed out");
    if (timedOutAt > 4) return `git ${message.slice(4, timedOutAt)} 超时`;
  }

  // Theme file validation (theme-file.ts) — label-prefixed patterns.
  const unknownKey = /^(.+?) has unknown key "(.+)"$/.exec(message);
  if (unknownKey) return `${unknownKey[1]} 包含未知键“${unknownKey[2]}”`;
  const missingKey = /^(.+?) is missing "(.+)"$/.exec(message);
  if (missingKey) return `${missingKey[1]} 缺少“${missingKey[2]}”`;
  if (message.endsWith(" is not a valid color"))
    return `${message.slice(0, -" is not a valid color".length)} 不是有效的颜色值`;
  const textLimit = /^(.+?) must be a non-empty string of at most (\d+) characters$/.exec(
    message,
  );
  if (textLimit)
    return `${textLimit[1]} 必须是不超过 ${textLimit[2]} 个字符的非空字符串`;
  const schema = /^unsupported \$schema \(expected (.+)\)$/.exec(message);
  if (schema) return `不支持的 $schema（应为 ${schema[1]}）`;
  const redirect = /^theme URL redirect \((.+)\) had no location header$/.exec(
    message,
  );
  if (redirect) return `主题 URL 重定向（${redirect[1]}）缺少 location 响应头`;
  const councilRange = /^Council timeout must be between (\d+) and (\d+) seconds$/.exec(
    message,
  );
  if (councilRange)
    return `Council 超时必须在 ${councilRange[1]} 到 ${councilRange[2]} 秒之间`;

  // Generic IPC argument type guards ("X must be a …"). Longer suffixes first.
  const genericSuffixes = [
    [" must be a string array", " 必须是字符串数组"],
    [" must be an array", " 必须是数组"],
    [" must be an object", " 必须是对象"],
    [" must be a boolean", " 必须是布尔值"],
    [" must be a string", " 必须是字符串"],
  ] as const;
  for (const [suffix, label] of genericSuffixes) {
    if (message.endsWith(suffix)) {
      return `${message.slice(0, -suffix.length)}${label}`;
    }
  }

  return message;
}

/** Strip Electron's transport prefix while preserving the original message. */
export function formatIpcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(IPC_ERROR_PREFIX_RE, "");
}

/** Localize an already-extracted message (e.g. an error field in a report). */
export function localizeIpcErrorMessage(message: string): string {
  return localizeKnownUiError(message);
}

/** Format a user-facing error without translating unknown runtime output. */
export function formatUiError(err: unknown): string {
  return localizeKnownUiError(formatIpcError(err));
}
