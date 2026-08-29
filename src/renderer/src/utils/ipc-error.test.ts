import assert from "node:assert/strict";
import { test } from "node:test";
import { formatIpcError, formatUiError } from "./ipc-error";

test("strips the Electron remote-method prefix and inner Error label", () => {
  assert.equal(
    formatIpcError(
      new Error(
        "Error invoking remote method 'file:diff': Error: git diff failed: fatal: bad object HEAD",
      ),
    ),
    "git diff failed: fatal: bad object HEAD",
  );
});

test("strips the prefix when no inner Error label is present", () => {
  assert.equal(
    formatIpcError(
      new Error(
        "Error invoking remote method 'file:diff': No active workspace",
      ),
    ),
    "No active workspace",
  );
});

test("localizes known application errors but preserves runtime details", () => {
  assert.equal(
    formatUiError(new Error("No active workspace")),
    "当前没有活动工作区",
  );
  assert.equal(
    formatUiError(new Error("Workspace not found: ws-1")),
    "找不到工作区：ws-1",
  );
  assert.equal(
    formatUiError(new Error("git diff failed: fatal: bad object HEAD")),
    "git diff 失败：fatal: bad object HEAD",
  );
  assert.equal(
    formatUiError(new Error("Provider returned an unexpected response")),
    "Provider returned an unexpected response",
  );
  assert.equal(formatUiError(new Error("toString")), "toString");
});

test("localizes git conveyor and workspace errors", () => {
  assert.equal(
    formatUiError(
      new Error("Commit message must be 200 characters or fewer"),
    ),
    "提交说明不能超过 200 个字符",
  );
  assert.equal(
    formatUiError(new Error("Commit message must be a string")),
    "提交说明必须是字符串",
  );
  assert.equal(
    formatUiError(
      new Error(
        "Pull request title, body, optional base branch, and optional draft flag are required",
      ),
    ),
    "需要提供拉取请求标题、正文，以及可选的基础分支和草稿标记",
  );
  assert.equal(
    formatUiError(
      new Error(
        "Managed worktree tabs cannot change folder; close the tab and create another one",
      ),
    ),
    "受管理的工作树标签页无法更改文件夹；请关闭该标签页并另建一个",
  );
  assert.equal(
    formatUiError(
      new Error(
        "The task references a GitHub pull request that is not checked out in a local worktree",
      ),
    ),
    "该任务引用的 GitHub 拉取请求未检出到本地工作树",
  );
});

test("localizes models config and permission scope errors", () => {
  assert.equal(
    formatUiError(
      new Error('models.json is not a valid models config (missing "providers")'),
    ),
    'models.json 不是有效的模型配置（缺少 "providers"）',
  );
  assert.equal(
    formatUiError(new Error('scope must be "global" or "workspace"')),
    'scope 必须是 "global" 或 "workspace"',
  );
});

test("localizes theme validation and storage errors", () => {
  assert.equal(
    formatUiError(new Error("Could not write theme to /tmp/x.json")),
    "无法写入主题文件：/tmp/x.json",
  );
  assert.equal(
    formatUiError(new Error("cannot overwrite built-in theme id: dark")),
    "不能覆盖内置主题 ID：dark",
  );
  assert.equal(
    formatUiError(
      new Error(
        "screenshot is not an allowed image type (content-type: text/html)",
      ),
    ),
    "截图不是允许的图片类型（content-type：text/html）",
  );
  assert.equal(
    formatUiError(
      new Error("theme URL redirect (302) had no location header"),
    ),
    "主题 URL 重定向（302）缺少 location 响应头",
  );
  assert.equal(
    formatUiError(new Error("theme must be a JSON object")),
    "主题必须是 JSON 对象",
  );
  assert.equal(
    formatUiError(new Error('kind must be "dark" or "light"')),
    'kind 必须是 "dark" 或 "light"',
  );
  assert.equal(
    formatUiError(new Error("colors has unknown key \"surface\"")),
    "colors 包含未知键“surface”",
  );
  assert.equal(
    formatUiError(new Error("colors.background is not a valid color")),
    "colors.background 不是有效的颜色值",
  );
  assert.equal(
    formatUiError(new Error("name must be a non-empty string of at most 40 characters")),
    "name 必须是不超过 40 个字符的非空字符串",
  );
  assert.equal(
    formatUiError(new Error("unsupported $schema (expected https://pi-desktop.dev/theme/v1.json)")),
    "不支持的 $schema（应为 https://pi-desktop.dev/theme/v1.json）",
  );
});

test("localizes generic argument type guards by suffix", () => {
  assert.equal(
    formatUiError(new Error("filePath must be a string")),
    "filePath 必须是字符串",
  );
  assert.equal(
    formatUiError(new Error("tags must be an array")),
    "tags 必须是数组",
  );
  assert.equal(
    formatUiError(new Error("Start options must be an object")),
    "Start options 必须是对象",
  );
  assert.equal(
    formatUiError(new Error("noSession must be a boolean")),
    "noSession 必须是布尔值",
  );
  assert.equal(
    formatUiError(new Error("args must be a string array")),
    "args 必须是字符串数组",
  );
});

test("localizes council timeout errors", () => {
  assert.equal(
    formatUiError(new Error("Council timeout must be a finite number")),
    "Council 超时必须是有限数字",
  );
  assert.equal(
    formatUiError(new Error("Council timeout must be between 10 and 600 seconds")),
    "Council 超时必须在 10 到 600 秒之间",
  );
});

test("passes through plain errors and non-Error values", () => {
  assert.equal(formatIpcError(new Error("plain failure")), "plain failure");
  assert.equal(formatIpcError("string failure"), "string failure");
});
