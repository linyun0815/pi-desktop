import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { DiagnosticsReport, DiagnosticsWorkspaceInfo } from '../shared/ipc-contracts'
import { EMBEDDED_AGENT_PROTOCOL_VERSION } from '../shared/embedded-agent-protocol'
import { sanitizeProvidersError, summarizeProviders } from './diagnostics-report'
import type { WorkspaceManager } from './workspace-manager'
import { workspaceTrustStore } from './workspace-trust'
import { getSessionsRoot } from './pi-paths'
import { getGuiDataDir } from './app-data-paths'
import { appLog } from './app-log'
import { validatePermissionRulesFile } from '../../resources/permission-rules'
import {
  getGlobalPermissionRulesPath,
} from './ipc/pi-start-options'
import { getSettingsPath, loadAppSettings } from './ipc/settings'
import { buildWorkspaceRulesStatus } from './ipc/permission-rules-handlers'
import { readModelsConfigFile } from './ipc/models-config-handlers'
import {
  getEmbeddedPiSdkVersion,
  MIN_HELPER_NODE_VERSION,
  resolveEmbeddedWorkerPath,
} from './pi-sdk-manager'

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

async function readGlobalRuleCount(): Promise<{ count: number | null; error: string | null }> {
  const rulesPath = getGlobalPermissionRulesPath()
  if (!existsSync(rulesPath)) return { count: 0, error: null }
  try {
    const parsed: unknown = JSON.parse(await readFile(rulesPath, 'utf-8'))
    return { count: validatePermissionRulesFile(parsed).rules.length, error: null }
  } catch (err) {
    return { count: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function collectDiagnostics(
  workspaceManager: WorkspaceManager,
): Promise<DiagnosticsReport> {
  const settings = await loadAppSettings(workspaceManager)

  const workspaces: DiagnosticsWorkspaceInfo[] = workspaceManager.getWorkspaces().map((ws) => ({
    id: ws.id,
    name: ws.name,
    path: ws.path,
    pathExists: existsSync(ws.path),
    trusted: workspaceTrustStore.isTrusted(ws.path),
    piStatus: workspaceManager.getPiManager(ws.id)?.getStatus().status ?? 'stopped',
  }))

  const modelsRead = await readModelsConfigFile()
  const providers = 'config' in modelsRead ? summarizeProviders(modelsRead.config, process.env) : null
  const providersError = 'error' in modelsRead ? sanitizeProvidersError(modelsRead.error) : null

  const globalRules = await readGlobalRuleCount()
  const sessionsRoot = getSessionsRoot()
  const nodeVersion = process.versions.node ?? 'unknown'
  const workerPath = resolveEmbeddedWorkerPath()

  return {
    generatedAt: Date.now(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: nodeVersion,
      platform: process.platform,
    },
    piRuntime: {
      sdkVersion: getEmbeddedPiSdkVersion(),
      protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
      workerPath,
      nodeVersion,
      nodeSatisfied: compareVersions(nodeVersion, MIN_HELPER_NODE_VERSION) >= 0,
      nodeRequired: MIN_HELPER_NODE_VERSION,
    },
    helpers: workspaceManager.getSessionRuntimes().map((runtime) => ({
      runtimeId: runtime.runtimeId,
      workspaceId: runtime.workspaceId,
      status: runtime.status,
      pid: runtime.pid,
      sessionPath: runtime.sessionPath,
      activity: runtime.activity,
    })),
    workspaces,
    providers,
    providersError,
    permissions: {
      mode: settings.permissionMode,
      globalRuleCount: globalRules.count,
      globalRulesError: globalRules.error,
      workspace: await buildWorkspaceRulesStatus(workspaceManager),
    },
    storage: {
      guiDataDir: getGuiDataDir(),
      settingsPath: getSettingsPath(),
      sessionsRoot,
      sessionsRootExists: existsSync(sessionsRoot),
    },
    recentErrors: appLog.getRecent().filter((entry) => entry.level !== 'info'),
  }
}
