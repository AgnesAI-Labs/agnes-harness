import { readFileSync } from 'node:fs'
import { parseSemver, satisfiesApiRange } from '@agnes/extension-api'
import {
  capabilityHash,
  containedEntry,
  hashDirectory,
  hashWorkspace,
  type InstalledInventory,
  type InstalledPackage,
  parseAgnesPluginEntries,
  readSurfaceInstances,
  stableInventoryRows,
} from '@agnes/package-manager'
import { inspectJsonData, validateSurfaceDescriptor, validateSurfaceServiceGrant } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { pluginRowSource } from '../ext-host/row-extension-host.js'
import { canonicalJson, sha256hex } from '../profile/canonical.js'
import { rangeNarrows } from './ranges.js'
import type { DeploymentPolicy, ResolvedDeployment } from './types.js'

const key = (grant: { extension: string; name: string }) => `${grant.extension}/${grant.name}`
const sorted = <T extends { extension: string; name: string }>(grants: readonly T[]) =>
  [...grants].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
const hash = (value: unknown) => `sha256-${sha256hex(canonicalJson(value))}`
function fail(message: string): never {
  throw new HostError('E_EXT_LOAD', message)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function copy<T>(value: T, maxBytes: number): T {
  const checked = inspectJsonData(value, maxBytes)
  if (!checked.ok) fail('deployment input is not bounded JSON data')
  return checked.value as T
}
function policySnapshot(input: DeploymentPolicy): DeploymentPolicy {
  const policy = copy(input, 1048576)
  if (
    Object.keys(policy).sort().join() !== 'grants,harnessVersion,surfaceApiVersion' ||
    !parseSemver(policy.harnessVersion) ||
    !parseSemver(policy.surfaceApiVersion) ||
    !policy.grants ||
    typeof policy.grants !== 'object' ||
    Array.isArray(policy.grants)
  )
    fail('deployment policy is invalid')
  const entries = Object.entries(policy.grants)
  if (entries.length > 256) fail('deployment policy is too large')
  for (const [source, grants] of entries) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(source) ||
      !Array.isArray(grants) ||
      grants.length > 64 ||
      new Set(grants.map(key)).size !== grants.length
    )
      fail('deployment source policy is invalid')
    for (const grant of grants)
      if (!validateSurfaceServiceGrant(grant).ok || !rangeNarrows(grant.range, '*'))
        fail('deployment grant policy is invalid')
  }
  return {
    ...policy,
    grants: Object.fromEntries(entries.map(([source, grants]) => [source, sorted(grants)])),
  }
}
function usable(row: InstalledPackage): boolean {
  return row.trusted && row.enabled && row.entry.state.enabled && row.blockers.length === 0
}
function verifyTree(row: InstalledPackage): string {
  if (
    !row.directory ||
    !row.entry.treeIntegrity ||
    hashDirectory(row.directory, { exclude: [] }) !== row.entry.treeIntegrity
  )
    fail('deployment package bytes differ from inventory')
  if (
    canonicalJson(row.contributions) !== canonicalJson(row.entry.contributions) ||
    row.capabilityHash !== capabilityHash(row.entry)
  )
    fail('deployment package metadata differs from inventory')
  if (
    row.entry.trust !== 'builtin' &&
    (row.entry.state.trusted === null ||
      row.entry.trustDecision?.integrity !== row.entry.integrity ||
      row.entry.trustDecision.capabilityHash !== row.capabilityHash)
  )
    fail('deployment package trust differs from inventory')
  return row.directory
}
type Service = ResolvedDeployment['surfaces'][number]['services'][number]
/** Caller retains inventory/deployment admission until the future controller accepts this exact plan. */
export function resolveDeployment(
  input: InstalledInventory,
  directory: string,
  policyInput: DeploymentPolicy,
): ResolvedDeployment {
  const inventory = copy(input, 67108864),
    policy = policySnapshot(policyInput)
  if (!Array.isArray(inventory.packages) || inventory.hash !== hash(stableInventoryRows(inventory.packages)))
    fail('deployment inventory snapshot hash differs')
  const before = hashWorkspace(directory),
    { manifest, instances } = readSurfaceInstances(directory)
  if (!satisfiesApiRange(manifest.harnessRange, policy.harnessVersion))
    fail('deployment harness version is incompatible')
  const packages = new Map<string, InstalledPackage>(),
    services = new Map<string, Service>(),
    owners = new Set<string>()
  for (const row of inventory.packages) {
    if (packages.has(row.id)) fail('deployment inventory has duplicate package ids')
    packages.set(row.id, row)
    if (!usable(row)) continue
    const root = verifyTree(row)
    const manifestPath = containedEntry(root, 'package.json', 'file', 'deployment')
    let declared: ReturnType<typeof parseAgnesPluginEntries>
    let version: string
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      const agnes = manifest.agnes as Record<string, unknown> | undefined
      declared = parseAgnesPluginEntries(row.id, agnes?.plugins)
      version = manifest.version as string
    } catch {
      fail('deployment plugin declaration is invalid')
    }
    if (version !== row.entry.version) fail('deployment package version differs from inventory')
    for (const plugin of declared) {
      if (owners.has(plugin.id)) fail('deployment inventory has duplicate plugin row ids')
      owners.add(plugin.id)
      for (const name of plugin.services ?? []) {
        const identity = { extension: pluginRowSource(plugin.id), name }
        if (services.has(key(identity))) fail('deployment service has multiple plugin providers')
        services.set(key(identity), {
          ...identity,
          version,
          package: row.id,
          integrity: row.entry.integrity,
        })
      }
    }
    verifyTree(row)
  }
  const mounts: string[] = [],
    sources = new Set<string>()
  const surfaces = instances
    .map(({ instance }) => {
      if (
        mounts.some(
          (mount) =>
            mount === instance.mount ||
            mount.startsWith(`${instance.mount}/`) ||
            instance.mount.startsWith(`${mount}/`),
        ) ||
        sources.has(instance.sourceId)
      )
        fail('deployment mount or source is duplicated or overlaps')
      mounts.push(instance.mount)
      sources.add(instance.sourceId)
      const row = packages.get(instance.package)
      if (!row || !usable(row)) fail('deployment package is not installed trusted and enabled')
      const contribution = row.contributions.find(
        (item) => item.kind === 'surface' && item.id === instance.surfaceId,
      )
      if (contribution?.kind !== 'surface') fail('deployment surface is not declared')
      const checked = validateSurfaceDescriptor(contribution.descriptor)
      if (!checked.ok || !satisfiesApiRange(checked.value.apiRange, policy.surfaceApiVersion))
        fail('deployment surface API is incompatible')
      const descriptor = checked.value,
        ceiling = policy.grants[instance.sourceId]
      if (!Object.hasOwn(policy.grants, instance.sourceId) || !ceiling)
        fail('deployment source has no managed grant policy')
      const resolved = descriptor.requires.services.map((requirement) => {
        const service = services.get(key(requirement))
        if (!service || !satisfiesApiRange(requirement.range, service.version))
          fail('deployment service is unavailable or incompatible')
        return service
      })
      for (const grant of instance.grants) {
        const required = descriptor.requires.services.find((item) => key(item) === key(grant)),
          allowed = ceiling.find((item) => key(item) === key(grant)),
          service = services.get(key(grant))
        if (
          !required ||
          !allowed ||
          !service ||
          !rangeNarrows(grant.range, required.range) ||
          !rangeNarrows(grant.range, allowed.range) ||
          !satisfiesApiRange(grant.range, service.version)
        )
          fail('deployment service grant widens its ceiling or excludes the installed version')
      }
      if (descriptor.artifact.kind === 'node')
        containedEntry(verifyTree(row), descriptor.artifact.entry, 'file', 'deployment')
      return {
        package: row.id,
        version: row.entry.version,
        integrity: row.entry.integrity,
        descriptor: { ...descriptor, requires: { services: sorted(descriptor.requires.services) } },
        instance: { ...instance, grants: sorted(instance.grants) },
        services: sorted(resolved),
      }
    })
    .sort((a, b) => (a.instance.mount < b.instance.mount ? -1 : 1))
  if (hashWorkspace(directory) !== before) fail('deployment files changed while resolving')
  const result = {
    id: manifest.id,
    version: manifest.version,
    inventoryHash: inventory.hash,
    deploymentHash: hash({
      manifest: { ...manifest, surfaces: [...(manifest.surfaces ?? [])].sort() },
      instances: instances
        .map(({ path, instance }) => ({ path, instance: { ...instance, grants: sorted(instance.grants) } }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    }),
    policyHash: hash(policy),
    surfaces,
  }
  return freeze({ ...result, hash: hash(result) })
}
