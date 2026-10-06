import { readFileSync } from 'node:fs'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import { RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  createReferenceModelFactory,
  createReferenceModelRegistry,
  type ReferenceModelHold,
} from './model.js'
import {
  ADAPTER,
  expectedInputDigest,
  factoryContext,
  inlineRef,
  OWNER_ID,
  prepareRequestOf,
  referenceDeployment,
  referenceModelFixture,
  runCall,
} from './model-contract.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const lineSet = (source: string) =>
  new Set(
    source
      .split('\n')
      .map((row) => row.replace(/\s/gu, ''))
      .filter(Boolean),
  )
function overlap(left: string, right: string) {
  const a = lineSet(left)
  const b = lineSet(right)
  return [...a].filter((row) => b.has(row)).length / Math.min(a.size, b.size)
}
const specifiers = (source: string) =>
  [...source.matchAll(/(?:from|import\()\s*'([^']+)'/gu)].map((match) => match[1] as string)

describe('the reference model service stays independent of the default', () => {
  const reference = read('./model.ts')
  const fixture = read('./model-contract.ts')
  const tools = read('./model-tools.ts')
  const production = read('../../../../packages/core/src/runtime/providers/model.ts')

  it('imports only the public packages and no core, host or default provider file', () => {
    expect([...new Set(specifiers(reference))].sort()).toEqual([
      './model-tools.js',
      '@agnes/extension-api/runtime',
      '@agnes/protocol',
      '@agnes/protocol/gen/model',
      '@agnes/protocol/runtime',
    ])
    expect([...new Set(specifiers(tools))].sort()).toEqual(['@agnes/protocol', '@agnes/protocol/runtime'])
    for (const source of [reference, fixture, tools])
      expect(source).not.toMatch(
        /(?:from|import\s*\()[^\n]*(?:@agnes\/core|@agnes\/host|packages\/(?:core|host)|runtime\/providers)/u,
      )
  })
  it('is not a re-export or wrapper of the default', () => {
    expect(reference).not.toMatch(/export\s*(?:\*|\{[^}]*\})\s*from/u)
    expect(reference).not.toContain('createDefaultModelFactory')
    expect(overlap(reference, production)).toBeLessThanOrEqual(0.5)
    expect(overlap(production, production)).toBeGreaterThan(0.5)
    expect(
      overlap(tools, read('../../../../packages/core/src/runtime/model/wire-tools.ts')),
    ).toBeLessThanOrEqual(0.5)
  })
})

describe('the reference registry', () => {
  const hold = (n: number, over: Partial<ReferenceModelHold> = {}): ReferenceModelHold => ({
    runId: 'run-1',
    sessionId: 'session-1',
    ownerBinding: ADAPTER,
    inputDigest: String(n).padStart(64, '0'),
    header: { n } as never,
    body: { n } as never,
    ...over,
  })
  it('never holds more than its bound and drops the oldest first', () => {
    const registry = createReferenceModelRegistry({ maxEntries: 3 })
    for (let n = 0; n < 10; n++) registry.put(`h${n}`, hold(n))
    expect(registry.size).toBe(3)
    expect(registry.get('h6')).toBeUndefined()
    expect(registry.get('h7')).toBeDefined()
    expect(registry.get('h9')).toBeDefined()
  })
  it('a refresh by the same content keeps the entry and moves it to the newest place', () => {
    const registry = createReferenceModelRegistry({ maxEntries: 2 })
    registry.put('a', hold(1))
    registry.put('b', hold(2))
    registry.put('a', hold(1))
    registry.put('c', hold(3))
    expect(registry.get('a')).toBeDefined()
    expect(registry.get('b')).toBeUndefined()
  })
  it('refuses other content under a held key but accepts it once the entry has expired', () => {
    let now = 0
    const registry = createReferenceModelRegistry({ ttlMs: 100, now: () => now })
    registry.put('a', hold(1))
    expect(() => registry.put('a', hold(2))).toThrow('already holds other content')
    now = 100
    expect(registry.get('a')).toBeUndefined()
    registry.put('a', hold(2))
    expect(registry.get('a')?.header).toEqual({ n: 2 })
  })
  it('hands out copies, so a reader cannot change what is held', () => {
    const registry = createReferenceModelRegistry()
    registry.put('a', hold(1))
    const first = registry.get('a')
    if (!first) throw new Error('missing')
    ;(first.header as unknown as { n: number }).n = 99
    expect(registry.get('a')?.header).toEqual({ n: 1 })
  })
  it('keeps nothing after clear', () => {
    const registry = createReferenceModelRegistry()
    registry.put('a', hold(1))
    registry.clear()
    expect(registry.size).toBe(0)
  })
})

describe('the reference prepare result', () => {
  it('returns a handle that is only a handle, whose digest matches an independent computation', async () => {
    const fixtureUnderTest = await referenceModelFixture()
    const provider = await fixtureUnderTest.factory.create(
      fixtureUnderTest.configuration,
      fixtureUnderTest.dependencies,
      fixtureUnderTest.factoryContext,
    )
    await provider.ready(fixtureUnderTest.call)
    const reply = await provider.compute?.(
      {
        target: {
          bindingId: OWNER_ID,
          contract: 'agh.model',
          logicalName: 'default',
          providerId: 'agh.reference/model',
        },
        method: 'prepare',
        input: fixtureUnderTest.prepareInput,
      },
      fixtureUnderTest.call,
    )
    if (!reply?.ok || reply.value.kind !== 'inline') throw new Error('prepare refused')
    const result = validateRuntime('ModelPrepareResult', reply.value.value)
    if (!result.ok || result.value.preparedRef.kind !== 'inline') throw new Error('bad result')
    const handle = validateRuntime('PreparedModelHandle', result.value.preparedRef.value)
    if (!handle.ok) throw new Error('bad handle')
    expect(Object.keys(handle.value).sort()).toEqual([
      'handleId',
      'header',
      'inputDigest',
      'kind',
      'ownerBinding',
    ])
    expect(JSON.stringify(result.value.preparedRef.value)).not.toContain('hello')
    expect(result.value.inputDigest).toBe(expectedInputDigest(prepareRequestOf(), handle.value.ownerBinding))
    await provider.close('shutdown')
  })
  it('does not hand out the default provider id unless a host names it', () => {
    expect(createReferenceModelFactory(referenceDeployment()).descriptor.providerId).toBe(
      'agh.reference/model',
    )
    expect(
      createReferenceModelFactory(referenceDeployment(undefined, { providerId: 'x/model' })).descriptor
        .providerId,
    ).toBe('x/model')
  })
  it('keeps the registry empty when a preparation is refused', async () => {
    const registry = createReferenceModelRegistry()
    const deployment = referenceDeployment(undefined, { prices: { version: () => 'drifted' } }, registry)
    const encoded = deployment.config.encode({})
    if (!encoded.ok) throw new Error('config')
    const provider = await createReferenceModelFactory(deployment).create(
      encoded.value,
      createTestServiceContainer().dependencies,
      factoryContext(),
    )
    await provider.ready(runCall())
    const reply = await provider.compute?.(
      {
        target: {
          bindingId: OWNER_ID,
          contract: 'agh.model',
          logicalName: 'default',
          providerId: 'agh.reference/model',
        },
        method: 'prepare',
        input: inlineRef(RuntimeMethodSchemaRefs['agh.model'].prepare.input, prepareRequestOf()),
      },
      runCall(),
    )
    expect(reply?.ok).toBe(false)
    expect(registry.size).toBe(0)
  })
})
