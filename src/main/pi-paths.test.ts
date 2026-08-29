import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import {
  getPiAgentDir,
  getSessionsRoot,
  getSessionRoots,
  isWithinSessionRoots,
} from './pi-paths'

/**
 * The embedded runtime uses only Pi's own session store (`~/.pi/agent/sessions`,
 * or PI_CODING_AGENT_DIR). Legacy OMP trees stay on disk untouched but are
 * neither listed nor authorized — resuming or deleting out of them is refused
 * exactly like any path outside the store.
 */

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('the agent directory honors PI_CODING_AGENT_DIR', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: '/custom/pi' }, () => {
    assert.equal(getPiAgentDir(), '/custom/pi')
    assert.equal(getSessionsRoot(), join('/custom/pi', 'sessions'))
    assert.deepEqual(getSessionRoots(), [join('/custom/pi', 'sessions')])
  })
})

test('the default store lives under ~/.pi/agent', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(getSessionsRoot(), join('/home/tester', '.pi', 'agent', 'sessions'))
    assert.deepEqual(getSessionRoots(), [getSessionsRoot()])
  })
})

test('a session inside the store is authorized', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(isWithinSessionRoots(join(getSessionsRoot(), '--home-tester--', 'a.jsonl')), true)
    // Nested subagent transcripts share the parent's authorization.
    assert.equal(isWithinSessionRoots(join(getSessionsRoot(), '--p--', 'run', 'c.jsonl')), true)
  })
})

test('a path outside the store is refused', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(isWithinSessionRoots('/etc/passwd'), false)
    assert.equal(isWithinSessionRoots(join('/home/tester', '.pi', 'agent', 'auth.json')), false)
    // A sibling directory whose name merely starts with the root must not pass.
    assert.equal(isWithinSessionRoots(join('/home/tester', '.pi', 'agent', 'sessions-backup', 'x.jsonl')), false)
    // A legacy OMP session is NOT authorized: the embedded runtime never
    // opens or migrates the old tree, whatever still sits on disk.
    assert.equal(isWithinSessionRoots(join('/home/tester', '.omp', 'agent', 'sessions', '--p--', 'b.jsonl')), false)
  })
})
