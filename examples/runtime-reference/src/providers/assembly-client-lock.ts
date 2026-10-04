import { createHash } from 'node:crypto'
import type { Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { type ClientSelection, type RuntimeWireTypes, validateRuntime } from '@agnes/protocol/runtime'

type ClientTarget = ClientSelection['target']
function targetOf(data: unknown): ClientTarget {
  for (const value of ['sdk', 'im', 'tui', 'web'] as const) if (data === value) return value
  throw new MappingRefusal('schema_invalid')
}
type Wire = RuntimeWireTypes
export interface ReferenceClientLockInput {
  plan: { targetReleaseSet: Wire['ReleaseSet'] }
  configuration: Wire['ConfigResolveResult']
  resolution: Wire['PackageResolverResolveResult']
  fixture: { contents: { ref: Wire['DataRef']; value: Wire['JsonValue'] }[] }
}
type Member = Wire['ClientModuleContribution'] & {
  entryPath: string
  renderKey: string | null
}
type Bundle = {
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
  contributions: Member[]
}
interface Mapping {
  selections: ClientSelection[]
  bundles: Bundle[]
  diagnostics: { code: 'renderer_selection_other_target'; target: ClientTarget; index: number }[]
}
class MappingRefusal extends Error {}
function insist(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new MappingRefusal(reason)
}
function parse<K extends keyof Wire>(name: K, data: unknown): Wire[K] {
  const checked = validateRuntime(name, data)
  insist(checked.ok, 'schema_invalid')
  return checked.value
}
function rows(data: unknown): unknown[] {
  insist(Array.isArray(data), 'schema_invalid')
  return data
}
function record(data: unknown, keys: string[]): Record<string, unknown> {
  insist(data && typeof data === 'object' && !Array.isArray(data), 'schema_invalid')
  insist(Object.keys(data).sort().join('|') === keys.sort().join('|'), 'schema_invalid')
  return data as Record<string, unknown>
}
function encode(data: unknown): string {
  return jcs(data as Wire['JsonValue'])
}
function hash(data: unknown): string {
  return createHash('sha256').update(encode(data)).digest('hex')
}
function retrieve(ref: Wire['DataRef'], input: ReferenceClientLockInput): Wire['JsonValue'] {
  const candidates =
    ref.kind === 'inline'
      ? [{ value: ref.value }]
      : input.fixture.contents.filter((item) => encode(item.ref) === encode(ref))
  insist(candidates.length === 1, 'content_unavailable')
  const value = candidates[0]?.value
  const identity = ref.kind === 'inline' ? ref : ref.blob
  insist(
    value !== undefined &&
      hash(value) === identity.digest &&
      Buffer.byteLength(encode(value)) === identity.bytes,
    'content_identity_mismatch',
  )
  return value
}
function detached<T>(data: T): T {
  if (data && typeof data === 'object') {
    Object.values(data).forEach(detached)
    Object.freeze(data)
  }
  return data
}
function protect<T>(work: () => T): Outcome<T> {
  try {
    return { ok: true, value: detached(work()) }
  } catch (cause) {
    const reason = cause instanceof MappingRefusal ? cause.message : 'schema_invalid'
    return {
      ok: false,
      error: {
        code:
          reason === 'schema_invalid'
            ? 'invalid_input'
            : reason.includes('unimplemented')
              ? 'incompatible'
              : 'conflict',
        detailCode: reason,
        message: 'Reference client lock refused the locked inputs',
        retryAdvice: { kind: 'never' },
        diagnosticId: 'reference-client-lock',
      },
    }
  }
}
function catalog(input: ReferenceClientLockInput, payload: unknown[]): Bundle[] {
  const packages = parse('ReleaseSet', input.plan.targetReleaseSet).packages
  const entries = parse('PackageResolverResolveResult', input.resolution).lockGraph.entries
  const result: Bundle[] = []
  for (const payloadItem of payload) {
    const data = record(payloadItem, [
      'bundleId',
      'digest',
      'target',
      'schemas',
      'packageId',
      'version',
      'entry',
      'viewSchemaRanges',
    ])
    const id = parse('Id', data.packageId),
      target = targetOf(data.target),
      key = parse('Id', data.entry)
    const owned = packages.filter((item) => item.packageId === id),
      located = entries.filter((item) => item.packageId === id)
    insist(owned.length <= 1 && located.length <= 1, 'client_package_mismatch')
    const pkg = owned[0],
      source = located[0]
    insist(pkg && source, 'client_package_missing')
    const provenance =
      source.manifestRef.kind === 'inline' ? source.manifestRef.digest : source.manifestRef.blob.digest
    insist(
      [pkg.version, source.version].every((version) => version === data.version) &&
        pkg.digest === source.digest &&
        source.locator.digest === pkg.digest &&
        pkg.sourceRef === source.locator.sourceId &&
        pkg.integrityRef === provenance,
      'client_package_mismatch',
    )
    const definition = parse('RuntimePluginManifest', retrieve(source.manifestRef, input))
    insist(
      definition.id === id && definition.version === pkg.version && definition.packageDigest === pkg.digest,
      'client_package_mismatch',
    )
    const path = definition.entries[key as keyof typeof definition.entries]
    const bytes = definition.files.filter((item) => item.path === path)
    const asset = Object.hasOwn(pkg.entries, key) ? pkg.entries[key] : undefined
    insist(
      key === target &&
        path &&
        bytes.length === 1 &&
        bytes[0]?.digest === data.digest &&
        asset?.digest === data.digest &&
        asset?.platform === target,
      'client_entry_mismatch',
    )
    const members: Member[] = []
    for (const service of definition.clientServices) {
      insist(service.packageDigest === pkg.digest, 'client_package_mismatch')
      insist(service.targets.length === new Set(service.targets).size, 'client_target_mismatch')
      if (!service.targets.some((item) => item === target)) continue
      insist(service.entry.entry === path, 'client_entry_mismatch')
      members.push({
        ...parse('ClientModuleContribution', {
          contributionId: service.id,
          kind: service.contract === 'agh.shell' ? 'shell' : 'registry',
          targets: service.targets.slice(),
          export: service.entry.export,
        }),
        entryPath: service.entry.entry,
        renderKey: null,
      })
    }
    for (const renderer of definition.renderers) {
      insist(renderer.packageDigest === pkg.digest, 'client_package_mismatch')
      insist(renderer.targets.length === new Set(renderer.targets).size, 'client_target_mismatch')
      if (renderer.targets.indexOf(target) < 0) continue
      insist(renderer.entry === path, 'client_entry_mismatch')
      members.push({
        ...parse('ClientModuleContribution', {
          kind: 'renderer',
          contributionId: renderer.id,
          targets: renderer.targets.slice(),
          descriptor: renderer,
        }),
        entryPath: renderer.entry,
        renderKey: renderer.renderKey,
      })
    }
    insist(members.length <= 128, 'schema_invalid')
    result.push({
      bundleId: parse('Id', data.bundleId),
      target,
      packageId: id,
      version: pkg.version,
      packageDigest: pkg.digest,
      sourceRef: pkg.sourceRef,
      manifestDigest: provenance,
      assetDigest: parse('Digest', data.digest),
      entry: key,
      entryPath: path,
      contributions: members,
    })
  }
  insist(
    result.every(
      (item, index) =>
        !result
          .slice(0, index)
          .some((other) => other.bundleId === item.bundleId && other.target === item.target),
    ),
    'duplicate_ui_bundle',
  )
  for (let current = 0; current < result.length; current++) {
    const bundle = result[current]
    if (!bundle) continue
    const previous = result.slice(0, current).filter((item) => item.target === bundle.target)
    const local = new Set<string>()
    for (const member of bundle.contributions) {
      insist(
        !local.has(member.contributionId) &&
          !previous.some(
            (item) =>
              item.packageId === bundle.packageId &&
              item.contributions.some((other) => other.contributionId === member.contributionId),
          ),
        'duplicate_client_contribution',
      )
      local.add(member.contributionId)
      insist(
        member.kind !== 'renderer' ||
          !previous.some((item) =>
            item.contributions.some(
              (other) => other.kind === 'renderer' && other.contributionId === member.contributionId,
            ),
          ),
        'duplicate_renderer_id',
      )
    }
  }
  return result
}
export function produceReferenceClientLock(
  input: ReferenceClientLockInput,
  payload: unknown[],
): Outcome<Mapping> {
  return protect(() => {
    const client = parse('ConfigResolveResult', input.configuration).profile.client
    const bundles = catalog(input, payload)
    const allTargets = Array.from(new Set(client.requiredTargets))
    const diagnostics: Mapping['diagnostics'] = []
    const selections: ClientSelection[] = []
    for (const target of allTargets) {
      const available = bundles.filter((item) => item.target === target)
      const resolve = (reference: Wire['ClientContributionRef'], kind: Member['kind']) => {
        const candidates = available
          .filter((item) => item.packageId === reference.packageId)
          .flatMap((item) => item.contributions)
          .filter((item) => item.kind === kind && item.contributionId === reference.contributionId)
        insist(candidates.length === 1, 'client_contribution_missing')
        return { packageId: reference.packageId, contributionId: reference.contributionId }
      }
      const shell = target === 'web' ? resolve(client.shell, 'shell') : null
      const registry = resolve(client.registry, 'registry'),
        fallbackRenderer = resolve(client.fallbackRenderer, 'renderer')
      const filtered: ClientSelection['rendererSelections'] = []
      client.rendererSelections.forEach((selected, index) => {
        if (selected.target !== target) {
          diagnostics.push({ code: 'renderer_selection_other_target', target, index })
          return
        }
        insist(
          !filtered.some((item) => item.renderKey === selected.renderKey),
          'duplicate_renderer_selection',
        )
        const matches = available
          .flatMap((item) => item.contributions)
          .filter(
            (item) =>
              item.kind === 'renderer' &&
              item.contributionId === selected.rendererId &&
              item.renderKey === selected.renderKey,
          )
        insist(matches.length === 1, 'client_contribution_missing')
        filtered.push({ ...selected })
      })
      selections.push(
        parse('ClientSelection', { target, shell, registry, fallbackRenderer, rendererSelections: filtered }),
      )
    }
    return { selections, bundles, diagnostics }
  })
}
export function verifyReferenceClientLock(input: ReferenceClientLockInput, raw: unknown): Outcome<void> {
  return protect(() => {
    insist(raw && typeof raw === 'object', 'schema_invalid')
    const included = Object.hasOwn(raw, 'clientLock')
    const body = record(raw, included ? ['bundles', 'clientLock'] : ['bundles'])
    const choices = input.configuration.profile.client
    const modern =
      choices.rendererSelections.length > 0 ||
      [choices.shell, choices.registry, choices.fallbackRenderer].some((ref) => {
        const source = input.resolution.lockGraph.entries.find((item) => item.packageId === ref.packageId)
        if (!source) return true
        const value = retrieve(source.manifestRef, input)
        return !(
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          encode(Object.keys(value).sort()) === encode(['packageDigest', 'packageId', 'version']) &&
          value.packageId === source.packageId &&
          value.version === source.version &&
          value.packageDigest === source.digest
        )
      })
    if (!modern && !included) {
      catalog(input, rows(body.bundles))
      return
    }
    insist(included, 'client_selection_unimplemented')
    const result = produceReferenceClientLock(input, rows(body.bundles))
    insist(result.ok, result.ok ? 'schema_invalid' : (result.error.detailCode ?? 'schema_invalid'))
    insist(
      body.clientLock &&
        typeof body.clientLock === 'object' &&
        Object.hasOwn(body.clientLock, 'selections') &&
        Object.hasOwn(body.clientLock, 'bundles'),
      'client_selection_unimplemented',
    )
    const mapping = record(body.clientLock, ['selections', 'bundles', 'diagnostics'])
    insist(
      rows(mapping.selections).length > 0 &&
        rows(mapping.bundles).every((item) => {
          if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'contributions')) return false
          const contents = (item as Record<string, unknown>).contributions
          return rows(contents).every(
            (member) =>
              member &&
              typeof member === 'object' &&
              Object.hasOwn(member, 'kind') &&
              Object.hasOwn(
                member,
                (member as Record<string, unknown>).kind === 'renderer' ? 'descriptor' : 'export',
              ),
          )
        }),
      'client_selection_unimplemented',
    )
    insist(encode(result.value) === encode(body.clientLock), 'client_lock_mismatch')
  })
}
