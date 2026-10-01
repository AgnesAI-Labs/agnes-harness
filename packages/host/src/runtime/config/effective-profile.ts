import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { classifyLegacyField, isLegacyPath, MAX_STEPS_FEATURE } from './legacy-fields.js'
import {
  type BlockedValue,
  type ConversionBody,
  type ConvertLegacyInput,
  type Diagnostic,
  type FieldRow,
  type Provenance,
  type ProviderConfig,
  readLegacyConfiguration,
  sessionAssign,
} from './legacy-profile-reader.js'

export type EffectiveStatus = 'accepted' | 'held' | 'refused'

export type PinnedConfiguration = {
  sessionParameters: Record<string, unknown>
  sessionBlocked: BlockedValue[]
  providerConfig: ProviderConfig
  features: string[]
  provenance: Provenance
  publishable: boolean
  sessionDigest: string
  providerDigest: string
  digest: string
}

export type EffectiveProfile = {
  status: EffectiveStatus
  publishable: boolean
  diagnostics: Diagnostic[]
  rows: FieldRow[]
  sessionParameters: Record<string, unknown> | null
  sessionBlocked: BlockedValue[]
  providerConfig: ProviderConfig | null
  features: string[]
  provenance: Provenance
  sessionDigest: string | null
  providerDigest: string | null
  pin: PinnedConfiguration | null
  /** True when a newer document was supplied and left unread. */
  latestIgnored: boolean
}

const json = (value: unknown): Parameters<typeof canonicalJsonDigest>[0] =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof canonicalJsonDigest>[0]

function digest(value: unknown): string {
  return canonicalJsonDigest(json(value))
}

function finish(body: ConversionBody, latestIgnored = false): EffectiveProfile {
  if (body.refused || !body.providerConfig) {
    return {
      status: 'refused',
      publishable: false,
      diagnostics: body.diagnostics,
      rows: body.rows,
      sessionParameters: null,
      sessionBlocked: [],
      providerConfig: null,
      features: [],
      provenance: body.provenance,
      sessionDigest: null,
      providerDigest: null,
      pin: null,
      latestIgnored,
    }
  }
  if (!body.sessionParameters) {
    const providerDigest = digest({ config: body.providerConfig, layers: body.provenance.layers })
    return {
      status: body.withheld ? 'held' : 'accepted',
      publishable: !body.withheld,
      diagnostics: body.diagnostics,
      rows: body.rows,
      sessionParameters: null,
      sessionBlocked: [],
      providerConfig: body.providerConfig,
      features: [],
      provenance: body.provenance,
      sessionDigest: null,
      providerDigest,
      pin: null,
      latestIgnored,
    }
  }
  const sessionBlocked = [...body.sessionBlocked].sort((a, b) => (a.path < b.path ? -1 : 1))
  const sessionDigest = digest({
    parameters: body.sessionParameters,
    blocked: sessionBlocked,
    chain: body.provenance.presetChain,
    features: body.features,
  })
  const providerDigest = digest({ config: body.providerConfig, layers: body.provenance.layers })
  const pin: PinnedConfiguration = {
    sessionParameters: body.sessionParameters,
    sessionBlocked,
    providerConfig: body.providerConfig,
    features: body.features,
    provenance: body.provenance,
    publishable: !body.withheld,
    sessionDigest,
    providerDigest,
    digest: digest({
      sessionDigest,
      providerDigest,
      features: body.features,
      provenance: body.provenance,
      publishable: !body.withheld,
    }),
  }
  return {
    status: body.withheld ? 'held' : 'accepted',
    publishable: !body.withheld,
    diagnostics: body.diagnostics,
    rows: body.rows,
    sessionParameters: body.sessionParameters,
    sessionBlocked,
    providerConfig: body.providerConfig,
    features: body.features,
    provenance: body.provenance,
    sessionDigest,
    providerDigest,
    pin,
    latestIgnored,
  }
}

/** Read legacy profile and preset documents into separate session and provider snapshots. */
export function convertLegacyConfiguration(input: ConvertLegacyInput): EffectiveProfile {
  return finish(readLegacyConfiguration(input))
}

