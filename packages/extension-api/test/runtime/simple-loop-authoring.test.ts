import { runInNewContext } from 'node:vm'
import type {
  DataRef,
  JsonValue,
  SimpleLoopCheckpoint,
  SimpleStepView,
  VersionedState,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { AuthorSchema, SimpleLoopDefinition } from '../../src/runtime/authoring.js'
import { runtimeAuthorSchemas } from '../../src/runtime/authoring-schemas.js'
import type { LoopReadPorts, Outcome } from '../../src/runtime/public-api.js'
import { createSimpleLoopEvaluator } from '../../src/runtime/simple-loop-authoring.js'

const time = '2026-10-03T00:00:00Z'
const digest = 'a'.repeat(64)
const signal = () => new AbortController().signal
function encode<T>(schema: AuthorSchema<T>, value: T): DataRef {
  const encoded = schema.encode(value)
  if (!encoded.ok) throw new Error(encoded.error.detailCode)
  return encoded.value
}
function view(): SimpleStepView {
  return {
    stepSeq: 0,
    observedAt: time,
    input: null,
    context: null,
    tools: { revision: 0, digest, tools: [] },
    previous: { kind: 'start' },
    signals: [],
    config: {},
  }
}
function checkpoint(): VersionedState {
  const current = view()
  const previous = encode(runtimeAuthorSchemas.SimpleObservation, current.previous)
  const logicalInput = encode(runtimeAuthorSchemas.SimpleLoopOutput, null)
  const data: SimpleLoopCheckpoint = {
    version: 1,
    stepSeq: 0,
    phase: 'opening',
    logicalInput,
    snapshot: 'fixed-snapshot',
    observedAt: time,
    signalHighWater: 0,
    sessionParameterRef: {
      authorityId: 'state',
      recordId: 'parameters',
      recordRevision: 0,
      schema: previous.schema,
      digest,
    },
    registrationDigest: digest,
    view: encode(runtimeAuthorSchemas.SimpleStepView, current),
    previous,
    decision: null,
    requestedDecision: null,
    committedDecision: null,
    pending: [],
    interactionId: null,
    wait: null,
    recovery: null,
    consumedBusinessSignals: [],
    references: [],
  }
  return {
    namespace: 'agh.sdk.simple-loop',
    codecVersion: '1',
    data: encode(runtimeAuthorSchemas.SimpleLoopCheckpoint, data),
    provenance: {
      sourceRefs: [],
      producer: { bindingId: 'loop', contract: 'agh.loop', logicalName: 'default', providerId: 'simple' },
      trustLabels: [],
    },
    createdAt: time,
    references: [],
  }
}
const inlineReader: Pick<LoopReadPorts, 'resolveData'> = {
  async resolveData(ref) {
    return ref.kind === 'inline' ? { ok: true, value: ref.value } : denied()
  },
}
function denied(): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'denied',
      detailCode: 'revoked',
      message: 'revoked',
      diagnosticId: 'test',
      retryAdvice: { kind: 'never' },
    },
  }
}

