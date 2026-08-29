import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ActivityStatsStore } from "./activity-stats";

// Fixed reference instant so window math is deterministic.
const NOW = new Date("2026-07-05T12:00:00");

function isoOn(day: string, hour = 12): string {
  return new Date(
    `${day}T${String(hour).padStart(2, "0")}:00:00`,
  ).toISOString();
}

interface MsgOpts {
  role?: "user" | "assistant";
  model?: string;
  provider?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Raw usage.cost object; overrides the default {input,output} shape. */
  cost?: unknown;
  /** Extra usage fields (e.g. cacheWrite1h) to verify they are ignored. */
  extraUsage?: Record<string, unknown>;
  hour?: number;
}

function messageLine(day: string, opts: MsgOpts = {}): string {
  const {
    role = "user",
    model,
    provider,
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost,
    extraUsage,
    hour = 12,
  } = opts;
  const message: Record<string, unknown> = { role };
  if (role === "assistant" && model) {
    message.model = model;
    if (provider !== undefined) message.provider = provider;
    message.usage = {
      input,
      output,
      ...(cacheRead !== 0 ? { cacheRead } : {}),
      ...(cacheWrite !== 0 ? { cacheWrite } : {}),
      ...extraUsage,
      ...(cost !== undefined ? { cost } : {}),
    };
  }
  return JSON.stringify({
    type: "message",
    timestamp: isoOn(day, hour),
    message,
  });
}

async function makeDirs(): Promise<{ root: string; storePath: string }> {
  const base = await mkdtemp(join(tmpdir(), "stats-"));
  const root = join(base, "sessions");
  await mkdir(root, { recursive: true });
  return { root, storePath: join(base, "activity-stats.json") };
}

test("aggregates messages, tokens, models and sessions across files", async () => {
  const { root, storePath } = await makeDirs();
  await mkdir(join(root, "ws"), { recursive: true });
  await writeFile(
    join(root, "ws/s1.jsonl"),
    [
      messageLine("2026-07-04", { role: "user" }),
      messageLine("2026-07-04", {
        role: "assistant",
        model: "claude-opus-4-8",
        input: 100,
        output: 900,
      }),
    ].join("\n"),
  );
  await writeFile(
    join(root, "ws/s2.jsonl"),
    messageLine("2026-07-05", {
      role: "assistant",
      model: "claude-sonnet-5",
      input: 10,
      output: 40,
    }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const result = await store.computeStats(NOW);
  const year = result.ranges["365"];

  assert.equal(year.messages, 3);
  assert.equal(year.sessions, 2);
  assert.equal(year.totalTokens, 100 + 900 + 10 + 40);
  assert.equal(year.activeDays, 2);
  // Models sorted desc by total; Opus (1000) before Sonnet (50).
  assert.equal(year.models[0].model, "claude-opus-4-8");
  assert.equal(year.models[0].output, 900);
  assert.equal(year.models[1].model, "claude-sonnet-5");

  await rm(root, { recursive: true, force: true });
});

test("aggregates same-named sessions from multiple engine roots independently", async () => {
  const { root, storePath } = await makeDirs();
  const secondRoot = `${root}-omp`;
  await mkdir(join(root, "ws"), { recursive: true });
  await mkdir(join(secondRoot, "ws"), { recursive: true });
  await writeFile(
    join(root, "ws", "same.jsonl"),
    messageLine("2026-07-04", { role: "user" }),
  );
  await writeFile(
    join(secondRoot, "ws", "same.jsonl"),
    messageLine("2026-07-05", {
      role: "assistant",
      model: "omp-model",
      input: 2,
      output: 3,
    }),
  );

  const store = new ActivityStatsStore({
    sessionsRoots: [root, secondRoot],
    storePath,
  });
  const year = (await store.computeStats(NOW)).ranges["365"];
  assert.equal(year.messages, 2);
  assert.equal(year.sessions, 2);
  assert.equal(year.totalTokens, 5);

  await rm(root, { recursive: true, force: true });
  await rm(secondRoot, { recursive: true, force: true });
});

test("preserves a session after its file is deleted (captureBeforeDelete)", async () => {
  const { root, storePath } = await makeDirs();
  const file = join(root, "s1.jsonl");
  await writeFile(
    file,
    messageLine("2026-07-04", {
      role: "assistant",
      model: "claude-opus-4-8",
      input: 5,
      output: 5,
    }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });

  // Capture before delete, with no prior scan, then remove the file.
  store.captureBeforeDelete(file);
  await rm(file);

  const result = await store.computeStats(NOW);
  assert.equal(result.ranges["365"].messages, 1);
  assert.equal(result.ranges["365"].totalTokens, 10);
  assert.equal(result.ranges["365"].sessions, 1);

  await rm(root, { recursive: true, force: true });
});

test("persists across store instances (survives process restart)", async () => {
  const { root, storePath } = await makeDirs();
  const file = join(root, "s1.jsonl");
  await writeFile(file, messageLine("2026-07-03", { role: "user" }));

  const first = new ActivityStatsStore({ sessionsRoot: root, storePath });
  first.flushSync(NOW); // synchronous scan + write to disk

  // New instance, and the source file is now gone.
  await rm(file);
  const second = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const result = await second.computeStats(NOW);
  assert.equal(result.ranges["365"].messages, 1);

  await rm(root, { recursive: true, force: true });
});

test("re-parses a file when its content changes", async () => {
  const { root, storePath } = await makeDirs();
  const file = join(root, "s1.jsonl");
  await writeFile(file, messageLine("2026-07-04", { role: "user" }));

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  let result = await store.computeStats(NOW);
  assert.equal(result.ranges["365"].messages, 1);

  await writeFile(
    file,
    [
      messageLine("2026-07-04", { role: "user" }),
      messageLine("2026-07-04", { role: "user" }),
    ].join("\n"),
  );
  // Bump mtime so the change is detected even if the rewrite lands in the same
  // filesystem mtime tick (the store re-parses on mtime change).
  const future = new Date(Date.now() + 2000);
  await utimes(file, future, future);
  result = await store.computeStats(NOW);
  assert.equal(result.ranges["365"].messages, 2);

  await rm(root, { recursive: true, force: true });
});

test("range filter: 7d excludes older activity that 1Y includes", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "s1.jsonl"),
    messageLine("2026-07-04", { role: "user" }),
  ); // in 7d
  await writeFile(
    join(root, "s2.jsonl"),
    messageLine("2026-05-01", { role: "user" }),
  ); // outside 7d, inside 1Y

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const result = await store.computeStats(NOW);

  assert.equal(result.ranges["365"].messages, 2);
  assert.equal(result.ranges["7"].messages, 1);

  await rm(root, { recursive: true, force: true });
});

