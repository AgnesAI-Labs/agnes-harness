import { createHash } from 'node:crypto'
import { type Static, Type } from '@sinclair/typebox'
import { Ajv2020 } from 'ajv/dist/2020.js'
import fixedDriverLock from './computer-use-driver-lock.json' with { type: 'json' }

const NonEmpty = Type.String({ pattern: '^\\S(?:.*\\S)?$' })
const Sha256 = Type.String({ pattern: '^[a-f0-9]{64}$' })
const Commit = Type.String({ pattern: '^[a-f0-9]{40}$' })
const ReleaseUrl = Type.String({ pattern: '^https://github\\.com/trycua/cua/releases/download/' })
const VersionTag = Type.String({ pattern: '^cua-driver-rs-v[0-9]+\\.[0-9]+\\.[0-9]+$' })
const ProvenanceFormat = Type.Union([
  Type.Literal('sigstore-bundle'),
  Type.Literal('in-toto'),
  Type.Literal('slsa'),
  Type.Literal('detached-signature'),
])

const PendingEvidence = Type.Object(
  {
    status: Type.Literal('pending'),
    kind: Type.Union([
      Type.Literal('apple-developer-id-notarized'),
      Type.Literal('windows-authenticode'),
      Type.Literal('linux-provenance'),
      Type.Literal('release-asset-provenance'),
    ]),
  },
  { additionalProperties: false },
)
const AppleEvidence = Type.Object(
  {
    status: Type.Literal('verified'),
    kind: Type.Literal('apple-developer-id-notarized'),
    bundleId: NonEmpty,
    teamId: NonEmpty,
    authority: NonEmpty,
    notarization: Type.Literal('stapled'),
    verifiedOn: Type.Literal('macOS'),
    verifiedDate: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
  },
  { additionalProperties: false },
)
const WindowsEvidence = Type.Object(
  {
    status: Type.Literal('verified'),
    kind: Type.Literal('windows-authenticode'),
    publisher: NonEmpty,
    leafThumbprint: Type.String({ pattern: '^[A-F0-9]{40,128}$' }),
    chainRootThumbprint: Type.String({ pattern: '^[A-F0-9]{40,128}$' }),
    timestampAuthority: NonEmpty,
    timestamp: NonEmpty,
    verifiedOn: Type.String({ pattern: '^Windows (10|11)' }),
    verifiedAt: NonEmpty,
  },
  { additionalProperties: false },
)
const ProvenanceEvidence = Type.Object(
  {
    status: Type.Literal('verified'),
    kind: Type.Union([Type.Literal('linux-provenance'), Type.Literal('release-asset-provenance')]),
    provenanceType: ProvenanceFormat,
    issuer: NonEmpty,
    subject: NonEmpty,
    sourceRepository: Type.Literal('https://github.com/trycua/cua'),
    sourceCommit: Commit,
    artifactSha256: Sha256,
    attestationPath: Type.String({
      pattern: '^packages/host/test/computer-use/evidence/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$',
    }),
    attestationSha256: Sha256,
    verifier: NonEmpty,
    verifiedAt: NonEmpty,
  },
  { additionalProperties: false },
)
const Evidence = Type.Union([PendingEvidence, AppleEvidence, WindowsEvidence, ProvenanceEvidence])
const RemoteArtifact = Type.Object(
  { url: ReleaseUrl, sha256: Sha256, size: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
)
const PendingReference = Type.Object({ status: Type.Literal('pending') }, { additionalProperties: false })
const VerifiedReference = Type.Object(
  {
    status: Type.Literal('verified'),
    evidencePath: Type.String({
      pattern: '^packages/host/test/computer-use/evidence/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$',
    }),
    sha256: Sha256,
  },
  { additionalProperties: false },
)
const EvidenceReference = Type.Union([PendingReference, VerifiedReference])
const LabState = Type.Union([
  Type.Object({ status: Type.Literal('unassigned') }, { additionalProperties: false }),
  Type.Object(
    {
      status: Type.Literal('assigned'),
      owner: NonEmpty,
      os: NonEmpty,
      architecture: Type.Union([Type.Literal('arm64'), Type.Literal('x86_64')]),
      evidencePath: Type.String({
        pattern: '^packages/host/test/computer-use/evidence/labs/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$',
      }),
      sha256: Sha256,
    },
    { additionalProperties: false },
  ),
])
const PlatformAdmissionState = Type.Object(
  {
    status: Type.Union([Type.Literal('candidate'), Type.Literal('ready')]),
    admissionEnabled: Type.Boolean(),
  },
  { additionalProperties: false },
)
const AcceptedProvenanceFormats = ['sigstore-bundle', 'in-toto', 'slsa', 'detached-signature'] as const
const TrustedMacIdentity = {
  bundleId: 'com.trycua.driver',
  teamId: 'YCK386LBJ7',
  notarization: 'stapled',
} as const
const TrustedWindowsPublishers: readonly string[] = ['Cua AI, Inc.']
// Filled only after upstream identities are independently verified and reviewed. Empty is fail-closed.
const TrustedLinuxIdentities: ReadonlyArray<{ issuer: string; subject: string }> = []
const TrustedSupportIdentities: ReadonlyArray<{ issuer: string; subject: string }> = []
// Admission stays impossible until Host verifies the downloaded bytes/signatures, not lock assertions.
const ArtifactVerifierReady = false
const PlatformArtifactVerifierReady = Object.freeze({ darwin: true, win32: true, linux: true })
const TrustedPlatformAdmissions = Object.freeze({
  'win32/x86_64': Object.freeze({
    sourceCommit: 'd8028a7943087ee258dc1b4d19dc12a7cd27669c',
    artifactSha256: '0f864381d3bcf29e7caf20d4b93bdf8476faf4e1ba986ce03890162beba5c3ee',
    evidencePath: 'packages/host/test/computer-use/evidence/labs/windows-x64-live-admission-2026-09-20.json',
    evidenceSha256: '0f34e54a9570669b03105d586b221628a9299cb4300b1f4a7b1c7dec3bc85f04',
    os: 'Windows 11 x64 build 26200.9457',
  }),
})
// The universal macOS bundle is an explicitly supported experimental path for this open-source
// project. Both Mac architectures still require the reviewed release bytes and Apple identity,
// but do not require a separate paid lab for each architecture before ordinary users can try it.
const TrustedExperimentalMacOSAdmission = Object.freeze({
  sourceCommit: 'd8028a7943087ee258dc1b4d19dc12a7cd27669c',
  artifactSha256: '52fdabd1947c9b252d881a257d3169372ed1a2d4ea90cdcce7dd624e8360d133',
})

const RuntimeContract = Type.Object(
  {
    minimumVersion: Type.String({ pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' }),
    manifestSchemaVersion: NonEmpty,
    capabilityVersion: NonEmpty,
    requiredSubcommandArguments: Type.Object(
      {
        mcp: Type.Array(Type.String({ pattern: '^--[a-z][a-z-]*$' }), {
          minItems: 1,
          uniqueItems: true,
        }),
        serve: Type.Array(Type.String({ pattern: '^--[a-z][a-z-]*$' }), {
          minItems: 1,
          uniqueItems: true,
        }),
        stop: Type.Array(Type.String({ pattern: '^--[a-z][a-z-]*$' }), {
          minItems: 1,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export const computerUseDriverLockSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    status: Type.Union([Type.Literal('candidate'), Type.Literal('ready')]),
    admissionEnabled: Type.Boolean(),
    platformAdmissions: Type.Object(
      {
        darwin: PlatformAdmissionState,
        win32: PlatformAdmissionState,
        linux: PlatformAdmissionState,
      },
      { additionalProperties: false },
    ),
    source: Type.Object(
      {
        repository: Type.Literal('https://github.com/trycua/cua'),
        tag: VersionTag,
        commit: Commit,
        publishedAt: NonEmpty,
        releaseCommitSignature: Type.Object(
          { verified: Type.Boolean(), reason: NonEmpty, verifiedAt: NonEmpty },
          { additionalProperties: false },
        ),
        releaseManifest: RemoteArtifact,
        checksums: RemoteArtifact,
      },
      { additionalProperties: false },
    ),
    runtimeContract: RuntimeContract,
    artifacts: Type.Array(
      Type.Object(
        {
          platform: Type.Union([Type.Literal('darwin'), Type.Literal('win32'), Type.Literal('linux')]),
          architectures: Type.Array(Type.Union([Type.Literal('arm64'), Type.Literal('x86_64')]), {
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
          }),
          name: NonEmpty,
          url: ReleaseUrl,
          sha256: Sha256,
          size: Type.Integer({ minimum: 1 }),
          signatureEvidence: Evidence,
        },
        { additionalProperties: false },
      ),
      { minItems: 5, maxItems: 5 },
    ),
    supportArtifacts: Type.Array(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal('skills'),
            Type.Literal('installer-posix'),
            Type.Literal('installer-windows'),
          ]),
          name: NonEmpty,
          url: ReleaseUrl,
          sha256: Sha256,
          size: Type.Integer({ minimum: 1 }),
          signatureEvidence: Evidence,
        },
        { additionalProperties: false },
      ),
      { minItems: 3, maxItems: 3 },
    ),
    lastKnownGood: Type.Object(
      {
        status: Type.Union([Type.Literal('candidate'), Type.Literal('ready')]),
        tag: VersionTag,
        commit: Commit,
        releaseManifestSha256: Sha256,
        platformVerification: EvidenceReference,
      },
      { additionalProperties: false },
    ),
    fixtures: Type.Object(
      {
        manifest: EvidenceReference,
        catalog: EvidenceReference,
        result: EvidenceReference,
        som: EvidenceReference,
        doctor: EvidenceReference,
        legacyCompatibility: EvidenceReference,
      },
      { additionalProperties: false },
    ),
    platformLabs: Type.Object(
      { darwin: LabState, win32: LabState, linuxX11: LabState, linuxWayland: LabState },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export type ComputerUseDriverLock = Static<typeof computerUseDriverLockSchema>
export type DriverLockInspection = { ok: true; lock: ComputerUseDriverLock } | { ok: false; issues: string[] }
export type DriverAdmissionDecision = { allowed: boolean; blockers: string[] }
export type ComputerUseDriverPlatform = 'darwin' | 'win32' | 'linux'
export type ComputerUseDriverArchitecture = 'arm64' | 'x64' | 'x86_64'

const validateSchema = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(
  computerUseDriverLockSchema,
)
const EXPECTED_TARGETS = [
  'darwin/arm64',
  'darwin/x86_64',
  'linux/arm64',
  'linux/x86_64',
  'win32/arm64',
  'win32/x86_64',
]

export function inspectComputerUseDriverLock(value: unknown): DriverLockInspection {
  if (validateSchema(value)) return { ok: true, lock: value as ComputerUseDriverLock }
  return {
    ok: false,
    issues: (validateSchema.errors ?? []).map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    ),
  }
}

function matchesTrustedIdentity(
  identities: ReadonlyArray<{ issuer: string; subject: string }>,
  evidence: { issuer: string; subject: string },
): boolean {
  return identities.some(
    (identity) => identity.issuer === evidence.issuer && identity.subject === evidence.subject,
  )
}

type EvidenceReferenceValue =
  | { status: 'pending' }
  | { status: 'verified'; evidencePath: string; sha256: string }
export type DriverAdmissionEvidence = ReadonlyMap<string, Uint8Array>

function hasVerifiedReference(
  reference: EvidenceReferenceValue,
  evidenceFiles: DriverAdmissionEvidence,
): boolean {
  if (reference.status !== 'verified') return false
  const bytes = evidenceFiles.get(reference.evidencePath)
  return bytes !== undefined && createHash('sha256').update(bytes).digest('hex') === reference.sha256
}

/** Pure fail-closed gate. It does not install, launch, or admit a driver by itself. */
export function evaluateComputerUseDriverAdmission(
  value: unknown,
  evidenceFiles: DriverAdmissionEvidence = new Map(),
): DriverAdmissionDecision {
  const inspected = inspectComputerUseDriverLock(value)
  if (!inspected.ok) return { allowed: false, blockers: inspected.issues.map((issue) => `schema:${issue}`) }

  const { lock } = inspected
  const blockers: string[] = []
  if (!ArtifactVerifierReady) blockers.push('verifier:not-implemented')
  const releasePrefix = `https://github.com/trycua/cua/releases/download/${lock.source.tag}/`
  if (!lock.source.releaseCommitSignature.verified) blockers.push('source:release-commit-signature')
  if (lock.source.releaseManifest.url !== `${releasePrefix}release-manifest.json`)
    blockers.push('source:release-manifest-url')
  if (lock.source.checksums.url !== `${releasePrefix}checksums.txt`) blockers.push('source:checksums-url')
  if (lock.status !== 'ready') blockers.push('lock:status')
  if (!lock.admissionEnabled) blockers.push('lock:admission-disabled')

  const targets = lock.artifacts
    .flatMap((artifact) =>
      artifact.architectures.map((architecture) => `${artifact.platform}/${architecture}`),
    )
    .sort()
  if (JSON.stringify(targets) !== JSON.stringify(EXPECTED_TARGETS)) blockers.push('artifacts:targets')

  const version = lock.source.tag.slice('cua-driver-rs-v'.length)
  const expectedArtifactNames: Record<string, string> = {
    'darwin/arm64,x86_64': `cua-driver-rs-${version}-darwin-universal.tar.gz`,
    'linux/arm64': `cua-driver-rs-${version}-linux-arm64.tar.gz`,
    'linux/x86_64': `cua-driver-rs-${version}-linux-x86_64.tar.gz`,
    'win32/arm64': `cua-driver-rs-${version}-windows-arm64.zip`,
    'win32/x86_64': `cua-driver-rs-${version}-windows-x86_64.zip`,
  }
  for (const artifact of lock.artifacts) {
    const evidence = artifact.signatureEvidence
    const key = `${artifact.platform}/${[...artifact.architectures].sort().join(',')}`
    const expectedName = expectedArtifactNames[key]
    if (
      expectedName === undefined ||
      artifact.name !== expectedName ||
      artifact.url !== `${releasePrefix}${expectedName}`
    )
      blockers.push(`artifact:${artifact.platform}:identity`)
    if (evidence.status !== 'verified') blockers.push(`artifact:${artifact.platform}:signature`)
    const expectedKind =
      artifact.platform === 'darwin'
        ? 'apple-developer-id-notarized'
        : artifact.platform === 'win32'
          ? 'windows-authenticode'
          : 'linux-provenance'
    if (evidence.kind !== expectedKind) blockers.push(`artifact:${artifact.platform}:evidence-kind`)
    if (
      evidence.status === 'verified' &&
      evidence.kind === 'apple-developer-id-notarized' &&
      (evidence.bundleId !== TrustedMacIdentity.bundleId ||
        evidence.teamId !== TrustedMacIdentity.teamId ||
        evidence.notarization !== TrustedMacIdentity.notarization)
    )
      blockers.push('artifact:darwin:signer')
    if (
      evidence.status === 'verified' &&
      evidence.kind === 'windows-authenticode' &&
      !TrustedWindowsPublishers.includes(evidence.publisher)
    )
      blockers.push('artifact:win32:publisher')
    if (
      evidence.status === 'verified' &&
      evidence.kind === 'linux-provenance' &&
      (!AcceptedProvenanceFormats.includes(evidence.provenanceType) ||
        !matchesTrustedIdentity(TrustedLinuxIdentities, evidence) ||
        evidence.sourceCommit !== lock.source.commit ||
        evidence.artifactSha256 !== artifact.sha256 ||
        !hasVerifiedReference(
          {
            status: 'verified',
            evidencePath: evidence.attestationPath,
            sha256: evidence.attestationSha256,
          },
          evidenceFiles,
        ))
    )
      blockers.push('artifact:linux:provenance-identity')
  }

  const expectedSupportNames = {
    skills: `${lock.source.tag}-skills.tar.gz`,
    'installer-posix': 'install.sh',
    'installer-windows': 'install.ps1',
  } as const
  for (const artifact of lock.supportArtifacts) {
    const evidence = artifact.signatureEvidence
    const expectedName = expectedSupportNames[artifact.kind]
    if (artifact.name !== expectedName || artifact.url !== `${releasePrefix}${expectedName}`)
      blockers.push(`support:${artifact.kind}:identity`)
    if (evidence.status !== 'verified') blockers.push(`support:${artifact.kind}:provenance`)
    if (evidence.kind !== 'release-asset-provenance') blockers.push(`support:${artifact.kind}:evidence-kind`)
    if (
      evidence.status === 'verified' &&
      evidence.kind === 'release-asset-provenance' &&
      (!AcceptedProvenanceFormats.includes(evidence.provenanceType) ||
        !matchesTrustedIdentity(TrustedSupportIdentities, evidence) ||
        evidence.sourceCommit !== lock.source.commit ||
        evidence.artifactSha256 !== artifact.sha256 ||
        !hasVerifiedReference(
          {
            status: 'verified',
            evidencePath: evidence.attestationPath,
            sha256: evidence.attestationSha256,
          },
          evidenceFiles,
        ))
    )
      blockers.push(`support:${artifact.kind}:provenance-identity`)
  }
  const supportKinds = lock.supportArtifacts.map((artifact) => artifact.kind).sort()
  if (JSON.stringify(supportKinds) !== JSON.stringify(['installer-posix', 'installer-windows', 'skills']))
    blockers.push('support:kinds')

  for (const [name, reference] of Object.entries(lock.fixtures)) {
    if (!hasVerifiedReference(reference, evidenceFiles)) blockers.push(`fixture:${name}`)
  }
  for (const [platform, lab] of Object.entries(lock.platformLabs)) {
    if (
      lab.status !== 'assigned' ||
      !hasVerifiedReference(
        { status: 'verified', evidencePath: lab.evidencePath, sha256: lab.sha256 },
        evidenceFiles,
      )
    )
      blockers.push(`lab:${platform}`)
  }
  if (lock.lastKnownGood.status !== 'ready') blockers.push('lkg:status')
  if (!hasVerifiedReference(lock.lastKnownGood.platformVerification, evidenceFiles))
    blockers.push('lkg:platform-verification')

  return { allowed: blockers.length === 0, blockers }
}

/** Platform-scoped release gate. A passing platform may start only its exact reviewed artifact;
 * global release readiness and other platforms remain independent. */
export function evaluateComputerUsePlatformAdmission(
  value: unknown,
  platform: ComputerUseDriverPlatform,
  architecture: ComputerUseDriverArchitecture,
): DriverAdmissionDecision {
  const inspected = inspectComputerUseDriverLock(value)
  if (!inspected.ok) return { allowed: false, blockers: inspected.issues.map((issue) => `schema:${issue}`) }
  const { lock } = inspected
  const blockers: string[] = []
  const normalizedArchitecture = architecture === 'x64' ? 'x86_64' : architecture
  const key = `${platform}/${normalizedArchitecture}` as keyof typeof TrustedPlatformAdmissions
  const admission = lock.platformAdmissions[platform]
  if (admission.status !== 'ready') blockers.push(`platform:${platform}:status`)
  if (!admission.admissionEnabled) blockers.push(`platform:${platform}:admission-disabled`)
  if (!PlatformArtifactVerifierReady[platform]) blockers.push(`platform:${platform}:verifier`)
  if (!lock.source.releaseCommitSignature.verified) blockers.push('source:release-commit-signature')
  const releasePrefix = `https://github.com/trycua/cua/releases/download/${lock.source.tag}/`
  if (lock.source.releaseManifest.url !== `${releasePrefix}release-manifest.json`)
    blockers.push('source:release-manifest-url')
  if (lock.source.checksums.url !== `${releasePrefix}checksums.txt`) blockers.push('source:checksums-url')

  const artifact = lock.artifacts.find(
    (candidate) =>
      candidate.platform === platform && candidate.architectures.includes(normalizedArchitecture),
  )
  if (!artifact) blockers.push(`platform:${key}:artifact`)
  else {
    const version = lock.source.tag.slice('cua-driver-rs-v'.length)
    const expectedName =
      platform === 'win32'
        ? `cua-driver-rs-${version}-windows-${normalizedArchitecture}.zip`
        : platform === 'darwin'
          ? `cua-driver-rs-${version}-darwin-universal.tar.gz`
          : `cua-driver-rs-${version}-linux-${normalizedArchitecture}.tar.gz`
    if (artifact.name !== expectedName || artifact.url !== `${releasePrefix}${expectedName}`)
      blockers.push(`platform:${key}:artifact-identity`)
    if (artifact.signatureEvidence.status !== 'verified') blockers.push(`platform:${key}:signature`)
    if (
      platform === 'win32' &&
      (artifact.signatureEvidence.kind !== 'windows-authenticode' ||
        artifact.signatureEvidence.status !== 'verified' ||
        !TrustedWindowsPublishers.includes(artifact.signatureEvidence.publisher))
    )
      blockers.push(`platform:${key}:publisher`)
    if (
      platform === 'darwin' &&
      (artifact.signatureEvidence.kind !== 'apple-developer-id-notarized' ||
        artifact.signatureEvidence.status !== 'verified' ||
        artifact.signatureEvidence.bundleId !== TrustedMacIdentity.bundleId ||
        artifact.signatureEvidence.teamId !== TrustedMacIdentity.teamId ||
        artifact.signatureEvidence.notarization !== TrustedMacIdentity.notarization)
    )
      blockers.push(`platform:${key}:signer`)
    if (
      platform === 'linux' &&
      (artifact.signatureEvidence.kind !== 'linux-provenance' ||
        artifact.signatureEvidence.status !== 'verified' ||
        !AcceptedProvenanceFormats.includes(artifact.signatureEvidence.provenanceType) ||
        !matchesTrustedIdentity(TrustedLinuxIdentities, artifact.signatureEvidence) ||
        artifact.signatureEvidence.sourceCommit !== lock.source.commit ||
        artifact.signatureEvidence.artifactSha256 !== artifact.sha256)
    )
      blockers.push(`platform:${key}:provenance-identity`)
  }

  if (platform === 'darwin') {
    if (lock.source.commit !== TrustedExperimentalMacOSAdmission.sourceCommit)
      blockers.push(`platform:${key}:source-commit`)
    if (artifact?.sha256 !== TrustedExperimentalMacOSAdmission.artifactSha256)
      blockers.push(`platform:${key}:artifact-digest`)
    return { allowed: blockers.length === 0, blockers }
  }

  const trusted = TrustedPlatformAdmissions[key]
  if (!trusted) blockers.push(`platform:${key}:evidence`)
  else {
    if (lock.source.commit !== trusted.sourceCommit) blockers.push(`platform:${key}:source-commit`)
    if (artifact?.sha256 !== trusted.artifactSha256) blockers.push(`platform:${key}:artifact-digest`)
    const lab = platform === 'win32' ? lock.platformLabs.win32 : lock.platformLabs.linuxX11
    if (
      lab.status !== 'assigned' ||
      lab.architecture !== normalizedArchitecture ||
      lab.os !== trusted.os ||
      lab.evidencePath !== trusted.evidencePath ||
      lab.sha256 !== trusted.evidenceSha256
    )
      blockers.push(`platform:${key}:lab-evidence`)
  }
  return { allowed: blockers.length === 0, blockers }
}

/** Inspects only Agnes' checked-in candidate. This reads lock data but never probes, installs,
 * launches or enables a driver; schema-invalid lock data remains denied. */
export function evaluateFixedComputerUseDriverAdmission(): DriverAdmissionDecision {
  return evaluateComputerUseDriverAdmission(fixedDriverLock)
}

export function evaluateFixedComputerUsePlatformAdmission(
  platform: ComputerUseDriverPlatform,
  architecture: ComputerUseDriverArchitecture,
): DriverAdmissionDecision {
  return evaluateComputerUsePlatformAdmission(fixedDriverLock, platform, architecture)
}

/** Internal maintenance snapshot. Installation may verify a candidate while runtime admission
 * remains disabled; callers must never use this function as an admission decision. */
export function inspectFixedComputerUseDriverLock(): DriverLockInspection {
  return inspectComputerUseDriverLock(fixedDriverLock)
}
