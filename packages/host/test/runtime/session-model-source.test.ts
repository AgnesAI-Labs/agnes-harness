import type { DefaultLoopInputs, DefaultLoopSource } from '@agnes/core'
import type { CallContext, LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import { describe, expect, it, vi } from 'vitest'
import { hostLoopCredentialSource } from '../../src/runtime/loop-credentials.js'
import { sessionParameterGuard } from '../../src/runtime/model/model-selection.js'
import {
  type SessionModelSourcePorts,
  sessionModelSelectionSource,
} from '../../src/runtime/model/session-model-source.js'
import {
  catalogOf,
  frameOf,
  gate,
  MODEL_A,
  MODEL_B,
  NEEDS,
  PAIR_A,
  PAIR_B,
  ParameterPointer,
  referenceOf,
  revision,
  routesFor,
} from './model-selection-fixture.js'

const reads = {} as LoopReadPorts
const good: Outcome<void> = { ok: true, value: undefined }

function baseSource(over: { tokenLimit?: number; onRead?: () => void; wait?: Promise<void> } = {}) {
  const seen = { reads: 0 }
  const source: DefaultLoopSource = {
    checkCurrent: async () => good,
    async readInputs(frame) {
      seen.reads += 1
      over.onRead?.()
      await over.wait
      const inputs = {
        snapshot: 'snapshot',
        inputDigest: 'd'.repeat(64),
        sessionParameterRef: frame.sessionParameters.reference,
        context: {
          sessionRef: { sessionId: 'session-1' },
          atRevision: frame.sessionParameters.value.revision,
          target: { modelRoute: 'placeholder', format: 'text', tokenLimit: over.tokenLimit ?? 1_000_000 },
          resourceRefs: [],
          purpose: 'loop',
          contributions: { runtimeContext: [] },
          hookResults: null,
        },
        routing: {
          purpose: 'loop',
          requiredFeatures: NEEDS,
          allowedRoutes: [{ routeId: 'placeholder', model: 'placeholder' }],
          catalogRevision: 1,
          budgetSnapshot: { kind: 'inline' },
          inputMeta: { kind: 'inline' },
        },
        tools: [],
        catalogPolicy: {},
        generation: { maxOutputTokens: 64, thinking: null },
        credentialRef: null,
      }
      return { ok: true, value: inputs as unknown as DefaultLoopInputs }
    },
  }
  return { source, seen }
}

function portsFor(over: Partial<SessionModelSourcePorts> = {}): SessionModelSourcePorts {
  return {
    catalog: { capture: () => catalogOf(MODEL_A, MODEL_B) },
    routes: routesFor(),
    parameters: { verify: async () => good },
    ...over,
  }
}
async function inputsOf(
  source: DefaultLoopSource,
  frame = frameOf(revision(1, { primary: PAIR_A })),
  stage: 'first-model' | 'second-model' = 'first-model',
) {
  const out = await source.readInputs(frame, stage, reads)
  if (!out.ok) throw new Error(`${out.error.code}/${out.error.detailCode}`)
  return out.value
}
const refusalOf = async (source: DefaultLoopSource, frame = frameOf(revision(1, { primary: PAIR_A }))) => {
  const out = await source.readInputs(frame, 'first-model', reads)
  return out.ok ? null : `${out.error.code}/${out.error.detailCode}`
}

describe('session model selection source', () => {
  it('overlays the selection of the frame revision onto the base inputs and nothing else', async () => {
    const { source } = baseSource({ tokenLimit: 1_000_000 })
    const frame = frameOf(revision(1, { primary: PAIR_A }, { primary: 'high' }))
    const inputs = await inputsOf(sessionModelSelectionSource(source, portsFor()), frame)
    expect(inputs.routing.allowedRoutes).toHaveLength(1)
    expect(inputs.routing.allowedRoutes[0]).toMatchObject({ routeId: 'route-1', model: 'model-a' })
    expect(inputs.routing.catalogRevision).toBe(7)
    expect(inputs.routing.requiredFeatures).toEqual(NEEDS)
    expect(inputs.generation).toEqual({ maxOutputTokens: 64, thinking: 'high' })
    expect(inputs.context.target).toEqual({ modelRoute: 'route-1', format: 'text', tokenLimit: 128000 })
    expect(inputs.sessionParameterRef).toEqual(frame.sessionParameters.reference)
    expect(inputs.snapshot).toBe('snapshot')
  })

  it('only tightens the context limit, never widens it', async () => {
    const { source } = baseSource({ tokenLimit: 1000 })
    const inputs = await inputsOf(sessionModelSelectionSource(source, portsFor()))
    expect(inputs.context.target.tokenLimit).toBe(1000)
  })

  it('selects by the frame of each call: a later frame carries the switch, in either stage', async () => {
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor())
    const first = await inputsOf(wrapped, frameOf(revision(1, { primary: PAIR_A })), 'first-model')
    const second = await inputsOf(wrapped, frameOf(revision(2, { primary: PAIR_B })), 'second-model')
    expect(first.routing.allowedRoutes[0]?.model).toBe('model-a')
    expect(second.routing.allowedRoutes[0]?.model).toBe('model-b')
  })

  it('gives the same answer for the same frame however often it is read', async () => {
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor())
    const frame = frameOf(revision(1, { primary: PAIR_A }))
    expect(await inputsOf(wrapped, frame)).toEqual(await inputsOf(wrapped, frame))
  })

  it('refuses when the base inputs name another parameter reference than the frame', async () => {
    const { source } = baseSource()
    const other = referenceOf(revision(9, { primary: PAIR_A }))
    const skewed: DefaultLoopSource = {
      checkCurrent: source.checkCurrent,
      async readInputs(frame, stage, ports) {
        const out = await source.readInputs(frame, stage, ports)
        return out.ok ? { ok: true, value: { ...out.value, sessionParameterRef: other } } : out
      },
    }
    expect(await refusalOf(sessionModelSelectionSource(skewed, portsFor()))).toBe(
      'conflict/model_selection_parameters',
    )
  })

  it('refuses a frame whose value is not the stored revision its reference names', async () => {
    const verify = vi.fn(
      async (): Promise<Outcome<void>> => ({
        ok: false,
        error: {
          code: 'conflict',
          detailCode: 'model_selection_parameters',
          message: 'x',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'x',
        },
      }),
    )
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor({ parameters: { verify } }))
    expect(await refusalOf(wrapped)).toBe('conflict/model_selection_parameters')
    expect(verify).toHaveBeenCalledOnce()
  })

  it('refuses a frame of another session than its revision', async () => {
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor())
    const frame = { ...frameOf(revision(1, { primary: PAIR_A })), sessionId: 'another' }
    expect(await refusalOf(wrapped, frame)).toBe('conflict/model_selection_parameters')
  })

  it('refuses a target that left the catalog and returns nothing from the base', async () => {
    const wrapped = sessionModelSelectionSource(
      baseSource().source,
      portsFor({ catalog: { capture: () => catalogOf(MODEL_B) } }),
    )
    expect(await refusalOf(wrapped)).toBe('denied/model_selection_route')
  })

  it('has no side effects: it reads the catalog once per call and touches nothing else', async () => {
    const capture = vi.fn(() => catalogOf(MODEL_A, MODEL_B))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor({ catalog: { capture } }))
    await inputsOf(wrapped)
    expect(capture).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('lets the credential wrapper pick its consumer from the newly selected route', async () => {
    const binding = {
      consumer: 'model' as const,
      secretId: 'secret-1',
      accountRef: null,
      serverRef: 'endpoint',
      audience: 'endpoint',
      purpose: 'model-inference',
    }
    const wrapped = sessionModelSelectionSource(
      baseSource().source,
      portsFor({ routes: routesFor(['route-1'], {}, binding) }),
    )
    const select = vi.fn(async (_route: { model: string }) => ({
      ok: true as const,
      value: { consumer: binding, context: {} as CallContext, accept: async () => good },
    }))
    const owner = {
      secrets: {
        resolve: async () => ({
          ok: true as const,
          value: {
            handleId: 'handle',
            secretId: 'secret-1',
            version: 'v1',
            audience: 'endpoint',
            expiresAt: '2999-01-01T00:00:00Z',
          },
        }),
      },
      select,
    }
    const composed = hostLoopCredentialSource(wrapped, owner as never)
    await inputsOf(composed, frameOf(revision(2, { primary: PAIR_B })))
    expect(select.mock.calls[0]?.[0]).toMatchObject({ routeId: 'route-1', model: 'model-b' })
  })
})

