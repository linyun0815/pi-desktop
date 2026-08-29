import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { PiMessageUpdateEvent, PiRpcEvent } from '../shared/ipc-contracts'
import type { CouncilAgentId, ConsensusMode, ConsultantResult } from '../shared/council-config'
import {
  buildConsultantPrompt,
  buildConsensusPrompt,
  buildArbiterRevisionPrompt,
  buildDebatePrompt,
  buildConsultantCommand,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parsePiStreamLine,
} from '../shared/council-config'
import { detectAgents } from './agent-detection'
import { escapeCmdSpawn } from './cmd-escape'
import { PiSdkManager } from './pi-sdk-manager'

const IS_WINDOWS = process.platform === 'win32'
const MS_PER_SECOND = 1000
const FORCE_KILL_TIMEOUT_MS = 3000

export interface SpawnOutcome {
  ok: boolean
  output: string
  error?: string
  timedOut?: boolean
}

/** Called with each readable text chunk as a consultant produces output. */
export type ConsultantChunkHandler = (chunk: string) => void

/** Injectable spawn so orchestration is testable without real CLIs. */
export type SpawnConsultant = (
  id: CouncilAgentId,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onChunk?: ConsultantChunkHandler,
) => Promise<SpawnOutcome>

export interface RunConsultantsParams {
  request: string
  members: CouncilAgentId[]
  cwd: string
  timeoutSeconds: number
  consensusMode: ConsensusMode
}

export interface ConsultantDeps {
  spawnConsultant: SpawnConsultant
  /** Notified with live output chunks per consultant, for streaming to the UI. */
  onProgress?: (id: CouncilAgentId, chunk: string) => void
}

const MIN_DEBATE_PARTICIPANTS = 2

/** Map a spawn outcome to a labeled consultant result. */
function toResult(id: CouncilAgentId, outcome: SpawnOutcome): ConsultantResult {
  if (outcome.timedOut) return { id, status: 'timed-out' }
  if (!outcome.ok) return { id, status: 'errored', error: outcome.error ?? 'unknown error' }
  return { id, status: 'contributed', plan: outcome.output.trim() }
}

/**
 * Run the consultant fan-out. Arbiter mode = one round. Debate mode = a second
 * round where each contributing member revises given the others' plans.
 */
export async function runConsultants(
  params: RunConsultantsParams,
  deps: ConsultantDeps,
): Promise<ConsultantResult[]> {
  const timeoutMs = params.timeoutSeconds * MS_PER_SECOND
  const prompt = buildConsultantPrompt(params.request)

  const forward = (id: CouncilAgentId): ConsultantChunkHandler => (chunk) => deps.onProgress?.(id, chunk)

  const round1 = await Promise.all(
    params.members.map(async (id) =>
      toResult(id, await deps.spawnConsultant(id, prompt, params.cwd, timeoutMs, forward(id))),
    ),
  )

  if (params.consensusMode !== 'debate') return round1

  const contributed = round1.filter((r) => r.status === 'contributed')
  if (contributed.length < MIN_DEBATE_PARTICIPANTS) return round1

  const round2 = await Promise.all(
    round1.map(async (r) => {
      if (r.status !== 'contributed') return r
      const others = contributed.filter((o) => o.id !== r.id)
      const debatePrompt = buildDebatePrompt(params.request, r.id, others)
      return toResult(r.id, await deps.spawnConsultant(r.id, debatePrompt, params.cwd, timeoutMs, forward(r.id)))
    }),
  )
  return round2
}

/**
 * Structured input for the arbiter step. `merge` combines contributed plans;
 * `revise` reworks an already-produced consensus plan given user feedback.
 */
export type ArbiterRequest =
  | { kind: 'merge'; request: string; results: ConsultantResult[] }
  | { kind: 'revise'; request: string; plan: string; feedback: string }

export interface ArbiterDeps {
  spawnConsultant: SpawnConsultant
  /** Notified with live output chunks from the arbiter, for streaming to the UI. */
  onProgress?: ConsultantChunkHandler
}

