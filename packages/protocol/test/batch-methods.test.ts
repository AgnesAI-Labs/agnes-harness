import { describe, expect, it } from 'vitest'
import { BATCH_ITEM_SESSION_PATTERN, METHODS, validateMethod } from '../src/index.js'

const spec = {
  dir: 'images',
  prompt: 'Count the insects in {{name}}',
  schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  concurrency: 4,
  maxEdge: 1024,
  budgetCredits: 10,
}
const status = {
  batchId: 'b0123456789ab',
  status: 'running',
  dir: 'images',
  outDir: 'agh-batch/b0123456789ab',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  counts: { total: 3, pending: 1, running: 1, done: 1, invalid: 0, failed: 0, skipped: 0, cancelled: 0 },
  spentCredits: 0.5,
}

describe('batch methods', () => {
  it('are client requests', () => {
    for (const method of [
      '_agnes/v1/batch.start',
      '_agnes/v1/batch.status',
      '_agnes/v1/batch.cancel',
      '_agnes/v1/batch.list',
    ] as const)
      expect(METHODS[method]).toMatchObject({ kind: 'request', direction: 'c2s' })
  })

  it('accepts a start request and refuses options out of range', () => {
    expect(validateMethod('_agnes/v1/batch.start', 'params', { cwd: '/w', spec }).ok).toBe(true)
    for (const bad of [
      { concurrency: 9 },
      { maxEdge: 2048 },
      { budgetCredits: 0 },
      { extra: 1 },
      { ext: ['JPG'] },
    ])
      expect(
        validateMethod('_agnes/v1/batch.start', 'params', { cwd: '/w', spec: { ...spec, ...bad } }).ok,
      ).toBe(false)
  })

  it('accepts a status result and refuses a malformed id', () => {
    expect(validateMethod('_agnes/v1/batch.status', 'result', status).ok).toBe(true)
    expect(validateMethod('_agnes/v1/batch.status', 'result', { ...status, extra: true }).ok).toBe(false)
    expect(validateMethod('_agnes/v1/batch.status', 'params', { batchId: 'nope' }).ok).toBe(false)
    expect(validateMethod('_agnes/v1/batch.list', 'result', { items: [status] }).ok).toBe(true)
  })

  it('recognises item session keys only', () => {
    expect(BATCH_ITEM_SESSION_PATTERN.test('agnes:local:default:batch:b0123456789ab:12')).toBe(true)
    expect(BATCH_ITEM_SESSION_PATTERN.test('agnes:local:default:cli:workspace:0123456789abcdef')).toBe(false)
    expect(BATCH_ITEM_SESSION_PATTERN.test('agnes:local:default:batch:b0123456789ab:12:sub')).toBe(false)
  })
})
