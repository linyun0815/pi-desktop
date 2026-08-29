import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeModelCost,
  validateModelsConfig,
  mergeModelsConfig,
  normalizeModelsConfigForPi,
  withImageInput,
  type ModelsConfig,
} from './models-config'

test('empty config is valid', () => {
  assert.deepEqual(validateModelsConfig({ providers: {} }), [])
})

test('flags empty provider key', () => {
  const errs = validateModelsConfig({ providers: { '': { models: [{ id: 'a' }] } } })
  assert.ok(errs.some((e) => e.includes('提供商')))
})

test('flags model with empty id', () => {
  const errs = validateModelsConfig({ providers: { p: { models: [{ id: '' }] } } })
  assert.ok(errs.some((e) => e.toLowerCase().includes('id')))
})

test('flags duplicate model id within a provider', () => {
  const errs = validateModelsConfig({
    providers: { p: { models: [{ id: 'x' }, { id: 'x' }] } },
  })
  assert.ok(errs.some((e) => e.includes('重复')))
})

test('flags non-finite numeric field', () => {
  const errs = validateModelsConfig({
    providers: { p: { models: [{ id: 'x', contextWindow: Number.NaN }] } },
  })
  assert.ok(errs.some((e) => e.toLowerCase().includes('contextwindow')))
})

test('merge preserves unknown top-level, provider, and model fields', () => {
  const original: ModelsConfig = {
    $schema: 'https://x',
    providers: {
      p: {
        baseUrl: 'http://old',
        authHeader: true,
        compat: { supportsDeveloperRole: false },
        models: [{ id: 'm', thinkingLevelMap: { high: 'max' }, contextWindow: 1000 }],
      },
    },
  } as ModelsConfig
  const edited: ModelsConfig = {
    providers: { p: { baseUrl: 'http://new', models: [{ id: 'm', contextWindow: 2000 }] } },
  }
  const merged = mergeModelsConfig(original, edited)
  assert.equal((merged as Record<string, unknown>).$schema, 'https://x')
  assert.equal(merged.providers.p.baseUrl, 'http://new')
  assert.equal(merged.providers.p.authHeader, true)
  assert.deepEqual(merged.providers.p.compat, { supportsDeveloperRole: false })
  assert.equal(merged.providers.p.models![0].contextWindow, 2000)
  assert.deepEqual(merged.providers.p.models![0].thinkingLevelMap, { high: 'max' })
})

test('an editor-provided thinkingLevelMap replaces the original outright', () => {
  const original: ModelsConfig = {
    providers: {
      p: { models: [{ id: 'm', thinkingLevelMap: { off: 'none', high: 'max' } }] },
    },
  }
  const edited: ModelsConfig = {
    providers: {
      p: { models: [{ id: 'm', thinkingLevelMap: { low: 'low', xhigh: null } }] },
    },
  }
  const merged = mergeModelsConfig(original, edited)
  // Editor-owned: no stale keys (off/high) survive from the old map.
  assert.deepEqual(merged.providers.p.models![0].thinkingLevelMap, {
    low: 'low',
    xhigh: null,
  })
})

test('an empty editor map removes the optional thinkingLevelMap field', () => {
  const original: ModelsConfig = {
    providers: {
      p: { models: [{ id: 'm', thinkingLevelMap: { high: 'max' } }] },
    },
  }
  const edited: ModelsConfig = {
    providers: {
      p: { models: [{ id: 'm', thinkingLevelMap: {} }] },
    },
  }
  const merged = mergeModelsConfig(original, edited)
  assert.equal(merged.providers.p.models![0].thinkingLevelMap, undefined)
})

test('validateModelsConfig flags bad thinkingLevelMap shapes with location', () => {
  const errs = validateModelsConfig({
    providers: {
      p: {
        models: [{ id: 'm', thinkingLevelMap: { low: '', bogus: 'x', high: 3 } as never }],
      },
    },
  })
  assert.ok(errs.some((e) => e.includes('提供商“p”、模型“m”') && e.includes('low')))
  assert.ok(errs.some((e) => e.includes('未知级别“bogus”')))
  assert.ok(errs.some((e) => e.includes('high')))
})

test('a valid map with null and string values passes validation', () => {
  assert.deepEqual(
    validateModelsConfig({
      providers: {
        p: {
          models: [{ id: 'm', thinkingLevelMap: { off: 'none', xhigh: null, max: 'max' } }],
        },
      },
    }),
    [],
  )
})

test('merge adds new and drops removed providers/models', () => {
  const original: ModelsConfig = {
    providers: { keep: { models: [{ id: 'a' }, { id: 'gone' }] }, drop: {} },
  }
  const edited: ModelsConfig = {
    providers: { keep: { models: [{ id: 'a' }] }, fresh: { models: [{ id: 'b' }] } },
  }
  const merged = mergeModelsConfig(original, edited)
  assert.deepEqual(Object.keys(merged.providers).sort(), ['fresh', 'keep'])
  assert.deepEqual(merged.providers.keep.models!.map((m) => m.id), ['a'])
})

test('normalizes Ollama Cloud reasoning effort support for thinking models', () => {
  const normalized = normalizeModelsConfigForPi({
    providers: {
      'ollama-cloud': {
        baseUrl: 'https://ollama.com/v1',
        api: 'openai-completions',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
        },
        models: [
          {
            id: 'glm-5.2:cloud',
            reasoning: true,
          },
        ],
      },
    },
  })

  assert.equal(normalized.providers['ollama-cloud'].compat?.supportsReasoningEffort, true)
  assert.equal(normalized.providers['ollama-cloud'].compat?.supportsDeveloperRole, false)
  assert.equal(normalized.providers['ollama-cloud'].compat?.supportsUsageInStreaming, true)
})