/**
 * Run the arbiter (Pi) as an isolated, read-only subprocess to merge or revise
 * the consensus plan. It runs read-only (via buildConsultantCommand('pi', …),
 * which excludes edit/write tools) precisely because consultant plans are
 * untrusted input: a poisoned plan cannot drive tool use here. Only the returned
 * plan text is later handed to the writable implementation session.
 */
export async function runArbiter(
  input: ArbiterRequest,
  cwd: string,
  timeoutSeconds: number,
  deps: ArbiterDeps,
): Promise<SpawnOutcome> {
  const prompt =
    input.kind === 'merge'
      ? buildConsensusPrompt(input.request, input.results)
      : buildArbiterRevisionPrompt(input.request, input.plan, input.feedback)
  const timeoutMs = timeoutSeconds * MS_PER_SECOND
  return deps.spawnConsultant('pi', prompt, cwd, timeoutMs, deps.onProgress)
}

/**
 * The exact program and argv handed to spawn() for one consultant.
 *
 * The prompt is delivered over stdin, never as a CLI argument. On Windows the
 * args pass through cmd.exe (shell:true is required to launch the `.cmd`
 * shims), so untrusted plan text on the command line would be open to
 * shell-metacharacter injection. All three CLIs read the prompt from stdin.
 * Node performs no quoting with shell:true, so the executable path (which may
 * contain spaces or cmd metacharacters via the user profile directory) and the
 * flags are escaped for the cmd.exe traversal on Windows.
 */
export function buildConsultantSpawn(
  id: Exclude<CouncilAgentId, 'pi'>,
  executable: string,
  isWindows: boolean,
): { file: string; args: string[] } {
  const command = buildConsultantCommand(id, executable)
  return escapeCmdSpawn(isWindows, command.file, command.args)
}

/**
 * Default spawn dispatch: the embedded Pi consultant/arbiter runs on a
 * short-lived SDK task helper; Claude/Codex remain external CLIs.
 */
export const defaultSpawnConsultant: SpawnConsultant = (id, prompt, cwd, timeoutMs, onChunk) => {
  if (id === 'pi') return runPiSdkConsultant(prompt, cwd, timeoutMs, onChunk)
  return spawnCliConsultant(id, prompt, cwd, timeoutMs, onChunk)
}

/**
 * One Pi consultant turn on an in-memory SDK runtime: read-only tools only
 * (read/grep/find/ls), no session persistence, no bash/edit/write. The plan
 * text the consultant returns is untrusted input handled by the caller; only
 * a user-approved consensus plan ever reaches a writable session.
 */
export async function runPiSdkConsultant(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onChunk?: ConsultantChunkHandler,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const manager = new PiSdkManager()
    let settled = false
    let planText = ''
    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      manager.removeAllListeners()
      // Ordered shutdown (abort -> dispose), escalating to a tree kill.
      void manager.abort().catch(() => undefined)
      void manager.stopAndWait().catch(() => undefined)
      resolve(outcome)
    }
    // SDK abort first so a mid-turn model request stops, then stopAndWait's
    // escalation reaps the utility process.
    const timer = setTimeout(() => {
      void manager.abort().catch(() => undefined)
      finish({ ok: false, output: planText, timedOut: true })
    }, timeoutMs)

    manager.on('event', (event: PiRpcEvent) => {
      if (event.type === 'message_update') {
        const ame = (event as PiMessageUpdateEvent).assistantMessageEvent
        if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
          planText += ame.delta
          onChunk?.(ame.delta)
        }
        return
      }
      if (event.type === 'agent_end') {
        finish({ ok: true, output: planText.trim() })
      }
    })

    void (async () => {
      const status = await manager.start({
        cwd,
        noSession: true,
        tools: ['read', 'grep', 'find', 'ls'],
      })
      if (settled) return
      if (status.status !== 'running') {
        finish({ ok: false, output: planText, error: status.error ?? 'Pi helper failed to start' })
        return
      }
      const response = await manager.prompt(prompt).catch((err: unknown) => {
        finish({ ok: false, output: planText, error: err instanceof Error ? err.message : String(err) })
        return null
      })
      if (!response || settled) return
      if (!response.success) {
        finish({ ok: false, output: planText, error: response.error ?? 'prompt rejected' })
      }
      // agent_end resolves from here; the timeout aborts a stalled turn.
    })().catch((err: unknown) => {
      finish({ ok: false, output: planText, error: err instanceof Error ? err.message : String(err) })
    })
  })
}

