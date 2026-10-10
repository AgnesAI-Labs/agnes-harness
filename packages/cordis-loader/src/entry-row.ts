/** Runtime modes accepted by the ordinary plugin tree after manifest normalization. */
export type NormalizedPluginRuntime = 'in-process' | 'isolated'

/** Canonical identity used to decide whether a live row must be remounted. */
export type MountIdentity = string & { readonly __mountIdentity: unique symbol }

/** Every field that can change the mounted code, ownership, or isolation boundary. */
export interface MountIdentityInput {
  snapshotDigest: string
  exportName: string
  entryRevision: string
  liveResources?: readonly string[]
  liveResourceRevision?: string
  extrasRevision: string
  plugin: string
  inject: readonly string[]
  isolate: Readonly<Record<string, string>>
  provides: readonly string[]
  runtime: NormalizedPluginRuntime
  mountRevision: string
}

/** One normalized desired row consumed by EntryTree. */
export interface EntryRow {
  readonly id: string
  readonly plugin: string
  readonly configReload?: 'live' | 'next-session'
  readonly config?: unknown
  readonly inject: readonly string[]
  readonly disabled: boolean
  readonly isolate: Readonly<Record<string, string>>
  readonly provides: readonly string[]
  readonly runtime: NormalizedPluginRuntime
  readonly mountIdentity: MountIdentity
  readonly mountRevision: string
  readonly entryRevision: string
  /** Resource inputs may change while the code fields remain pinned. */
  readonly liveResources?: readonly string[]
  readonly liveResourceRevision?: string
  readonly codeMountIdentity?: MountIdentity
  readonly extrasRevision: string
}

/**
 * Copy the structural row fields at the apply boundary.
 *
 * The plugin-runtime adapter owns config validation and deep freezing. The loader only prevents
 * callers from changing the arrays, isolation map, or row properties after diffing.
 */
export function snapshotEntryRow(row: Readonly<EntryRow>): Readonly<EntryRow> {
  return Object.freeze({
    id: row.id,
    plugin: row.plugin,
    inject: Object.freeze([...row.inject]),
    disabled: row.disabled,
    isolate: Object.freeze({ ...row.isolate }),
    provides: Object.freeze([...row.provides]),
    runtime: row.runtime,
    mountIdentity: row.mountIdentity,
    mountRevision: row.mountRevision,
    entryRevision: row.entryRevision,
    extrasRevision: row.extrasRevision,
    ...(row.codeMountIdentity === undefined ? {} : { codeMountIdentity: row.codeMountIdentity }),
    ...(row.liveResources === undefined ? {} : { liveResources: Object.freeze([...row.liveResources]) }),
    ...(row.liveResourceRevision === undefined ? {} : { liveResourceRevision: row.liveResourceRevision }),
    ...(row.configReload === undefined ? {} : { configReload: row.configReload }),
    ...(row.config === undefined ? {} : { config: row.config }),
  })
}
