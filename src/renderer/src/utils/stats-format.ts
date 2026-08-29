import type { ActivityStatsDay } from "../../../shared/ipc-contracts";

/**
 * Pure display/formatting helpers shared by the activity-stats surfaces
 * (stats-panel.tsx, status-popover.tsx). Every accessor tolerates missing or
 * non-finite numbers: older main-process payloads predate the four-kind token
 * split and the cost fields, and those must render as zero instead of NaN.
 */

/** Coerce a possibly-absent or non-finite number (old payloads) to 0. */
export function num(v: number | undefined | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Compact token/count formatting: 6600000 → "6.6M", 847200 → "847.2k". */
export function formatCompact(n: number): string {
  const v = num(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

/** Fixed one-decimal kilo formatting for narrow status rows: 12345 → "12.3k". */
export function formatK(n: number): string {
  return `${(num(n) / 1000).toFixed(1)}k`;
}

/**
 * USD cost: 0 → "$0.00" (a clean zero, never a misleading "$0.0000");
 * anything under one cent keeps four decimals ("$0.0004") so tiny costs don't
 * collapse into a fake zero; otherwise two decimals with thousands separators
 * ("$1,234.56").
 */
export function formatCost(usd: number | undefined | null): string {
  const c = num(usd);
  if (c === 0) return "$0.00";
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  const [int = "0", frac = ""] = abs.toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${frac}`;
}

/** Four-kind token split, all parts normalized (missing → 0). */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Normalize a `{input, output, cacheRead, cacheWrite}` shape (SessionStats.tokens). */
export function tokenBreakdown(t?: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null): TokenBreakdown {
  const input = num(t?.input);
  const output = num(t?.output);
  const cacheRead = num(t?.cacheRead);
  const cacheWrite = num(t?.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

/** Breakdown of one ActivityStatsDay; `tokens` stays the authoritative total. */
export function dayTokenBreakdown(
  d?: Partial<ActivityStatsDay> | null,
): TokenBreakdown & { cost: number } {
  return {
    input: num(d?.inputTokens),
    output: num(d?.outputTokens),
    cacheRead: num(d?.cacheReadTokens),
    cacheWrite: num(d?.cacheWriteTokens),
    total: num(d?.tokens),
    cost: num(d?.cost),
  };
}

/**
 * Four-kind sum for an ActivityModelUsage row, tolerating missing fields.
 * Falls back to a precomputed `total` when the four kinds are absent, so a
 * payload that only carries the aggregate is never reported as 0.
 */
export function usageTotal(u?: {
  total?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null): number {
  if (!u) return 0;
  const sum = tokenBreakdown(u).total;
  if (sum === 0 && num(u.total) !== 0) return num(u.total);
  return sum;
}

/** Display label for a model usage row: its models.json name, or the raw id. */
export function modelDisplayName(u: {
  name?: string | null;
  model: string;
}): string {
  return u.name ?? u.model;
}

/** Provider column label: the provider key, or an em dash when absent. */
export function providerLabel(u: { provider?: string | null }): string {
  return u.provider ? u.provider : "—";
}
