import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  type ActionFrame,
  canonicalJsonDigest,
  type EffectResult,
  type ReconcileResult,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModelSourceStoreConflict,
  ModelSourceStoreCorrupt,
  type ModelSourceStoreOptions,
  ModelSourceStoreRefused,
  openModelSourceStore,
} from '../../src/runtime/model/model-source-store.js'
import {
  actionContext,
  attemptRef,
  BODY_DIGEST,
  bigRef,
  frameFor,
  inlineRef,
  registryOf,
  requestRef,
  resultFor,
  SENTINEL,
  unknownResultFor,
  usageFor,
} from './model-source-store-fixture.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
})
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'model-source-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
type Extra = Partial<Omit<ModelSourceStoreOptions, 'path' | 'calls'>>
function open(frames: ActionFrame[], extra: Extra = {}, directory = scratch()) {
  const path = join(directory, 'model-source.sqlite')
  const calls = registryOf(...frames)
  const store = openModelSourceStore({ path, calls, ...extra })
  cleanup.push(() => {
    try {
      store.close()
    } catch {
      // Already closed by the test.
    }
  })
  return { store, path, calls, directory }
}
function raw<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    return run(db)
  } finally {
    db.close()
  }
}
const rowCount = (path: string) =>
  raw(path, (db) => Number(db.prepare('SELECT count(*) AS n FROM model_attempts').get()?.n))
const keyOf = (frame: ActionFrame) => ({
  runId: frame.runId,
  actionId: frame.actionId,
  attemptId: frame.attemptId,
})
const context = actionContext()
function resolved(answer: ReconcileResult) {
  if (answer.kind !== 'resolved') throw new Error(`expected resolved, got ${JSON.stringify(answer)}`)
  return answer
}
const reasonOf = (answer: ReconcileResult) => (answer.kind === 'unknown' ? answer.reason : answer.kind)

describe('model source store fixtures', () => {
  it('builds frames and results the official codecs accept', () => {
    const frame = frameFor('1')
    expect(validateRuntime('ActionFrame', frame).ok).toBe(true)
    expect(validateRuntime('EffectResult', resultFor(frame)).ok).toBe(true)
    expect(validateRuntime('EffectResult', unknownResultFor(frame)).ok).toBe(true)
  })
})