describe('selection and the commit boundary', () => {
  it('a switch committed while a stage is being read cannot reach that stage’s commit', async () => {
    const pointer = new ParameterPointer(revision(1, { primary: PAIR_A }))
    const paused = gate()
    const release = gate()
    const wrapped = sessionModelSelectionSource(
      baseSource({ onRead: paused.open, wait: release.opened }).source,
      portsFor(),
    )
    const frame1 = pointer.frame()
    const pending = wrapped.readInputs(frame1, 'first-model', reads)
    await paused.opened
    pointer.commit(revision(2, { primary: PAIR_B })) // the switch lands while the read is paused
    release.open()
    const first = await pending
    if (!first.ok) throw new Error(first.error.detailCode)
    // The read was fixed by its frame, so it still carries the old pair ...
    expect(first.value.routing.allowedRoutes[0]?.model).toBe('model-a')
    // ... and the commit of that invocation is refused, so no action carries it.
    expect(pointer.check([sessionParameterGuard(frame1).readGuard])).toMatchObject({
      ok: false,
      error: { code: 'conflict', detailCode: 'read_guard' },
    })
    // The re-planned invocation reads a new frame, gets the new pair, and its commit passes.
    const frame2 = pointer.frame()
    const second = await wrapped.readInputs(frame2, 'first-model', reads)
    if (!second.ok) throw new Error(second.error.detailCode)
    expect(second.value.routing.allowedRoutes[0]?.model).toBe('model-b')
    expect(pointer.check([sessionParameterGuard(frame2).readGuard]).ok).toBe(true)
  })

  it('an action committed before the switch keeps its target; only the next frame carries the switch', async () => {
    const pointer = new ParameterPointer(revision(1, { primary: PAIR_A }))
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor())
    const frame1 = pointer.frame()
    const first = await wrapped.readInputs(frame1, 'first-model', reads)
    if (!first.ok) throw new Error(first.error.detailCode)
    expect(pointer.check([sessionParameterGuard(frame1).readGuard]).ok).toBe(true) // the commit wins
    const action = {
      target: first.value.routing.allowedRoutes[0],
      parameterRef: frame1.sessionParameters.reference,
    }
    pointer.commit(revision(2, { primary: PAIR_B }))
    expect(action.target?.model).toBe('model-a')
    expect(action.parameterRef.recordRevision).toBe(2)
    const next = await wrapped.readInputs(pointer.frame(), 'second-model', reads)
    expect(next.ok && next.value.routing.allowedRoutes[0]?.model).toBe('model-b')
  })

  it('a pending next-run command does not move the frame, so the selection does not move', async () => {
    const pointer = new ParameterPointer(revision(1, { primary: PAIR_A }))
    const wrapped = sessionModelSelectionSource(baseSource().source, portsFor())
    const before = await wrapped.readInputs(pointer.frame(), 'first-model', reads)
    // An accepted next-run command is only recorded; no revision is committed for this run.
    const after = await wrapped.readInputs(pointer.frame(), 'second-model', reads)
    expect(before.ok && after.ok && before.value.routing.allowedRoutes).toEqual(
      after.ok ? after.value.routing.allowedRoutes : null,
    )
  })
})
