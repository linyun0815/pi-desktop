import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMBEDDED_AGENT_PROTOCOL_VERSION,
  parseAdminHelperToParent,
  parseHelperToParent,
  parseParentToAdminHelper,
  parseParentToHelper,
  toTransferable,
} from './embedded-agent-protocol'

/**
 * The utility-process wire carries these messages both ways; every message is
 * structurally validated at the boundary, and anything the SDK produced is
 * JSON-rounded into structured-clone-safe plain data before posting.
 */

const VALID_INIT = {
  kind: 'init',
  protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
  cwd: '/tmp/proj',
  agentDir: '/home/u/.pi/agent',
  projectTrusted: true,
  session: { kind: 'new' },
  tools: ['read', 'grep', 'find', 'ls'],
  permissionMode: 'plan-readonly',
}

test('a valid init message parses with defaults applied', () => {
  const parsed = parseParentToHelper(VALID_INIT)
  assert.ok(parsed)
  assert.equal(parsed.kind, 'init')
  if (parsed.kind === 'init') {
    assert.equal(parsed.projectTrusted, true)
    assert.deepEqual(parsed.tools, ['read', 'grep', 'find', 'ls'])
    assert.equal(parsed.permissionExtensionPath, null)
  }
})

test('a protocol-version mismatch rejects init', () => {
  const parsed = parseParentToHelper({ ...VALID_INIT, protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION + 1 })
  assert.equal(parsed, null)
})

test('malformed init variants are rejected', () => {
  assert.equal(parseParentToHelper({ ...VALID_INIT, cwd: 42 }), null)
  assert.equal(parseParentToHelper({ ...VALID_INIT, session: { kind: 'open' } }), null)
  assert.equal(parseParentToHelper({ ...VALID_INIT, session: { kind: 'open', sessionPath: '/x.jsonl' } }) !== null, true)
  assert.equal(parseParentToHelper({ ...VALID_INIT, thinkingLevel: 'bogus' }), null)
  assert.equal(parseParentToHelper({ ...VALID_INIT, thinkingLevel: 'high' }) !== null, true)
  assert.equal(parseParentToHelper({ ...VALID_INIT, tools: 'read' }), null)
})

test('correlated commands carry their ids through', () => {
  const prompt = parseParentToHelper({ kind: 'prompt', id: 'req-1', message: 'hi', images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] })
  assert.ok(prompt)
  if (prompt.kind === 'prompt') {
    assert.equal(prompt.id, 'req-1')
    assert.equal(prompt.images?.length, 1)
  }

  assert.equal(parseParentToHelper({ kind: 'prompt', id: 'req-1', message: 5 }), null)
  assert.equal(parseParentToHelper({ kind: 'prompt', message: 'hi' }), null)

  const model = parseParentToHelper({ kind: 'setModel', id: 'r2', provider: 'anthropic', modelId: 'claude' })
  assert.ok(model && model.kind === 'setModel')
  assert.equal(parseParentToHelper({ kind: 'setModel', id: 'r2', provider: 'anthropic' }), null)
})

test('an unknown kind is rejected', () => {
  assert.equal(parseParentToHelper({ kind: 'teleport', id: 'x' }), null)
  assert.equal(parseParentToHelper(null), null)
  assert.equal(parseParentToHelper('prompt'), null)
})

test('helper events and ui requests round-trip', () => {
  const event = parseHelperToParent({ kind: 'event', event: { type: 'agent_start' } })
  assert.ok(event && event.kind === 'event')

  // An event without a type is not a renderer event.
  assert.equal(parseHelperToParent({ kind: 'event', event: { payload: true } }), null)

  const ui = parseHelperToParent({ kind: 'uiRequest', request: { id: 'u1', method: 'confirm', title: 'Allow?' } })
  assert.ok(ui && ui.kind === 'uiRequest')
  // Missing request id is rejected — the router correlates on it.
  assert.equal(parseHelperToParent({ kind: 'uiRequest', request: { method: 'confirm' } }), null)
})

test('sessionBound tolerates absent fields as null', () => {
  const bound = parseHelperToParent({ kind: 'sessionBound' })
  assert.deepEqual(bound, { kind: 'sessionBound', sessionFile: null, sessionId: null, sessionName: null })
})

test('admin messages parse in both directions', () => {
  const init = parseParentToAdminHelper({
    kind: 'admin-init',
    protocolVersion: EMBEDDED_AGENT_PROTOCOL_VERSION,
    agentDir: '/u/.pi/agent',
    cwd: '/tmp',
  })
  assert.ok(init && init.kind === 'admin-init')

  const login = parseParentToAdminHelper({ kind: 'adminLogin', id: 'a1', loginId: 'l1', providerId: 'anthropic' })
  assert.ok(login && login.kind === 'adminLogin')

  const answer = parseParentToAdminHelper({ kind: 'adminPromptAnswer', id: 'a2', loginId: 'l1', value: 'sk-test' })
  assert.ok(answer && answer.kind === 'adminPromptAnswer')

  const prompt = parseAdminHelperToParent({ kind: 'authPrompt', loginId: 'l1', prompt: { type: 'secret', message: 'API key' } })
  assert.ok(prompt && prompt.kind === 'authPrompt')

  assert.equal(parseParentToAdminHelper({ kind: 'adminLogin', id: 'a1', loginId: 'l1' }), null)
  assert.equal(parseAdminHelperToParent({ kind: 'authPrompt', prompt: { type: 'secret' } }), null)
})

test('toTransferable JSON-rounds class-shaped values and rejects cycles', () => {
  class Box {
    value = 3
    hidden = (): number => 1
  }
  const plain = toTransferable({ box: new Box(), when: new Date(0) })
  assert.ok(plain)
  assert.deepEqual((plain as { box: { value: number } }).box, { value: 3 })
  // Dates serialize like the old JSONL pipe did.
  assert.equal(typeof (plain as { when: unknown }).when, 'string')

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(toTransferable(cyclic), null)
})
