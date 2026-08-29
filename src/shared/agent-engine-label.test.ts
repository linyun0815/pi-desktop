import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from './agent-engine-label'

/**
 * The desktop embeds exactly one agent runtime, so every surface that names
 * the agent — status bar, empty chat, permission prompts — reads this module
 * and gets the same constant. The old per-engine map is gone along with the
 * OMP runtime selection.
 */

test('the label is the embedded engine name', () => {
  assert.equal(agentEngineLabel('pi'), 'Pi')
  assert.equal(agentEngineLabel(undefined), 'Pi')
  assert.equal(agentEngineLabel(null), 'Pi')
})

test('the default label is a real engine name, not a placeholder', () => {
  // The permission extension renders this when it was told nothing.
  assert.equal(DEFAULT_AGENT_ENGINE_LABEL, 'Pi')
  assert.equal(agentEngineLabel(undefined), DEFAULT_AGENT_ENGINE_LABEL)
})
