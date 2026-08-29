/**
 * Display name for the embedded agent runtime.
 *
 * Shared by both processes because several surfaces name the running agent —
 * the status bar, the empty chat state, and the permission prompt the agent
 * itself raises — and they must agree. The desktop embeds exactly one engine,
 * so the label is the constant "Pi"; the module stays as the single naming
 * point so future engines have one place to land.
 */
export const DEFAULT_AGENT_ENGINE_LABEL = 'Pi'

/** Stable alias so call sites read as the agent's name, not a fallback. */
export function agentEngineLabel(_engine?: unknown): string {
  return DEFAULT_AGENT_ENGINE_LABEL
}