describe('save and lookup', () => {
  it('returns the original result after save, and again from a reopened connection', async () => {
    const frame = frameFor('1')
    const original = resultFor(frame)
    const { store, path, calls } = open([frame])
    await store.deployment.save(frame, original, BODY_DIGEST)
    const answer = resolved(await store.deployment.lookup(frame, [], context, null))
    expect(canonicalJsonDigest(answer.result as never)).toBe(canonicalJsonDigest(original as never))
    expect(answer.result.usage).toEqual(original.usage)
    expect(validateRuntime('ReconcileResult', answer).ok).toBe(true)
    store.close()
    const again = openModelSourceStore({ path, calls })
    cleanup.push(() => again.close())
    expect(await again.deployment.lookup(frame, [], context, null)).toEqual(answer)
  })

  it('answers a reconcile action that names the attempt through target, ignoring forged evidence', async () => {
    const frame = frameFor('1')
    const { store } = open([frame])
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    const reconcileFrame = frameFor('9', { method: 'reconcile', requestIdentity: null })
    const answer = await store.deployment.lookup(
      reconcileFrame,
      [inlineRef({ forged: true })],
      context,
      attemptRef(frame),
    )
    expect(resolved(answer).result).toEqual(resultFor(frame))
  })

  it('keeps the original facts when the same content is saved again', async () => {
    const frame = frameFor('1')
    let tick = 0
    const { store, path } = open([frame], { now: () => new Date(Date.UTC(2026, 9, 5, 10, 0, tick++)) })
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    const before = JSON.stringify(store.admin.read(keyOf(frame)))
    const savedAt = raw(path, (db) => db.prepare('SELECT saved_at FROM model_attempts').get()?.saved_at)
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    expect(JSON.stringify(store.admin.read(keyOf(frame)))).toBe(before)
    expect(rowCount(path)).toBe(1)
    expect(raw(path, (db) => db.prepare('SELECT saved_at FROM model_attempts').get()?.saved_at)).toBe(savedAt)
  })

  it.each([
    [
      'a different result',
      (frame: ActionFrame) => [resultFor(frame, { result: inlineRef({ changed: 1 }) }), BODY_DIGEST],
    ],
    ['different usage', (frame: ActionFrame) => [resultFor(frame, {}, 9), BODY_DIGEST]],
    ['a different body digest', (frame: ActionFrame) => [resultFor(frame), 'e'.repeat(64)]],
    ['no body digest', (frame: ActionFrame) => [resultFor(frame), null]],
  ] as const)('refuses to overwrite the saved result with %s', async (_name, change) => {
    const frame = frameFor('1')
    const original = resultFor(frame)
    const { store } = open([frame])
    await store.deployment.save(frame, original, BODY_DIGEST)
    const before = JSON.stringify(store.admin.read(keyOf(frame)))
    const [result, digest] = change(frame) as [EffectResult, string | null]
    await expect(store.deployment.save(frame, result, digest)).rejects.toBeInstanceOf(
      ModelSourceStoreConflict,
    )
    expect(JSON.stringify(store.admin.read(keyOf(frame)))).toBe(before)
    const answer = resolved(await store.deployment.lookup(frame, [], context, null))
    expect(canonicalJsonDigest(answer.result as never)).toBe(canonicalJsonDigest(original as never))
  })

  it('accepts a missing body digest and returns the result', async () => {
    const frame = frameFor('1')
    const { store } = open([frame])
    await store.deployment.save(frame, resultFor(frame), null)
    expect(store.admin.read(keyOf(frame))?.bodyDigest).toBeNull()
    expect((await store.deployment.lookup(frame, [], context, null)).kind).toBe('resolved')
  })

  it('does not let one external request live under two attempts', async () => {
    const first = frameFor('1')
    const second = frameFor('2', { requestIdentity: first.requestIdentity })
    const { store, path } = open([first, second])
    await store.deployment.save(first, resultFor(first), BODY_DIGEST)
    await expect(store.deployment.save(second, resultFor(second), BODY_DIGEST)).rejects.toBeInstanceOf(
      ModelSourceStoreConflict,
    )
    expect(rowCount(path)).toBe(1)
  })

  it('does not let two requests share a usage origin key', async () => {
    const digest = 'f'.repeat(64)
    const first = frameFor('3', {
      requestIdentity: { system: 'a:b', aghRequestId: 'c', idempotencyKey: null, requestDigest: digest },
    })
    const second = frameFor('4', {
      requestIdentity: { system: 'a', aghRequestId: 'b:c', idempotencyKey: null, requestDigest: digest },
    })
    const { store, path } = open([first, second])
    await store.deployment.save(first, resultFor(first), BODY_DIGEST)
    await expect(store.deployment.save(second, resultFor(second), BODY_DIGEST)).rejects.toBeInstanceOf(
      ModelSourceStoreConflict,
    )
    expect(rowCount(path)).toBe(1)
  })
})

