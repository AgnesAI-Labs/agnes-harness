import type { ReleaseSet, SchemaRef } from '@agnes/protocol/runtime'
import { array, equal, fields, readWire, requireRelease } from './primitives.js'

/** Closed Host-private bundle lock. Recovery codecs belong to provider bindings. */
export function verifyClientBundles(
  release: ReleaseSet,
  delivered: unknown[],
  required: unknown[],
  known: (schema: SchemaRef) => boolean,
): void {
  const check = (value: unknown, path: string) => {
    const row = fields(
      value,
      ['bundleId', 'digest', 'target', 'schemas', 'packageId', 'version', 'entry', 'viewSchemaRanges'],
      path,
    )
    readWire('Id', row.bundleId)
    const digest = readWire('Digest', row.digest)
    const packageId = readWire('Id', row.packageId)
    const version = readWire('Id', row.version)
    const entry = readWire('Id', row.entry)
    requireRelease(['web', 'tui', 'im', 'sdk'].includes(String(row.target)), 'schema_invalid', path)
    const schemas = array(row.schemas, path).map((ref) => readWire('SchemaRef', ref))
    requireRelease(schemas.every(known), 'schema_missing', `${path}/schemas`)
    const owner = release.packages.find((pkg) => pkg.packageId === packageId && pkg.version === version)
    const artifact = owner && Object.hasOwn(owner.entries, entry) ? owner.entries[entry] : undefined
    requireRelease(
      artifact && artifact.digest === digest && artifact.platform === row.target,
      'bundle_package_mismatch',
      path,
    )
    for (const raw of array(row.viewSchemaRanges, path)) {
      const range = readWire('ViewSchemaRange', raw)
      readWire('TypeId', range.typeId)
      readWire('UInt53', range.minRevision)
      readWire('UInt53', range.maxRevision)
      requireRelease(
        range.minRevision <= range.maxRevision &&
          schemas.some(
            (schema) =>
              schema.typeId === range.typeId &&
              schema.revision >= range.minRevision &&
              schema.revision <= range.maxRevision,
          ),
        'bundle_schema_range_mismatch',
        `${path}/viewSchemaRanges`,
      )
    }
  }
  for (const row of delivered) check(row, '/clientBundlesRef/bundles')
  required.forEach((row) => {
    check(row, '/configSnapshotRef/bundles')
    requireRelease(
      delivered.some((bundle) => equal(bundle, row)),
      'required_ui_bundle_missing',
      '/clientBundlesRef/bundles',
    )
  })
  requireRelease(
    new Set(
      delivered.map((row) => {
        const bundle = row as Record<string, unknown>
        return `${String(bundle.bundleId)}/${String(bundle.target)}`
      }),
    ).size === delivered.length,
    'duplicate_ui_bundle',
    '/clientBundlesRef/bundles',
  )
}
