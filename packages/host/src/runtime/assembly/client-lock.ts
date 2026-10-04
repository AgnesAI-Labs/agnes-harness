import type { Outcome } from '@agnes/extension-api/runtime'
import type {
  ClientModuleContribution,
  ClientSelection,
  RuntimePluginManifest,
} from '@agnes/protocol/runtime'
import type { ReleaseSetInputs } from './inputs.js'
import { array, attempt, equal, fields, freeze, readContent, readWire, requireRelease } from './primitives.js'

function check(condition: unknown, code: string): asserts condition {
  requireRelease(condition, code, '/clientLock')
}

type ClientTarget = ClientSelection['target']
function readTarget(value: unknown): ClientTarget {
  check(value === 'web' || value === 'tui' || value === 'im' || value === 'sdk', 'schema_invalid')
  return value
}

type Contribution = ClientModuleContribution & {
  entryPath: string
  renderKey: string | null
}
export interface ClientBundleLock {
  bundleId: string
  target: ClientTarget
  packageId: string
  version: string
  packageDigest: string
  sourceRef: string
  manifestDigest: string
  assetDigest: string
  entry: string
  entryPath: string
  contributions: Contribution[]
}
/** Host-private source for authenticated catalogs; contains no URL or generation credential. */
export interface ClientLock {
  selections: ClientSelection[]
  bundles: ClientBundleLock[]
  diagnostics: { code: 'renderer_selection_other_target'; target: ClientTarget; index: number }[]
}

function deriveClientBundles(input: ReleaseSetInputs, delivered: unknown[]): ClientBundleLock[] {
  const release = readWire('ReleaseSet', input.plan.targetReleaseSet)
  const resolution = readWire('PackageResolverResolveResult', input.resolution)
  const manifests = new Map<string, RuntimePluginManifest>()
  const bundles: ClientBundleLock[] = []
  for (const raw of delivered) {
    const row = fields(
      raw,
      ['bundleId', 'digest', 'target', 'schemas', 'packageId', 'version', 'entry', 'viewSchemaRanges'],
      '/clientBundlesRef/bundles',
    )
    const packageId = readWire('Id', row.packageId)
    const target = readTarget(row.target)
    const entry = readWire('Id', row.entry)
    const owners = release.packages.filter((pkg) => pkg.packageId === packageId)
    const sources = resolution.lockGraph.entries.filter((pkg) => pkg.packageId === packageId)
    check(owners.length <= 1 && sources.length <= 1, 'client_package_mismatch')
    const owner = owners[0],
      locked = sources[0]
    check(owner && locked, 'client_package_missing')
    const manifestDigest =
      locked.manifestRef.kind === 'inline' ? locked.manifestRef.digest : locked.manifestRef.blob.digest
    check(
      owner.version === row.version &&
        owner.version === locked.version &&
        owner.digest === locked.digest &&
        locked.locator.digest === owner.digest &&
        owner.sourceRef === locked.locator.sourceId &&
        owner.integrityRef === manifestDigest,
      'client_package_mismatch',
    )
    let manifest = manifests.get(packageId)
    if (!manifest) {
      manifest = readWire(
        'RuntimePluginManifest',
        readContent(locked.manifestRef, '/client/manifest', input.fixture.contents),
      )
      check(
        manifest.id === packageId &&
          manifest.version === owner.version &&
          manifest.packageDigest === owner.digest,
        'client_package_mismatch',
      )
      manifests.set(packageId, manifest)
    }
    const entryPath = manifest.entries[entry as keyof typeof manifest.entries]
    const file = manifest.files.filter((item) => item.path === entryPath)
    const artifact = Object.hasOwn(owner.entries, entry) ? owner.entries[entry] : undefined
    check(
      entry === target &&
        entryPath &&
        file.length === 1 &&
        file[0]?.digest === row.digest &&
        artifact?.digest === row.digest &&
        artifact?.platform === target,
      'client_entry_mismatch',
    )
    const contributions: Contribution[] = []
    for (const original of [...manifest.clientServices, ...manifest.renderers]) {
      check(original.packageDigest === owner.digest, 'client_package_mismatch')
      check(new Set(original.targets).size === original.targets.length, 'client_target_mismatch')
      if (!original.targets.some((item) => item === target)) continue
      const renderer = 'renderKey' in original
      const path = renderer ? original.entry : original.entry.entry
      check(path === entryPath, 'client_entry_mismatch')
      contributions.push({
        ...readWire('ClientModuleContribution', {
          contributionId: original.id,
          kind: renderer ? 'renderer' : original.contract === 'agh.shell' ? 'shell' : 'registry',
          targets: [...original.targets],
          ...(renderer ? { descriptor: original } : { export: original.entry.export }),
        }),
        entryPath: path,
        renderKey: renderer ? original.renderKey : null,
      })
    }
    check(contributions.length <= 128, 'schema_invalid')
    bundles.push({
      bundleId: readWire('Id', row.bundleId),
      target,
      packageId,
      version: owner.version,
      packageDigest: owner.digest,
      sourceRef: owner.sourceRef,
      manifestDigest,
      assetDigest: readWire('Digest', row.digest),
      entry,
      entryPath,
      contributions,
    })
  }
  check(
    new Set(bundles.map((row) => JSON.stringify([row.bundleId, row.target]))).size === bundles.length,
    'duplicate_ui_bundle',
  )
  const seen = new Set<string>(),
    renderers = new Set<string>()
  for (const bundle of bundles) {
    for (const contribution of bundle.contributions) {
      const identity = JSON.stringify([bundle.packageId, contribution.contributionId, bundle.target])
      check(!seen.has(identity), 'duplicate_client_contribution')
      seen.add(identity)
      if (contribution.kind === 'renderer') {
        const renderer = JSON.stringify([bundle.target, contribution.contributionId])
        check(!renderers.has(renderer), 'duplicate_renderer_id')
        renderers.add(renderer)
      }
    }
  }
  return bundles
}

