import type {
  ArtifactClient,
  RendererHandle,
  RendererPresentation,
  WebRendererDefinition,
} from '@agnes/extension-api/client'
import type {
  CallContext,
  LoopProvider,
  Outcome,
  OwnerRef,
  ProviderFactory,
  ProviderLifecycle,
  StateStoreControl,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import type { DataRef, LoopTransition, RunFrame } from '@agnes/protocol/runtime'
import { RuntimeSchemas, validateRuntime } from '@agnes/protocol/runtime'
import { expect, expectTypeOf, it } from 'vitest'

it('imports public runtime subpaths and shares their wire types and validation', () => {
  const owner: OwnerRef = { kind: 'run', id: 'run-1' }
  const outcome: Outcome<OwnerRef> = { ok: true, value: owner }
  const context: CallContext = {
    principalRef: 'principal-1',
    scope: { kind: 'runtime', installationId: 'installation-1', runtimeId: 'runtime-1' },
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-09-30T12:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'authorization-1',
    signal: new AbortController().signal,
  }
  expect(RuntimeSchemas.OwnerRef).toBeDefined()
  expect(validateRuntime('OwnerRef', outcome.value)).toEqual({ ok: true, value: owner })
  const { signal, ...wire } = context
  expect(signal.aborted).toBe(false)
  expect(validateRuntime('CallContextWire', wire).ok).toBe(true)
  expect(validateRuntime('CallContextWire', context).ok).toBe(false)
})

it('exposes complete Local provider, authority and client contracts through package exports', () => {
  expectTypeOf<LoopProvider>().toExtend<ProviderLifecycle>()
  expectTypeOf<ProviderFactory<LoopProvider>['create']>().returns.toEqualTypeOf<Promise<LoopProvider>>()
  expectTypeOf<Parameters<LoopProvider['start']>[0]>().toEqualTypeOf<RunFrame>()
  expectTypeOf<ReturnType<LoopProvider['start']>>().toEqualTypeOf<Promise<LoopTransition>>()
  expectTypeOf<StateStoreControl>().toHaveProperty('importConversation')
  expectTypeOf<StateStoreControl>().toHaveProperty('probeMigration')
  expectTypeOf<TrustedIngressContext['transportEvidence']>().toEqualTypeOf<DataRef>()
  expectTypeOf<ReturnType<RendererHandle['present']>>().toEqualTypeOf<Outcome<RendererPresentation>>()
  expectTypeOf<WebRendererDefinition<{ message: string }>>().toHaveProperty('component')
  expectTypeOf<ArtifactClient>().toHaveProperty('readRange')
  expectTypeOf<ArtifactClient>().toHaveProperty('openStream')
})