describe('what save refuses', () => {
  const frame = frameFor('1')
  const request = requestRef(frame)
  const failedError = {
    code: 'internal' as const,
    detailCode: 'x',
    message: 'm',
    retryAdvice: { kind: 'never' as const },
    diagnosticId: 'd',
  }
  const blob = {
    kind: 'blob' as const,
    schema: inlineRef({}).schema,
    blob: {
      authorityId: 'a',
      blobId: 'b',
      digest: 'c'.repeat(64),
      bytes: 1,
      mediaType: 'text/plain',
      pinId: 'p',
    },
  }
  it.each([
    ['a failed outcome', resultFor(frame, { outcome: 'failed', error: failedError }), 'model_store_outcome'],
    [
      'a cancelled outcome',
      resultFor(frame, { outcome: 'cancelled', error: failedError }),
      'model_store_outcome',
    ],
    ['a blob result', resultFor(frame, { result: blob }), 'model_store_result'],
    [
      'an external request that is not the dispatched one',
      resultFor(frame, { externalRequests: [{ ...request, requestId: 'other' }] }),
      'model_store_request',
    ],
    ['no external request', resultFor(frame, { externalRequests: [] }), 'model_store_request'],
    ['no usage fact', resultFor(frame, { usage: [] }), 'model_store_usage'],
    [
      'two usage facts',
      resultFor(frame, { usage: [usageFor(frame), usageFor(frame, 1, { usageId: 'second' })] }),
      'model_store_usage',
    ],
    [
      'usage of another attempt',
      resultFor(frame, { usage: [usageFor(frame, 7, { attemptId: 'other' })] }),
      'model_store_usage',
    ],
    [
      'a usage origin that is not the request',
      resultFor(frame, { usage: [usageFor(frame, 7, { originKey: 'other:origin' })] }),
      'model_store_usage',
    ],
    [
      'a blob usage dimension',
      resultFor(frame, { usage: [usageFor(frame, 7, { dimensions: blob })] }),
      'model_store_usage',
    ],
    [
      'retention references',
      resultFor(frame, {
        references: [
          {
            kind: 'blob',
            authorityId: 'a',
            resourceId: 'r',
            version: '1',
            digest: 'c'.repeat(64),
            pinId: 'p',
          },
        ],
      }),
      'model_store_references',
    ],
    ['a result over the size cap', resultFor(frame, { result: bigRef(300000) }), 'model_store_oversize'],
  ] as const)('refuses %s', async (_name, result, detailCode) => {
    const { store, path } = open([frame])
    const error = await store.deployment.save(frame, result, BODY_DIGEST).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ModelSourceStoreRefused)
    expect((error as ModelSourceStoreRefused).detailCode).toBe(detailCode)
    expect(rowCount(path)).toBe(0)
  })

  it('refuses a result that is not an unknown_effect with the unknown_effect error', async () => {
    const { store } = open([frame])
    const result = { ...unknownResultFor(frame), error: failedError }
    await expect(store.deployment.save(frame, result, BODY_DIGEST)).rejects.toBeInstanceOf(
      ModelSourceStoreRefused,
    )
  })

  it.each([
    ['an attempt State never dispatched', frameFor('7'), undefined],
    [
      'a frame that reports another request identity than the dispatched one',
      frameFor('1', {
        requestIdentity: { ...(frame.requestIdentity as object), aghRequestId: 'forged' } as never,
      }),
      undefined,
    ],
    ['a frame with another input digest', frameFor('1', { inputDigest: 'e'.repeat(64) }), undefined],
    ['a frame for another binding', frameFor('1', { bindingId: 'other-adapter' }), undefined],
    ['a reconcile frame', frameFor('1', { method: 'reconcile' }), undefined],
    ['a frame without request identity', frameFor('1', { requestIdentity: null }), undefined],
    ['a body digest that is not a digest', frame, 'not-a-digest'],
  ] as const)('refuses %s', async (_name, candidate, digest) => {
    const { store, path } = open([frame])
    const result = candidate.requestIdentity === null ? resultFor(frame) : resultFor(candidate)
    await expect(store.deployment.save(candidate, result, digest ?? BODY_DIGEST)).rejects.toBeInstanceOf(
      ModelSourceStoreRefused,
    )
    expect(rowCount(path)).toBe(0)
  })
})

