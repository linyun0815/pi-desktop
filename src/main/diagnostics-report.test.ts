import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyProviderKey,
  sanitizeProvidersError,
  summarizeProviders,
} from './diagnostics-report'
import type { ModelsConfig } from '../shared/ipc-contracts'

test('classifyProviderKey covers literal, env, shell, and missing keys', () => {
  const env = { OPENAI_KEY: 'sk-real', EMPTY_KEY: '' }
  assert.deepEqual(classifyProviderKey('sk-abc123', env), { keyState: 'literal' })
  assert.deepEqual(classifyProviderKey('$OPENAI_KEY', env), { keyState: 'env-set', envVar: 'OPENAI_KEY' })
  assert.deepEqual(classifyProviderKey('$MISSING_KEY', env), { keyState: 'env-missing', envVar: 'MISSING_KEY' })
  assert.deepEqual(classifyProviderKey('$EMPTY_KEY', env), { keyState: 'env-missing', envVar: 'EMPTY_KEY' })
  assert.deepEqual(classifyProviderKey('!op read secret', env), { keyState: 'shell' })
  assert.deepEqual(classifyProviderKey(undefined, env), { keyState: 'none' })
  assert.deepEqual(classifyProviderKey('   ', env), { keyState: 'none' })
  assert.deepEqual(classifyProviderKey(42, env), { keyState: 'none' })
})

test('summarizeProviders counts models and classifies each provider', () => {
  const config: ModelsConfig = {
    providers: {
      openai: { apiKey: '$OPENAI_KEY', models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] },
      local: { baseUrl: 'http://localhost:11434' },
    },
  }
  const rows = summarizeProviders(config, { OPENAI_KEY: 'x' })
  assert.deepEqual(rows, [
    { name: 'openai', modelCount: 2, keyState: 'env-set', envVar: 'OPENAI_KEY' },
    { name: 'local', modelCount: 0, keyState: 'none' },
  ])
})

test('summarizeProviders tolerates null and non-object provider entries', () => {
  const config = {
    providers: { broken: null, alsoBroken: 'oops', ok: { apiKey: 'sk-x' } },
  } as unknown as ModelsConfig
  assert.deepEqual(summarizeProviders(config, {}), [
    { name: 'broken', modelCount: 0, keyState: 'none' },
    { name: 'alsoBroken', modelCount: 0, keyState: 'none' },
    { name: 'ok', modelCount: 0, keyState: 'literal' },
  ])
})

test('sanitizeProvidersError withholds JSON.parse detail that can quote file content', () => {
  assert.equal(
    sanitizeProvidersError('models.json is not valid JSON: Unexpected token s, ..."apiKey": sk-live-ab"...'),
    'models.json is not valid JSON',
  )
  assert.equal(
    sanitizeProvidersError('models.json is not a valid models config (missing "providers")'),
    'models.json is not a valid models config (missing "providers")',
  )
  assert.equal(
    sanitizeProvidersError('Could not read models.json: EACCES: permission denied'),
    'Could not read models.json: EACCES: permission denied',
  )
})

