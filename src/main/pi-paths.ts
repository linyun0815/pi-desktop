import { join } from "path";
import { isPathWithin } from "./path-authorization";

/**
 * Absolute Pi agent directory, honoring the SDK's environment override. The
 * embedded runtime reuses Pi's own data (`auth.json`, `models.json`,
 * `settings.json`, sessions) in place.
 */
export function getPiAgentDir(): string {
 return (
  process.env.PI_CODING_AGENT_DIR ||
  join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent")
 );
}

/**
 * Absolute path to Pi's on-disk session store (`~/.pi/agent/sessions`).
 * Centralized so session listing, lineage, and activity aggregation agree.
 */
export function getSessionsRoot(): string {
 return join(getPiAgentDir(), "sessions");
}

/**
 * All stores the session index reads. The embedded runtime uses only Pi's
 * default store; the separate OMP tree under `~/.omp` is left untouched on
 * disk and never listed or resumed.
 */
export function getSessionRoots(): string[] {
 return [getSessionsRoot()];
}

/**
 * Authorization gate for a session path the renderer supplied. A path is
 * acceptable when it sits inside the store the index itself reads; anything
 * else is refused, which is what keeps resume/fork/delete inside the store.
 */
export function isWithinSessionRoots(candidate: string): boolean {
 return isPathWithin(getSessionsRoot(), candidate);
}