describe('lookup when nothing was saved', () => {
  it('answers unknown, never not_found, when no row exists, whatever evidence the caller brings', async () => {
    const frame = frameFor('1')
    const { store } = open([frame])
    const answer = await store.deployment.lookup(frame, [inlineRef({ forged: 'not found' })], context, null)
    expect(answer).toMatchObject({ kind: 'unknown', reason: 'model_not_recorded' })
    expect(validateRuntime('ReconcileResult', answer).ok).toBe(true)
    expect(store.admin.pending()).toEqual([])
  })

  it('answers unknown when another attempt already holds the same external request', async () => {
    const first = frameFor('1')
    const second = frameFor('2', { requestIdentity: first.requestIdentity })
    const { store } = open([first, second])
    await store.deployment.save(first, resultFor(first), BODY_DIGEST)
    expect(await store.deployment.lookup(second, [], context, null)).toMatchObject({
      kind: 'unknown',
      reason: 'model_request_sent_elsewhere',
    })
  })

  it('refuses to reopen a file with an unknown format', () => {
    const frame = frameFor('1')
    const { store, path, calls } = open([frame])
    store.close()
    raw(path, (db) => db.exec('PRAGMA user_version=2'))
    expect(() => openModelSourceStore({ path, calls })).toThrow('model_store_format')
  })
})

describe('lookup answers', () => {
  it('answers an unknown_effect result with unknown and keeps its usage readable for the reconciler', async () => {
    const frame = frameFor('1')
    const { store } = open([frame])
    await store.deployment.save(frame, unknownResultFor(frame), BODY_DIGEST)
    expect(await store.deployment.lookup(frame, [], context, null)).toMatchObject({
      kind: 'unknown',
      reason: 'model_stream_unknown',
    })
    const stored = store.admin.read(keyOf(frame))
    expect(stored?.result?.usage).toEqual(unknownResultFor(frame).usage)
    expect(stored?.result?.outcome).toBe('unknown_effect')
  })

  it('answers unknown when the resolved answer would not fit the adapter reconcile encoding', async () => {
    const frame = frameFor('1')
    const { store } = open([frame])
    await store.deployment.save(frame, resultFor(frame, { result: bigRef(70000) }), BODY_DIGEST)
    expect(await store.deployment.lookup(frame, [], context, null)).toMatchObject({
      kind: 'unknown',
      reason: 'model_result_oversize',
    })
    expect(store.admin.read(keyOf(frame))?.result?.outcome).toBe('succeeded')
  })

  it('does not reveal facts for an attempt State no longer lists', async () => {
    const frame = frameFor('1')
    const { store, calls } = open([frame])
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    calls.remove(frame.attemptId)
    expect(reasonOf(await store.deployment.lookup(frame, [], context, null))).toBe('model_call_unregistered')
  })

  it.each([
    [
      'a target for another run',
      (frame: ActionFrame) => [
        frame,
        { ...attemptRef(frame), run: { ...attemptRef(frame).run, runId: 'other' } },
      ],
    ],
    [
      'a target for another action',
      (frame: ActionFrame) => [frame, { ...attemptRef(frame), actionId: 'other' }],
    ],
    ['a frame for another binding', (frame: ActionFrame) => [{ ...frame, bindingId: 'other-adapter' }, null]],
    [
      'a frame with another input digest',
      (frame: ActionFrame) => [{ ...frame, inputDigest: 'e'.repeat(64) }, null],
    ],
    [
      'a frame with another request identity',
      (frame: ActionFrame) => [
        { ...frame, requestIdentity: { ...(frame.requestIdentity as object), aghRequestId: 'x' } },
        null,
      ],
    ],
    ['a reconcile frame without a target', (frame: ActionFrame) => [{ ...frame, method: 'reconcile' }, null]],
  ] as const)('answers unknown for %s', async (_name, change) => {
    const frame = frameFor('1')
    const { store } = open([frame])
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    const [candidate, target] = change(frame) as [ActionFrame, ReturnType<typeof attemptRef> | null]
    expect(reasonOf(await store.deployment.lookup(candidate, [], context, target))).toBe(
      'model_attempt_mismatch',
    )
  })

  it('answers unknown for a cancelled call and never throws once the store is closed', async () => {
    const frame = frameFor('1')
    const { store } = open([frame])
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    const aborted = new AbortController()
    aborted.abort()
    expect(reasonOf(await store.deployment.lookup(frame, [], actionContext(aborted.signal), null))).toBe(
      'model_lookup_cancelled',
    )
    store.close()
    expect(reasonOf(await store.deployment.lookup(frame, [], context, null))).toBe('model_store_unavailable')
  })
})

