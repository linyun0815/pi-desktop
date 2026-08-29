import assert from "node:assert/strict";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
  getPermissionModeLabel,
  isPermissionMode,
} from "./permission-mode";

assert.equal(DEFAULT_PERMISSION_MODE, "ask-edits");

assert.deepEqual(
  PERMISSION_MODE_OPTIONS.map((option) => option.value),
  ["plan-readonly", "ask-edits", "ask-commands", "trusted"],
);

assert.equal(getPermissionModeLabel("plan-readonly"), "规划 / 只读");
assert.equal(getPermissionModeLabel("ask-edits"), "编辑前询问");
assert.equal(getPermissionModeLabel("ask-commands"), "命令前询问");
assert.equal(getPermissionModeLabel("trusted"), "信任模式");

assert.equal(isPermissionMode("ask-edits"), true);
assert.equal(isPermissionMode("bad-mode"), false);