test('withImageInput enables image while keeping text', () => {
  assert.deepEqual(withImageInput(['text'], true), ['text', 'image'])
})

test('withImageInput defaults missing input to text before enabling image', () => {
  assert.deepEqual(withImageInput(undefined, true), ['text', 'image'])
})

test('withImageInput is idempotent when image already present', () => {
  assert.deepEqual(withImageInput(['text', 'image'], true), ['text', 'image'])
})

test('withImageInput removes image but keeps text when disabled', () => {
  assert.deepEqual(withImageInput(['text', 'image'], false), ['text'])
})

test('withImageInput keeps text when disabling on a text-only model', () => {
  assert.deepEqual(withImageInput(['text'], false), ['text'])
})

test('withImageInput adds missing text for an image-only input', () => {
  assert.deepEqual(withImageInput(['image'], true), ['text', 'image'])
  assert.deepEqual(withImageInput(['image'], false), ['text'])
})

test('validateModelsConfig accepts full and partial costs, rejects invalid ones', () => {
  assert.deepEqual(
    validateModelsConfig({
      providers: { p: { models: [{ id: 'm', cost: { input: 1, output: 2 } as never }] } },
    }),
    [],
  )
  assert.deepEqual(
    validateModelsConfig({
      providers: {
        p: {
          models: [
            {
              id: 'm',
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                tiers: [{ inputTokensAbove: 200000, input: 2, output: 4 } as never],
              },
            },
          ],
        },
      },
    }),
    [],
  )
  const errs = validateModelsConfig({
    providers: {
      p: {
        models: [
          {
            id: 'm',
            cost: {
              input: -1,
              output: Number.NaN,
              cacheRead: 'x',
              tiers: 'nope',
            } as never,
          },
          {
            id: 'm2',
            cost: { tiers: [{ inputTokensAbove: -5 }] } as never,
          },
          { id: 'm3', cost: 'cheap' as never },
        ],
      },
    },
  })
  assert.ok(errs.some((e) => e.includes('cost.input')))
  assert.ok(errs.some((e) => e.includes('cost.output')))
  assert.ok(errs.some((e) => e.includes('cost.cacheRead')))
  assert.ok(errs.some((e) => e.includes('cost.tiers 必须是数组')))
  assert.ok(errs.some((e) => e.includes('tiers[0].inputTokensAbove')))
  assert.ok(errs.some((e) => e.includes('cost 必须是对象')))
})

test('merge keeps the original cost when the edit has none', () => {
  const original: ModelsConfig = {
    providers: { p: { models: [{ id: 'm', cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }] } },
  }
  const edited: ModelsConfig = { providers: { p: { models: [{ id: 'm', name: 'Renamed' }] } } }
  const merged = mergeModelsConfig(original, edited)
  assert.deepEqual(merged.providers.p.models![0].cost, {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 0,
  })
  assert.equal(merged.providers.p.models![0].name, 'Renamed')
})

test('merge replaces a non-empty cost and normalizes missing rates to zero', () => {
  const original: ModelsConfig = {
    providers: { p: { models: [{ id: 'm', cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }] } },
  }
  const edited: ModelsConfig = {
    providers: { p: { models: [{ id: 'm', cost: { input: 3, output: 4 } as never }] } },
  }
  const merged = mergeModelsConfig(original, edited)
  assert.deepEqual(merged.providers.p.models![0].cost, {
    input: 3,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

test('merge removes cost when the edited cost object is empty', () => {
  const original: ModelsConfig = {
    providers: { p: { models: [{ id: 'm', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] } },
  }
  const edited: ModelsConfig = {
    providers: { p: { models: [{ id: 'm', cost: {} as never }] } },
  }
  const merged = mergeModelsConfig(original, edited)
  assert.equal(merged.providers.p.models![0].cost, undefined)
})

test('merge preserves unknown per-model and cost fields', () => {
  const original = {
    providers: {
      p: {
        models: [
          {
            id: 'm',
            compat: { supportsUsageInStreaming: true },
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 1, input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 }], providerNote: 'keepme' },
          },
        ],
      },
    },
  } as never as ModelsConfig
  const edited: ModelsConfig = {
    providers: { p: { models: [{ id: 'm', cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } }] } },
  }
  const merged = mergeModelsConfig(original, edited)
  const model = merged.providers.p.models![0]
  assert.deepEqual(model.compat, { supportsUsageInStreaming: true })
  // Replacement layers the new base rates over the original cost: existing
  // tiers and unknown cost extras survive the edit.
  assert.deepEqual(model.cost, {
    input: 9,
    output: 9,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 1, input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 }],
    providerNote: 'keepme',
  })
})

test('normalizeModelCost fills missing rates with zero and keeps tiers', () => {
  assert.deepEqual(normalizeModelCost({ input: 1, output: 2 } as never), {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  })
  const withTiers = normalizeModelCost({
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 5, input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 }],
  })
  assert.equal(withTiers?.tiers?.length, 1)
  assert.equal(normalizeModelCost(null as never), null)
  assert.equal(normalizeModelCost([1] as never), null)
})
