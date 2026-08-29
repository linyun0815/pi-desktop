import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { getGuiDataPath } from './app-data-paths'

/**
 * Workspace trust registry (versioned).
 *
 * A workspace's `.pi-desktop/permission-rules.json` can come from an untrusted
 * cloned repository. Its `allow` rules take effect only once the user trusts
 * the workspace (see loadEffectiveRules), and the HTML file preview only runs
 * scripts for a trusted workspace. The same trust switch now also authorizes
 * project Pi resources (settings/extensions/packages/skills) for the embedded
 * runtime.
 *
 * On-disk format (v2):
 *
 *   { "version": 2, "trusted": [..paths..], "pendingReconfirmation": [..paths..] }
 *
 * Upgrade rule: the legacy format was a bare JSON array of trusted paths.
 * Those records predate the unified trust switch, so on first read every
 * legacy path is demoted to `pendingReconfirmation` — the user re-confirms on
 * the workspace's next use, and only then does the path move to `trusted`.
 * Nothing is deleted: a pending path that the user declines simply stays
 * pending (or is dropped by an explicit revoke).
 *
 * `isTrusted` is synchronous so it can be consulted from the hot, sync paths
 * that gate on trust: building each helper's environment, and Electron's
 * `will-attach-webview` handler for the preview guest.
 */

const TRUST_FILE_NAME = 'trusted-workspaces.json'
const TRUST_FILE_VERSION = 2

interface TrustFileV2 {
  version: number
  trusted: string[]
  pendingReconfirmation: string[]
}

export class WorkspaceTrustStore {
  private path: string
  private trusted = new Set<string>()
  private pending = new Set<string>()
  private loaded = false

  constructor(filePath?: string) {
    this.path = filePath ?? getGuiDataPath(TRUST_FILE_NAME)
  }

  isTrusted(workspacePath: string): boolean {
    if (!workspacePath) return false
    this.ensureLoaded()
    return this.trusted.has(resolve(workspacePath))
  }

  /** True when a path only carries a legacy record awaiting re-confirmation. */
  isPendingReconfirmation(workspacePath: string): boolean {
    if (!workspacePath) return false
    this.ensureLoaded()
    const key = resolve(workspacePath)
    return this.pending.has(key) && !this.trusted.has(key)
  }

  /** Snapshot for IPC; resolved paths only, no file paths leaked verbatim. */
  status(workspacePath: string): { trusted: boolean; pendingReconfirmation: boolean } {
    if (!workspacePath) return { trusted: false, pendingReconfirmation: false }
    this.ensureLoaded()
    const key = resolve(workspacePath)
    return {
      trusted: this.trusted.has(key),
      pendingReconfirmation: this.pending.has(key) && !this.trusted.has(key),
    }
  }

  /**
   * Trust a workspace. A pending legacy record is promoted; an explicit new
   * trust also clears any pending state for the same path.
   */
  async trust(workspacePath: string): Promise<void> {
    if (!workspacePath) return
    this.ensureLoaded()
    const key = resolve(workspacePath)
    this.pending.delete(key)
    if (this.trusted.has(key)) return
    this.trusted.add(key)
    await this.save()
  }

  async revoke(workspacePath: string): Promise<void> {
    if (!workspacePath) return
    this.ensureLoaded()
    const key = resolve(workspacePath)
    const had = this.trusted.delete(key) || this.pending.delete(key)
    if (had) await this.save()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    try {
      if (existsSync(this.path)) {
        const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
        if (Array.isArray(parsed)) {
          // Legacy v1 array: every record is stale until re-confirmed.
          for (const entry of parsed) {
            if (typeof entry === 'string' && entry) this.pending.add(resolve(entry))
          }
        } else if (parsed && typeof parsed === 'object') {
          const file = parsed as Partial<TrustFileV2>
          for (const entry of file.trusted ?? []) {
            if (typeof entry === 'string' && entry) this.trusted.add(resolve(entry))
          }
          for (const entry of file.pendingReconfirmation ?? []) {
            if (typeof entry === 'string' && entry) this.pending.add(resolve(entry))
          }
        }
      }
    } catch {
      this.trusted = new Set()
      this.pending = new Set()
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const file: TrustFileV2 = {
      version: TRUST_FILE_VERSION,
      trusted: [...this.trusted],
      pendingReconfirmation: [...this.pending],
    }
    const payload = JSON.stringify(file, null, 2)
    try {
      const dir = dirname(this.path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Atomic write: a crash mid-save must never corrupt the trust registry.
      const tmpPath = `${this.path}.tmp`
      writeFileSync(tmpPath, payload, 'utf-8')
      renameSync(tmpPath, this.path)
    } catch (err) {
      console.error('Failed to save trusted workspaces:', err)
    }
  }
}

/** Singleton used across the main process. */
export const workspaceTrustStore = new WorkspaceTrustStore()
