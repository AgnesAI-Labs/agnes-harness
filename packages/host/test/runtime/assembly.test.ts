import { readFileSync } from 'node:fs'
import type { CallContext } from '@agnes/extension-api/runtime'
import { simpleLoopCapabilities } from '@agnes/extension-api/runtime/authoring'
import { RuntimeAuthorCapabilities } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  constructReferenceReleaseSet,
  createReferenceAssemblyProvider,
} from '../../../../examples/runtime-reference/src/providers/assembly.js'
import {
  assemblyRefusalFixtures,
  communityAssemblyFixture,
  migrationAssemblyFixture,
  pairAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-cases.js'
import {
  ASSEMBLY_UNFINISHED,
  assemblyFixture,
  fixtureHash,
  resealAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import { constructReleaseSet, releaseSetDigest } from '../../src/runtime/assembly/release-set.js'
import { createAssemblyProvider } from '../../src/runtime/providers/assembly.js'

const context = (signal = new AbortController().signal): CallContext => ({
  signal,
  principalRef: 'fixture-principal',
  bindingId: 'fixture-binding',
  invocationId: 'fixture-invocation',
  deadline: '2030-01-01T00:00:00Z',
  traceRef: 'fixture-trace',
  authorizationRef: 'fixture-authorization',
  scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
})
const implementations = [
  { name: 'default', construct: constructReleaseSet, create: createAssemblyProvider },
  { name: 'reference', construct: constructReferenceReleaseSet, create: createReferenceAssemblyProvider },
]

describe('detached immutable assembly plans', () => {
  it.each(['unpaired', 'joint', 'migration', 'joint and migration', 'explicit feature', 'community'])(
    'constructs the same frozen release for %s',
    async (recipe) => {
      const input = assemblyFixture()
      if (recipe === 'community') communityAssemblyFixture(input)
      if (recipe.includes('joint')) pairAssemblyFixture(input)
      if (recipe.includes('migration')) migrationAssemblyFixture(input)
      if (recipe === 'explicit feature') {
        input.plan.targetReleaseSet.bindings
          .find((row) => row.descriptor.contract === 'agh.loop')
          ?.descriptor.features.push('fixture-quality-slot')
        input.plan.targetReleaseSet.configSnapshotRef.value.features.push({
          bindingId: 'binding:agh.loop',
          features: ['fixture-quality-slot'],
          path: '/parameters',
          sourceId: 'fixture-profile',
        })
        resealAssemblyFixture(input)
      }
      const before = JSON.stringify(input)
      const results = implementations.map(({ construct }) => construct(input))
      expect(results[0]).toEqual(results[1])
      for (const result of results) {
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(result.error.detailCode)
        expect(result.value.releaseSetId).toBe(releaseSetDigest(result.value))
        expect(Object.isFrozen(result.value.bindings[0]?.descriptor)).toBe(true)
        expect(() => {
          result.value.bindings.pop()
        }).toThrow()
        expect(releaseSetDigest({ ...result.value, releaseSetId: 'irrelevant-self-id' })).toBe(
          result.value.releaseSetId,
        )
        expect(result.value.configSnapshotRef).toEqual(input.plan.targetReleaseSet.configSnapshotRef)
      }
      for (const implementation of implementations) {
        const provider = implementation.create(input)
        const outcome = await provider.plan(
          { configRef: input.graph.configRef, lock: input.graph.lock },
          context(),
        )
        expect(outcome).toEqual({ ok: true, value: input.graph })
        input.graph.digest = '0'.repeat(64)
        const repeat = await provider.plan(
          { configRef: input.plan.targetReleaseSet.configSnapshotRef, lock: input.resolution.lockGraph },
          context(),
        )
        expect(repeat).toEqual(outcome)
        input.graph.digest = outcome.ok ? outcome.value.digest : ''
      }
      expect(JSON.stringify(input)).toBe(before)
    },
  )

  it.each(assemblyRefusalFixtures())('refuses $name with the same stable code', async ({ input, code }) => {
    const before = JSON.stringify(input)
    for (const implementation of implementations) {
      const release = implementation.construct(input)
      expect(release.ok).toBe(false)
      if (!release.ok) expect(release.error.detailCode).toBe(code)
      const provider = implementation.create(input)
      const plan = await provider.plan(
        { configRef: input.graph.configRef, lock: input.graph.lock },
        context(),
      )
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.error.detailCode).toBe(code)
    }
    expect(JSON.stringify(input)).toBe(before)
  })

  it('refuses unknown input fields before accessing a latest document', () => {
    const input = assemblyFixture()
    Object.defineProperty(input, 'latest', {
      enumerable: true,
      get() {
        throw new Error('latest must remain unread')
      },
    })
    for (const { construct } of implementations) {
      const result = construct(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.detailCode).toBe('schema_invalid')
    }
  })

  it.each(implementations)(
    'keeps $name preparation, publication, drain and recovery unfinished',
    async ({ create }) => {
      const provider = create(assemblyFixture())
      expect(provider.implemented).toEqual(['plan'])
      expect(provider.incomplete).toEqual(ASSEMBLY_UNFINISHED)
      for (const method of ['prepare', 'publish', 'drain'] as const) {
        const result = await provider[method]({}, context())
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.detailCode).toBe(`assembly_${method}_unimplemented`)
      }
      const controller = new AbortController()
      controller.abort()
      const result = await provider.plan({}, context(controller.signal))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('cancelled')
    },
  )

  it('consumes the unique generated model inference capability and keeps the reference independent', () => {
    expect(simpleLoopCapabilities.modelInference).toBe(RuntimeAuthorCapabilities.modelInference)
    const reference = readFileSync(
      new URL('../../../../examples/runtime-reference/src/providers/assembly.ts', import.meta.url),
      'utf8',
    )
    expect(reference).not.toMatch(
      /@agnes\/host|packages\/host|runtime\/assembly\/release-set|createAssemblyProvider/,
    )
    const files = [
      '../../src/runtime/providers/assembly.ts',
      '../../src/runtime/assembly/release-set.ts',
      '../../src/runtime/assembly/inputs.ts',
      '../../src/runtime/assembly/primitives.ts',
    ]
    const defaultText = files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    const lines = (source: string) =>
      new Set(
        source
          .split('\n')
          .map((line) => line.replace(/\s/g, ''))
          .filter(Boolean),
      )
    const one = lines(defaultText),
      two = lines(reference)
    const overlap = [...one].filter((line) => two.has(line)).length / Math.min(one.size, two.size)
    expect(overlap).toBeLessThanOrEqual(0.5)
    expect(fixtureHash(simpleLoopCapabilities.modelInference)).toBe(
      fixtureHash(RuntimeAuthorCapabilities.modelInference),
    )
  })
})