test("computes current and longest streaks", async () => {
  const { root, storePath } = await makeDirs();
  // Active Jul 3,4,5 (3-day streak ending today) and an isolated day earlier.
  await writeFile(
    join(root, "s1.jsonl"),
    [
      messageLine("2026-07-03", { role: "user" }),
      messageLine("2026-07-04", { role: "user" }),
      messageLine("2026-07-05", { role: "user" }),
      messageLine("2026-06-20", { role: "user" }),
    ].join("\n"),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];
  assert.equal(year.currentStreak, 3);
  assert.equal(year.longestStreak, 3);

  await rm(root, { recursive: true, force: true });
});

test("peak hour reflects the busiest local hour", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "s1.jsonl"),
    [
      messageLine("2026-07-04", { role: "user", hour: 9 }),
      messageLine("2026-07-04", { role: "user", hour: 23 }),
      messageLine("2026-07-04", { role: "user", hour: 23 }),
    ].join("\n"),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];
  assert.equal(year.peakHour, 23);

  await rm(root, { recursive: true, force: true });
});

test("resolves model names from models.json, keyed by id", async () => {
  const { root, storePath } = await makeDirs();
  const modelsConfigPath = join(root, "..", "models.json");
  await writeFile(
    modelsConfigPath,
    JSON.stringify({
      providers: {
        lmstudio: {
          models: [{ id: "ornith-1.0-35b@q6_k", name: "Ornith 1.0 Q6" }],
        },
      },
    }),
  );
  await writeFile(
    join(root, "s1.jsonl"),
    [
      messageLine("2026-07-04", {
        role: "assistant",
        model: "ornith-1.0-35b@q6_k",
        input: 10,
        output: 20,
      }),
      messageLine("2026-07-04", {
        role: "assistant",
        model: "no-such-model",
        input: 1,
        output: 1,
      }),
    ].join("\n"),
  );

  const store = new ActivityStatsStore({
    sessionsRoot: root,
    storePath,
    modelsConfigPath,
  });
  const models = (await store.computeStats(NOW)).ranges["365"].models;
  const ornith = models.find((m) => m.model === "ornith-1.0-35b@q6_k");
  const unknown = models.find((m) => m.model === "no-such-model");
  assert.equal(ornith?.name, "Ornith 1.0 Q6");
  assert.equal(unknown?.name, null); // not in models.json → null (frontend falls back to id)

  await rm(root, { recursive: true, force: true });
});

