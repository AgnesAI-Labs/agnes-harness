import type { CallContext, Outcome, OwnerRef } from '@agnes/extension-api/runtime'
import { RuntimeSchemas, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'

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
