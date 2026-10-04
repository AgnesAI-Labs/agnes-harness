import { readFileSync } from 'node:fs'
import { jcs } from '@agnes/protocol'
import type { RuntimePluginManifest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { constructReferenceReleaseSet } from '../../../../examples/runtime-reference/src/providers/assembly.js'
import {
  produceReferenceClientLock,
  verifyReferenceClientLock,
} from '../../../../examples/runtime-reference/src/providers/assembly-client-lock.js'
import {
  assemblyFixture,
  fixtureHash,
  fixtureRef,
  resealAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import { produceClientLock, verifyClientLock } from '../../src/runtime/assembly/client-lock.js'
import { constructReleaseSet } from '../../src/runtime/assembly/release-set.js'

type Input = ReturnType<typeof assemblyFixture>
function clientFixture() {
  const input = assemblyFixture()
  const release = input.plan.targetReleaseSet
  const source = input.resolution.lockGraph.entries[1]
  if (source?.manifestRef.kind !== 'inline') throw new Error('UI manifest missing')
  const manifest = structuredClone(source.manifestRef.value) as unknown as RuntimePluginManifest
  const schema = manifest.schemas[0]?.ref
  if (!schema) throw new Error('UI schema missing')
  manifest.clientServices = ['shell', 'registry'].map((id) => ({
    id,
    packageDigest: manifest.packageDigest,
    contract: id === 'shell' ? ('agh.shell' as const) : ('agh.ui-registry' as const),
    apiMajor: 1,
    targets: ['web' as const],
    scope: 'client' as const,
    configSchema: schema,
    entry: {
      entry: './web/index.js',
      export: id === 'shell' ? 'customShellFactory' : 'customRegistryFactory',
    },
    requiredFeatures: [],
  }))
  source.manifestRef = fixtureRef(manifest)
  const owner = release.packages[1]
  if (!owner) throw new Error('UI owner missing')
  owner.integrityRef = source.manifestRef.digest
  input.configuration.profile.client = {
    requiredTargets: ['web'],
    shell: { packageId: manifest.id, contributionId: 'shell' },
    registry: { packageId: manifest.id, contributionId: 'registry' },
    fallbackRenderer: { packageId: manifest.id, contributionId: manifest.renderers[0]?.id ?? 'missing' },
    rendererSelections: [
      {
        target: 'web',
        renderKey: manifest.renderers[0]?.renderKey ?? 'missing',
        rendererId: manifest.renderers[0]?.id ?? 'missing',
      },
      { target: 'tui', renderKey: 'foreign/key', rendererId: 'absent' },
    ],
  }
  resealAssemblyFixture(input)
  return input
}
function manifestOf(input: Input): RuntimePluginManifest {
  const ref = input.resolution.lockGraph.entries[1]?.manifestRef
  if (ref?.kind !== 'inline') throw new Error('missing manifest')
  return ref.value as unknown as RuntimePluginManifest
}
function sealManifest(input: Input): void {
  const pkg = input.resolution.lockGraph.entries[1]
  if (pkg?.manifestRef.kind !== 'inline') throw new Error('missing manifest')
  pkg.manifestRef = fixtureRef(pkg.manifestRef.value)
  const owner = input.plan.targetReleaseSet.packages[1]
  if (!owner) throw new Error('missing owner')
  owner.integrityRef = pkg.manifestRef.digest
  resealAssemblyFixture(input)
}
function deliver(input: Input) {
  return input.plan.targetReleaseSet.clientBundlesRef.value.bundles
}
function locked(input: Input) {
  const result = produceClientLock(input, deliver(input))
  if (!result.ok) throw new Error(result.error.detailCode)
  input.plan.targetReleaseSet.clientBundlesRef = fixtureRef({
    bundles: deliver(input),
    clientLock: result.value,
  }) as Input['plan']['targetReleaseSet']['clientBundlesRef']
  resealAssemblyFixture(input)
  return result.value
}
const producers = [produceClientLock, produceReferenceClientLock]
const constructors = [constructReleaseSet, constructReferenceReleaseSet]

// Full source validation and tampered projection checks take up to 15s on hosted Linux.
describe('package contribution client locks', { timeout: 30_000 }, () => {
  it('projects only the requested target with diagnostics and locks original identities and exports', () => {
    const input = clientFixture(),
      before = JSON.stringify(input)
    const one = producers[0]?.(input, deliver(input)),
      two = producers[1]?.(input, deliver(input))
    expect(one).toEqual(two)
    expect(one).toMatchObject({
      ok: true,
      value: {
        selections: [
          {
            target: 'web',
            registry: { packageId: manifestOf(input).id, contributionId: 'registry' },
            rendererSelections: [input.configuration.profile.client.rendererSelections[0]],
          },
        ],
        bundles: [
          {
            packageDigest: manifestOf(input).packageDigest,
            sourceRef: 'fixture-ui-source',
            assetDigest: deliver(input)[0]?.digest,
            entryPath: './web/index.js',
            contributions: [
              { contributionId: 'shell', export: 'customShellFactory' },
              { contributionId: 'registry', export: 'customRegistryFactory' },
              {
                contributionId: manifestOf(input).renderers[0]?.id,
                descriptor: manifestOf(input).renderers[0],
              },
            ],
          },
        ],
        diagnostics: [{ code: 'renderer_selection_other_target', target: 'web', index: 1 }],
      },
    })
    expect(JSON.stringify(input)).toBe(before)
    if (one?.ok) {
      expect(Object.isFrozen(one.value.bundles[0]?.contributions)).toBe(true)
      const renderer = one.value.bundles[0]?.contributions.find((row) => row.kind === 'renderer')
      expect(renderer).not.toHaveProperty('export')
      if (renderer?.kind !== 'renderer') throw new Error('missing renderer')
      expect(renderer.descriptor).toEqual(manifestOf(input).renderers[0])
      expect(renderer.descriptor).not.toBe(manifestOf(input).renderers[0])
      expect(Object.isFrozen(renderer.descriptor.viewSchemaRanges)).toBe(true)
      expect(Object.isFrozen(manifestOf(input).renderers[0])).toBe(false)
    }
  })

  it.each([
    {
      name: 'renderer digest differs',
      code: 'client_package_mismatch',
      change: (input: Input) => {
        const row = manifestOf(input).renderers[0]
        if (row) row.packageDigest = 'a'.repeat(64)
      },
    },
    {
      name: 'renderer original entry differs',
      code: 'client_entry_mismatch',
      change: (input: Input) => {
        const row = manifestOf(input).renderers[0]
        if (row) row.entry = './other.js'
      },
    },
    {
      name: 'missing selected contribution',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        input.configuration.profile.client.registry.contributionId = 'missing'
      },
    },
    {
      name: 'entry used as contribution identity',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        input.configuration.profile.client.registry.contributionId = './web/index.js'
      },
    },
    {
      name: 'foreign package identity',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        input.configuration.profile.client.registry.packageId = 'acme.release'
      },
    },
    {
      name: 'wrong contribution kind',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        input.configuration.profile.client.registry.contributionId = 'shell'
      },
    },
    {
      name: 'wrong target',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        const row = manifestOf(input).clientServices[1]
        if (row) row.targets = ['tui']
      },
    },
    {
      name: 'contribution digest differs',
      code: 'client_package_mismatch',
      change: (input: Input) => {
        const row = manifestOf(input).clientServices[1]
        if (row) row.packageDigest = 'a'.repeat(64)
      },
    },
    {
      name: 'package digest differs',
      code: 'client_package_mismatch',
      change: (input: Input) => {
        manifestOf(input).packageDigest = 'a'.repeat(64)
      },
    },
    {
      name: 'source differs',
      code: 'client_package_mismatch',
      change: (input: Input) => {
        const pkg = input.plan.targetReleaseSet.packages[1]
        if (pkg) pkg.sourceRef = 'foreign-source'
      },
    },
    {
      name: 'entry differs',
      code: 'client_entry_mismatch',
      change: (input: Input) => {
        const row = manifestOf(input).clientServices[1]
        if (row) row.entry.entry = './other.js'
      },
    },
    {
      name: 'bundle file digest differs',
      code: 'client_entry_mismatch',
      change: (input: Input) => {
        const file = manifestOf(input).files.find((row) => row.path === './web/index.js')
        if (file) file.digest = 'a'.repeat(64)
      },
    },
    {
      name: 'duplicate contributions',
      code: 'duplicate_client_contribution',
      change: (input: Input) => {
        const row = manifestOf(input).clientServices[1]
        if (row) manifestOf(input).clientServices.push(structuredClone(row))
      },
    },
    {
      name: 'same contribution in two modules',
      code: 'duplicate_client_contribution',
      change: (input: Input) => {
        const bundle = deliver(input)[0]
        if (bundle) deliver(input).push({ ...bundle, bundleId: 'other-bundle' })
      },
    },
    {
      name: 'duplicate renderer selection key',
      code: 'duplicate_renderer_selection',
      change: (input: Input) => {
        const row = input.configuration.profile.client.rendererSelections[0]
        if (row) input.configuration.profile.client.rendererSelections.push({ ...row })
      },
    },
    {
      name: 'renderer key differs',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        const row = input.configuration.profile.client.rendererSelections[0]
        if (row) row.renderKey = 'other/key'
      },
    },
    {
      name: 'required target without bundle',
      code: 'client_contribution_missing',
      change: (input: Input) => {
        input.configuration.profile.client.requiredTargets.push('sdk')
      },
    },
  ])('rejects $name in both producers', ({ change, code }) => {
    const input = clientFixture()
    change(input)
    sealManifest(input)
    for (const produce of producers)
      expect(produce(input, deliver(input))).toMatchObject({ ok: false, error: { detailCode: code } })
  })

  it('rejects a same-target renderer id declared by two packages before publishing', () => {
    const input = clientFixture(),
      original = manifestOf(input)
    locked(input)
    const foreign = { ...structuredClone(original), id: 'other.ui', clientServices: [] }
    const foreignRef = fixtureRef(foreign)
    const owner = input.plan.targetReleaseSet.packages[1],
      source = input.resolution.lockGraph.entries[1],
      bundle = deliver(input)[0]
    if (!owner || !source || !bundle) throw new Error('missing fixture')
    input.plan.targetReleaseSet.packages.push({
      ...structuredClone(owner),
      packageId: foreign.id,
      integrityRef: foreignRef.digest,
    })
    input.resolution.lockGraph.entries.push({
      ...structuredClone(source),
      packageId: foreign.id,
      manifestRef: foreignRef,
    })
    deliver(input).push({ ...structuredClone(bundle), packageId: foreign.id, bundleId: 'foreign-bundle' })
    resealAssemblyFixture(input)
    for (const produce of producers)
      expect(produce(input, deliver(input))).toMatchObject({
        ok: false,
        error: { detailCode: 'duplicate_renderer_id' },
      })
    for (const construct of constructors)
      expect(construct(input)).toMatchObject({ ok: false, error: { detailCode: 'duplicate_renderer_id' } })
  })

  it('allows the same renderer id on disjoint targets and emits only per-target selections', () => {
    const input = clientFixture(),
      manifest = manifestOf(input)
    const webEntry = manifest.entries.web
    if (!webEntry) throw new Error('web entry missing')
    manifest.entries.tui = webEntry
    const renderer = manifest.renderers[0]
    if (!renderer) throw new Error('renderer missing')
    manifest.renderers.push({ ...structuredClone(renderer), targets: ['tui'] })
    const registry = manifest.clientServices[1]
    if (registry?.contract !== 'agh.ui-registry') throw new Error('registry missing')
    registry.targets.push('tui')
    const owner = input.plan.targetReleaseSet.packages[1],
      bundle = deliver(input)[0]
    if (!owner || !bundle || !owner.entries.web) throw new Error('missing bundle')
    Object.assign(owner.entries, { tui: { ...owner.entries.web, platform: 'tui' } })
    deliver(input).push({ ...bundle, target: 'tui', entry: 'tui', bundleId: 'tui-bundle' })
    input.configuration.profile.client.rendererSelections.pop()
    sealManifest(input)
    for (const produce of producers)
      expect(produce(input, deliver(input))).toMatchObject({
        ok: true,
        value: { selections: [{ target: 'web' }] },
      })
    input.configuration.profile.client.requiredTargets.push('tui')
    sealManifest(input)
    const results = producers.map((produce) => produce(input, deliver(input)))
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({
      ok: true,
      value: { selections: [{ target: 'web' }, { target: 'tui', shell: null, rendererSelections: [] }] },
    })
  })

  it('rejects old-minor omission after selecting a new client and refuses tampered projections', () => {
    const input = clientFixture(),
      mapping = locked(input)
    const verify = (body: unknown) => {
      let reason: string | undefined
      try {
        verifyClientLock(input, body)
      } catch (error) {
        reason = (error as { detailCode?: string }).detailCode
      }
      const reference = verifyReferenceClientLock(input, body)
      expect(reference.ok ? undefined : reference.error.detailCode).toBe(reason)
      return reason
    }
    expect(verify(input.plan.targetReleaseSet.clientBundlesRef.value)).toBeUndefined()
    expect(verify({ bundles: deliver(input) })).toBe('client_selection_unimplemented')
    expect(
      verify({ bundles: deliver(input), clientLock: { bundles: mapping.bundles, diagnostics: [] } }),
    ).toBe('client_selection_unimplemented')
    const body = { bundles: deliver(input), clientLock: structuredClone(mapping) }
    body.clientLock.selections = []
    expect(verify(body)).toBe('client_selection_unimplemented')
    body.clientLock = structuredClone(mapping)
    const member = body.clientLock.bundles[0]?.contributions[0]
    if (member && 'export' in member) member.export = 'otherExport'
    expect(verify(body)).toBe('client_lock_mismatch')
    if (member && 'export' in member) delete (member as Partial<typeof member>).export
    expect(verify(body)).toBe('client_selection_unimplemented')
    body.clientLock = structuredClone(mapping)
    const renderer = body.clientLock.bundles[0]?.contributions.find((row) => row.kind === 'renderer')
    if (renderer?.kind !== 'renderer') throw new Error('missing renderer')
    for (const changes of [
      { id: 'other-renderer' },
      { packageDigest: 'a'.repeat(64) },
      { targets: ['tui'] },
      { renderKey: 'other/key' },
      { entry: './other.js' },
      { viewSchemaRanges: {} },
      { requiredFeatures: ['other-feature'] },
      { optionalFeatures: ['other-feature'] },
      { scope: 'session' },
    ]) {
      const original = structuredClone(renderer.descriptor)
      Object.assign(renderer.descriptor, changes)
      expect(verify(body)).toBe('client_lock_mismatch')
      renderer.descriptor = original
    }
    delete (renderer as Partial<typeof renderer>).descriptor
    expect(verify(body)).toBe('client_selection_unimplemented')
    body.clientLock = structuredClone(mapping)
    if (body.clientLock.bundles[0])
      delete (body.clientLock.bundles[0] as Partial<(typeof body.clientLock.bundles)[0]>).contributions
    expect(verify(body)).toBe('client_selection_unimplemented')
  })

  it.each(constructors)(
    'checks the lock at release construction and retains the existing restricted fixture path (%#)',
    (construct) => {
      const legacy = assemblyFixture(),
        before = JSON.stringify(legacy),
        releaseBytes = jcs(legacy.plan.targetReleaseSet),
        bundlesBytes = jcs(legacy.plan.targetReleaseSet.clientBundlesRef)
      const result = construct(legacy)
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) throw new Error(result.error.detailCode)
      expect(jcs(result.value)).toBe(releaseBytes)
      expect(fixtureHash(result.value)).toBe(fixtureHash(legacy.plan.targetReleaseSet))
      expect(jcs(result.value.clientBundlesRef)).toBe(bundlesBytes)
      expect(result.value.clientBundlesRef.kind).toBe('inline')
      if (result.value.clientBundlesRef.kind === 'inline')
        expect(result.value.clientBundlesRef.value).not.toHaveProperty('clientLock')
      expect(JSON.stringify(legacy)).toBe(before)
      const input = clientFixture()
      expect(construct(input)).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'client_selection_unimplemented' },
      })
      locked(input)
      expect(construct(input)).toMatchObject({ ok: true })
    },
  )

  it('keeps the reference independent with no more than half of normalized lines shared', () => {
    const main = readFileSync(new URL('../../src/runtime/assembly/client-lock.ts', import.meta.url), 'utf8')
    const reference = readFileSync(
      new URL(
        '../../../../examples/runtime-reference/src/providers/assembly-client-lock.ts',
        import.meta.url,
      ),
      'utf8',
    )
    expect(reference).not.toMatch(/@agnes\/host|packages\/host|runtime\/assembly\/client-lock/)
    const lines = (text: string) =>
      new Set(
        text
          .split('\n')
          .map((line) => line.replace(/\s/g, ''))
          .filter(Boolean),
      )
    const a = lines(main),
      b = lines(reference)
    expect([...a].filter((line) => b.has(line)).length / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  })
})
