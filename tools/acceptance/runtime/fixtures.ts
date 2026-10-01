import type {
  AssertionRecord,
  BuildIdentity,
  ReportDraft,
} from '../../../packages/extension-api/testkit/index.js'

/** Synthetic report rows. These are not service implementations. */
export const SAMPLE_BUILD: BuildIdentity = {
  codeSha: 'code-sha',
  buildDigest: 'build-digest',
  lockDigest: 'lock-digest',
  specVersion: 'spec-1',
  sdkVersion: 'sdk-1',
  sdkDigest: 'sdk-digest',
  platform: 'darwin-arm64',
}

export const SAMPLE_CLOCK = {
  startedAt: '2026-10-01T00:00:00.000Z',
  finishedAt: '2026-10-01T00:00:01.000Z',
} as const

export function sampleAssertion(overrides: Partial<AssertionRecord> = {}): AssertionRecord {
  return {
    id: 'loop-normal',
    contract: 'agh.loop',
    scenario: 'normal',
    qualification: 'required',
    providerId: 'reference',
    providerDigest: 'provider-digest',
    recipe: 'sample',
    features: ['read'],
    build: SAMPLE_BUILD,
    consumer: 'consumer',
    command: 'conformance',
    startedAt: SAMPLE_CLOCK.startedAt,
    finishedAt: SAMPLE_CLOCK.finishedAt,
    status: 'passed',
    configDigest: 'config-digest',
    releaseSetDigest: 'release-digest',
    attachmentDigest: null,
    fixture: null,
    sharedEvidenceId: null,
    ...overrides,
  }
}

export function sampleDraft(
  assertions: readonly AssertionRecord[],
  overrides: Partial<ReportDraft> = {},
): ReportDraft {
  return {
    contracts: ['agh.loop'],
    providers: ['reference'],
    unknownContracts: [],
    command: 'conformance',
    startedAt: SAMPLE_CLOCK.startedAt,
    finishedAt: SAMPLE_CLOCK.finishedAt,
    assertions,
    ...overrides,
  }
}