/** Derive identities from locked manifests, never from client-supplied module descriptors. */
export function produceClientLock(input: ReleaseSetInputs, delivered: unknown[]): Outcome<ClientLock> {
  return attempt(() => {
    const config = readWire('ConfigResolveResult', input.configuration)
    const bundles = deriveClientBundles(input, delivered)
    const targets = [...new Set(config.profile.client.requiredTargets)]
    const diagnostics: ClientLock['diagnostics'] = []
    const selections = targets.map((target) => {
      const lookup = (ref: { packageId: string; contributionId: string }, kind: Contribution['kind']) => {
        const matches = bundles
          .filter((bundle) => bundle.target === target && bundle.packageId === ref.packageId)
          .flatMap((bundle) => bundle.contributions)
          .filter((row) => row.contributionId === ref.contributionId && row.kind === kind)
        check(matches.length === 1, 'client_contribution_missing')
        return { ...ref }
      }
      const shell = target === 'web' ? lookup(config.profile.client.shell, 'shell') : null
      const registry = lookup(config.profile.client.registry, 'registry')
      const fallbackRenderer = lookup(config.profile.client.fallbackRenderer, 'renderer')
      const rendererSelections = config.profile.client.rendererSelections.filter((row, index) => {
        if (row.target === target) return true
        diagnostics.push({ code: 'renderer_selection_other_target', target, index })
        return false
      })
      const keys = new Set<string>()
      for (const selected of rendererSelections) {
        check(!keys.has(selected.renderKey), 'duplicate_renderer_selection')
        keys.add(selected.renderKey)
        const matches = bundles
          .filter((bundle) => bundle.target === target)
          .flatMap((bundle) => bundle.contributions)
          .filter(
            (row) =>
              row.kind === 'renderer' &&
              row.contributionId === selected.rendererId &&
              row.renderKey === selected.renderKey,
          )
        check(matches.length === 1, 'client_contribution_missing')
      }
      return readWire('ClientSelection', { target, shell, registry, fallbackRenderer, rendererSelections })
    })
    return freeze({ selections, bundles, diagnostics })
  })
}

/** Read compatibility never qualifies a selected new client without its derived proof. */
export function verifyClientLock(input: ReleaseSetInputs, body: unknown): void {
  const object = body as Record<string, unknown>
  const hasLock = Object.hasOwn(object, 'clientLock')
  fields(body, hasLock ? ['bundles', 'clientLock'] : ['bundles'], '/clientBundlesRef/value')
  const profile = input.configuration.profile.client
  const refs = [profile.shell, profile.registry, profile.fallbackRenderer]
  const selectedNew =
    profile.rendererSelections.length > 0 ||
    refs.some((ref) => {
      const pkg = input.resolution.lockGraph.entries.find((row) => row.packageId === ref.packageId)
      if (!pkg) return true
      const manifest = readContent(pkg.manifestRef, '/client/manifest', input.fixture.contents)
      return !(
        manifest !== null &&
        typeof manifest === 'object' &&
        !Array.isArray(manifest) &&
        Object.keys(manifest).sort().join(',') === 'packageDigest,packageId,version' &&
        manifest.packageId === pkg.packageId &&
        manifest.version === pkg.version &&
        manifest.packageDigest === pkg.digest
      )
    })
  if (!selectedNew && !hasLock) {
    deriveClientBundles(input, array(object.bundles, '/clientBundlesRef/bundles'))
    return // Existing non-deployable public fixtures retain their old selection gate.
  }
  check(hasLock, 'client_selection_unimplemented')
  const produced = produceClientLock(input, array(object.bundles, '/clientBundlesRef/bundles'))
  check(produced.ok, produced.ok ? 'schema_invalid' : (produced.error.detailCode ?? 'schema_invalid'))
  check(
    object.clientLock !== null &&
      typeof object.clientLock === 'object' &&
      Object.hasOwn(object.clientLock, 'selections') &&
      Object.hasOwn(object.clientLock, 'bundles'),
    'client_selection_unimplemented',
  )
  const stored = fields(
    object.clientLock,
    ['selections', 'bundles', 'diagnostics'],
    '/clientBundlesRef/clientLock',
  )
  check(
    array(stored.selections, '/clientLock/selections').length > 0 &&
      array(stored.bundles, '/clientLock/bundles').every((row) => {
        if (row === null || typeof row !== 'object' || !('contributions' in row)) return false
        return array(row.contributions, '/clientLock/contributions').every(
          (member) =>
            member !== null &&
            typeof member === 'object' &&
            Object.hasOwn(member, 'kind') &&
            Object.hasOwn(member, 'kind' in member && member.kind === 'renderer' ? 'descriptor' : 'export'),
        )
      }),
    'client_selection_unimplemented',
  )
  check(equal(produced.value, object.clientLock), 'client_lock_mismatch')
}
