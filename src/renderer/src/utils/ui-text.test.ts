import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localizedCommandGroup,
  localizedPackageType,
  localizedScope,
  localizedStatus,
  localizedThemeKind,
  localizedThemeName,
  localizedTokenLabel,
} from "./ui-text";

test("localizes shared renderer labels while preserving unknown values", () => {
  assert.equal(localizedStatus("running"), "运行中");
  assert.equal(localizedStatus("provider-specific"), "provider-specific");
  assert.equal(localizedCommandGroup("Commands"), "命令");
  assert.equal(localizedPackageType("extension"), "扩展");
  assert.equal(localizedScope("project"), "项目");
  assert.equal(localizedThemeKind("light"), "浅色");
  assert.equal(localizedThemeName("dark", "Dark"), "深色");
  assert.equal(localizedThemeName("custom", "我的主题"), "我的主题");
  assert.equal(localizedTokenLabel("border-strong"), "强边框");
});
