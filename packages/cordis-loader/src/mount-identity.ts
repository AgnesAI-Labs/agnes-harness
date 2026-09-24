import { canonicalStringMap, canonicalStringSet, encodeCanonicalRecord } from './codec.js'
import type { MountIdentity, MountIdentityInput } from './entry-row.js'

/** Build the sole canonical identity used by EntryTree to select update versus remount. */
export function buildMountIdentity(input: MountIdentityInput): MountIdentity {
  if (input.runtime !== 'in-process' && input.runtime !== 'isolated') {
    throw new TypeError(`invalid normalized plugin runtime: ${String(input.runtime)}`)
  }
  const encoded = encodeCanonicalRecord({
    snapshotDigest: input.snapshotDigest,
    exportName: input.exportName,
    entryRevision: input.entryRevision,
    extrasRevision: input.extrasRevision,
    plugin: input.plugin,
    inject: canonicalStringSet(input.inject),
    isolate: canonicalStringMap(input.isolate),
    provides: canonicalStringSet(input.provides),
    runtime: input.runtime,
    mountRevision: input.mountRevision,
  })
  return `agnes-mount-v1:${encoded}` as MountIdentity
}
