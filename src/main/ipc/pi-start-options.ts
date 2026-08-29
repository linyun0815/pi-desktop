import { app } from 'electron'
import type { PiStartOptions, AppSettings, PermissionMode } from '../../shared/ipc-contracts'
import { getGuiDataPath } from '../app-data-paths'
import { workspaceTrustStore } from '../workspace-trust'
import { join } from 'path'
import { statSync } from 'fs'
import { PERMISSION_RULES_FILE_NAME } from '../../../resources/permission-rules'
import { isString, isObject, isOptionalString, isOptionalBoolean } from './validation'

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

const PERMISSIONS_EXTENSION_PATH = app.isPackaged
  ? join(process.resourcesPath, 'resources', 'pi-desktop-permissions.ts')
  : join(app.getAppPath(), 'resources', 'pi-desktop-permissions.ts')

export function getGlobalPermissionRulesPath(): string {
  return getGuiDataPath(PERMISSION_RULES_FILE_NAME)
}

export function getPermissionsExtensionPath(): string | null {
  try {
    return statSync(PERMISSIONS_EXTENSION_PATH).isFile() ? PERMISSIONS_EXTENSION_PATH : null
  } catch {
    return null
  }
}

function toolsForPermissionMode(mode: PermissionMode): string[] | null {
  switch (mode) {
    case 'plan-readonly':
      return READ_ONLY_TOOLS
    case 'ask-commands':
    case 'ask-edits':
    case 'trusted':
      return null
  }
}

/**
 * Opt into resuming the most recent session on launch when the user setting is
 * enabled and the caller hasn't requested a specific session or an ephemeral
 * (no-session) run.
 */
export function applyResumePreference(options: PiStartOptions, settings: AppSettings): PiStartOptions {
  if (settings.resumeLastSession && !options.sessionPath && !options.forkSessionPath && !options.noSession) {
    return { ...options, continueSession: true }
  }
  return options
}

/**
 * Derive the SDK-facing permission fields for a start: the plan/read-only
 * tool allowlist, the desktop permissions extension, and the environment the
 * extension reads. The renderer never supplies any of these.
 */
export function applyPermissionModeToStartOptions(
  options: PiStartOptions,
  settings: AppSettings
): PiStartOptions {
  const toolList = toolsForPermissionMode(settings.permissionMode)
  const globalRulesPath = getGlobalPermissionRulesPath()
  const permissionExtensionPath = getPermissionsExtensionPath()

  return {
    ...options,
    tools: options.tools ?? toolList,
    permissionMode: settings.permissionMode,
    permissionRulesPath: globalRulesPath,
    agentLabel: 'Pi',
    extensionPaths: permissionExtensionPath ? [permissionExtensionPath] : [],
    env: {
      ...options.env,
      PI_DESKTOP_PERMISSION_MODE: settings.permissionMode,
      // The extension raises the approval prompt from inside the agent, so it
      // has no other way to know which host it is running in.
      PI_DESKTOP_AGENT_LABEL: 'Pi',
      // Resolved here because the extension cannot re-derive the GUI data
      // dir (env override / canonical appData / legacy fallback).
      PI_DESKTOP_PERMISSION_RULES_PATH: globalRulesPath,
      // Gates whether this workspace's own permission-rules.json allow rules
      // take effect. Untrusted repos may only tighten (deny) — the user grants
      // trust explicitly (see workspace-trust.ts).
      PI_DESKTOP_WORKSPACE_TRUSTED:
        options.cwd && workspaceTrustStore.isTrusted(options.cwd) ? '1' : '0',
    },
  }
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

export function validateStartOptions(value: unknown): PiStartOptions {
  if (value === undefined || value === null) return {}

  if (!isObject(value)) throw new Error('Start options must be an object')

  const opts: PiStartOptions = {}

  if (!isOptionalString(value.cwd)) throw new Error('cwd must be a string')
  if (!isOptionalString(value.model)) throw new Error('model must be a string')
  if (!isOptionalString(value.provider)) throw new Error('provider must be a string')
  if (!isOptionalString(value.sessionPath)) throw new Error('sessionPath must be a string')
  if (!isOptionalString(value.forkSessionPath)) throw new Error('forkSessionPath must be a string')
  if (!isOptionalBoolean(value.noSession)) throw new Error('noSession must be a boolean')
  if (value.env !== undefined && !isObject(value.env)) throw new Error('env must be an object')

  if (isString(value.cwd)) opts.cwd = value.cwd
  if (isString(value.model)) opts.model = value.model
  if (isString(value.provider)) opts.provider = value.provider
  if (isString(value.sessionPath)) opts.sessionPath = value.sessionPath
  if (isString(value.forkSessionPath)) opts.forkSessionPath = value.forkSessionPath
  if (value.noSession === true) opts.noSession = true
  if (isObject(value.env)) {
    opts.env = Object.fromEntries(
      Object.entries(value.env).filter((entry): entry is [string, string] => isString(entry[1]))
    )
  }

  return opts
}