describe('torn and corrupted rows', () => {
  it.each([
    [
      'a changed result byte',
      'UPDATE model_attempts SET result=replace(result,\'"tokens":7\',\'"tokens":8\')',
      false,
    ],
    ['a changed column', "UPDATE model_attempts SET binding_id='other-adapter'", false],
    ['a result removed from a saved row', 'UPDATE model_attempts SET result=NULL', true],
    ['a result digest removed', 'UPDATE model_attempts SET result_digest=NULL', false],
  ] as const)('never returns %s as a result', async (_name, statement, listed) => {
    const frame = frameFor('1')
    const { store, path } = open([frame])
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    raw(path, (db) => db.exec(statement))
    expect(reasonOf(await store.deployment.lookup(frame, [], context, null))).toBe('model_store_corrupt')
    await expect(store.deployment.save(frame, resultFor(frame), BODY_DIGEST)).rejects.toBeInstanceOf(
      ModelSourceStoreCorrupt,
    )
    expect(() => store.admin.read(keyOf(frame))).toThrow(ModelSourceStoreCorrupt)
    expect(store.admin.pending().map((entry) => entry.kind)).toEqual(listed ? ['corrupt'] : [])
  })

  it('rolls the row back when the save transaction fails before it commits', async () => {
    const frame = frameFor('1')
    const { store, path } = open([frame], {
      beforeCommit: () => {
        throw new Error('stop before commit')
      },
    })
    await expect(store.deployment.save(frame, resultFor(frame), BODY_DIGEST)).rejects.toThrow(
      'stop before commit',
    )
    expect(rowCount(path)).toBe(0)
    expect(reasonOf(await store.deployment.lookup(frame, [], context, null))).toBe('model_not_recorded')
  })
})

describe('pending and storage hygiene', () => {
  it('lists nothing for healthy rows and every row whose result is gone, in key order', async () => {
    const frames = ['1', '2', '3'].map((n) => frameFor(n))
    const [first, second, third] = frames as [ActionFrame, ActionFrame, ActionFrame]
    const { store, path } = open(frames)
    for (const frame of frames) await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    expect(store.admin.pending()).toEqual([])
    raw(path, (db) =>
      db
        .prepare('UPDATE model_attempts SET result=NULL WHERE attempt_id IN (?, ?)')
        .run(first.attemptId, third.attemptId),
    )
    const expected = [first, third].map((frame) => canonicalJsonDigest(keyOf(frame) as never)).sort()
    expect(store.admin.pending()).toEqual(expected.map((attemptKey) => ({ kind: 'corrupt', attemptKey })))
    expect(store.admin.read(keyOf(second))?.result.outcome).toBe('succeeded')
  })

  it('keeps the frame input, request body and credentials out of the file', async () => {
    const frame = frameFor('1')
    const { store, path } = open([frame])
    await store.deployment.save(frame, resultFor(frame), BODY_DIGEST)
    store.close()
    const bytes = () =>
      [path, `${path}-wal`]
        .map((file) => {
          try {
            return readFileSync(file)
          } catch {
            return Buffer.alloc(0)
          }
        })
        .map((buffer) => buffer.toString('latin1'))
        .join('')
    expect(bytes()).not.toContain(SENTINEL)
    // Positive control: the scan would see the sentinel if it had been stored.
    raw(path, (db) => {
      db.exec('CREATE TABLE control(value TEXT)')
      db.prepare('INSERT INTO control(value) VALUES(?)').run(SENTINEL)
    })
    expect(bytes()).toContain(SENTINEL)
  })

  it.skipIf(process.platform === 'win32')('creates the file private to the owner', () => {
    const { path } = open([frameFor('1')])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('stays out of pricing, ledger, credential and egress modules', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/runtime/model/model-source-store.ts', import.meta.url)),
      'utf8',
    )
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '')
    expect(
      specifiers.filter((name) => /ledger|billing|pricing|credential|secret|egress|usage/i.test(name)),
    ).toEqual([])
  })
})
