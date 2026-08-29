/**
 * Versioned parent <-> helper protocol for the embedded Pi SDK runtime.
 *
 * The parent (Electron main) drives one utility process per live session; the
 * helper dynamically imports the Pi SDK and owns an AgentSessionRuntime. This
 * module is the single source of truth for both directions of that conversation:
 *
 *  - `ParentToHelperMessage` — init, prompting, model/thinking mutations,
 *    session management, compaction, bash, package/admin commands, shutdown.
 *  - `HelperToParentMessage` — ready/fatal, correlated responses, renderer-
 *    shaped Pi events, extension-UI requests, session rebindings, diagnostics.
 *
 * Every message is structurally validated (`parseParentToHelper` /
 * `parseHelperToParent`) and may only carry structured-clone transferable data:
 * plain objects, arrays, strings, numbers, booleans and null. The worker runs a
 * JSON round-trip over anything derived from the SDK before posting, so class
 * instances and functions never reach the wire.
 *
 * Session targets (plan §5): new -> SessionManager.create, open ->
 * SessionManager.open, continue -> continueRecent, fork -> forkFrom,
 * inMemory -> inMemory.
 */
import type { PiExtensionUiRequest, PiRpcEvent, PromptImage } from './ipc-contracts'

/** Bump on any wire-incompatible change; the parent refuses mismatched helpers. */
export const EMBEDDED_AGENT_PROTOCOL_VERSION = 1

/** How a helper binds its AgentSessionRuntime's session manager at init. */
export type SessionTarget =
  | { kind: 'new' }
  | { kind: 'open'; sessionPath: string }
  | { kind: 'continue' }
  | { kind: 'fork'; sourcePath: string }
  | { kind: 'inMemory' }

export type SessionTargetKind = SessionTarget['kind']

/** Thinking levels accepted by the SDK; validated as a closed set. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ProtocolThinkingLevel = (typeof THINKING_LEVELS)[number]

/** Config handed to the helper before any SDK object exists. */
export interface HelperInitMessage {
  kind: 'init'
  protocolVersion: number
  /** Bound working directory; the helper chdirs here before loading the SDK. */
  cwd: string
  /** Pi agent dir (honors PI_CODING_AGENT_DIR upstream of this call). */
  agentDir: string
  /** Main's workspace-trust decision; feeds SettingsManager + loader trust. */
  projectTrusted: boolean
  session: SessionTarget
  provider?: string
  modelId?: string
  thinkingLevel?: ProtocolThinkingLevel
  /** Permission mode name forwarded to the desktop permissions extension. */
  permissionMode?: string
  /** Allowlist applied to the session for plan/read-only mode. */
  tools?: string[] | null
  /** Absolute path of the desktop permissions extension, when present. */
  permissionExtensionPath?: string | null
  /** GUI data-dir rules file the permissions extension re-reads per call. */
  permissionRulesPath?: string | null
  /** Display name the permission prompts use ("Pi"). */
  agentLabel?: string
  /** Extra extension paths the helper must load alongside Pi's own set. */
  extensionPaths?: string[]
}

// ─── Parent -> Helper: session commands ─────────────────────────────────────

export interface HelperPromptMessage {
  kind: 'prompt'
  id: string
  message: string
  images?: PromptImage[]
  streamingBehavior?: 'steer' | 'followUp'
}

export interface HelperSteerMessage {
  kind: 'steer'
  id: string
  message: string
  images?: PromptImage[]
}

export interface HelperFollowUpMessage {
  kind: 'followUp'
  id: string
  message: string
}

export interface HelperAbortMessage {
  kind: 'abort'
  id: string
}

export interface HelperBashMessage {
  kind: 'bash'
  id: string
  command: string
}

export interface HelperAbortBashMessage {
  kind: 'abortBash'
  id: string
}

export interface HelperSetModelMessage {
  kind: 'setModel'
  id: string
  provider: string
  modelId: string
}

export interface HelperCycleModelMessage {
  kind: 'cycleModel'
  id: string
}

export interface HelperSetThinkingLevelMessage {
  kind: 'setThinkingLevel'
  id: string
  level: ProtocolThinkingLevel
}

export interface HelperCycleThinkingLevelMessage {
  kind: 'cycleThinkingLevel'
  id: string
}

// ─── Parent -> Helper: state reads ──────────────────────────────────────────