/** CLI consultant spawn for Claude/Codex; stream output, enforce timeout. */
export const spawnCliConsultant: SpawnConsultant = (id, prompt, cwd, timeoutMs, onChunk) =>
  new Promise<SpawnOutcome>((resolve) => {
    const { file, args } = buildConsultantSpawn(
      // 'pi' routes to runPiSdkConsultant before this point.
      id as Exclude<CouncilAgentId, 'pi'>,
      resolveExecutable(id),
      IS_WINDOWS,
    )
    const child = spawn(file, args, {
      cwd,
      shell: IS_WINDOWS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Ignore EPIPE if the child exits before consuming stdin; write then close
    // so the CLI sees a complete prompt and does not block waiting for more.
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let settled = false

    // Both CLIs emit JSONL: Claude via --output-format stream-json, Codex via
    // --json. We parse each line into readable text — streaming live via onChunk
    // and accumulating the plan separately from activity/reasoning noise.
    const isClaude = id === 'claude'
    let lineBuffer = ''
    let planText = ''
    let claudeFinal: string | undefined

    const applyLine = (line: string): void => {
      if (isClaude) {
        const { delta, final } = parseClaudeStreamLine(line)
        if (delta) {
          planText += delta
          onChunk?.(delta)
        }
        if (typeof final === 'string') claudeFinal = final
      } else {
        // Pi streams thinking as token deltas (append raw); Codex emits whole
        // reasoning items (separate with a newline).
        const isPi = id === 'pi'
        const { plan, display } = isPi ? parsePiStreamLine(line) : parseCodexStreamLine(line)
        if (typeof plan === 'string') {
          planText += plan
          onChunk?.(plan)
        } else if (typeof display === 'string') {
          // Reasoning/activity: show live but keep it out of the final plan.
          onChunk?.(isPi ? display : display + '\n')
        }
      }
    }

    const consume = (text: string): void => {
      lineBuffer += text
      let nl: number
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        applyLine(lineBuffer.slice(0, nl))
        lineBuffer = lineBuffer.slice(nl + 1)
      }
    }

    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_TIMEOUT_MS)
      finish({ ok: false, output: planText, timedOut: true })
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      const text = outDecoder.write(d)
      stdout += text
      consume(text)
    })
    child.stderr?.on('data', (d: Buffer) => { stderr += errDecoder.write(d) })
    child.on('error', (err) => finish({ ok: false, output: stdout, error: err.message }))
    child.on('close', (code) => {
      if (lineBuffer) applyLine(lineBuffer)
      if (code === 0) {
        // Prefer the parsed plan; fall back to raw stdout if parsing yielded nothing.
        const output = (claudeFinal ?? planText) || stdout
        finish({ ok: true, output })
      } else {
        // Some CLIs (e.g. Claude on an auth failure) print the real reason to
        // stdout, not stderr. Surface stdout as the error when stderr is empty so
        // the consultant card shows something actionable instead of "exit code N".
        finish({ ok: false, output: stdout, error: stderr.trim() || stdout.trim() || `exit code ${code}` })
      }
    })
  })

// Resolve the executable path from agent detection; falls back to the bare id.
function resolveExecutable(id: CouncilAgentId): string {
  const found = detectAgents().find((a) => a.id === id)
  return found?.path ?? id
}