test("keeps last-known name after a model is removed from models.json", async () => {
  const { root, storePath } = await makeDirs();
  const modelsConfigPath = join(root, "..", "models.json");
  await writeFile(
    join(root, "s1.jsonl"),
    messageLine("2026-07-04", {
      role: "assistant",
      model: "m1",
      input: 5,
      output: 5,
    }),
  );

  // First scan with the name present.
  await writeFile(
    modelsConfigPath,
    JSON.stringify({
      providers: { p: { models: [{ id: "m1", name: "Model One" }] } },
    }),
  );
  const first = new ActivityStatsStore({
    sessionsRoot: root,
    storePath,
    modelsConfigPath,
  });
  first.flushSync(NOW);

  // The model disappears from models.json; a fresh instance should still show it.
  await rm(modelsConfigPath);
  const second = new ActivityStatsStore({
    sessionsRoot: root,
    storePath,
    modelsConfigPath,
  });
  const models = (await second.computeStats(NOW)).ranges["365"].models;
  assert.equal(models.find((m) => m.model === "m1")?.name, "Model One");

  await rm(root, { recursive: true, force: true });
});

test("prunes sessions older than the retention window", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "old.jsonl"),
    messageLine("2024-01-01", { role: "user" }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const result = await store.computeStats(NOW);
  assert.equal(result.ranges["365"].messages, 0);

  await rm(root, { recursive: true, force: true });
});

// ─── Four-kind token accounting (v2) ────────────────────────────────────────

test("aggregates four token kinds and cost; total is the four-kind sum", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "s1.jsonl"),
    messageLine("2026-07-04", {
      role: "assistant",
      model: "claude-opus-4-8",
      provider: "anthropic",
      input: 100,
      output: 50,
      cacheRead: 1000,
      cacheWrite: 20,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
    }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];

  assert.equal(year.totalTokens, 1170);
  assert.equal(year.inputTokens, 100);
  assert.equal(year.outputTokens, 50);
  assert.equal(year.cacheReadTokens, 1000);
  assert.equal(year.cacheWriteTokens, 20);
  assert.equal(year.totalCost, 0.0033);
  assert.equal(year.models.length, 1);
  const m = year.models[0];
  assert.equal(m.model, "claude-opus-4-8");
  assert.equal(m.provider, "anthropic");
  assert.equal(m.modelKey, "anthropic/claude-opus-4-8");
  assert.equal(m.total, 1170);
  assert.equal(m.cost, 0.0033);
  // Per-day series agrees with the range rollup.
  const day = result_days(await store.computeStats(NOW), "2026-07-04");
  assert.equal(day.tokens, 1170);
  assert.equal(day.cost, 0.0033);
  assert.equal(
    day.tokensByModel["anthropic/claude-opus-4-8"],
    1170,
  );

  await rm(root, { recursive: true, force: true });
});

function result_days(result: Awaited<ReturnType<ActivityStatsStore["computeStats"]>>, date: string) {
  return result.days.find((d) => d.date === date)!;
}

test("same model id under two providers stays separate", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "s1.jsonl"),
    [
      messageLine("2026-07-04", {
        role: "assistant",
        model: "same-model",
        provider: "alpha",
        input: 10,
        output: 5,
        cost: { total: 0.01 },
      }),
      messageLine("2026-07-04", {
        role: "assistant",
        model: "same-model",
        provider: "beta",
        input: 20,
        output: 5,
        cost: { total: 0.02 },
      }),
    ].join("\n"),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const models = (await store.computeStats(NOW)).ranges["365"].models;

  assert.equal(models.length, 2);
  const alpha = models.find((m) => m.provider === "alpha");
  const beta = models.find((m) => m.provider === "beta");
  assert.equal(alpha?.modelKey, "alpha/same-model");
  assert.equal(alpha?.input, 10);
  assert.equal(alpha?.cost, 0.01);
  assert.equal(beta?.modelKey, "beta/same-model");
  assert.equal(beta?.input, 20);
  assert.equal(beta?.cost, 0.02);
  // And the range total covers both rows without cross-contamination.
  assert.equal(
    (await store.computeStats(NOW)).ranges["365"].totalTokens,
    40,
  );

  await rm(root, { recursive: true, force: true });
});

test("cost falls back to component sum, then zero; illegal values are zeroed", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "s1.jsonl"),
    [
      // No cost at all → 0.
      messageLine("2026-07-04", {
        role: "assistant",
        model: "m1",
        provider: "p",
        input: 1,
        output: 1,
      }),
      // cost.total missing → finite components sum.
      messageLine("2026-07-04", {
        role: "assistant",
        model: "m2",
        provider: "p",
        input: 1,
        output: 1,
        cost: { input: 0.5, output: 0.25, cacheRead: "x" },
      }),
      // Illegal token/cost values zero out instead of poisoning with NaN.
      messageLine("2026-07-04", {
        role: "assistant",
        model: "m3",
        provider: "p",
        input: Number.NaN,
        output: "zzz" as unknown as number,
        cost: { total: Number.NaN },
      }),
    ].join("\n"),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];
  const byId = new Map(year.models.map((m) => [m.model, m]));

  assert.equal(year.totalCost, 0.75);
  assert.equal(byId.get("m1")?.cost, 0);
  assert.equal(byId.get("m2")?.cost, 0.75);
  assert.equal(byId.get("m3")?.input, 0);
  assert.equal(byId.get("m3")?.output, 0);
  assert.equal(byId.get("m3")?.cost, 0);
  assert.ok(Number.isFinite(year.totalTokens));

  await rm(root, { recursive: true, force: true });
});

