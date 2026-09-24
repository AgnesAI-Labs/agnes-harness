import {
  buildMountIdentity,
  type EntryRow,
  type MountIdentityInput,
  type NormalizedPluginRuntime,
} from '@agnes/cordis-loader'

export type PluginRow = EntryRow

export interface PluginRowInput {
  readonly id: string
  readonly plugin: string
  readonly snapshotDigest: string
  readonly exportName: string
  readonly entryRevision: string
  readonly extrasRevision: string
  readonly mountRevision: string
  readonly config?: unknown
  readonly inject?: readonly string[]
  readonly disabled?: boolean
  readonly isolate?: Readonly<Record<string, string>>
  readonly provides?: readonly string[]
  readonly runtime?: NormalizedPluginRuntime
}

function sortedUnique(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze([...new Set(values ?? [])].sort())
}

function sortedRecord(
  values: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = Object.create(null)
  if (values) for (const key of Object.keys(values).sort()) output[key] = values[key] as string
  return Object.freeze(output)
}

function snapshotConfig(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotConfig))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = snapshotConfig((value as Record<string, unknown>)[key])
    }
    return Object.freeze(output)
  }
  return value
}

function staticComponent(value: string): never {
  throw Object.assign(new Error(`static component cannot be represented as a plugin row: ${value}`), {
    code: 'E_STATIC_COMPONENT' as const,
  })
}

/** Normalize a package contribution before it enters an EntryTree. */
export function createPluginRow(input: PluginRowInput): Readonly<EntryRow> {
  if (input.id === 'seam:platform' || input.id === 'seam:sandbox') staticComponent(input.id)
  const runtime = input.runtime ?? 'in-process'
  const inject = sortedUnique(input.inject)
  const isolate = sortedRecord(input.isolate)
  const provides = sortedUnique(input.provides)
  const forbiddenProvide = provides.find(
    (service) => service === 'seam:platform' || service === 'seam:sandbox',
  )
  if (forbiddenProvide) staticComponent(forbiddenProvide)
  const identity: MountIdentityInput = {
    snapshotDigest: input.snapshotDigest,
    exportName: input.exportName,
    entryRevision: input.entryRevision,
    extrasRevision: input.extrasRevision,
    plugin: input.plugin,
    inject,
    isolate,
    provides,
    runtime,
    mountRevision: input.mountRevision,
  }
  const row: EntryRow = {
    id: input.id,
    plugin: input.plugin,
    inject,
    disabled: input.disabled ?? false,
    isolate,
    provides,
    runtime,
    mountIdentity: buildMountIdentity(identity),
    mountRevision: input.mountRevision,
    entryRevision: input.entryRevision,
    extrasRevision: input.extrasRevision,
    ...(input.config === undefined ? {} : { config: snapshotConfig(input.config) }),
  }
  return Object.freeze(row)
}
