import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import type {
  ActivityStatsResult,
  ActivityRangeKey,
  ActivityStatsDay,
  ActivityModelUsage,
} from "../../../shared/ipc-contracts";
import {
  buildWeeks,
  intensityLevel,
  type IntensityLevel,
} from "../utils/heatmap-grid";
import {
  dayTokenBreakdown,
  formatCompact,
  formatCost,
  modelDisplayName,
  num,
  providerLabel,
  usageTotal,
} from "../utils/stats-format";

type Tab = "overview" | "models";

const RANGE_LABELS: { key: ActivityRangeKey; label: string }[] = [
  { key: "365", label: "1年" },
  { key: "180", label: "6个月" },
  { key: "90", label: "3个月" },
  { key: "30", label: "30天" },
  { key: "7", label: "7天" },
];

const RANGE_DAYS: Record<ActivityRangeKey, number> = {
  "365": 365,
  "180": 180,
  "90": 90,
  "30": 30,
  "7": 7,
};
const MAX_BARS = 26; // token chart resolution cap
const CHART_TICKS = 4; // y-axis intervals (→ 5 labels)

// Intensity buckets for the heatmap (0 = empty).
const LEVEL_CLASSES: Record<IntensityLevel, string> = {
  0: "bg-card/60",
  1: "bg-accent/30",
  2: "bg-accent/50",
  3: "bg-accent/70",
  4: "bg-accent",
};

// Legend dot colors, cycled by model rank.
const MODEL_DOT_COLORS = [
  "bg-emerald-500" /* theme-exempt: categorical palette */,
  "bg-blue-500" /* theme-exempt: categorical palette */,
  "bg-sky-400" /* theme-exempt: categorical palette */,
  "bg-violet-500" /* theme-exempt: categorical palette */,
  "bg-amber-500" /* theme-exempt: categorical palette */,
  "bg-rose-500" /* theme-exempt: categorical palette */,
  "bg-teal-400" /* theme-exempt: categorical palette */,
  "bg-neutral-500" /* theme-exempt: categorical palette */,
];

/** Format a local hour as a compact 24-hour label. */
function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

function formatShortDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

interface TokenBucket {
  label: string;
  total: number;
  cost: number;
  parts: { input: number; output: number; cacheRead: number; cacheWrite: number };
  byModel: Record<string, number>; // model key -> tokens in this bucket
}