/**
 * Restore a pinned snapshot.
 * A newer document is not merged, and a digest mismatch does not fall back to it.
 */
export function restorePinnedConfiguration(
  pin: PinnedConfiguration,
  latest?: ConvertLegacyInput,
): EffectiveProfile {
  const latestIgnored = latest !== undefined
  const sessionDigest = digest({
    parameters: pin.sessionParameters,
    blocked: pin.sessionBlocked,
    chain: pin.provenance.presetChain,
    features: pin.features,
  })
  const providerDigest = digest({ config: pin.providerConfig, layers: pin.provenance.layers })
  const digestMatches =
    sessionDigest === pin.sessionDigest &&
    providerDigest === pin.providerDigest &&
    digest({
      sessionDigest: pin.sessionDigest,
      providerDigest: pin.providerDigest,
      features: pin.features,
      provenance: pin.provenance,
      publishable: pin.publishable,
    }) === pin.digest
  if (!digestMatches) {
    return {
      status: 'refused',
      publishable: false,
      diagnostics: [
        {
          code: 'pin_digest_mismatch',
          path: '/',
          message: latestIgnored
            ? 'pinned configuration digest does not match its content; the latest document was not applied'
            : 'pinned configuration digest does not match its content',
        },
      ],
      rows: [],
      sessionParameters: null,
      sessionBlocked: [],
      providerConfig: null,
      features: [],
      provenance: pin.provenance,
      sessionDigest: null,
      providerDigest: null,
      pin: null,
      latestIgnored,
    }
  }
  return {
    status: pin.publishable ? 'accepted' : 'held',
    publishable: pin.publishable,
    diagnostics: [],
    rows: [],
    sessionParameters: pin.sessionParameters,
    sessionBlocked: pin.sessionBlocked,
    providerConfig: pin.providerConfig,
    features: pin.features,
    provenance: pin.provenance,
    sessionDigest: pin.sessionDigest,
    providerDigest: pin.providerDigest,
    pin,
    latestIgnored,
  }
}

/**
 * Change one session parameter.
 * A provider path is refused and the caller's previous profile is left unchanged.
 */
export function applySessionParameterChange(
  profile: EffectiveProfile,
  path: string,
  value: unknown,
): EffectiveProfile {
  const field = isLegacyPath('preset', path) ? classifyLegacyField('preset', path) : undefined
  if (
    !profile.sessionParameters ||
    !profile.providerConfig ||
    !field ||
    field.bucket !== 'session' ||
    !field.placed
  ) {
    return {
      status: 'refused',
      publishable: false,
      diagnostics: [
        ...profile.diagnostics,
        { code: 'session_patch_rejected', path, message: `${path} is not a session parameter` },
      ],
      rows: profile.rows,
      sessionParameters: null,
      sessionBlocked: [],
      providerConfig: null,
      features: [],
      provenance: profile.provenance,
      sessionDigest: null,
      providerDigest: null,
      pin: null,
      latestIgnored: false,
    }
  }
  const next = structuredClone(profile.sessionParameters)
  sessionAssign(next, path, value)
  const validated = validateRuntime('DefaultSessionParameters', next)
  if (!validated.ok) {
    return {
      status: 'refused',
      publishable: false,
      diagnostics: [{ code: 'schema_invalid', path, message: 'session parameter change failed validation' }],
      rows: profile.rows,
      sessionParameters: null,
      sessionBlocked: [],
      providerConfig: null,
      features: [],
      provenance: profile.provenance,
      sessionDigest: null,
      providerDigest: null,
      pin: null,
      latestIgnored: false,
    }
  }
  const features =
    typeof (validated.value as { budget?: { max_steps?: unknown } }).budget?.max_steps === 'number'
      ? [MAX_STEPS_FEATURE]
      : profile.features.filter((item) => item !== MAX_STEPS_FEATURE)
  return finish({
    diagnostics: profile.diagnostics.filter((item) => item.code !== 'schema_invalid'),
    rows: profile.rows,
    sessionParameters: validated.value as Record<string, unknown>,
    sessionBlocked: profile.sessionBlocked,
    providerConfig: profile.providerConfig,
    features,
    provenance: profile.provenance,
    refused: false,
    withheld: profile.status === 'held',
  })
}