export interface HelperSessionStateMessage {
  kind: 'sessionState'
  id: string
}

export interface HelperSessionMessagesMessage {
  kind: 'sessionMessages'
  id: string
}

export interface HelperListModelsMessage {
  kind: 'listModels'
  id: string
}

export interface HelperSessionStatsMessage {
  kind: 'sessionStats'
  id: string
}

export interface HelperListCommandsMessage {
  kind: 'listCommands'
  id: string
}

export interface HelperGetForkMessagesMessage {
  kind: 'getForkMessages'
  id: string
}

// ─── Parent -> Helper: session mutations ────────────────────────────────────

export interface HelperSetSessionNameMessage {
  kind: 'setSessionName'
  id: string
  name: string
}

export interface HelperSessionNewMessage {
  kind: 'sessionNew'
  id: string
}

export interface HelperSessionSwitchMessage {
  kind: 'sessionSwitch'
  id: string
  sessionPath: string
}

export interface HelperSessionForkMessage {
  kind: 'sessionFork'
  id: string
  entryId?: string
}

export interface HelperSessionCloneMessage {
  kind: 'sessionClone'
  id: string
}

export interface HelperCompactMessage {
  kind: 'compact'
  id: string
  customInstructions?: string
}

export interface HelperExportHtmlMessage {
  kind: 'exportHtml'
  id: string
  outputPath?: string
}

// ─── Parent -> Helper: lifecycle ────────────────────────────────────────────

/** Answer to a helper auth/UI prompt; `payload` mirrors the RPC response. */
export interface HelperExtensionUiResponseMessage {
  kind: 'extensionUiResponse'
  /** The helper-side request id (`uiRequest.request.id`). */
  responseId: string
  payload: Record<string, unknown>
}

/** Re-create the ModelRuntime after models.json changed on disk. */
export interface HelperReloadModelConfigMessage {
  kind: 'reloadModelConfig'
  id: string
}

/** Ordered graceful shutdown: abort + dispose, then exit. */
export interface HelperShutdownMessage {
  kind: 'shutdown'
  id: string
}

export type ParentToHelperMessage =
  | HelperInitMessage
  | HelperPromptMessage
  | HelperSteerMessage
  | HelperFollowUpMessage
  | HelperAbortMessage
  | HelperBashMessage
  | HelperAbortBashMessage
  | HelperSetModelMessage
  | HelperCycleModelMessage
  | HelperSetThinkingLevelMessage
  | HelperCycleThinkingLevelMessage
  | HelperSessionStateMessage
  | HelperSessionMessagesMessage
  | HelperListModelsMessage
  | HelperSessionStatsMessage
  | HelperListCommandsMessage
  | HelperGetForkMessagesMessage
  | HelperSetSessionNameMessage
  | HelperSessionNewMessage
  | HelperSessionSwitchMessage
  | HelperSessionForkMessage
  | HelperSessionCloneMessage
  | HelperCompactMessage
  | HelperExportHtmlMessage
  | HelperExtensionUiResponseMessage
  | HelperReloadModelConfigMessage
  | HelperShutdownMessage

// ─── Helper -> Parent ───────────────────────────────────────────────────────

export interface HelperReadyMessage {
  kind: 'ready'
  protocolVersion: number
  sdkVersion: string
  pid: number
}

/** The helper could not initialize; it exits after posting. */
export interface HelperFatalMessage {
  kind: 'fatal'
  message: string
}

/**
 * Correlated response mirroring the renderer response envelope
 * (`{type:'response', command, success, data?, error?}`) so existing handler
 * return shapes survive the migration.
 */
