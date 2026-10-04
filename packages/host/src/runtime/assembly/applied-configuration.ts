import { jcs } from '@agnes/protocol'
import type { ConfigResolveResult, DataRef } from '@agnes/protocol/runtime'
import { digest, equal, fields, freeze, readWire, requireRelease } from './primitives.js'

/** Host-private provisional codec. Its identity and application proof await protocol-owner confirmation. */
export const APPLIED_CONFIGURATION_KIND = 'assembly-applied-awaiting-protocol-confirmation' as const
const typeId = 'agh.assembly/applied-configuration-awaiting-confirmation@1'
export const appliedConfigurationSchema = freeze({
  typeId,
  revision: 1,
  digest: digest({ typeId, schemaStatus: 'provisional-awaiting-protocol-owner-confirmation' }),
})

export function appliedConfigurationRef(value: unknown): DataRef {
  const canonicalJson = jcs(readWire('JsonValue', value))
  const json = { canonicalJson, contentDigest: digest(value) }
  return readWire('DataRef', {
    kind: 'inline',
    schema: appliedConfigurationSchema,
    value: json,
    digest: digest(json),
    bytes: Buffer.byteLength(jcs(json)),
  })
}
export function readAppliedConfiguration(
  ref: DataRef,
  configuration: ConfigResolveResult,
): Record<string, unknown> {
  requireRelease(
    ref.kind === 'inline' && equal(ref.schema, appliedConfigurationSchema),
    'applied_configuration_codec_mismatch',
    '/configuration',
  )
  const envelope = fields(ref.value, ['canonicalJson', 'contentDigest'], '/configuration')
  requireRelease(
    typeof envelope.canonicalJson === 'string',
    'applied_configuration_codec_mismatch',
    '/configuration',
  )
  const decoded = readWire('JsonValue', JSON.parse(envelope.canonicalJson))
  requireRelease(
    jcs(decoded) === envelope.canonicalJson && digest(decoded) === envelope.contentDigest,
    'applied_configuration_source_mismatch',
    '/configuration',
  )
  const row = fields(
    decoded,
    ['kind', 'configuration', 'features', 'bundles', 'jointDomains', 'directory', 'deployments'],
    '/configuration',
  )
  requireRelease(
    row.kind === APPLIED_CONFIGURATION_KIND &&
      equal(readWire('ConfigResolveResult', row.configuration), configuration) &&
      equal(ref, appliedConfigurationRef(decoded)),
    'applied_configuration_source_mismatch',
    '/configuration',
  )
  return row
}
