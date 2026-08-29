import { spawnSync } from 'child_process'

/**
 * Cross-platform process-tree teardown for agent helper processes.
 *
 * A helper is not a security boundary — Pi spawns its own subagents (OMP put
 * them in fresh process groups) — so "stop the helper" has to mean "stop
 * everything it still owns". A negative-PID group signal only reaches the
 * killed process's own group; escaped descendants are enumerated BEFORE the
 * parent is signalled, because re-parenting to init erases the link the
 * moment the parent dies.
 */

const PROCESS_TREE_TIMEOUT_MS = 2_000
export const FORCE_KILL_TIMEOUT_MS = 3_000

const IS_WINDOWS = process.platform === 'win32'

/**
 * PIDs descended from `root`, children before grandchildren. POSIX only —
 * Windows has the same gap but `taskkill /T` is the fix there and it cannot
 * be verified from here.
 */
export function descendantPids(root: number): number[] {
  if (IS_WINDOWS) return []
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf-8',
      timeout: PROCESS_TREE_TIMEOUT_MS,
    })
  } catch {
    return []
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') return []

  const childrenByParent = new Map<number, number[]>()
  for (const line of result.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const siblings = childrenByParent.get(ppid)
    if (siblings) siblings.push(pid)
    else childrenByParent.set(ppid, [pid])
  }

  const found: number[] = []
  const queue = [root]
  // Breadth-first with a seen set: a malformed table must not loop forever.
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

function signal(pid: number, signalName: NodeJS.Signals): void {
  try {
    if (IS_WINDOWS) {
      // taskkill /T walks the tree itself and works on processes whose group
      // semantics differ from POSIX.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        timeout: PROCESS_TREE_TIMEOUT_MS,
        stdio: 'ignore',
      })
      return
    }
    try {
      // Kill the whole group first: the helper's own children usually sit in it.
      process.kill(-pid, signalName)
    } catch {
      // No group (e.g. the helper detached) — signal the process alone.
      process.kill(pid, signalName)
    }
    for (const stray of descendantPids(pid)) {
      try {
        process.kill(stray, signalName)
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Terminate the process tree rooted at `rootPid`: SIGTERM (graceful window),
 * then SIGKILL after `graceMs`. Never throws — a victim that already exited
 * is the success case.
 */
export function killProcessTree(rootPid: number, graceMs = FORCE_KILL_TIMEOUT_MS): void {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return
  signal(rootPid, 'SIGTERM')
  setTimeout(() => signal(rootPid, 'SIGKILL'), graceMs).unref?.()
}