/** Bucket a day slice into ≤ MAX_BARS bars, trimming leading token-free days. */
function bucketTokens(days: ActivityStatsDay[]): TokenBucket[] {
  let start = 0;
  while (start < days.length && num(days[start].tokens) === 0) start += 1;
  const span = days.slice(start);
  if (span.length === 0) return [];
  const size = Math.max(1, Math.ceil(span.length / MAX_BARS));
  const buckets: TokenBucket[] = [];
  for (let i = 0; i < span.length; i += size) {
    const chunk = span.slice(i, i + size);
    const byModel: Record<string, number> = {};
    const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let total = 0;
    let cost = 0;
    for (const d of chunk) {
      const day = dayTokenBreakdown(d);
      total += day.total;
      cost += day.cost;
      parts.input += day.input;
      parts.output += day.output;
      parts.cacheRead += day.cacheRead;
      parts.cacheWrite += day.cacheWrite;
      for (const [modelKey, t] of Object.entries(d.tokensByModel))
        byModel[modelKey] = (byModel[modelKey] ?? 0) + num(t);
    }
    buckets.push({ label: formatShortDate(chunk[0].date), total, cost, parts, byModel });
  }
  return buckets;
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-card/40 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-dim">
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-lg font-semibold text-primary"
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function Heatmap({ days }: { days: ActivityStatsDay[] }): React.JSX.Element {
  const { weeks, maxCount } = useMemo(() => {
    const asActivity = days.map((d) => ({ date: d.date, count: d.messages }));
    return {
      weeks: buildWeeks(asActivity),
      maxCount: days.reduce((m, d) => Math.max(m, d.messages), 0),
    };
  }, [days]);

  return (
    <div className="flex gap-1 overflow-x-auto">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-1">
          {week.map((day, di) => (
            <div
              key={di}
              title={day ? `${day.date} — ${day.count} 条消息` : undefined}
              className={clsx(
                "h-3 w-3 rounded-sm",
                day
                  ? LEVEL_CLASSES[intensityLevel(day.count, maxCount)]
                  : "bg-transparent",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function TokenChart({
  days,
  orderedModels,
  modelColor,
}: {
  days: ActivityStatsDay[];
  orderedModels: string[]; // model keys, largest-first; stacking order (top → bottom)
  modelColor: Map<string, string>;
}): React.JSX.Element {
  const buckets = useMemo(() => bucketTokens(days), [days]);

  if (buckets.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-faint">
        此时间范围内没有 Token 用量。
      </div>
    );
  }

  const max = buckets.reduce((m, b) => Math.max(m, b.total), 0);
  const ticks = Array.from(
    { length: CHART_TICKS + 1 },
    (_, i) => (max * (CHART_TICKS - i)) / CHART_TICKS,
  );
  const labelStep = Math.ceil(buckets.length / 6);

  return (
    <div className="flex gap-2">
      {/* Y-axis tick labels */}
      <div className="flex h-40 w-12 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-faint">
        {ticks.map((t, i) => (
          <div key={i}>{formatCompact(Math.round(t))}</div>
        ))}
      </div>

      {/* Plot area */}
      <div className="min-w-0 flex-1">
        <div className="relative h-40">
          {/* Gridlines */}
          {ticks.map((_, i) => (
            <div
              key={i}
              className="absolute inset-x-0 border-t border-border/70"
              style={{ top: `${(i / CHART_TICKS) * 100}%` }}
            />
          ))}
          {/* Stacked bars: one column per bucket, segments colored by model. */}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {buckets.map((b, i) => (
              <div
                key={i}
                title={`${b.label} — ${formatCompact(b.total)} 个 Token\n输入 ${formatCompact(b.parts.input)} · 输出 ${formatCompact(b.parts.output)} · 缓存读 ${formatCompact(b.parts.cacheRead)} · 缓存写 ${formatCompact(b.parts.cacheWrite)}\n费用 ${formatCost(b.cost)}`}
                className="flex min-w-[2px] flex-1 flex-col overflow-hidden rounded-sm"
                style={{
                  height:
                    max > 0
                      ? `${Math.max((b.total / max) * 100, b.total > 0 ? 2 : 0)}%`
                      : "0%",
                }}
              >
                {orderedModels.map((modelKey) => {
                  const t = b.byModel[modelKey] ?? 0;
                  if (t <= 0 || b.total <= 0) return null;
                  return (
                    <div
                      key={modelKey}
                      className={clsx(
                        "w-full",
                        modelColor.get(modelKey) ?? "bg-accent",
                      )}
                      style={{ height: `${(t / b.total) * 100}%` }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {/* X-axis labels */}
        <div className="mt-1 flex gap-[3px] text-[10px] text-faint">
          {buckets.map((b, i) => (
            <div key={i} className="min-w-[2px] flex-1 text-center">
              {i % labelStep === 0 ? b.label : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ModelTable({
  models,
  modelColor,
}: {
  models: ActivityModelUsage[];
  modelColor: Map<string, string>;
}): React.JSX.Element {
  if (models.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-faint">
        此时间范围内没有模型用量。
      </div>
    );
  }
  const grandTotal = models.reduce((s, m) => s + usageTotal(m), 0);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[620px]">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border pb-1.5 text-[10px] uppercase tracking-wide text-faint">
          <span className="w-2 shrink-0" />
          <span className="w-20 shrink-0">提供商</span>
          <span className="min-w-0 flex-1">模型</span>
          <span className="w-14 shrink-0 text-right">输入</span>
          <span className="w-14 shrink-0 text-right">输出</span>
          <span className="w-14 shrink-0 text-right">缓存读</span>
          <span className="w-14 shrink-0 text-right">缓存写</span>
          <span className="w-14 shrink-0 text-right">总计</span>
          <span className="w-16 shrink-0 text-right">费用</span>
          <span className="w-12 shrink-0 text-right">占比</span>
        </div>
        {models.map((m) => {
          const total = usageTotal(m);
          const pct = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
          return (
            <div
              key={m.modelKey}
              className="flex items-center gap-2 py-1.5 text-xs"
            >
              <span
                className={clsx(
                  "h-2 w-2 shrink-0 rounded-full",
                  modelColor.get(m.modelKey) ??
                    "bg-neutral-500" /* theme-exempt: categorical palette */,
                )}
              />
              <span
                className="w-20 shrink-0 truncate text-dim"
                title={m.provider ?? undefined}
              >
                {providerLabel(m)}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-secondary"
                title={m.model}
              >
                {modelDisplayName(m)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-dim">
                {formatCompact(m.input)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-dim">
                {formatCompact(m.output)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-dim">
                {formatCompact(m.cacheRead)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-dim">
                {formatCompact(m.cacheWrite)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-secondary">
                {formatCompact(total)}
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-secondary">
                {formatCost(m.cost)}
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-muted">
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Home-screen activity dashboard, backed by the persisted stats store (survives
 * session deletion). Renders nothing until there is activity, so a fresh install
 * stays uncluttered.
 */
export function StatsPanel(): React.JSX.Element | null {
  const [data, setData] = useState<ActivityStatsResult | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<ActivityRangeKey>("365");

  useEffect(() => {
    let cancelled = false;
    window.piDesktop.activity
      .getStats()
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rangedDays = useMemo(() => {
    if (!data) return [];
    return data.days.slice(-RANGE_DAYS[range]);
  }, [data, range]);

  // Nothing to show on a fresh install.
  if (!data || data.ranges["365"].messages === 0) return null;

  const stats = data.ranges[range];
  const favoriteModel = stats.models[0]
    ? modelDisplayName(stats.models[0])
    : "—";

  // Shared model-key→color mapping (largest-first) so the stacked bars and the
  // model table agree on colors. Keys are modelKey (provider/id or bare id) —
  // the same keys tokensByModel aggregates by — while display names stay
  // name ?? model, so same-named models remain distinguishable via provider.
  const orderedModels = stats.models.map((m) => m.modelKey);
  const modelColor = new Map<string, string>(
    orderedModels.map((modelKey, i) => [
      modelKey,
      MODEL_DOT_COLORS[i % MODEL_DOT_COLORS.length],
    ]),
  );

  return (
    <div className="mb-8 rounded-lg border border-border bg-surface/50 p-4">
      {/* Tabs + range toggle */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-1">
          {(["overview", "models"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                tab === t
                  ? "bg-elevated text-primary"
                  : "text-dim hover:text-secondary",
              )}
            >
              {t === "overview" ? "概览" : "模型"}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5 rounded-md bg-card/60 p-0.5">
          {RANGE_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={clsx(
                "rounded px-2 py-0.5 text-xs font-medium tabular-nums transition-colors",
                range === key
                  ? "bg-elevated text-primary"
                  : "text-dim hover:text-secondary",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <StatCard label="会话数" value={stats.sessions.toLocaleString()} />
            <StatCard label="消息数" value={stats.messages.toLocaleString()} />
            <StatCard
              label="Token 总数"
              value={formatCompact(stats.totalTokens)}
            />
            <StatCard
              label="输入 Token"
              value={formatCompact(stats.inputTokens)}
            />
            <StatCard
              label="输出 Token"
              value={formatCompact(stats.outputTokens)}
            />
            <StatCard
              label="缓存读取"
              value={formatCompact(stats.cacheReadTokens)}
            />
            <StatCard
              label="缓存写入"
              value={formatCompact(stats.cacheWriteTokens)}
            />
            <StatCard label="总费用" value={formatCost(stats.totalCost)} />
            <StatCard
              label="活跃天数"
              value={stats.activeDays.toLocaleString()}
            />
            <StatCard
              label="当前连续天数"
              value={`${stats.currentStreak} 天`}
            />
            <StatCard
              label="最长连续天数"
              value={`${stats.longestStreak} 天`}
            />
            <StatCard
              label="高峰时段"
              value={stats.peakHour === null ? "—" : formatHour(stats.peakHour)}
            />
            <StatCard label="常用模型" value={favoriteModel} />
          </div>
          <Heatmap days={rangedDays} />
        </>
      ) : (
        <>
          <TokenChart
            days={rangedDays}
            orderedModels={orderedModels}
            modelColor={modelColor}
          />
          <div className="mt-4 border-t border-border pt-3">
            <ModelTable models={stats.models} modelColor={modelColor} />
          </div>
        </>
      )}
    </div>
  );
}