describe('SimpleLoop pure callback evaluation', () => {
  it('keeps previous and decision separate, freezes inputs, and preserves JSON false/null', () => {
    const definition: SimpleLoopDefinition = {
      id: 'simple',
      permissions: [],
      next(current, decision) {
        expect(current.previous).toEqual({ kind: 'start' })
        expect(decision).toEqual({ kind: 'none' })
        expect(Object.isFrozen(current.tools.tools)).toBe(true)
        return { kind: 'finish', output: false }
      },
    }
    const evaluator = createSimpleLoopEvaluator(definition)
    expect(evaluator.ask(view(), signal())).toEqual({ ok: true, value: null })
    expect(evaluator.next(view(), { kind: 'none' }, signal())).toEqual({
      ok: true,
      value: { kind: 'finish', output: false },
    })
    expect(
      createSimpleLoopEvaluator({ ...definition, next: () => ({ kind: 'finish', output: null }) }).next(
        view(),
        { kind: 'none' },
        signal(),
      ),
    ).toEqual({ ok: true, value: { kind: 'finish', output: null } })
  })

  it('validates the selected configuration and rejects a drifted view before calling the author', () => {
    let calls = 0
    const configured = { content: [{ type: 'text' as const, text: 'fixed' }] }
    const evaluator = createSimpleLoopEvaluator({
      id: 'configured',
      permissions: [],
      config: { schema: runtimeAuthorSchemas.StandardToolOutput, defaults: configured },
      next() {
        calls++
        return { kind: 'finish', output: null }
      },
    })
    expect(evaluator.next(view(), { kind: 'none' }, signal()).ok).toBe(false)
    expect(calls).toBe(0)
    expect(evaluator.next({ ...view(), config: configured }, { kind: 'none' }, signal()).ok).toBe(true)
    const original = structuredClone(configured)
    const content = configured.content[0]
    if (!content) throw new Error('content fixture required')
    content.text = 'changed after creation'
    expect(evaluator.next({ ...view(), config: original }, { kind: 'none' }, signal()).ok).toBe(true)
    expect(evaluator.next({ ...view(), config: configured }, { kind: 'none' }, signal()).ok).toBe(false)
    expect(() =>
      createSimpleLoopEvaluator(
        { id: 'empty', permissions: [], next: () => ({ kind: 'finish', output: null }) },
        { unexpected: true },
      ),
    ).toThrow()
  })

  it('refuses malformed, asynchronous, throwing and tool-enabled decision-model callbacks', async () => {
    const invalid = [
      undefined,
      { kind: 'tools', calls: [] },
      { kind: 'finish', output: () => 1 },
      Promise.resolve({ kind: 'finish', output: null }),
      Promise.reject(new Error('private error')),
      Object.create(Promise.prototype),
    ]
    for (const result of invalid) {
      const evaluator = createSimpleLoopEvaluator({
        id: 'invalid',
        permissions: [],
        next: (() => result) as SimpleLoopDefinition['next'],
      })
      expect(evaluator.next(view(), { kind: 'none' }, signal()).ok).toBe(false)
    }
    const throwing = createSimpleLoopEvaluator({
      id: 'throws',
      permissions: [],
      next() {
        throw new Error('secret')
      },
    })
    expect(JSON.stringify(throwing.next(view(), { kind: 'none' }, signal()))).not.toContain('secret')
    const asks = createSimpleLoopEvaluator({
      id: 'asks',
      permissions: [],
      ask: () => ({ toolNames: ['write'] }),
      next: () => ({ kind: 'finish', output: null }),
    })
    expect(asks.ask(view(), signal()).ok).toBe(false)
    for (const source of ['Promise.resolve(null)', 'Promise.reject(new Error("foreign rejection"))']) {
      const foreign = createSimpleLoopEvaluator({
        id: 'foreign',
        permissions: [],
        next: () => runInNewContext(source),
      })
      expect(foreign.next(view(), { kind: 'none' }, signal())).toMatchObject({
        ok: false,
        error: { detailCode: 'simple_loop_async_callback' },
      })
    }
    let thenReads = 0
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: deliberately hostile callback output must not be assimilated
      get then() {
        thenReads++
        throw new Error('must not execute thenable')
      },
    }
    const refusesThenable = createSimpleLoopEvaluator({
      id: 'thenable',
      permissions: [],
      next: (() => thenable) as unknown as SimpleLoopDefinition['next'],
    })
    expect(refusesThenable.next(view(), { kind: 'none' }, signal()).ok).toBe(false)
    expect(thenReads).toBe(0)
    await Promise.resolve()
  })

  it('honors cancellation before and after callback evaluation', () => {
    const controller = new AbortController()
    let calls = 0
    const evaluator = createSimpleLoopEvaluator({
      id: 'cancel',
      permissions: [],
      next() {
        calls++
        controller.abort()
        return { kind: 'finish', output: null }
      },
    })
    expect(evaluator.next(view(), { kind: 'none' }, controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(evaluator.next(view(), { kind: 'none' }, controller.signal).ok).toBe(false)
    expect(calls).toBe(1)
    const interrupted = new AbortController()
    const throwing = createSimpleLoopEvaluator({
      id: 'interrupted',
      permissions: [],
      next() {
        interrupted.abort()
        throw new Error('interrupted author')
      },
    })
    expect(throwing.next(view(), { kind: 'none' }, interrupted.signal)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})

describe('SimpleLoop checkpoint decoding', () => {
  const evaluator = createSimpleLoopEvaluator({
    id: 'reader',
    permissions: [],
    next: () => ({ kind: 'finish', output: null }),
  })

  it('decodes official checkpoint and typed refs through the current authorized reader', async () => {
    const state = checkpoint()
    const seen: DataRef[] = []
    const result = await evaluator.readCheckpoint(
      state,
      {
        async resolveData(ref) {
          seen.push(ref)
          return inlineReader.resolveData(ref)
        },
      },
      signal(),
    )
    expect(result).toMatchObject({
      ok: true,
      value: { phase: 'opening', stepSeq: 0, snapshot: 'fixed-snapshot' },
    })
    expect(seen).toContainEqual(state.data)
    expect(seen.length).toBeGreaterThan(1)
    expect(await evaluator.readCheckpoint(state, { resolveData: async () => denied() }, signal())).toEqual(
      denied(),
    )
    for (const invalid of [
      null,
      { ok: false, error: { secret: 'private value' } },
      { ok: true },
      { ok: 1, value: null },
    ]) {
      await expect(
        evaluator.readCheckpoint(
          state,
          {
            resolveData: async () => invalid as never,
          },
          signal(),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
  })

  it.each([
    'namespace',
    'codec',
    'schema',
    'digest',
    'bytes',
    'nested-schema',
    'schema-revision',
    'schema-digest',
    'view-step',
    'view-time',
    'view-input',
    'future-signal',
    'inline-value',
    'config',
  ])('rejects corrupted %s without treating it as a recovered decision', async (change) => {
    const state = structuredClone(checkpoint())
    if (state.data.kind !== 'inline') throw new Error('inline fixture required')
    const data = state.data.value as unknown as SimpleLoopCheckpoint
    if (change === 'namespace') state.namespace = 'other'
    if (change === 'codec') state.codecVersion = '2'
    if (change === 'schema') state.data.schema = runtimeAuthorSchemas.SimpleObservation.ref
    if (change === 'digest') state.data.digest = 'b'.repeat(64)
    if (change === 'bytes') state.data.bytes++
    if (change === 'nested-schema') data.previous.schema = runtimeAuthorSchemas.SimpleStepDecision.ref
    if (change === 'schema-revision') data.previous.schema.revision++
    if (change === 'schema-digest') data.previous.schema.digest = 'b'.repeat(64)
    if (['view-step', 'view-time', 'view-input', 'future-signal', 'config'].includes(change)) {
      const changed = {
        ...view(),
        ...(change === 'view-step' ? { stepSeq: 1 } : {}),
        ...(change === 'view-time' ? { observedAt: '2026-10-04T00:00:00Z' } : {}),
        ...(change === 'view-input' ? { input: 'new input' } : {}),
        ...(change === 'future-signal'
          ? { signals: [{ signalId: 'future', typeId: 'demo/signal@1', seq: 1, payload: null }] }
          : {}),
        ...(change === 'config' ? { config: { changed: true } } : {}),
      }
      data.view = encode(runtimeAuthorSchemas.SimpleStepView, changed)
    }
    if (change === 'inline-value' && data.logicalInput.kind === 'inline') data.logicalInput.value = 'tampered'
    if (
      [
        'nested-schema',
        'schema-revision',
        'schema-digest',
        'view-step',
        'view-time',
        'view-input',
        'future-signal',
        'inline-value',
        'config',
      ].includes(change)
    )
      state.data = encode(runtimeAuthorSchemas.SimpleLoopCheckpoint, data)
    const reader =
      change === 'inline-value'
        ? {
            async resolveData(ref: DataRef): Promise<Outcome<JsonValue>> {
              return ref.schema.typeId === runtimeAuthorSchemas.SimpleLoopOutput.ref.typeId
                ? { ok: true, value: null }
                : inlineReader.resolveData(ref)
            },
          }
        : inlineReader
    expect((await evaluator.readCheckpoint(state, reader, signal())).ok).toBe(false)
  })

  it('refuses invalid phase fields and cancellation while resolving a checkpoint', async () => {
    const state = checkpoint()
    if (state.data.kind !== 'inline') throw new Error('inline fixture required')
    const data = state.data.value as unknown as SimpleLoopCheckpoint
    expect(runtimeAuthorSchemas.SimpleLoopCheckpoint.parse({ ...data, phase: 'deciding' }).ok).toBe(false)
    const controller = new AbortController()
    const result = await evaluator.readCheckpoint(
      state,
      {
        async resolveData(ref): Promise<Outcome<JsonValue>> {
          controller.abort()
          return inlineReader.resolveData(ref)
        },
      },
      controller.signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const waitingController = new AbortController()
    let reads = 0
    const pending = evaluator.readCheckpoint(
      state,
      {
        resolveData() {
          reads++
          return new Promise(() => {})
        },
      },
      waitingController.signal,
    )
    waitingController.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(reads).toBe(1)
    const lateController = new AbortController()
    let rejectRead: ((reason: Error) => void) | undefined
    const late = evaluator.readCheckpoint(
      state,
      {
        resolveData() {
          return new Promise((_resolve, reject) => {
            rejectRead = reject
          })
        },
      },
      lateController.signal,
    )
    lateController.abort()
    await expect(late).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    rejectRead?.(new Error('late private failure'))
    await Promise.resolve()
  })

  it('decodes a retained blob and verifies every optional typed reference', async () => {
    const state = structuredClone(checkpoint())
    if (state.data.kind !== 'inline') throw new Error('inline fixture required')
    const data = state.data.value as unknown as SimpleLoopCheckpoint
    const decision = encode(runtimeAuthorSchemas.SimpleStepDecision, { kind: 'finish', output: null })
    const completed = {
      ...data,
      phase: 'settling' as const,
      requestedDecision: encode(runtimeAuthorSchemas.SimpleModelRequest, {}),
      decision: encode(runtimeAuthorSchemas.SimpleDecisionObservation, { kind: 'none' }),
      committedDecision: decision,
    }
    const encoded = encode(runtimeAuthorSchemas.SimpleLoopCheckpoint, completed)
    if (encoded.kind !== 'inline') throw new Error('inline fixture required')
    state.data = {
      kind: 'blob',
      schema: encoded.schema,
      blob: {
        authorityId: 'blob',
        blobId: 'checkpoint',
        digest: encoded.digest,
        bytes: encoded.bytes,
        mediaType: 'application/json',
        pinId: 'checkpoint-pin',
      },
    }
    const reads: Pick<LoopReadPorts, 'resolveData'> = {
      async resolveData(ref) {
        return ref.kind === 'blob' ? { ok: true, value: encoded.value } : inlineReader.resolveData(ref)
      },
    }
    expect((await evaluator.readCheckpoint(state, reads, signal())).ok).toBe(true)
    state.data.blob.digest = 'b'.repeat(64)
    expect((await evaluator.readCheckpoint(state, reads, signal())).ok).toBe(false)
    for (const field of ['requestedDecision', 'decision', 'committedDecision'] as const) {
      state.data = encode(runtimeAuthorSchemas.SimpleLoopCheckpoint, {
        ...completed,
        [field]: encode(runtimeAuthorSchemas.SimpleObservation, { kind: 'start' }),
      })
      expect((await evaluator.readCheckpoint(state, inlineReader, signal())).ok).toBe(false)
    }
    if (!data.view) throw new Error('view fixture required')
    const recovering = {
      ...data,
      phase: 'recovering' as const,
      recovery: { source: 'business' as const, view: data.view, decision: null },
    }
    state.data = encode(runtimeAuthorSchemas.SimpleLoopCheckpoint, recovering)
    expect((await evaluator.readCheckpoint(state, inlineReader, signal())).ok).toBe(true)
    state.data = encode(runtimeAuthorSchemas.SimpleLoopCheckpoint, {
      ...recovering,
      recovery: {
        ...recovering.recovery,
        view: encode(runtimeAuthorSchemas.SimpleStepView, {
          ...view(),
          tools: { ...view().tools, revision: 1 },
        }),
      },
    })
    expect((await evaluator.readCheckpoint(state, inlineReader, signal())).ok).toBe(false)
  })
})