export interface HelperResponseMessage {
  kind: 'response'
  id: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/** One renderer-shaped event, already stripped of SDK-only fields. */
export interface HelperEventMessage {
  kind: 'event'
  event: PiRpcEvent
}

/** Extension UI protocol request (select/confirm/input/editor/notify/...). */
export interface HelperUiRequestMessage {
  kind: 'uiRequest'
  request: PiExtensionUiRequest
}

/** Emitted after init and after every successful session rebinding. */
export interface HelperSessionBoundMessage {
  kind: 'sessionBound'
  sessionFile: string | null
  sessionId: string | null
  sessionName: string | null
}

export interface HelperLogMessage {
  kind: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Graceful-shutdown acknowledgement; the exit event remains authoritative. */
export interface HelperByeMessage {
  kind: 'bye'
}

export type HelperToParentMessage =
  | HelperReadyMessage
  | HelperFatalMessage
  | HelperResponseMessage
  | HelperEventMessage
  | HelperUiRequestMessage
  | HelperSessionBoundMessage
  | HelperLogMessage
  | HelperByeMessage

// ─── Admin (auth + package management) helper messages ──────────────────────
//
// The admin helper is a second utility process kind sharing this protocol
// file. It never hosts a session; it performs API-key login/logout, package
// install/remove/update, and resource refresh so extension code stays out of
// the Electron main process.

export interface AdminInitMessage {
  kind: 'admin-init'
  protocolVersion: number
  agentDir: string
  cwd: string
}

export interface AdminListProvidersMessage {
  kind: 'adminListProviders'
  id: string
}

export interface AdminLoginMessage {
  kind: 'adminLogin'
  id: string
  /** Correlates the prompts/notify emitted during this login flow. */
  loginId: string
  providerId: string
}

export interface AdminCancelLoginMessage {
  kind: 'adminCancelLogin'
  id: string
  loginId: string
}

/** The renderer's answer to one forwarded auth prompt. */
export interface AdminPromptAnswerMessage {
  kind: 'adminPromptAnswer'
  id: string
  loginId: string
  value?: string
  canceled?: boolean
}

export interface AdminLogoutMessage {
  kind: 'adminLogout'
  id: string
  providerId: string
}

export interface AdminPackageInstallMessage {
  kind: 'adminPackageInstall'
  id: string
  source: string
}

export interface AdminPackageRemoveMessage {
  kind: 'adminPackageRemove'
  id: string
  source: string
}

export interface AdminPackageUpdateMessage {
  kind: 'adminPackageUpdate'
  id: string
  source?: string
}

export interface AdminPackagesConfiguredMessage {
  kind: 'adminPackagesConfigured'
  id: string
}

export interface AdminNpmAvailableMessage {
  kind: 'adminNpmAvailable'
  id: string
}

export interface AdminShutdownMessage {
  kind: 'adminShutdown'
  id: string
}

export type ParentToAdminHelperMessage =
  | AdminInitMessage
  | AdminListProvidersMessage
  | AdminLoginMessage
  | AdminCancelLoginMessage
  | AdminPromptAnswerMessage
  | AdminLogoutMessage
  | AdminPackageInstallMessage
  | AdminPackageRemoveMessage
  | AdminPackageUpdateMessage
  | AdminPackagesConfiguredMessage
  | AdminNpmAvailableMessage
  | AdminShutdownMessage

export interface AdminReadyMessage {
  kind: 'adminReady'
  protocolVersion: number
  sdkVersion: string
  pid: number
}

export interface AdminResponseMessage {
  kind: 'adminResponse'
  id: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/** One interactive step of an SDK auth flow, forwarded to the renderer. */
export interface AdminAuthPromptMessage {
  kind: 'authPrompt'
  loginId: string
  prompt: AuthPromptPayload
}

/** Non-interactive auth progress/info event. */
export interface AdminAuthNotifyMessage {
  kind: 'authNotify'
  loginId: string
  event: AuthEventPayload
}

export interface AdminPackageProgressMessage {
  kind: 'adminPackageProgress'
  /** Action-scoped correlation id supplied by the parent request. */
  id: string
  event: { type: string; action: string; source: string; message?: string }
}

export type AdminHelperToParentMessage =
  | AdminReadyMessage
  | AdminResponseMessage
  | AdminAuthPromptMessage
  | AdminAuthNotifyMessage
  | AdminPackageProgressMessage
  | HelperLogMessage
  | HelperByeMessage

/**
 * Serializable projection of pi-ai's AuthPrompt. Only `text` / `secret` /
 * `select` reach the renderer: the first release ships the api_key flow only,
 * and `manual_code` belongs to OAuth flows the desktop does not offer.
 */
export type AuthPromptPayload = {
  type: 'text'
  message: string
  placeholder?: string
} | {
  type: 'secret'
  message: string
  placeholder?: string
} | {
  type: 'select'
  message: string
  options: ReadonlyArray<{ id: string; label: string; description?: string }>
}

export type AuthEventPayload =
  | { type: 'info'; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
  | { type: 'progress'; message: string }

// ─── Validation ─────────────────────────────────────────────────────────────
//
// Hand-rolled structural guards: the protocol is small, closed, and must stay
// dependency-free for both the renderer and the utility-process bundles. Every
// validator returns the narrowed message or null; payload data fields are
// checked for structured-clone safety at the boundaries that accept them.

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isOptString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string'

const isOptBool = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === 'boolean'

const isPromptImage = (value: unknown): value is PromptImage =>
  isPlainObject(value) &&
  value.type === 'image' &&
  isString(value.mimeType) &&
  isString(value.data)

const isImages = (value: unknown): value is PromptImage[] =>
  Array.isArray(value) && value.every(isPromptImage)

const isSessionTarget = (value: unknown): value is SessionTarget => {
  if (!isPlainObject(value)) return false
  switch (value.kind) {
    case 'new':
    case 'continue':
    case 'inMemory':
      return true
    case 'open':
    case 'fork':
      return isString(value.sessionPath)
    default:
      return false
  }
}

const isThinkingLevel = (value: unknown): value is ProtocolThinkingLevel =>
  isString(value) && (THINKING_LEVELS as readonly string[]).includes(value)

/** Validator for the shared prefix: `kind` + optional correlation id. */
function messageKind(value: unknown, kinds: readonly string[]): string | null {
  if (!isPlainObject(value)) return null
  const kind = value.kind
  return isString(kind) && kinds.includes(kind) ? kind : null
}

const PARENT_KINDS = [
  'init', 'prompt', 'steer', 'followUp', 'abort', 'bash', 'abortBash',
  'setModel', 'cycleModel', 'setThinkingLevel', 'cycleThinkingLevel',
  'sessionState', 'sessionMessages', 'listModels', 'sessionStats', 'listCommands',
  'getForkMessages', 'setSessionName', 'sessionNew', 'sessionSwitch',
  'sessionFork', 'sessionClone', 'compact', 'exportHtml',
  'extensionUiResponse', 'reloadModelConfig', 'shutdown',
] as const

/** Narrow one parent -> helper message; null when malformed. */
export function parseParentToHelper(value: unknown): ParentToHelperMessage | null {
  const kind = messageKind(value, PARENT_KINDS)
  if (!kind || !isPlainObject(value)) return null
  const id = value.id
  const hasId = isString(id)
  switch (kind) {
    case 'init': {
      if (
        value.protocolVersion !== EMBEDDED_AGENT_PROTOCOL_VERSION ||
        !isString(value.cwd) ||
        !isString(value.agentDir) ||
        !isOptBool(value.projectTrusted) ||
        !isSessionTarget(value.session) ||
        !isOptString(value.provider) ||
        !isOptString(value.modelId) ||
        !(value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel)) ||
        !isOptString(value.permissionMode) ||
        !isOptString(value.permissionExtensionPath) ||
        !isOptString(value.permissionRulesPath) ||
        !isOptString(value.agentLabel) ||
        !(value.tools === undefined || value.tools === null || (Array.isArray(value.tools) && value.tools.every(isString))) ||
        !(value.extensionPaths === undefined || (Array.isArray(value.extensionPaths) && value.extensionPaths.every(isString)))
      ) return null
      const session = value.session as SessionTarget
      return {
        kind: 'init',
        protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
        cwd: value.cwd,
        agentDir: value.agentDir,
        projectTrusted: value.projectTrusted ?? false,
        session,
        provider: value.provider,
        modelId: value.modelId,
        thinkingLevel: value.thinkingLevel,
        permissionMode: value.permissionMode,
        tools: (value.tools ?? null) as string[] | null,
        permissionExtensionPath: value.permissionExtensionPath ?? null,
        permissionRulesPath: value.permissionRulesPath ?? null,
        agentLabel: value.agentLabel,
        extensionPaths: value.extensionPaths,
      }
    }
    case 'prompt':
      if (!hasId || !isString(value.message)) return null
      return {
        kind, id, message: value.message,
        images: isImages(value.images) ? value.images : undefined,
        streamingBehavior: value.streamingBehavior === 'steer' || value.streamingBehavior === 'followUp'
          ? value.streamingBehavior
          : undefined,
      }
    case 'steer':
      if (!hasId || !isString(value.message)) return null
      return {
        kind, id, message: value.message,
        images: isImages(value.images) ? value.images : undefined,
      }
    case 'followUp':
    case 'bash':
      if (!hasId || !isString(value.message ?? value.command)) return null
      return kind === 'bash'
        ? { kind, id, command: value.command as string }
        : { kind, id, message: value.message as string }
    case 'abort':
    case 'cycleModel':
    case 'cycleThinkingLevel':
    case 'sessionState':
    case 'sessionMessages':
    case 'listModels':
    case 'sessionStats':
    case 'listCommands':
    case 'getForkMessages':
    case 'sessionNew':
    case 'sessionClone':
    case 'reloadModelConfig':
    case 'shutdown':
      if (!hasId) return null
      return { kind, id } as ParentToHelperMessage
    case 'abortBash':
      if (!hasId) return null
      return { kind, id }
    case 'setModel':
      if (!hasId || !isString(value.provider) || !isString(value.modelId)) return null
      return { kind, id, provider: value.provider, modelId: value.modelId }
    case 'setThinkingLevel':
      if (!hasId || !isThinkingLevel(value.level)) return null
      return { kind, id, level: value.level }
    case 'setSessionName':
      if (!hasId || !isString(value.name)) return null
      return { kind, id, name: value.name }
    case 'sessionSwitch':
      if (!hasId || !isString(value.sessionPath)) return null
      return { kind, id, sessionPath: value.sessionPath }
    case 'sessionFork':
      if (!hasId || !isOptString(value.entryId)) return null
      return { kind, id, entryId: value.entryId }
    case 'compact':
      if (!hasId || !isOptString(value.customInstructions)) return null
      return { kind, id, customInstructions: value.customInstructions }
    case 'exportHtml':
      if (!hasId || !isOptString(value.outputPath)) return null
      return { kind, id, outputPath: value.outputPath }
    case 'extensionUiResponse':
      if (!isString(value.responseId) || !isPlainObject(value.payload)) return null
      return { kind, responseId: value.responseId, payload: value.payload }
    default:
      return null
  }
}

const HELPER_KINDS = [
  'ready', 'fatal', 'response', 'event', 'uiRequest',
  'sessionBound', 'log', 'bye',
] as const

/** Narrow one helper -> parent message; null when malformed. */
export function parseHelperToParent(value: unknown): HelperToParentMessage | null {
  const kind = messageKind(value, HELPER_KINDS)
  if (!kind || !isPlainObject(value)) return null
  switch (kind) {
    case 'ready':
      if (
        value.protocolVersion !== EMBEDDED_AGENT_PROTOCOL_VERSION ||
        !isString(value.sdkVersion) ||
        typeof value.pid !== 'number'
      ) return null
      return { kind, protocolVersion: value.protocolVersion, sdkVersion: value.sdkVersion, pid: value.pid }
    case 'fatal':
      if (!isString(value.message)) return null
      return { kind, message: value.message }
    case 'response':
      if (!isString(value.id) || !isString(value.command) || typeof value.success !== 'boolean') return null
      return {
        kind, id: value.id, command: value.command, success: value.success,
        data: value.data, error: isString(value.error) ? value.error : undefined,
      }
    case 'event':
      if (!isPlainObject(value.event) || !isString((value.event as { type?: unknown }).type)) return null
      return { kind, event: value.event as unknown as PiRpcEvent }
    case 'uiRequest':
      if (!isPlainObject(value.request) || !isString((value.request as { id?: unknown }).id)) return null
      return { kind, request: value.request as unknown as PiExtensionUiRequest }
    case 'sessionBound':
      return {
        kind,
        sessionFile: isString(value.sessionFile) ? value.sessionFile : null,
        sessionId: isString(value.sessionId) ? value.sessionId : null,
        sessionName: isString(value.sessionName) ? value.sessionName : null,
      }
    case 'log':
      if (!(value.level === 'info' || value.level === 'warn' || value.level === 'error') || !isString(value.message)) return null
      return { kind, level: value.level, message: value.message }
    case 'bye':
      return { kind }
    default:
      return null
  }
}

const ADMIN_PARENT_KINDS = [
  'admin-init', 'adminListProviders', 'adminLogin', 'adminCancelLogin',
  'adminPromptAnswer', 'adminLogout', 'adminPackageInstall', 'adminPackageRemove',
  'adminPackageUpdate', 'adminPackagesConfigured', 'adminNpmAvailable',
  'adminShutdown',
] as const

/** Narrow one parent -> admin-helper message; null when malformed. */
export function parseParentToAdminHelper(value: unknown): ParentToAdminHelperMessage | null {
  const kind = messageKind(value, ADMIN_PARENT_KINDS)
  if (!kind || !isPlainObject(value)) return null
  const id = value.id
  const hasId = isString(id)
  switch (kind) {
    case 'admin-init':
      if (value.protocolVersion !== EMBEDDED_AGENT_PROTOCOL_VERSION || !isString(value.agentDir) || !isString(value.cwd)) return null
      return { kind, protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION, agentDir: value.agentDir, cwd: value.cwd }
    case 'adminListProviders':
    case 'adminPackagesConfigured':
    case 'adminNpmAvailable':
    case 'adminShutdown':
      if (!hasId) return null
      return { kind, id }
    case 'adminLogin':
      if (!hasId || !isString(value.loginId) || !isString(value.providerId)) return null
      return { kind, id, loginId: value.loginId, providerId: value.providerId }
    case 'adminCancelLogin':
      if (!hasId || !isString(value.loginId)) return null
      return { kind, id, loginId: value.loginId }
    case 'adminPromptAnswer':
      if (!hasId || !isString(value.loginId)) return null
      return {
        kind, id, loginId: value.loginId,
        value: isString(value.value) ? value.value : undefined,
        canceled: value.canceled === true,
      }
    case 'adminLogout':
      if (!hasId || !isString(value.providerId)) return null
      return { kind, id, providerId: value.providerId }
    case 'adminPackageInstall':
    case 'adminPackageRemove':
      if (!hasId || !isString(value.source)) return null
      return { kind, id, source: value.source }
    case 'adminPackageUpdate':
      if (!hasId || !isOptString(value.source)) return null
      return { kind, id, source: value.source }
    default:
      return null
  }
}

const ADMIN_HELPER_KINDS = [
  'adminReady', 'adminResponse', 'authPrompt', 'authNotify',
  'adminPackageProgress', 'log', 'bye',
] as const

/** Narrow one admin-helper -> parent message; null when malformed. */
export function parseAdminHelperToParent(value: unknown): AdminHelperToParentMessage | null {
  const kind = messageKind(value, ADMIN_HELPER_KINDS)
  if (!kind || !isPlainObject(value)) return null
  switch (kind) {
    case 'adminReady':
      if (
        value.protocolVersion !== EMBEDDED_AGENT_PROTOCOL_VERSION ||
        !isString(value.sdkVersion) ||
        typeof value.pid !== 'number'
      ) return null
      return { kind, protocolVersion: value.protocolVersion, sdkVersion: value.sdkVersion, pid: value.pid }
    case 'adminResponse':
      if (!isString(value.id) || !isString(value.command) || typeof value.success !== 'boolean') return null
      return {
        kind, id: value.id, command: value.command, success: value.success,
        data: value.data, error: isString(value.error) ? value.error : undefined,
      }
    case 'authPrompt':
      if (!isString(value.loginId) || !isPlainObject(value.prompt)) return null
      return { kind, loginId: value.loginId, prompt: value.prompt as AuthPromptPayload }
    case 'authNotify':
      if (!isString(value.loginId) || !isPlainObject(value.event)) return null
      return { kind, loginId: value.loginId, event: value.event as AuthEventPayload }
    case 'adminPackageProgress':
      if (!isString(value.id) || !isPlainObject(value.event)) return null
      return { kind, id: value.id, event: value.event as { type: string; action: string; source: string; message?: string } }
    case 'log':
      if (!(value.level === 'info' || value.level === 'warn' || value.level === 'error') || !isString(value.message)) return null
      return { kind, level: value.level, message: value.message }
    case 'bye':
      return { kind }
    default:
      return null
  }
}

/**
 * Structured-clone safety net. The SDK hands out class instances (Model,
 * AssistantMessage) whose private fields may hold functions or cyclic refs.
 * The old JSONL pipe JSON-serialized everything; this round-trip reproduces
 * exactly that behavior over the utility-process wire. Returns null for
 * values JSON cannot represent at all.
 */
export function toTransferable<T>(value: T): T | null {
  if (value === null || value === undefined) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return null
  }
}
