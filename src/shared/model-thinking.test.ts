import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampThinkingLevel,
  isThinkingLevel,
  modelSupportsThinkingLevel,
  normalizeThinkingLevelMap,
  supportedThinkingLevels,
  validateThinkingLevelMap,
} from "./model-thinking";

test("non-reasoning models only support off", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinkingLevels({}), ["off"]);
  // A configured map stays inert while reasoning is off (kept for re-enable).
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: false, thinkingLevelMap: { high: "max" } }),
    ["off"],
  );
});

test("standard levels default to provider mapping when absent from the map", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("xhigh/max are only supported when the map sets a string", () => {
  const base = { reasoning: true } as const;
  assert.equal(
    modelSupportsThinkingLevel("xhigh", { ...base, thinkingLevelMap: { xhigh: "xhigh" } }),
    true,
  );
  assert.equal(
    modelSupportsThinkingLevel("max", { ...base, thinkingLevelMap: { max: "max" } }),
    true,
  );
  assert.equal(modelSupportsThinkingLevel("xhigh", base), false);
  assert.equal(modelSupportsThinkingLevel("max", base), false);
  // null marks the level explicitly unsupported even when set.
  assert.equal(
    modelSupportsThinkingLevel("xhigh", { ...base, thinkingLevelMap: { xhigh: null } }),
    false,
  );
});

test("null hides a standard level; strings keep it", () => {
  const model = { reasoning: true, thinkingLevelMap: { minimal: null, low: "enabled" } };
  assert.deepEqual(supportedThinkingLevels(model), [
    "off",
    "low",
    "medium",
    "high",
  ]);
});

test("clamp prefers the requested level, then up, then down", () => {
  const model = {
    reasoning: true,
    thinkingLevelMap: { low: null, medium: "med", xhigh: null },
  };
  // Supported: off, minimal, medium, high (low null-unsupported, xhigh null,
  // max unset).
  assert.equal(clampThinkingLevel("medium", model), "medium");
  assert.equal(clampThinkingLevel("low", model), "medium");
  assert.equal(clampThinkingLevel("xhigh", model), "high");
  assert.equal(clampThinkingLevel("max", model), "high");
  // Unknown request starts from the bottom.
  assert.equal(clampThinkingLevel("bogus", model), "off");
  // Non-reasoning models clamp everything to off.
  assert.equal(clampThinkingLevel("high", { reasoning: false }), "off");
  assert.equal(clampThinkingLevel("high", { reasoning: false, thinkingLevelMap: { high: "hi" } }), "off");
});

test("isThinkingLevel accepts exactly the seven levels", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isThinkingLevel(level), true);
  }
  assert.equal(isThinkingLevel("MAX"), false);
  assert.equal(isThinkingLevel("ultra"), false);
});

test("normalizeThinkingLevelMap drops junk and keeps valid entries", () => {
  assert.equal(normalizeThinkingLevelMap(undefined), undefined);
  assert.equal(normalizeThinkingLevelMap("high"), undefined);
  assert.equal(normalizeThinkingLevelMap([]), undefined);
  assert.deepEqual(normalizeThinkingLevelMap({ off: "none", low: 3, junk: "x" }), {
    off: "none",
  });
  // Valid string values are kept verbatim (no silent trimming of provider values).
  assert.deepEqual(normalizeThinkingLevelMap({ high: null, xhigh: " xh " }), {
    high: null,
    xhigh: " xh ",
  });
  // An all-invalid map normalizes to undefined.
  assert.equal(normalizeThinkingLevelMap({ low: 42 }), undefined);
});

test("validateThinkingLevelMap reports bad shapes with the label", () => {
  assert.deepEqual(validateThinkingLevelMap(undefined, "提供商 p、模型 m"), []);
  assert.deepEqual(validateThinkingLevelMap({ low: "low" }, "L"), []);
  assert.deepEqual(validateThinkingLevelMap({ low: "low" }, "L"), []);

  const shape = validateThinkingLevelMap(42, "L");
  assert.equal(shape.length, 1);
  assert.ok(shape[0]!.includes("必须是对象"));

  const entries = validateThinkingLevelMap({ low: "", ultra: "x", high: 5 }, "L");
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.startsWith("L：")));
});
