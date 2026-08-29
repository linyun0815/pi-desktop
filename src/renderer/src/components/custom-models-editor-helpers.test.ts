import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateRowId,
  applyCatalogLookupResult,
  configToRows,
  filterDiscoveryModels,
  fillBlankModelMetadata,
  mapLevelState,
  normalizeCostDraft,
  resetModelMap,
  rowsToConfig,
  validateRows,
  withMapLevel,
  withStableRowIds,
  type ModelRow,
  type ProviderRow,
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

test("configToRows safely skips broken provider entries and model elements", () => {
  const config = {
    providers: {
      good: { baseUrl: "http://x", models: [{ id: "a" }] },
      broken: null,
      alsoBroken: "nope",
      noModels: { models: "junk" },
      partial: {
        models: [
          null,
          42,
          {
            id: "b",
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
            vendorCustom: "keep",
          },
        ],
      },
    },
  } as unknown as ModelsConfig;
  const rows = configToRows(config);
  assert.deepEqual(
    rows.map((r) => r.key).sort(),
    ["good", "noModels", "partial"],
  );
  assert.equal(rows.find((r) => r.key === "noModels")!.models.length, 0);
  const partial = rows.find((r) => r.key === "partial")!;
  assert.equal(partial.models.length, 1);
  assert.equal(partial.models[0]!.id, "b");
  // Valid models keep their cost, unknown fields and thinkingLevelMap.
  assert.deepEqual(partial.models[0]!.cost, {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 0.25,
  });
  assert.equal(
    (partial.models[0] as Record<string, unknown>).vendorCustom,
    "keep",
  );
  // Every row (provider and model) carries a unique local id.
  const ids = rows.flatMap((r) => [r.rowId, ...r.models.map((m) => m.rowId)]);
  assert.equal(new Set(ids).size, ids.length);
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

test("rowsToConfig strips the local rowId from providers and models", () => {
  const rows = configToRows({
    providers: { p: { models: [{ id: "a" }] } },
  });
  const config = rowsToConfig(rows);
  const outModel = config.providers.p!.models![0]!;
  assert.ok(!("rowId" in outModel));
  assert.ok(!("rowId" in config.providers.p!));
});

test("normalizeCostDraft fills missing rates and drops all-blank drafts", () => {
  assert.equal(normalizeCostDraft(undefined), undefined);
  // Nothing configured → the caller treats this as "remove the cost".
  assert.equal(normalizeCostDraft({}), undefined);
  // Non-object junk and invalid-only drafts are dropped.
  assert.equal(normalizeCostDraft("junk" as unknown as undefined), undefined);
  assert.equal(normalizeCostDraft({ input: -1 }), undefined);
  // A single typed rate fills the remaining three as 0.
  assert.deepEqual(normalizeCostDraft({ input: 2 }), {
    input: 2,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // Tiers pass through untouched.
  const tiers = [
    { inputTokensAbove: 200000, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
  ];
  assert.deepEqual(
    normalizeCostDraft({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      tiers,
    }),
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers },
  );
});

test("rowsToConfig cost: partial fills zeros, all-blank emits {}, absent omits", () => {
  // Partial cost objects are intentional here: a hand-edited models.json may
  // carry them and the editor treats missing rates as unconfigured.
  const rows = configToRows({
    providers: {
      p: {
        models: [
          { id: "partial", cost: { input: 2 } },
          { id: "cleared", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
          { id: "typed", },
          { id: "no-cost" },
          // A tiers-only cost (no base rates) counts as blank: the four price
          // inputs are the editor's source of truth.
          { id: "tiers-only", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, tiers: [{ inputTokensAbove: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] } },
        ],
      },
    },
  } as unknown as ModelsConfig);
  const models = rows[0]!.models;
  // User clears every rate on "cleared": the draft object stays, blank.
  models[1]!.cost = {};
  // User types one rate on "typed".
  models[2]!.cost = { output: 3 };
  // User clears "tiers-only" down to just its tiers.
  models[4]!.cost = { tiers: [{ inputTokensAbove: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] };

  const out = rowsToConfig(rows).providers.p!.models!;
  const byId = (id: string): ModelRow =>
    out.find((m) => m.id === id)! as unknown as ModelRow;
  assert.deepEqual(byId("partial").cost, {
    input: 2,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // All four rates cleared → explicit removal signal for mergeModelsConfig.
  assert.deepEqual(byId("cleared").cost, {});
  assert.deepEqual(byId("typed").cost, {
    input: 0,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // Never had a draft → no cost key at all (merge keeps the original, which
  // here is also absent).
  assert.equal(byId("no-cost").cost, undefined);
  assert.deepEqual(byId("tiers-only").cost, {});
});

test("fillBlankModelMetadata only fills blanks and preserves explicit values", () => {
  const suggestion = {
    name: "Suggested",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };

  const blank = fillBlankModelMetadata({ id: "m", rowId: "r1" }, suggestion);
  assert.equal(blank.name, "Suggested");
  assert.equal(blank.reasoning, true);
  assert.deepEqual(blank.input, ["text", "image"]);
  assert.equal(blank.contextWindow, 128000);
  assert.equal(blank.maxTokens, 4096);
  assert.deepEqual(blank.cost, suggestion.cost);

  // Explicit false / 0 / existing values / map / unknown fields survive.
  const model: ModelRow = {
    id: "m",
    rowId: "r2",
    name: "Mine",
    reasoning: false,
    input: ["text"],
    contextWindow: 1,
    maxTokens: 2,
    thinkingLevelMap: { low: "low" },
    cost: { input: 0, output: 9 },
    vendorField: "keep-me",
  };
  const next = fillBlankModelMetadata(model, suggestion);
  assert.equal(next.name, "Mine");
  assert.equal(next.reasoning, false);
  assert.deepEqual(next.input, ["text"]);
  assert.equal(next.contextWindow, 1);
  assert.equal(next.maxTokens, 2);
  assert.deepEqual(next.thinkingLevelMap, { low: "low" });
  // 0 stays 0; only the missing rates are filled in.
  assert.deepEqual(next.cost, {
    input: 0,
    output: 9,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  assert.equal((next as Record<string, unknown>).vendorField, "keep-me");
  // Pure: the input row is untouched.
  assert.deepEqual(model.cost, { input: 0, output: 9 });

  // A blank (whitespace) name counts as fillable.
  assert.equal(
    fillBlankModelMetadata({ id: "m", rowId: "r3", name: "  " }, suggestion)
      .name,
    "Suggested",
  );

  // No suggestion.cost → no rates are injected.
  const { cost: _noCost, ...withoutCost } = suggestion;
  assert.equal(
    fillBlankModelMetadata({ id: "m", rowId: "r4" }, withoutCost).cost,
    undefined,
  );
});

test("applyCatalogLookupResult reports error and no-match without touching rows", () => {
  const rows = configToRows({
    providers: { p: { models: [{ id: "m1" }, { id: "m2" }] } },
  });
  const provider = rows[0]!;
  const [m1, m2] = provider.models;

  let outcome = applyCatalogLookupResult(
    rows,
    provider.rowId,
    m1!.rowId,
    { ok: false, error: "目录服务不可用" },
  );
  assert.equal(outcome.rows, rows);
  assert.deepEqual(outcome.status, {
    state: "error",
    message: "目录服务不可用",
  });

  outcome = applyCatalogLookupResult(rows, provider.rowId, m1!.rowId, {
    ok: true,
    match: {
      modelId: "m1",
      match: "none",
      metadata: {},
      priceReliable: true,
      warnings: [],
    },
  });
  assert.equal(outcome.rows, rows);
  assert.equal(outcome.status.state, "no-match");

  // A non-"none" match with an entirely empty suggestion is also no-match.
  outcome = applyCatalogLookupResult(rows, provider.rowId, m2!.rowId, {
    ok: true,
    match: {
      modelId: "m2",
      match: "consensus",
      metadata: {},
      priceReliable: true,
      warnings: [],
    },
  });
  assert.equal(outcome.status.state, "no-match");
});

test("applyCatalogLookupResult merges into the latest row values", () => {
  const rows = configToRows({
    providers: { p: { models: [{ id: "m1" }, { id: "m2" }] } },
  });
  const provider = rows[0]!;
  const m1 = provider.models[0]!;
  const m2 = provider.models[1]!;

  // The user renamed the model and typed a context window while the request
  // was in flight; the merge must land on these current values.
  const edited: ProviderRow[] = rows.map((r) =>
    r.rowId === provider.rowId
      ? {
          ...r,
          models: r.models.map((m) =>
            m.rowId === m1.rowId
              ? { ...m, name: "User", contextWindow: 8 }
              : m,
          ),
        }
      : r,
  );
  const outcome = applyCatalogLookupResult(edited, provider.rowId, m1.rowId, {
    ok: true,
    match: {
      modelId: "m1",
      match: "exact",
      metadata: {
        name: "Catalog",
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      priceReliable: true,
      warnings: ["价格来自单一来源"],
    },
  });
  const filled = outcome.rows
    .find((r) => r.rowId === provider.rowId)!
    .models.find((m) => m.rowId === m1.rowId)!;
  assert.equal(filled.name, "User"); // user edit preserved
  assert.equal(filled.contextWindow, 8); // user edit preserved
  assert.equal(filled.maxTokens, 8192); // blank filled
  assert.deepEqual(filled.cost, {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(outcome.status.state, "success");
  assert.ok(outcome.status.message.includes("已从目录填充"));
  assert.ok(outcome.status.message.includes("价格来自单一来源"));
  // Other rows are untouched; rows were replaced (new draft).
  assert.equal(
    outcome.rows.find((r) => r.rowId === provider.rowId)!.models.find(
      (m) => m.rowId === m2.rowId,
    )!.name,
    undefined,
  );
  assert.notEqual(outcome.rows, edited);
});

test("applyCatalogLookupResult never injects unreliable prices", () => {
  const rows = configToRows({
    providers: { p: { models: [{ id: "m" }] } },
  });
  const provider = rows[0]!;
  const model = provider.models[0]!;

  // Price-only suggestion, prices unreliable → nothing fillable, nothing set.
  let outcome = applyCatalogLookupResult(rows, provider.rowId, model.rowId, {
    ok: true,
    match: {
      modelId: "m",
      match: "baseUrl",
      metadata: { cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } },
      priceReliable: false,
      warnings: [],
    },
  });
  let filled = outcome.rows
    .find((r) => r.rowId === provider.rowId)!
    .models.find((m) => m.rowId === model.rowId)!;
  assert.equal(filled.cost, undefined);
  assert.equal(outcome.status.state, "unreliable");

  // Reliable non-price fields are still filled alongside the note.
  outcome = applyCatalogLookupResult(rows, provider.rowId, model.rowId, {
    ok: true,
    match: {
      modelId: "m",
      match: "consensus",
      metadata: {
        reasoning: true,
        maxTokens: 4096,
        cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
      },
      priceReliable: false,
      warnings: [],
    },
  });
  filled = outcome.rows
    .find((r) => r.rowId === provider.rowId)!
    .models.find((m) => m.rowId === model.rowId)!;
  assert.equal(filled.reasoning, true);
  assert.equal(filled.maxTokens, 4096);
  assert.equal(filled.cost, undefined);
  assert.equal(outcome.status.state, "unreliable");
  assert.ok(outcome.status.message.includes("未填充价格"));

  // A deleted row yields an error status instead of throwing.
  outcome = applyCatalogLookupResult(rows, "no-such-provider", model.rowId, {
    ok: true,
    match: {
      modelId: "m",
      match: "exact",
      metadata: { name: "x" },
      priceReliable: true,
      warnings: [],
    },
  });
  assert.equal(outcome.rows, rows);
  assert.equal(outcome.status.state, "error");
});

test("withStableRowIds reuses ids for matching content and keeps fresh ones", () => {
  const first = configToRows({
    providers: { p: { models: [{ id: "a" }, { id: "b" }] } },
  });
  const second = configToRows({
    providers: { p: { models: [{ id: "b" }, { id: "c" }] } },
  });
  const merged = withStableRowIds(second, first);
  assert.equal(merged[0]!.rowId, first[0]!.rowId);
  // "b" moved to the front but keeps its id; "c" is genuinely new.
  assert.equal(merged[0]!.models[0]!.rowId, first[0]!.models[1]!.rowId);
  assert.notEqual(merged[0]!.models[1]!.rowId, first[0]!.models[0]!.rowId);

  // A renamed provider gets a fresh id (expansion resets, as before).
  const renamed = configToRows({
    providers: { q: { models: [{ id: "a" }] } },
  });
  assert.notEqual(withStableRowIds(renamed, first)[0]!.rowId, first[0]!.rowId);

  // Duplicate keys in the draft never share one id.
  const prev = configToRows({ providers: { p: { models: [] } } });
  const duped: ProviderRow[] = [
    prev[0]!,
    { ...prev[0]!, rowId: allocateRowId() },
  ];
  const mergedDup = withStableRowIds(duped, prev);
  assert.notEqual(mergedDup[0]!.rowId, mergedDup[1]!.rowId);
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

test("validateRows flags invalid price rates with a locating label", () => {
  const rows = configToRows({
    providers: { p: { models: [{ id: "m" }] } },
  });
  const model = rows[0]!.models[0]!;

  model.cost = { input: -1 };
  let errors = validateRows(rows);
  assert.ok(
    errors.some(
      (e) => e.includes("输入价") && e.includes("p") && e.includes("m"),
    ),
  );

  model.cost = { input: Number.NaN, output: 2 };
  errors = validateRows(rows);
  assert.ok(errors.some((e) => e.includes("输入价")));
  assert.ok(!errors.some((e) => e.includes("输出价")));

  // 0 is a legal free price; blank rates are fine.
  model.cost = { input: 0 };
  assert.deepEqual(validateRows(rows), []);
  model.cost = undefined;
  assert.deepEqual(validateRows(rows), []);
});

test("filterDiscoveryModels matches all tokens across id and name", () => {
  const models = [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o mini" },
    { id: "claude-3", name: "Claude" },
  ];
  assert.equal(filterDiscoveryModels(models, "").length, 3);
  assert.equal(filterDiscoveryModels(models, "   ").length, 3);
  assert.deepEqual(
    filterDiscoveryModels(models, "mini").map((m) => m.id),
    ["gpt-4o-mini"],
  );
  assert.deepEqual(
    filterDiscoveryModels(models, "GPT mini").map((m) => m.id),
    ["gpt-4o-mini"],
  );
  assert.equal(filterDiscoveryModels(models, "opus").length, 0);
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
  assert.ok(!("thinkingLevelMap" in reset));
  assert.equal(reset.id, "m");
  assert.equal(reset.name, "M");
  assert.equal(reset.reasoning, true);
  // Original untouched (pure).
  assert.deepEqual(model.thinkingLevelMap, { low: "low" });
});
