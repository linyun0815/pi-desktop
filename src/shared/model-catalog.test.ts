import { test } from "node:test";
import assert from "node:assert/strict";
import { matchModelInCatalog, parseModelCatalog } from "./model-catalog";

// A trimmed models.dev-shaped document (snake_case cost keys, modalities,
// limit.context/output, per-provider `api` base URL).
const RAW = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: "https://api.anthropic.com",
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        reasoning: true,
        modalities: { input: ["text", "image"] },
        limit: { context: 200000, output: 64000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      "shared-model": {
        id: "shared-model",
        name: "Anthropic Shared",
        limit: { context: 100000 },
        cost: { input: 1, output: 2 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    models: {
      "gpt-test": {
        id: "gpt-test",
        name: "GPT Test",
        cost: { input: 3, output: 6 },
      },
      "shared-model": {
        id: "shared-model",
        name: "OpenAI Shared",
        cost: { input: 1, output: 2 },
      },
    },
  },
  broken: {
    id: "broken",
    models: {
      "junk": "not-an-object",
      "": { id: "", name: "empty id" },
      "ok-model": { id: "ok-model", name: "Ok" },
    },
  },
};

function catalog() {
  return parseModelCatalog(RAW);
}

test("parseModelCatalog maps snake_case fields into Pi-native shape", () => {
  const parsed = catalog();
  assert.equal(parsed.providers.length, 3);
  const anthropic = parsed.byProviderId.get("anthropic")![0];
  const opus = anthropic.models.find((m) => m.id === "claude-opus-4-8")!;
  assert.deepEqual(opus, {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  });
});

test("parseModelCatalog skips malformed entries instead of failing", () => {
  const parsed = catalog();
  const broken = parsed.byProviderId.get("broken")![0];
  assert.deepEqual(
    broken.models.map((m) => m.id),
    ["ok-model"],
  );
  // Entirely invalid documents parse to an empty catalog.
  for (const junk of [null, "x", 42, []]) {
    assert.equal(parseModelCatalog(junk).providers.length, 0);
  }
});

test("exact provider + model match carries reliable prices", () => {
  const match = matchModelInCatalog(catalog(), {
    modelId: "claude-opus-4-8",
    providerId: "anthropic",
  });
  assert.equal(match.match, "exact");
  assert.equal(match.priceReliable, true);
  assert.equal(match.metadata.name, "Claude Opus 4.8");
  assert.equal(match.metadata.contextWindow, 200000);
  assert.equal(match.metadata.cost?.input, 5);
});

test("base-URL host match works without a provider id", () => {
  const match = matchModelInCatalog(catalog(), {
    modelId: "gpt-test",
    baseUrl: "https://api.openai.com/v1/",
  });
  assert.equal(match.match, "baseUrl");
  assert.equal(match.priceReliable, true);
  assert.equal(match.metadata.name, "GPT Test");
});

test("consensus across providers requires price agreement", () => {
  const agree = matchModelInCatalog(catalog(), { modelId: "shared-model" });
  assert.equal(agree.match, "consensus");
  // Both sources price it at 1/2 → reliable; the name vote ties and the
  // first catalog source wins. No single-source warning with two sources.
  assert.equal(agree.priceReliable, true);
  assert.equal(agree.metadata.cost?.input, 1);
  assert.equal(agree.warnings.length, 0);

  // A model known to only one catalog provider is still a consensus match,
  // but carries the single-source warning.
  const single = matchModelInCatalog(catalog(), { modelId: "gpt-test" });
  assert.equal(single.match, "consensus");
  assert.ok(single.warnings.some((w) => w.includes("单个提供商")));

  const conflictRaw = {
    a: { id: "a", models: { m: { id: "m", cost: { input: 1, output: 2 } } } },
    b: { id: "b", models: { m: { id: "m", cost: { input: 9, output: 2 } } } },
  };
  const conflict = matchModelInCatalog(parseModelCatalog(conflictRaw), {
    modelId: "m",
  });
  assert.equal(conflict.match, "consensus");
  assert.equal(conflict.priceReliable, false);
  assert.equal(conflict.metadata.cost, undefined);
  assert.ok(conflict.warnings.some((w) => w.includes("价格来源不一致")));
});

test("unknown models return a none match without metadata", () => {
  const match = matchModelInCatalog(catalog(), { modelId: "no-such-model" });
  assert.equal(match.match, "none");
  assert.deepEqual(match.metadata, {});
  assert.equal(match.priceReliable, false);
  assert.equal(matchModelInCatalog(catalog(), { modelId: "" }).match, "none");
});

test("host matching is host-scoped, not path-scoped", () => {
  // models.dev stores the openai base as https://api.openai.com/v1; a user
  // pointing at the same host but a different path still matches by host.
  const match = matchModelInCatalog(catalog(), {
    modelId: "gpt-test",
    baseUrl: "https://api.openai.com/custom/proxy",
  });
  assert.equal(match.match, "baseUrl");
});

test("first-party providers without a base URL match via host label", () => {
  // models.dev omits `api` for first-party entries; a custom relay pointed at
  // the vendor host (api.anthropic.com → label "anthropic") still matches.
  const raw = {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          cost: { input: 5, output: 25 },
        },
      },
    },
  };
  const match = matchModelInCatalog(parseModelCatalog(raw), {
    modelId: "claude-opus-4-8",
    providerId: "my-relay",
    baseUrl: "https://api.anthropic.com",
  });
  assert.equal(match.match, "baseUrl");
  assert.equal(match.priceReliable, true);
  assert.equal(match.metadata.name, "Claude Opus 4.8");
});
