import { packageOfRow } from '@agnes/daemon-foundation/composite-desired'
import {
  decodeRuntimeTargetArtifact,
  type PluginRow,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import type { ClientModuleRegistryOptions } from './client-modules.js'

const REVISION = /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/

type RuntimeClientTruth = Readonly<{
  useArtifact: boolean
  active: ReadonlyMap<string, Readonly<{ packageId: string; revision: string }>>
  backend: ReadonlyMap<string, Readonly<{ packageId: string; revision: string }>>
  referenced: ReadonlyMap<string, ReadonlySet<string>>
}>

/**
 * Decode the daemon-minted browser locator without searching for `/client` in
 * the whole string: scoped package names may themselves contain that prefix.
 */
function webRowReference(row: PluginRow): Readonly<{ packageId: string; revision: string }> | undefined {
  if (!row.id.startsWith('web:')) return undefined
  const packageId = packageOfRow(row.plugin)
  if (!packageId) return undefined
  const prefix = `${packageId}@`
  if (!row.plugin.startsWith(prefix)) return undefined
  const remainder = row.plugin.slice(prefix.length)
  const separator = remainder.indexOf('/')
  if (separator < 1) return undefined
  const revision = remainder.slice(0, separator)
  const clientPath = remainder.slice(separator)
  if (clientPath !== '/client' && !clientPath.startsWith('/client/')) return undefined
  return REVISION.test(revision) ? { packageId, revision } : undefined
}

function webRowRevision(row: PluginRow): Readonly<{ packageId: string; revision: string }> | undefined {
  return row.disabled ? undefined : webRowReference(row)
}

export function runtimeClientTruth(
  artifacts: ReturnType<NonNullable<ClientModuleRegistryOptions['runtimeArtifacts']>>,
): RuntimeClientTruth {
  if (!artifacts) return { useArtifact: false, active: new Map(), backend: new Map(), referenced: new Map() }
  const active = new Map<string, Readonly<{ packageId: string; revision: string }>>()
  const backend = new Map<string, Readonly<{ packageId: string; revision: string }>>()
  const referenced = new Map<string, Set<string>>()
  const readRows = (artifact: RuntimeTargetArtifact | undefined): readonly Readonly<PluginRow>[] => {
    if (!artifact) return []
    try {
      return decodeRuntimeTargetArtifact(artifact).tree.rows
    } catch {
      return []
    }
  }
  for (const artifact of [artifacts.desired, artifacts.previous, artifacts.lastGood]) {
    for (const row of readRows(artifact)) {
      const reference = webRowReference(row)
      if (!reference) continue
      const set = referenced.get(reference.packageId) ?? new Set<string>()
      set.add(reference.revision)
      referenced.set(reference.packageId, set)
    }
  }
  const selected = artifacts.lastGood ?? artifacts.desired
  for (const row of readRows(selected)) {
    const selected = webRowRevision(row)
    if (selected) active.set(row.id, selected)
    if (!row.disabled && !row.id.startsWith('web:')) {
      const packageId = packageOfRow(row.plugin)
      if (packageId) backend.set(row.id, { packageId, revision: row.entryRevision })
    }
  }
  return {
    useArtifact: Boolean(artifacts.lastGood || artifacts.desired || artifacts.previous),
    active,
    backend,
    referenced,
  }
}
