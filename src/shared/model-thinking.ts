/**
 * Shared model thinking-level definitions.
 *
 * Single source of truth for the seven levels Pi's SDK supports
 * (`off`…`max`) and the `thinkingLevelMap` semantics from pi-ai's `Model`:
 *
 *  - a missing map entry uses the provider's default mapping for that level;
 *  - `null` marks the level as explicitly unsupported;
 *  - a string is the provider-side value sent for that level;
 *  - `xhigh`/`max` are only effective when the map sets them to a string —
 *    without an entry the provider has no default for them;
 *  - a non-reasoning model only supports `off` (the map is kept so flipping
 *    `reasoning` back on restores the configured levels).
 *
 * The level list and the support predicate mirror the SDK's own
 * `getSupportedThinkingLevels` / `clampThinkingLevel` so the desktop UI never
 * offers a level the runtime would silently clamp away.
 */

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Provider-side mapping: `string` = value sent, `null` = unsupported, absent = provider default. */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** Levels that only exist when the map explicitly provides a value. */
const OPT_IN_LEVELS: ReadonlySet<ThinkingLevel> = new Set(["xhigh", "max"]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/** Whether one thinking level is effective for a model, per the SDK rules above. */
export function modelSupportsThinkingLevel(
  level: ThinkingLevel,
  model: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap },
): boolean {
  if (model.reasoning !== true) return level === "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  if (OPT_IN_LEVELS.has(level)) return mapped !== undefined;
  return true;
}

/** All effective levels for a model, in canonical off→max order. */
export function supportedThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) =>
    modelSupportsThinkingLevel(level, model),
  );
}

/**
 * Clamp a requested level to the nearest supported one, mirroring the SDK:
 * first supported level at or above the request, then the nearest below,
 * else the lowest supported level. Returns null when nothing is supported
 * (never happens for a valid model — `off` is always present).
 */
export function clampThinkingLevel(
  requested: string,
  model: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap },
): ThinkingLevel | null {
  const supported = supportedThinkingLevels(model);
  if (supported.length === 0) return null;
  if (isThinkingLevel(requested) && supported.includes(requested))
    return requested;
  const index = isThinkingLevel(requested)
    ? THINKING_LEVELS.indexOf(requested)
    : -1;
  for (let i = index === -1 ? 0 : index; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i];
    if (supported.includes(candidate)) return candidate;
  }
  for (let i = (index === -1 ? THINKING_LEVELS.length : index) - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i];
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? null;
}

/**
 * Normalize an unknown value into a `ThinkingLevelMap`, or undefined when the
 * value is not a plain object. Unknown (non-level) keys are dropped; entries
 * that are neither a non-empty string nor null are dropped too, matching the
 * validator's "leave invalid junk out of the written file" stance.
 */
export function normalizeThinkingLevelMap(
  value: unknown,
): ThinkingLevelMap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const out: ThinkingLevelMap = {};
  let any = false;
  for (const level of THINKING_LEVELS) {
    const entry = source[level];
    if (entry === null) {
      out[level] = null;
      any = true;
    } else if (typeof entry === "string" && entry.trim().length > 0) {
      out[level] = entry;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Validate one model's `thinkingLevelMap`. Returns human-readable errors
 * prefixed with `label` (e.g. "提供商 p、模型 m"). An absent map is valid;
 * invalid shapes are reported (the editor keeps unknown junk out, but a
 * hand-edited models.json must still be diagnosable).
 */
export function validateThinkingLevelMap(
  value: unknown,
  label: string,
): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${label}：thinkingLevelMap 必须是对象`];
  }
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isThinkingLevel(key)) {
      errors.push(`${label}：thinkingLevelMap 含未知级别“${key}”`);
      continue;
    }
    if (entry !== null && !(typeof entry === "string" && entry.trim().length > 0)) {
      errors.push(
        `${label}：思考级别“${key}”的值必须是非空字符串或 null`,
      );
    }
  }
  return errors;
}
