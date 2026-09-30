import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type { ProviderDescriptor } from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  adaptProvider,
  canonicalJsonDigest,
  defineInterceptor,
  defineRoutingStrategy,
  defineRuntimePlugin,
  defineSimpleLoop,
  defineTool,
  runtimeAuthorSchemas,
  standardHookCapabilities,
} from '../../src/runtime/authoring.js'

describe('runtime author declarations', () => {
  it('preserves numeric validation before canonicalizing metadata', () => {
    const reference = { ...runtimeAuthorSchemas.StandardToolOutput.ref, revision: -0 }
    expect(() =>
      defineRuntimePlugin({ id: '@demo/metadata', version: '1.0.0', schemas: [reference] }),
    ).toThrow(/schema reference/)
    expect(() =>
      adaptProvider({
        id: 'loop',
        contract: 'agh.loop',
        requires: [],
        permissions: [],
        stateCodecs: [{ namespace: 'demo/loop', codecVersion: '1', schema: reference }],
        make() {
          throw new Error('not called')
        },
      }),
    ).toThrow(/state codec/)
    expect(runtimeAuthorSchemas.StandardToolOutput.parse({ content: [], structured: { value: -0 } }).ok).toBe(
      true,
    )
  })

  it('refuses nested metadata accessors without evaluating them', () => {
    let reads = 0
    const capability = { capability: 'demo.read', resourceTypes: [], operations: [] }
    Object.defineProperty(capability, 'operations', {
      enumerable: true,
      get() {
        reads++
        return []
      },
    })
    expect(() =>
      defineSimpleLoop({
        id: 'safe',
        permissions: [capability],
        next: () => ({ kind: 'finish', output: null }),
      }),
    ).toThrow()
    const text = { type: 'text' as const, text: 'safe' }
    Object.defineProperty(text, 'text', {
      enumerable: true,
      get() {
        reads++
        return 'unsafe'
      },
    })
    expect(runtimeAuthorSchemas.StandardToolOutput.parse({ content: [text] }).ok).toBe(false)
    expect(reads).toBe(0)
  })

  it('copies and freezes advanced author metadata instead of retaining mutable input', () => {
    const author = { entries: { runtime: './src/plugin.ts' } }
    const declared = defineRuntimePlugin({ id: '@demo/metadata', version: '1.0.0', author })
    author.entries.runtime = './src/changed.ts'
    expect(declared.author?.entries?.runtime).toBe('./src/plugin.ts')
    expect(Object.isFrozen(declared.author?.entries)).toBe(true)
    expect(() =>
      defineRuntimePlugin({
        id: '@demo/metadata',
        version: '1.0.0',
        author: { unauthorized: true } as unknown as typeof author,
      }),
    ).toThrow(/author metadata/)
  })

  it('isolates complete factory metadata while retaining its create function without calling it', () => {
    let creates = 0
    const schemas = RuntimeMethodSchemaRefs['agh.pricing'].quote
    const descriptor: ProviderDescriptor = {
      providerId: 'pricing',
      contract: 'agh.pricing',
      major: 1,
      logicalName: 'default',
      packageVersion: '1.0.0',
      packageDigest: 'a'.repeat(64),
      features: [],
      scope: 'workspace',
      configSchema: { ...runtimeAuthorSchemas.StandardToolOutput.ref },
      requires: [],
      capabilities: [],
      recovery: 'R1',
      isolation: ['trusted-in-process'],
      stateCodecs: [],
      activationMode: 'lazy',
      operations: [
        {
          method: 'quote',
          kind: 'compute',
          inputSchema: schemas.input,
          outputSchema: schemas.output,
          requiredCapabilities: [],
          retrySafety: 'read-only',
        },
      ],
    }
    const create = async () => {
      creates++
      throw new Error('not called during declaration')
    }
    const plugin = defineRuntimePlugin({
      id: '@demo/pricing',
      version: '1.0.0',
      providers: [{ descriptor, create }],
    })
    const factory = plugin.providers?.[0]
    if (!factory || !('descriptor' in factory)) throw new Error('complete factory expected')
    descriptor.packageVersion = '2.0.0'
    descriptor.configSchema.digest = 'b'.repeat(64)
    expect(factory.descriptor.packageVersion).toBe('1.0.0')
    expect(factory.descriptor.configSchema.digest).toBe(runtimeAuthorSchemas.StandardToolOutput.ref.digest)
    expect(Object.isFrozen(factory.descriptor.configSchema)).toBe(true)
    expect(factory.create).toBe(create)
    expect(creates).toBe(0)
  })

  it('creates branded provider declarations without invoking factories or decisions', () => {
    let decisions = 0
    let factories = 0
    const loop = defineSimpleLoop({
      id: 'simple',
      permissions: [],
      next() {
        decisions++
        return { kind: 'finish', output: null }
      },
    })
    const pricing = adaptProvider({
      id: 'pricing',
      contract: 'agh.pricing',
      requires: [],
      permissions: [],
      make() {
        factories++
        return {
          quote(input) {
            return {
              quoteId: 'quote',
              priceVersion: input.priceVersion,
              inputDigest: canonicalJsonDigest(input),
              lineItems: [],
              amount: { currency: input.currency, scale: 6, units: '0' },
              rounding: 'half-even',
            }
          },
        }
      },
    })
    const plugin = defineRuntimePlugin({
      id: '@demo/decisions',
      version: '1.0.0',
      providers: [loop, pricing],
    })
    expect(plugin.providers).toEqual([loop, pricing])
    expect(loop.kind).toBe('simple-loop')
    expect(pricing.kind).toBe('algorithm')
    expect(loop).not.toHaveProperty('descriptor')
    expect(loop).not.toHaveProperty('create')
    expect(Object.isFrozen(loop.definition)).toBe(true)
    expect(decisions).toBe(0)
    expect(factories).toBe(0)
    expect(() =>
      defineRuntimePlugin({ id: '@demo/decisions', version: '1.0.0', providers: [{ ...loop }] }),
    ).toThrow(/SDK constructor/)
    expect(() =>
      defineRuntimePlugin({ id: '@demo/decisions', version: '1.0.0', providers: [loop, loop] }),
    ).toThrow(/duplicate/)
  })

  it('rejects asynchronous simple decisions and unsupported algorithm contracts', () => {
    const next = () => ({ kind: 'finish' as const, output: null })
    expect(() =>
      defineSimpleLoop({
        id: 'simple',
        permissions: [],
        next: (async () => next()) as unknown as typeof next,
      }),
    ).toThrow(/synchronous/)
    expect(() =>
      defineSimpleLoop({
        id: 'simple',
        permissions: [],
        next,
        ask: (async () => null) as unknown as () => null,
      }),
    ).toThrow(/synchronous/)
    expect(() =>
      adaptProvider({
        id: 'unsupported',
        contract: 'agh.billing' as 'agh.pricing',
        requires: [],
        permissions: [],
        make() {
          throw new Error('not invoked')
        },
      }),
    ).toThrow(/complete algorithm/)
  })

  it('uses registered codecs for canonical data references and refuses forged schemas', () => {
    const codec = runtimeAuthorSchemas.StandardToolOutput
    const value = { content: [{ type: 'text' as const, text: 'hello' }] }
    const encoded = codec.encode(value)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok || encoded.value.kind !== 'inline') throw new Error('inline codec result expected')
    expect(encoded.value.schema).toEqual(codec.ref)
    expect(encoded.value.digest).toBe(canonicalJsonDigest(value))
    expect(encoded.value.bytes).toBe(new TextEncoder().encode(jcs(value)).byteLength)
    expect(codec.parse({ ...value, permission: 'all' }).ok).toBe(false)
    let executions = 0
    const execute = () => {
      executions++
      return value
    }
    const declared = defineTool({
      id: 'text',
      description: 'Return supplied text',
      execution: 'pure',
      input: codec,
      execute,
    })
    expect(declared.execute).toBe(execute)
    expect(executions).toBe(0)
    expect(() =>
      defineTool({ id: 'fake', description: 'Forged', execution: 'pure', input: { ...codec }, execute }),
    ).toThrow(/generated schema/)
    expect(() =>
      defineTool({
        id: 'fake',
        description: 'Forged',
        execution: 'pure',
        input: codec,
        execute,
        effects: [],
      } as typeof declared),
    ).toThrow(/unknown/)
  })

  it('normalizes interception defaults and preserves stronger failure policies', () => {
    let executions = 0
    const declared = defineInterceptor({
      id: 'redact',
      event: 'tool_result',
      execution: 'pure',
      readFields: ['/result'],
      writeFields: ['/result/content'],
      permissions: [standardHookCapabilities.rawToolResult, standardHookCapabilities.toolResultDisplay],
      failPolicy: 'closed',
      handle() {
        executions++
        return {}
      },
    })
    expect(declared.failPolicy).toBe('closed')
    expect(declared.mandatory).toBe(true)
    expect(declared.timeoutMs).toBe(2000)
    expect(declared.priority).toBe(0)
    expect(declared.before).toEqual([])
    expect(executions).toBe(0)
    expect(() => defineInterceptor({ ...declared, permissions: [] })).toThrow(/capability request/)
  })

  it('refuses opaque declarations for unregistered operations and authority entry points', () => {
    const input = runtimeAuthorSchemas.StandardToolOutput
    for (const operation of [
      { contract: 'agh.model', logicalName: 'default', method: 'infer' },
      { contract: 'agh.loop', logicalName: 'default', method: 'start' },
      { contract: 'agh.state-store', logicalName: 'default', method: 'commitControl' },
      { contract: 'demo/unknown', logicalName: 'default', method: 'invoke' },
    ])
      expect(() =>
        defineTool({
          id: 'opaque',
          description: 'A restricted operation',
          execution: 'opaque',
          input,
          effects: [operation],
          permissions: [],
          execute: () => ({ content: [] }),
        }),
      ).toThrow(/broker attempt/)
  })

  it('validates and isolates explicit configuration defaults before declaration', () => {
    const defaults = { content: [{ type: 'text' as const, text: 'initial' }] }
    const select = () => {
      throw new Error('must not run during declaration')
    }
    const declared = defineRoutingStrategy({
      id: 'configured',
      select,
      config: { schema: runtimeAuthorSchemas.StandardToolOutput, defaults },
    })
    const text = defaults.content[0]
    if (!text) throw new Error('configuration fixture missing')
    text.text = 'changed'
    expect(declared.config?.defaults.content[0]?.text).toBe('initial')
    expect(Object.isFrozen(declared.config?.defaults.content)).toBe(true)
    expect(() =>
      defineRoutingStrategy({
        id: 'configured',
        select,
        config: {
          schema: runtimeAuthorSchemas.StandardToolOutput,
          defaults: { content: [{ type: 'image' as 'text', text: 'invalid' }] },
        },
      }),
    ).toThrow(/defaults/)
  })

  it('rejects relaxed failure policy, forbidden fields and self ordering', () => {
    const base = {
      id: 'check',
      event: 'tool_call' as const,
      execution: 'pure' as const,
      readFields: ['/args'],
      writeFields: ['/allow'],
      permissions: [],
      handle: () => ({ allow: true as const }),
    }
    expect(() => defineInterceptor({ ...base, failPolicy: 'open' })).toThrow(/closed/)
    expect(() => defineInterceptor({ ...base, readFields: ['/args/nested'] })).toThrow(/read field/)
    expect(() => defineInterceptor({ ...base, writeFields: ['/actor'] })).toThrow(/write field/)
    expect(() => defineInterceptor({ ...base, before: ['check'] })).toThrow(/itself/)
    expect(() => defineInterceptor({ ...base, timeoutMs: 2001 })).toThrow(/timeout/)
    expect(() => defineInterceptor({ ...base, timeoutMs: -0 })).toThrow(/timeout/)
    expect(() => defineInterceptor({ ...base, next: () => undefined } as typeof base)).toThrow(/unknown/)
  })

  it('normalizes contribution declarations without running their source exports', () => {
    const source = {
      id: '@demo/stats',
      version: '1.0.0',
      contributions: [
        { kind: 'tool' as const, id: 'stats', implementation: { entry: './src/stats.ts', export: 'stats' } },
      ],
    }
    const first = defineRuntimePlugin(source)
    const second = defineRuntimePlugin(source)
    expect(first).toEqual(second)
    expect(first.runtimeApiMajor).toBe(1)
    expect(first.providers).toEqual([])
    expect(first.contracts).toEqual([])
    expect(Object.isFrozen(first)).toBe(true)
    const contribution = source.contributions[0]
    if (!contribution) throw new Error('fixture contribution missing')
    contribution.implementation.entry = './src/changed.ts'
    expect(first.contributions?.[0]?.implementation.entry).toBe('./src/stats.ts')
  })

  it('rejects duplicate IDs, duplicate exports, source traversal and unknown fields', () => {
    const contribution = {
      kind: 'tool' as const,
      id: 'stats',
      implementation: { entry: './src/stats.ts', export: 'stats' },
    }
    const base = { id: '@demo/stats', version: '1.0.0' }
    expect(() => defineRuntimePlugin({ ...base, contributions: [contribution, contribution] })).toThrow(
      /duplicate/,
    )
    expect(() =>
      defineRuntimePlugin({ ...base, contributions: [contribution, { ...contribution, id: 'other' }] }),
    ).toThrow(/export/)
    expect(() =>
      defineRuntimePlugin({
        ...base,
        contributions: [
          { ...contribution, implementation: { ...contribution.implementation, entry: './../secret.ts' } },
        ],
      }),
    ).toThrow(/path/)
    expect(() => defineRuntimePlugin({ ...base, runtimeApiMajor: 2 as 1 })).toThrow(/major/)
    expect(() => defineRuntimePlugin({ ...base, alias: 'escape' } as typeof base)).toThrow(/unknown/)
  })

  it('refuses declaration accessors without evaluating them', () => {
    let observed = false
    const definition = { id: '@demo/stats', version: '1.0.0' }
    Object.defineProperty(definition, 'contributions', {
      enumerable: true,
      get() {
        observed = true
        return []
      },
    })
    expect(() => defineRuntimePlugin(definition)).toThrow(/accessors/)
    expect(observed).toBe(false)
  })

  it('preserves a routing handler without invoking it or adding external capabilities', () => {
    let calls = 0
    const select = () => {
      calls++
      throw new Error('must not run during declaration')
    }
    const declared = defineRoutingStrategy({ id: 'routing', select })
    expect(declared.select).toBe(select)
    expect(calls).toBe(0)
    expect(Object.keys(declared).sort()).toEqual(['id', 'select'])
    expect(() =>
      defineRoutingStrategy({ id: 'routing', select, permissions: ['*'] } as {
        id: string
        select: typeof select
      }),
    ).toThrow(/unknown/)
  })

  it('hashes canonical UTF-8 bytes consistently across key order and multi-block inputs', () => {
    for (const value of [null, { z: 1, a: '你好' }, ['abc', 'x'.repeat(1000)], -0]) {
      const expected = createHash('sha256').update(jcs(value)).digest('hex')
      expect(canonicalJsonDigest(value)).toBe(expected)
    }
    expect(canonicalJsonDigest({ a: 1, b: 2 })).toBe(canonicalJsonDigest({ b: 2, a: 1 }))
    expect(() => canonicalJsonDigest(Number.NaN)).toThrow()
    expect(() => canonicalJsonDigest({ hidden: undefined } as unknown as { hidden: null })).toThrow()
  })
})
