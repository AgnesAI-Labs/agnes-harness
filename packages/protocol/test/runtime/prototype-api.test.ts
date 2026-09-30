import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RuntimeSchemas, validateRuntime } from '../../src/runtime/index.js'
import type { JsonSchemaDoc } from '../../tools/gen-core.js'
import { generateRuntimeArtifacts } from '../../tools/gen-runtime.js'

const schema = JSON.parse(
  readFileSync(new URL('../../schema/runtime/prototype.json', import.meta.url), 'utf8'),
) as JsonSchemaDoc

describe('runtime prototype schema API', () => {
  it('exports a validator for each definition from the same schema', () => {
    for (const name of Object.keys(schema.$defs ?? {})) expect(RuntimeSchemas).toHaveProperty(name)
    expect(validateRuntime('OwnerRef', { kind: 'run', id: 'run-1' }).ok).toBe(true)
    expect(validateRuntime('OwnerRef', { kind: 'unknown', id: 'run-1' }).ok).toBe(false)
    expect(validateRuntime('OwnerRef', { kind: 'run', id: 'run-1', extra: true }).ok).toBe(false)
  })

  it('keeps recursive JSON constraints at arbitrary nesting', () => {
    expect(validateRuntime('JsonValue', { nested: [{ value: [null, true, 42, 'valid'] }] }).ok).toBe(true)
    expect(validateRuntime('JsonValue', { nested: [{ value: undefined }] }).ok).toBe(false)
    expect(validateRuntime('JsonValue', { nested: Number.NaN }).ok).toBe(false)
  })

  it('rejects values that cannot cross the JSON wire boundary', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [new Date(), () => null, Number.NaN, Number.POSITIVE_INFINITY, cycle])
      expect(validateRuntime('JsonValue', value).ok).toBe(false)
    expect(validateRuntime('JsonValue', Object.create({ inherited: true })).ok).toBe(false)
  })

  it('rejects UInt53 negative zero through references while preserving JSON number semantics', () => {
    expect(validateRuntime('UInt53', 0).ok).toBe(true)
    expect(validateRuntime('UInt53', -0).ok).toBe(false)
    expect(validateRuntime('JsonValue', { value: -0 }).ok).toBe(true)
    const schemaRef = { typeId: 'agh.runtime/example@1', revision: -0, digest: 'a'.repeat(64) }
    expect(validateRuntime('SchemaRef', schemaRef).ok).toBe(false)
    expect(validateRuntime('SchemaRef', { ...schemaRef, revision: 0 }).ok).toBe(true)
    const signal = { kind: 'signals', typeIds: ['agh.runtime/signal@1'], afterSeq: -0 }
    expect(validateRuntime('WaitClause', signal).ok).toBe(false)
    expect(validateRuntime('WaitClause', { ...signal, afterSeq: 0 }).ok).toBe(true)
  })

  it('requires complete wire scopes and keeps AbortSignal in the Local API', () => {
    const wire = {
      principalRef: 'principal-1',
      scope: { kind: 'runtime', installationId: 'installation-1', runtimeId: 'runtime-1' },
      bindingId: 'binding-1',
      invocationId: 'invocation-1',
      deadline: '2026-09-30T12:00:00.000Z',
      traceRef: 'trace-1',
      authorizationRef: 'authorization-1',
    }
    expect(validateRuntime('CallContextWire', wire).ok).toBe(true)
    expect(validateRuntime('CallContextWire', { ...wire, signal: new AbortController().signal }).ok).toBe(
      false,
    )
    expect(
      validateRuntime('CallContextWire', {
        ...wire,
        scope: { kind: 'runtime', installationId: 'installation-1' },
      }).ok,
    ).toBe(false)
  })

  it('fails generation when metadata references unknown input or output definitions', () => {
    const broken = structuredClone(schema)
    broken['x-state-store-control'] = {
      open: { requestName: 'request', input: 'MissingInput', output: 'StateOpenResult' },
    }
    expect(() => generateRuntimeArtifacts(broken)).toThrow('unknown runtime method schema: open')
  })

  it('fails generation instead of discarding unsupported constraints', () => {
    const broken = structuredClone(schema)
    if (!broken.$defs) throw new Error('missing schema definitions')
    broken.$defs.Unsupported = { type: 'string', maxLenght: 8 }
    expect(() => generateRuntimeArtifacts(broken)).toThrow('maxLenght')
  })

  it('rejects unresolved nested references instead of generating incomplete wire types', () => {
    const broken = structuredClone(schema)
    if (!broken.$defs) throw new Error('missing schema definitions')
    broken.$defs.Unresolved = {
      type: 'array',
      items: { $ref: '#/$defs/MissingDefinition' },
    }
    expect(() => generateRuntimeArtifacts(broken)).toThrow('unknown runtime schema reference')
  })
})
