import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayTokenBreakdown,
  formatCompact,
  formatCost,
  formatK,
  modelDisplayName,
  num,
  providerLabel,
  tokenBreakdown,
  usageTotal,
} from "./stats-format";
import type {
  ActivityModelUsage,
  ActivityStatsDay,
} from "../../../shared/ipc-contracts";

test("num coerces missing and non-finite values to 0", () => {
  assert.equal(num(undefined), 0);
  assert.equal(num(null), 0);
  assert.equal(num(Number.NaN), 0);
  assert.equal(num(Number.POSITIVE_INFINITY), 0);
  assert.equal(num(Number.NEGATIVE_INFINITY), 0);
  assert.equal(num(0), 0);
  assert.equal(num(42), 42);
  assert.equal(num(-3.5), -3.5);
});

test("formatCompact keeps the compact k/M rendering", () => {
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1000), "1.0k");
  assert.equal(formatCompact(847200), "847.2k");
  assert.equal(formatCompact(1_000_000), "1.0M");
  assert.equal(formatCompact(6_600_000), "6.6M");
  // New split fields may be absent in older payloads.
  assert.equal(formatCompact(undefined as unknown as number), "0");
  assert.equal(formatCompact(Number.NaN), "0");
});

test("formatK renders one-decimal kilo values", () => {
  assert.equal(formatK(0), "0.0k");
  assert.equal(formatK(999), "1.0k");
  assert.equal(formatK(12345), "12.3k");
  assert.equal(formatK(undefined as unknown as number), "0.0k");
});

test("formatCost shows a clean zero and keeps sub-cent precision", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(undefined), "$0.00");
  assert.equal(formatCost(null), "$0.00");
  assert.equal(formatCost(Number.NaN), "$0.00");
  assert.equal(formatCost(0.0004), "$0.0004");
  assert.equal(formatCost(0.005), "$0.0050");
  assert.equal(formatCost(0.0099), "$0.0099");
  assert.equal(formatCost(0.01), "$0.01");
  assert.equal(formatCost(1.234), "$1.23");
  assert.equal(formatCost(1.236), "$1.24");
  assert.equal(formatCost(1234.567), "$1,234.57");
  assert.equal(formatCost(1234567.891), "$1,234,567.89");
  assert.equal(formatCost(-1.5), "-$1.50");
  assert.equal(formatCost(-0.0004), "-$0.0004");
});

test("tokenBreakdown sums the four kinds and tolerates missing fields", () => {
  assert.deepEqual(
    tokenBreakdown({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
    { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
  );

  // Older payloads may only carry some kinds (or none at all).
  assert.deepEqual(tokenBreakdown({ input: 5, output: 7 }), {
    input: 5,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    total: 12,
  });
  assert.deepEqual(tokenBreakdown(undefined), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.deepEqual(tokenBreakdown({ input: Number.NaN, output: 1 }), {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1,
  });
});

test("dayTokenBreakdown maps the day field names and keeps tokens as total", () => {
  const day: ActivityStatsDay = {
    date: "2026-08-29",
    messages: 4,
    tokens: 100,
    tokensByModel: { "anthropic/claude-opus-4-8": 100 },
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    cost: 1.25,
  };
  assert.deepEqual(dayTokenBreakdown(day), {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    total: 100,
    cost: 1.25,
  });
});

test("dayTokenBreakdown renders pre-four-kind days as zeros plus the old total", () => {
  const oldDay = {
    date: "2026-08-28",
    messages: 2,
    tokens: 70,
    tokensByModel: { "claude-opus-4-8": 70 },
  } as unknown as ActivityStatsDay;
  assert.deepEqual(dayTokenBreakdown(oldDay), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 70,
    cost: 0,
  });
  assert.deepEqual(dayTokenBreakdown(undefined), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  });
});

test("usageTotal sums the four kinds for a full model row", () => {
  const row: ActivityModelUsage = {
    model: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "anthropic",
    modelKey: "anthropic/claude-opus-4-8",
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    total: 100,
    cost: 0.5,
  };
  assert.equal(usageTotal(row), 100);
});

test("usageTotal tolerates older rows without the cache kinds", () => {
  const oldRow = {
    model: "claude-opus-4-8",
    name: null,
    input: 10,
    output: 20,
  } as ActivityModelUsage;
  assert.equal(usageTotal(oldRow), 30);
  assert.equal(usageTotal(undefined), 0);
});

test("usageTotal falls back to a precomputed total when kinds are absent", () => {
  assert.equal(usageTotal({ total: 5000 }), 5000);
  // Kinds present and non-zero win over a stale aggregate.
  assert.equal(usageTotal({ input: 1, total: 5000 }), 1);
  assert.equal(usageTotal({}), 0);
});

test("modelDisplayName prefers the models.json name and falls back to the id", () => {
  assert.equal(
    modelDisplayName({ name: "Claude Opus 4.8", model: "claude-opus-4-8" }),
    "Claude Opus 4.8",
  );
  assert.equal(
    modelDisplayName({ name: null, model: "claude-opus-4-8" }),
    "claude-opus-4-8",
  );
  assert.equal(modelDisplayName({ name: undefined, model: "m" }), "m");
});

test("providerLabel renders an em dash for absent providers", () => {
  assert.equal(providerLabel({ provider: "anthropic" }), "anthropic");
  assert.equal(providerLabel({ provider: null }), "—");
  assert.equal(providerLabel({ provider: undefined }), "—");
  assert.equal(providerLabel({ provider: "" }), "—");
});
