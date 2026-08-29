import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configToRows,
  mapLevelState,
  resetModelMap,
  rowsToConfig,
  validateRows,
  withMapLevel,
} from "./custom-models-editor-helpers";
import type { ModelsConfig } from "../../../shared/models-config";

test("configToRows normalizes a broken thinkingLevelMap into valid entries", () => {
  const config = {
    providers: {
      p: {
        baseUrl: "http://x",
        models: [
          {
            id: "m",
            // Junk that models.json may contain after hand edits.
            thinkingLevelMap: { low: "low", high: 5, junk: "x", off: null },
          },
        ],
      },
    },
  } as unknown as ModelsConfig;
  const rows = configToRows(config);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.models[0]!.thinkingLevelMap, {
    low: "low",
    off: null,
  });
});

test("rowsToConfig drops empty custom values and all-default maps", () => {
  const rows = configToRows({
    providers: {
      p: {
        models: [{ id: "a", thinkingLevelMap: { low: "low" } }],
      },
    },
  });
  rows[0]!.models[0]!.thinkingLevelMap = { high: "  ", low: null };
  let config = rowsToConfig(rows);
  assert.deepEqual(config.providers.p!.models![0]!.thinkingLevelMap, {
    low: null,
  });

  rows[0]!.models[0]!.thinkingLevelMap = undefined;
  config = rowsToConfig(rows);
  assert.equal(config.providers.p!.models![0]!.thinkingLevelMap, undefined);
});

test("three-state map helpers round-trip", () => {
  let map = withMapLevel(undefined, "low", "custom", "low");
  assert.equal(mapLevelState(map, "low"), "custom");
  assert.deepEqual(map, { low: "low" });

  map = withMapLevel(map, "low", "unsupported");
  assert.equal(mapLevelState(map, "low"), "unsupported");
  assert.deepEqual(map, { low: null });

  // Switching back to default removes the entry entirely.
  map = withMapLevel(map, "low", "default");
  assert.equal(mapLevelState(map, "low"), "default");
  assert.deepEqual(map, {});

  // An in-progress empty custom value is kept in the draft (kept editable).
  map = withMapLevel(undefined, "high", "custom", "");
  assert.deepEqual(map, { high: "" });
  assert.equal(mapLevelState(map, "high"), "custom");
});

test("validateRows reports provider key, model id and empty custom value problems", () => {
  const rows = configToRows({
    providers: {
      p: {
        models: [{ id: "dup" }, { id: "dup" }, { id: "" }],
      },
      "": { models: [] },
    },
  } as unknown as ModelsConfig);
  // An in-progress empty custom value (typed then cleared) is flagged.
  rows[0]!.models[2]!.thinkingLevelMap = withMapLevel(undefined, "low", "custom", " ");
  const errors = validateRows(rows);
  assert.ok(errors.some((e) => e.includes("非空键名")));
  assert.ok(errors.some((e) => e.includes("模型 ID 重复")));
  assert.ok(errors.some((e) => e.includes("缺少 ID")));
  assert.ok(
    errors.some((e) => e.includes("自定义值不能为空") && e.includes("low")),
  );
});

test("valid rows produce no errors", () => {
  const rows = configToRows({
    providers: {
      a: { models: [{ id: "x", thinkingLevelMap: { off: "none", xhigh: null } }] },
      b: { models: [{ id: "y" }] },
    },
  });
  assert.deepEqual(validateRows(rows), []);
});

test("resetModelMap clears the map but keeps other fields", () => {
  const model = {
    id: "m",
    name: "M",
    reasoning: true,
    thinkingLevelMap: { low: "low" },
  };
  const reset = resetModelMap(model);
  assert.equal(reset.thinkingLevelMap, undefined);
  assert.equal(reset.id, "m");
  assert.equal(reset.name, "M");
  assert.equal(reset.reasoning, true);
  // Original untouched (pure).
  assert.deepEqual(model.thinkingLevelMap, { low: "low" });
});