test("cacheWrite1h is not double-counted", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    join(root, "s1.jsonl"),
    messageLine("2026-07-04", {
      role: "assistant",
      model: "m1",
      provider: "p",
      input: 10,
      output: 10,
      cacheRead: 100,
      cacheWrite: 5,
      extraUsage: { cacheWrite1h: 4 },
    }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];
  assert.equal(year.totalTokens, 125);
  assert.equal(year.cacheWriteTokens, 5);

  await rm(root, { recursive: true, force: true });
});

test("resolves names by provider/id key with bare-id fallback", async () => {
  const { root, storePath } = await makeDirs();
  const modelsConfigPath = join(root, "..", "models.json");
  await writeFile(
    modelsConfigPath,
    JSON.stringify({
      providers: {
        alpha: { models: [{ id: "shared", name: "Alpha Shared" }] },
        beta: { models: [{ id: "shared", name: "Beta Shared" }] },
        solo: { models: [{ id: "only-here", name: "Solo Name" }] },
      },
    }),
  );
  await writeFile(
    join(root, "s1.jsonl"),
    [
      messageLine("2026-07-04", {
        role: "assistant",
        model: "shared",
        provider: "alpha",
        input: 3,
        output: 1,
      }),
      messageLine("2026-07-04", {
        role: "assistant",
        model: "shared",
        provider: "beta",
        input: 2,
        output: 1,
      }),
      // No provider on the message → bare-id fallback name.
      messageLine("2026-07-04", {
        role: "assistant",
        model: "only-here",
        input: 1,
        output: 1,
      }),
    ].join("\n"),
  );

  const store = new ActivityStatsStore({
    sessionsRoot: root,
    storePath,
    modelsConfigPath,
  });
  const models = (await store.computeStats(NOW)).ranges["365"].models;
  assert.equal(
    models.find((m) => m.modelKey === "alpha/shared")?.name,
    "Alpha Shared",
  );
  assert.equal(
    models.find((m) => m.modelKey === "beta/shared")?.name,
    "Beta Shared",
  );
  assert.equal(
    models.find((m) => m.model === "only-here")?.name,
    "Solo Name",
  );

  await rm(root, { recursive: true, force: true });
});

test("migrates a v1 store: zero-fills new fields and re-parses live files", async () => {
  const { root, storePath } = await makeDirs();
  const file = join(root, "s1.jsonl");
  await writeFile(
    file,
    messageLine("2026-07-04", {
      role: "assistant",
      model: "m1",
      provider: "p",
      input: 10,
      output: 10,
      cacheRead: 500,
      cacheWrite: 5,
      cost: { total: 0.02 },
    }),
  );

  // Hand-write a v1-shaped store pointing at the live file (old bucket shape).
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      sessions: {
        [file]: {
          filePath: file,
          mtimeMs: 1, // stale: real mtime differs, so a v2 scan re-parses
          days: {
            "2026-07-04": {
              messages: 1,
              models: { m1: { input: 10, output: 10 } },
              hours: { "12": 1 },
            },
          },
        },
      },
      modelNames: { m1: "Legacy Name" },
    }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];

  // Live file re-parsed: real cache/cost restored.
  assert.equal(year.totalTokens, 525);
  assert.equal(year.totalCost, 0.02);
  assert.equal(year.models[0].modelKey, "p/m1");

  await rm(root, { recursive: true, force: true });
});

test("v1 store for a deleted session keeps its aggregate with zero new fields", async () => {
  const { root, storePath } = await makeDirs();
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      sessions: {
        "gone.jsonl": {
          filePath: "gone.jsonl",
          mtimeMs: 1,
          days: {
            "2026-07-04": {
              messages: 2,
              models: { m1: { input: 7, output: 3 } },
              hours: { "12": 2 },
            },
          },
        },
      },
      modelNames: {},
    }),
  );

  const store = new ActivityStatsStore({ sessionsRoot: root, storePath });
  const year = (await store.computeStats(NOW)).ranges["365"];

  assert.equal(year.messages, 2);
  assert.equal(year.totalTokens, 10); // legacy input+output preserved
  assert.equal(year.cacheReadTokens, 0);
  assert.equal(year.cacheWriteTokens, 0);
  assert.equal(year.totalCost, 0);
  assert.equal(year.models[0].model, "m1");
  assert.equal(year.models[0].provider, null);
  assert.equal(year.models[0].total, 10);

  await rm(root, { recursive: true, force: true });
});
