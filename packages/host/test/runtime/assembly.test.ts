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
import { candidateLifecycle } from '../../src/runtime/assembly/candidate.js'
import { constructReleaseSet, releaseSetDigest } from '../../src/runtime/assembly/release-set.js'
import { createAssemblyProvider } from '../../src/runtime/providers/assembly.js'
import { memoryAssemblyLifecycle } from './fixtures/assembly-lifecycle.js'

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
      const preparedResults: unknown[] = []
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
        const fixture = await memoryAssemblyLifecycle(input)
        const candidate = implementation.create(input, fixture.lifecycle)
        try {
          const prepared = await candidate.prepare({ graph: input.graph }, context())
          expect(prepared.ok).toBe(true)
          expect(prepared).toMatchObject({ ok: true, value: { readiness: { state: 'ready' } } })
          expect(candidate.inspectCandidate()?.graph).toEqual(input.graph)
          expect(candidate.inspectCandidate()?.releaseSet).toEqual(input.plan.targetReleaseSet)
          expect(fixture.root.view('fixture-current').published).toBe(true)
          expect(fixture.lifecycle.view()).toMatchObject({ staged: true, state: 'ready' })
          expect(await candidate.prepare({ graph: input.graph }, context())).toEqual(prepared)
          preparedResults.push(prepared)
          expect(
            await candidate.drain(
              { releaseSetId: input.plan.targetReleaseSet.releaseSetId, deadline: context().deadline },
              context(),
            ),
          ).toEqual({ ok: true, value: { remainingRefs: [] } })
          expect(fixture.released).toEqual(
            [...fixture.mounted].reverse().map((id) => id.slice(fixture.lifecycle.generationId.length + 1)),
          )
        } finally {
          await candidate.dispose()
          await fixture.cleanup()
        }
      }
      expect(preparedResults[0]).toEqual(preparedResults[1])
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
      const deniedPrepare = await provider.prepare({ graph: input.graph }, context())
      expect(deniedPrepare.ok).toBe(false)
      if (!deniedPrepare.ok) expect(deniedPrepare.error.detailCode).toBe(code)
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
    'keeps $name durable publication, pin and recovery unfinished',
    async ({ create }) => {
      const input = assemblyFixture(),
        provider = create(input)
      expect(provider.implemented).toEqual(['plan', 'prepare', 'memory-drain'])
      expect(provider.incomplete).toEqual(ASSEMBLY_UNFINISHED)
      expect(await provider.publish({}, context())).toMatchObject({
        ok: false,
        error: { detailCode: 'assembly_publish_unimplemented' },
      })
      expect(await provider.prepare({ graph: input.graph }, context())).toMatchObject({
        ok: false,
        error: { detailCode: 'candidate_lifecycle_unavailable' },
      })
      expect(await provider.drain({}, context())).toMatchObject({
        ok: false,
        error: { detailCode: 'candidate_not_prepared' },
      })
      const controller = new AbortController()
      controller.abort()
      expect(await provider.plan({}, context(controller.signal))).toMatchObject({
        ok: false,
        error: { code: 'cancelled' },
      })
      expect(await provider.prepare({}, context(controller.signal))).toMatchObject({
        ok: false,
        error: { code: 'cancelled' },
      })
    },
  )

  it.each(implementations)(
    'cleans $name failed, cancelled and disposed candidates without changing current',
    async ({ create }) => {
      for (const mode of ['failure', 'residual', 'cancel', 'dispose'] as const) {
        const input = assemblyFixture()
        const fixture = await memoryAssemblyLifecycle(input, {
          failReady: mode === 'failure' || mode === 'residual',
          failRelease: mode === 'residual',
          pause: mode === 'cancel' || mode === 'dispose',
        })
        const candidate = create(input, fixture.lifecycle),
          controller = new AbortController()
        const preparing = candidate.prepare({ graph: input.graph }, context(controller.signal))
        await fixture.started
        let disposing: Promise<readonly string[]> | undefined
        if (mode === 'cancel') controller.abort()
        if (mode === 'dispose') disposing = candidate.dispose()
        const result = await preparing
        expect(result).toMatchObject({
          ok: false,
          error: {
            detailCode:
              mode === 'cancel' || mode === 'dispose' ? 'prepare_cancelled' : 'candidate_prepare_failed',
          },
        })
        expect(fixture.root.view('fixture-current').published).toBe(true)
        expect(candidate.inspectCandidate()?.readiness.state).toBe('blocked')
        expect(fixture.released).toEqual(
          [...fixture.mounted].reverse().map((id) => id.slice(fixture.lifecycle.generationId.length + 1)),
        )
        const releaseCount = fixture.released.length
        const residual = await (disposing ?? candidate.dispose())
        expect([...residual].sort()).toEqual(mode === 'residual' ? [...fixture.released].sort() : [])
        expect(candidate.inspectCandidate()?.state).toBe(mode === 'residual' ? 'residual' : 'disposed')
        expect(await candidate.dispose()).toEqual(residual)
        expect(fixture.released).toHaveLength(releaseCount)
        expect(await candidate.prepare({ graph: input.graph }, context())).toMatchObject({
          ok: false,
          error: { detailCode: 'candidate_disposed' },
        })
        await fixture.cleanup()
      }
    },
  )

  it.each(implementations)(
    'applies $name HK-04 to effective hooks and retains mixed legacy/SPI contributions',
    async ({ create }) => {
      for (const event of ['before_step', 'turn_stopping'] as const) {
        for (const bound of [false, true]) {
          const input = assemblyFixture(),
            providerId = 'acme.release/loop'
          const applied: string[] = []
          const fixture = await memoryAssemblyLifecycle(input, {
            contributions: [
              {
                providerId,
                source: 'legacy-apply',
                hooks: [{ event, bound }],
                apply(ports) {
                  applied.push(`legacy:${ports.generationId}`)
                },
              },
              {
                providerId,
                source: 'author',
                operations: [{ method: 'quote', kind: 'query' }],
                apply(ports) {
                  applied.push(`spi:${ports.generationId}`)
                },
              },
            ],
          })
          const candidate = create(input, fixture.lifecycle)
          try {
            const result = await candidate.prepare({ graph: input.graph }, context())
            if (event === 'before_step' && bound) {
              expect(result).toMatchObject({ ok: false, error: { detailCode: 'feature_missing' } })
              expect(applied).toEqual([])
            } else {
              expect(result.ok).toBe(true)
              expect(applied).toEqual([
                `legacy:${fixture.lifecycle.generationId}`,
                `spi:${fixture.lifecycle.generationId}`,
              ])
              const warning = event === 'turn_stopping' && bound ? ['loop_feature_absent:turn_stopping'] : []
              if (result.ok)
                expect(
                  result.value.readiness.required.find((row) => row.contributionId === 'binding:agh.loop')
                    ?.diagnosticIds,
                ).toEqual(warning)
              expect(fixture.root.view(fixture.lifecycle.generationId).installedHooks).not.toContain(event)
              expect(fixture.root.view(fixture.lifecycle.generationId).controlMethods).toContain('cancel')
            }
            expect(fixture.root.view('fixture-current').published).toBe(true)
          } finally {
            await candidate.dispose()
            await fixture.cleanup()
          }
        }
      }
      for (const changed of ['definition', 'operation', 'loop-feature'] as const) {
        const input = assemblyFixture()
        communityAssemblyFixture(input)
        const fixture = await memoryAssemblyLifecycle(input)
        const publication = {
          ...fixture.publication,
          providers: fixture.publication.providers.map((provider) =>
            provider.binding.contract === 'acme.release/inspection'
              ? {
                  ...provider,
                  ...(changed === 'definition'
                    ? {
                        contractDefinition: {
                          ownerPackageId: 'acme.release',
                          definitionDigest: '0'.repeat(64),
                        },
                      }
                    : {}),
                  ...(changed === 'operation'
                    ? {
                        operations: provider.operations?.map((operation) => ({
                          ...operation,
                          kind: 'compute' as const,
                        })),
                      }
                    : {}),
                }
              : provider,
          ),
          ...(changed === 'loop-feature' ? { loopFeatures: ['loop-hook:before_step'] } : {}),
        }
        const candidate = create(input, candidateLifecycle(fixture.root, publication))
        try {
          const result = await candidate.prepare({ graph: input.graph }, context())
          expect(result).toMatchObject({
            ok: false,
            error: {
              detailCode:
                changed === 'definition'
                  ? 'contract_definition_mismatch'
                  : changed === 'operation'
                    ? 'contract_operation_mismatch'
                    : 'loop_feature_mismatch',
            },
          })
          expect(fixture.mounted).toEqual([])
          expect(fixture.root.view('fixture-current').published).toBe(true)
        } finally {
          await candidate.dispose()
          await fixture.cleanup()
        }
      }
      const input = assemblyFixture()
      const fixture = await memoryAssemblyLifecycle(input)
      const mismatched = create(input, { ...fixture.lifecycle, selections: [] })
      expect(await mismatched.prepare({ graph: input.graph }, context())).toMatchObject({
        ok: false,
        error: { detailCode: 'candidate_selection_mismatch' },
      })
      expect(fixture.mounted).toEqual([])
      const candidate = create(input, fixture.lifecycle)
      expect(
        await candidate.prepare({ graph: { ...input.graph, graphId: 'changed' } }, context()),
      ).toMatchObject({ ok: false, error: { detailCode: 'prepare_input_mismatch' } })
      expect(await candidate.prepare({ graph: input.graph }, context())).toMatchObject({ ok: true })
      expect(
        await candidate.drain({ releaseSetId: 'other', deadline: context().deadline }, context()),
      ).toMatchObject({ ok: false, error: { detailCode: 'candidate_release_mismatch' } })
      await candidate.dispose()
      await fixture.cleanup()
    },
  )

  it('consumes the unique generated model inference capability and keeps the reference independent', () => {
    expect(simpleLoopCapabilities.modelInference).toBe(RuntimeAuthorCapabilities.modelInference)
    const reference = ['assembly.ts', 'assembly-candidate.ts']
      .map((name) =>
        readFileSync(
          new URL(`../../../../examples/runtime-reference/src/providers/${name}`, import.meta.url),
          'utf8',
        ),
      )
      .join('\n')
    expect(reference).not.toMatch(
      /@agnes\/host|packages\/host|runtime\/assembly\/release-set|createAssemblyProvider/,
    )
    const files = [
      '../../src/runtime/providers/assembly.ts',
      '../../src/runtime/assembly/release-set.ts',
      '../../src/runtime/assembly/candidate.ts',
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
