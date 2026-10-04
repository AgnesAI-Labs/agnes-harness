import { jcs } from '@agnes/protocol'
import type { ConfigResolveResult, DataRef } from '@agnes/protocol/runtime'
import { validateOwnedAuthorSchemaSource } from '@agnes/protocol/runtime'
import type { ResolvedReleaseInputs } from './inputs.js'
import { array, digest, equal, fields, readContent, readWire, requireRelease } from './primitives.js'

export const APPLIED_CONFIGURATION_KIND = 'assembly-applied' as const

/** Decode the original selected author's schema; no provisional Host schema is issued here. */
export function readAppliedConfiguration(
  ref: DataRef,
  configuration: ConfigResolveResult,
  schemasRef: DataRef,
  contents: ResolvedReleaseInputs['observations']['contents'],
): Record<string, unknown> {
  const materials = fields(
    readContent(schemasRef, '/schemasRef', contents),
    ['schemas', 'builtinContracts', 'contracts'],
    '/schemasRef',
  )
  const source = array(materials.schemas, '/schemasRef/schemas')
    .map(validateOwnedAuthorSchemaSource)
    .find((row) => equal(row.ref, ref.schema))
  const original = readContent(ref, '/configuration', contents)
  requireRelease(source?.validate(original).ok, 'applied_configuration_codec_mismatch', '/configuration')
  const envelope = fields(original, ['canonicalJson', 'contentDigest'], '/configuration')
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
      equal(readWire('ConfigResolveResult', row.configuration), configuration),
    'applied_configuration_source_mismatch',
    '/configuration',
  )
  return row
}
