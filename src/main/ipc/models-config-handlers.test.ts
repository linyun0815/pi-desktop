import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { discoverProviderModels } from "./models-config-handlers";

/**
 * The discovery IPC path writes a TEMPORARY models.json for the admin helper
 * and must remove it on every path — success or failure. The helper stub here
 * reads the temp file during the call so the merged draft content is
 * observable at the moment the real helper would load it.
 */

const ABSENT_PROVIDER = "___no-such-provider-in-real-config___";

interface Discovered {
  id: string;
  name?: string;
}

interface TempCapture {
  calls: string[];
  config: unknown;
}

function makeContext(
  impl: (configPath: string) => Promise<Discovered[]>,
): { ctx: never; capture: TempCapture } {
  const capture: TempCapture = { calls: [], config: undefined };
  const ctx = {
    adminManager: {
      discoverModels: async (configPath: string, providerId: string) => {
        capture.calls.push(providerId);
        // The temp config must exist while the helper reads it.
        assert.equal(existsSync(configPath), true);
        capture.config = JSON.parse(readFileSync(configPath, "utf-8"));
        return impl(configPath);
      },
    },
  };
  return { ctx: ctx as never, capture };
}

function tempConfigDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) =>
    name.startsWith("pi-desktop-models-"),
  );
}

async function withNoTempResidue(fn: () => Promise<void>): Promise<void> {
  const before = new Set(tempConfigDirs());
  await fn();
  assert.deepEqual(
    tempConfigDirs().filter((dir) => !before.has(dir)),
    [],
  );
}

function providerOf(config: unknown): Record<string, unknown> {
  return (config as { providers: Record<string, Record<string, unknown>> })
    .providers[ABSENT_PROVIDER];
}

test("discovery writes a temp config with the draft key and cleans it up", async () => {
  await withNoTempResidue(async () => {
    const { ctx, capture } = makeContext(async () => [{ id: "m1", name: "One" }]);
    const result = await discoverProviderModels(ctx, {
      providerId: ABSENT_PROVIDER,
      baseUrl: "https://api.example.com",
      api: "openai-completions",
      apiKey: "sk-draft-only",
    });
    assert.deepEqual(result, { ok: true, models: [{ id: "m1", name: "One" }] });
    assert.deepEqual(capture.calls, [ABSENT_PROVIDER]);

    // The temp config the helper saw merged the draft fields…
    const provider = providerOf(capture.config);
    assert.equal(provider.apiKey, "sk-draft-only");
    assert.equal(provider.baseUrl, "https://api.example.com");
    assert.equal(provider.api, "openai-completions");
    assert.equal("models" in provider, false);
    // …and the temp directory is gone afterwards (checked by the wrapper).
  });
});

test("discovery without a draft key sends no apiKey and still cleans up", async () => {
  await withNoTempResidue(async () => {
    const { ctx, capture } = makeContext(async () => []);
    const result = await discoverProviderModels(ctx, {
      providerId: ABSENT_PROVIDER,
      api: "anthropic-messages",
      apiKey: null,
    });
    assert.deepEqual(result, { ok: true, models: [] });
    assert.equal("apiKey" in providerOf(capture.config), false);
  });
});

test("a failed discovery still removes the temp config", async () => {
  await withNoTempResidue(async () => {
    const { ctx } = makeContext(async () => {
      throw new Error("HTTP 503");
    });
    await assert.rejects(
      discoverProviderModels(ctx, {
        providerId: ABSENT_PROVIDER,
        api: "openai-responses",
        apiKey: null,
      }),
      /HTTP 503/,
    );
  });
});

test("temp configs are unique per request (concurrent discovery is safe)", async () => {
  await withNoTempResidue(async () => {
    const { ctx } = makeContext(async () => [{ id: "x" }]);
    const [a, b] = await Promise.all([
      discoverProviderModels(ctx, {
        providerId: ABSENT_PROVIDER,
        api: "openai-completions",
        apiKey: null,
      }),
      discoverProviderModels(ctx, {
        providerId: ABSENT_PROVIDER,
        api: "openai-completions",
        apiKey: null,
      }),
    ]);
    assert.ok(a.ok && b.ok);
  });
});
