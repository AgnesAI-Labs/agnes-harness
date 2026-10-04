import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { TypedEffectOperation } from '../../src/runtime/authoring.js'
import { createAuthorSchema } from '../../src/runtime/authoring-schema-core.js'
import type { CallContext, Outcome } from '../../src/runtime/public-api.js'
import {
  createToolAuthorEffects,
  validateToolAuthorEffectRoutes,
} from '../../src/runtime/tool-author-effects.js'
import { createRestrictedEffectsFixture } from '../../testkit/runtime/effects.js'

const refs = RuntimeMethodSchemaRefs['agh.files'].stat
const operation: TypedEffectOperation<Wire.FilesStatRequest, Wire.FileStat> = Object.freeze({
  contract: 'agh.files',
  logicalName: 'default',
  method: 'stat',
  input: createAuthorSchema(refs.input, (value) => validateRuntime('FilesStatRequest', value)),
  output: createAuthorSchema(refs.output, (value) => validateRuntime('FileStat', value)),
})
const route = {
  contract: 'agh.files',
  logicalName: 'default',
  method: 'stat',
  brokerOperation: 'bound-file-stat',
}
const declaration = { contract: route.contract, logicalName: route.logicalName, method: route.method }
const input: Wire.FilesStatRequest = {
  mountRef: {
    workspaceId: 'workspace',
    mountId: 'mount',
    revision: 1,
    lease: { authorityId: 'authority', leaseId: 'lease', epoch: 1, expiresAt: '2099-01-01T00:00:00.000Z' },
  },
  path: 'hello.txt',
}
const output: Wire.FileStat = { kind: 'file', bytes: 12, mtimeMs: 1, version: 1 }
function value<T>(result: Outcome<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
const outputRef = value(operation.output.encode(output))
const unknown: Wire.RuntimeError = {
  code: 'unknown_effect',
  detailCode: 'lost_response',
  message: 'Effect confirmation lost',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'fixture',
}
function setup(deadline = '2099-01-01T00:00:00.000Z') {
  const fixture = createRestrictedEffectsFixture()
  const abort = new AbortController()
  const callAbort = new AbortController()
  const context: CallContext = {
    principalRef: 'principal',
    bindingId: 'tool-binding',
    invocationId: 'invoke',
    deadline,
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal: callAbort.signal,
    scope: {
      kind: 'action',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
      runId: 'run',
      actionId: 'action',
    },
  }
  const window = createToolAuthorEffects([declaration], [route], fixture.ports, context, abort.signal)
  return { fixture, abort, context, window }
}

describe('opaque typed tool effect window', () => {
  it('encodes the declared official input, calls the explicit route and decodes its verified output', async () => {
    const { fixture, context, window, abort } = setup()
    fixture.allow({
      port: 'invoke',
      operation: route.brokerOperation,
      handle: async (request, actual) => {
        expect(request).toEqual({
          operation: route.brokerOperation,
          input: value(operation.input.encode(input)),
        })
        const { signal: _expected, ...expectedWire } = context
        const { signal: actualSignal, ...actualWire } = actual
        expect(actualWire).toEqual(expectedWire)
        abort.abort()
        expect(actualSignal.aborted).toBe(true)
        return { ok: true, value: outputRef }
      },
    })
    expect(await window.effects.invoke(operation, input)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(window.dispatched).toBe(true)
    expect(window.pending).toBe(0)
  })

  it('returns the typed value from the actual restricted port', async () => {
    const { fixture, window } = setup()
    fixture.allow({
      port: 'invoke',
      operation: route.brokerOperation,
      handle: async () => ({ ok: true, value: outputRef }),
    })
    expect(await window.effects.invoke(operation, input)).toEqual({ ok: true, value: output })
    expect(fixture.calls()).toEqual([{ port: 'invoke', operation: route.brokerOperation }])
  })

  it.each([
    'undeclared',
    'wrong-schema',
    'unbranded',
    'invalid-input',
    'closed',
    'cancelled',
    'deadline',
  ] as const)('refuses %s before any effect dispatch', async (condition) => {
    const { fixture, window, abort } = condition === 'deadline' ? setup('2000-01-01T00:00:00.000Z') : setup()
    let op = operation
    let arg = input
    if (condition === 'undeclared') op = { ...operation, logicalName: 'other' }
    if (condition === 'wrong-schema')
      op = {
        ...operation,
        output: createAuthorSchema({ ...refs.output, digest: 'a'.repeat(64) }, (value) =>
          validateRuntime('FileStat', value),
        ),
      }
    if (condition === 'unbranded') op = { ...operation, output: { ...operation.output } }
    if (condition === 'invalid-input')
      arg = { ...input, mountRef: undefined } as unknown as Wire.FilesStatRequest
    if (condition === 'closed') window.close()
    if (condition === 'cancelled') abort.abort()
    expect((await window.effects.invoke(op, arg)).ok).toBe(false)
    expect(fixture.calls()).toEqual([])
    expect(window.dispatched).toBe(false)
  })

  it.each(['digest', 'bytes', 'schema', 'value', 'blob'] as const)(
    'locks unknown confirmation for invalid %s output',
    async (condition) => {
      const { fixture, window } = setup()
      if (outputRef.kind !== 'inline') throw new Error('inline expected')
      let bad: Wire.DataRef = outputRef
      if (condition === 'digest') bad = { ...outputRef, digest: 'a'.repeat(64) }
      if (condition === 'bytes') bad = { ...outputRef, bytes: outputRef.bytes + 1 }
      if (condition === 'schema') bad = { ...outputRef, schema: refs.input }
      if (condition === 'value') bad = { ...outputRef, value: {} }
      if (condition === 'blob')
        bad = {
          kind: 'blob',
          schema: refs.output,
          blob: {
            authorityId: 'blob-authority',
            blobId: 'blob',
            digest: 'a'.repeat(64),
            bytes: 1,
            mediaType: 'application/json',
            pinId: 'pin',
          },
        }
      fixture.allow({
        port: 'invoke',
        operation: route.brokerOperation,
        handle: async () => ({ ok: true, value: bad }),
      })
      expect(await window.effects.invoke(operation, input)).toMatchObject({
        ok: false,
        error: { code: 'unknown_effect' },
      })
      expect(window.failure?.code).toBe('unknown_effect')
      expect((await window.effects.invoke(operation, input)).ok).toBe(false)
      expect(fixture.calls()).toHaveLength(1)
    },
  )

  it('retains pending work after close and absorbs its late rejection as unknown', async () => {
    const { fixture, window } = setup()
    let reject!: (error: Error) => void
    fixture.allow({
      port: 'invoke',
      operation: route.brokerOperation,
      handle: () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    })
    const result = window.effects.invoke(operation, input)
    window.close()
    expect(window.pending).toBe(1)
    let drained = false
    const wait = window.waitForPending().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect((await window.effects.invoke(operation, input)).ok).toBe(false)
    reject(new Error('private credentials must not leak'))
    expect(await result).toMatchObject({ ok: false, error: { code: 'unknown_effect' } })
    await wait
    expect(window.pending).toBe(0)
    expect(JSON.stringify(window.failure)).not.toContain('private credentials')
  })

  it.each(['unknown_effect', 'denied', 'cancelled'] as const)(
    'keeps the real broker %s error even if an author ignores the returned failure',
    async (code) => {
      const { fixture, window } = setup()
      const realError = { ...unknown, code }
      fixture.allow({
        port: 'invoke',
        operation: route.brokerOperation,
        handle: async () => ({ ok: false, error: realError }),
      })
      expect(await window.effects.invoke(operation, input)).toEqual({ ok: false, error: realError })
      expect(window.failure).toEqual(realError)
      realError.message = 'mutated after receipt'
      expect(window.failure?.message).toBe('Effect confirmation lost')
    },
  )

  it.each([
    ['agh.model', 'invoke'],
    ['agh.billing', 'record'],
    ['agh.loop', 'start'],
    ['agh.files', 'authorityExport'],
  ])('rejects %s/%s assembly instead of falling back to raw I/O', (contract, method) => {
    const denied = { ...declaration, contract, method }
    expect(() =>
      validateToolAuthorEffectRoutes([denied], [{ ...denied, brokerOperation: route.brokerOperation }]),
    ).toThrow('Invalid author declaration')
  })
  it('rejects missing and undeclared route mappings before execute', () => {
    expect(() => validateToolAuthorEffectRoutes([declaration], [])).toThrow('missing bound broker route')
    expect(() => validateToolAuthorEffectRoutes([], [route])).toThrow('invalid bound broker route')
  })
})
