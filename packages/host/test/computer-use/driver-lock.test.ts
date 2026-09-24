import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type DriverAdmissionEvidence,
  evaluateComputerUseDriverAdmission,
  evaluateComputerUsePlatformAdmission,
  evaluateFixedComputerUseDriverAdmission,
  evaluateFixedComputerUsePlatformAdmission,
  inspectComputerUseDriverLock,
} from '../../src/computer-use/driver-lock.js'

const candidate: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../src/computer-use/computer-use-driver-lock.json', import.meta.url)),
    'utf8',
  ),
)

type MutableEvidence = { status: string; kind: string; [key: string]: unknown }
type MutableReference = { status: string; evidencePath?: string; sha256?: string }
type VerifiedReference = { status: 'verified'; evidencePath: string; sha256: string }
type MutableArtifact = {
  kind?: string
  name: string
  url: string
  sha256: string
  size: number
  signatureEvidence: MutableEvidence
}
type MutableLab = {
  status: string
  owner?: string
  os?: string
  architecture?: string
  evidencePath?: string
  sha256?: string
}
type MutableLock = {
  status: string
  admissionEnabled: boolean
  platformAdmissions: Record<'darwin' | 'win32' | 'linux', { status: string; admissionEnabled: boolean }>
  source: {
    tag: string
    commit?: string
    releaseCommitSignature: { verified: boolean }
    releaseManifest: { url: string; sha256: string; size: number }
    checksums: { url: string; sha256: string; size: number }
  }
  runtimeContract: {
    minimumVersion: string
    manifestSchemaVersion: string
    capabilityVersion: string
    requiredSubcommandArguments: Record<string, string[]>
  }
  artifacts: [MutableArtifact, MutableArtifact, MutableArtifact, MutableArtifact, MutableArtifact]
  supportArtifacts: [MutableArtifact, MutableArtifact, MutableArtifact]
  fixtures: {
    manifest: MutableReference
    catalog: MutableReference
    result: MutableReference
    som: MutableReference
    doctor: MutableReference
    legacyCompatibility: MutableReference
  }
  platformLabs: {
    darwin: MutableLab
    win32: MutableLab
    linuxX11: MutableLab
    linuxWayland: MutableLab
  }
  lastKnownGood: { status: string; platformVerification: MutableReference }
  untrusted?: boolean
  [key: string]: unknown
}

function cloneCandidate(): MutableLock {
  return structuredClone(candidate) as MutableLock
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nearReadyLock(): { lock: MutableLock; evidence: DriverAdmissionEvidence } {
  const lock = cloneCandidate()
  const evidence = new Map<string, Uint8Array>()
  const addReference = (path: string): VerifiedReference => {
    const bytes = new TextEncoder().encode(`review evidence for ${path}`)
    evidence.set(path, bytes)
    return { status: 'verified', evidencePath: path, sha256: sha256(bytes) }
  }

  lock.status = 'ready'
  lock.admissionEnabled = true
  lock.lastKnownGood.status = 'ready'
  lock.lastKnownGood.platformVerification = addReference(
    'packages/host/test/computer-use/evidence/lkg-platforms.json',
  )
  const fixtureKeys = ['manifest', 'catalog', 'result', 'som', 'doctor', 'legacyCompatibility'] as const
  for (const key of fixtureKeys) {
    lock.fixtures[key] = addReference(`packages/host/test/computer-use/evidence/${key}.json`)
  }
  const labKeys = ['darwin', 'win32', 'linuxX11', 'linuxWayland'] as const
  for (const key of labKeys) {
    const reference = addReference(`packages/host/test/computer-use/evidence/labs/${key}.json`)
    lock.platformLabs[key] = {
      status: 'assigned',
      owner: `owner:${key}`,
      os: `test-os:${key}`,
      architecture: 'x86_64',
      evidencePath: reference.evidencePath,
      sha256: reference.sha256,
    }
  }
  for (const artifact of [...lock.artifacts, ...lock.supportArtifacts]) {
    if (artifact.signatureEvidence.kind === 'apple-developer-id-notarized') continue
    if (artifact.signatureEvidence.kind === 'windows-authenticode') {
      artifact.signatureEvidence = {
        status: 'verified',
        kind: 'windows-authenticode',
        publisher: 'Cua AI, Inc.',
        leafThumbprint: 'A'.repeat(40),
        chainRootThumbprint: 'B'.repeat(40),
        timestampAuthority: 'test timestamp authority',
        timestamp: '2026-09-12T08:45:39Z',
        verifiedOn: 'Windows 11 test lab',
        verifiedAt: '2026-09-16T00:00:00Z',
      }
    } else {
      const attestation = addReference(
        `packages/host/test/computer-use/evidence/${artifact.name}.attestation.json`,
      )
      artifact.signatureEvidence = {
        status: 'verified',
        kind: artifact.signatureEvidence.kind,
        provenanceType: 'sigstore-bundle',
        issuer: 'test issuer',
        subject: 'test subject bound to asset digest',
        sourceRepository: 'https://github.com/trycua/cua',
        sourceCommit: lock.source.commit,
        artifactSha256: artifact.sha256,
        attestationPath: attestation.evidencePath,
        attestationSha256: attestation.sha256,
        verifier: 'test verifier',
        verifiedAt: '2026-09-16T00:00:00Z',
      }
    }
  }
  return { lock, evidence }
}

describe('computer-use driver lock schema and fixed candidate', () => {
  it('ships Windows admission evidence with the pinned bytes after documentation cleanup', () => {
    const lab = cloneCandidate().platformLabs.win32
    const bytes = readFileSync(
      new URL('./evidence/labs/windows-x64-live-admission-2026-09-20.json', import.meta.url),
    )
    expect(lab.evidencePath).toBe(
      'packages/host/test/computer-use/evidence/labs/windows-x64-live-admission-2026-09-20.json',
    )
    expect(sha256(bytes)).toBe(lab.sha256)
  })

  it('pins the reviewed 0.28.1 source and every release digest', () => {
    const lock = cloneCandidate()
    expect(lock.source.tag).toBe('cua-driver-rs-v0.28.1')
    expect(lock.source.commit).toBe('d8028a7943087ee258dc1b4d19dc12a7cd27669c')
    expect(lock.source.releaseManifest).toEqual({
      url: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.1/release-manifest.json',
      sha256: '65f1c3af8a270c388def74ff16c7acb58a4574792673a342030a0af9c5b9d5ab',
      size: 7086,
    })
    expect(lock.source.checksums).toEqual({
      url: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.1/checksums.txt',
      sha256: '35fbf023e27f65b7ab8afb4daef990940c8f2435828bc76c940d527cd022942e',
      size: 1742,
    })
    expect(lock.runtimeContract).toEqual({
      minimumVersion: '0.20.0',
      manifestSchemaVersion: '1',
      capabilityVersion: '1',
      requiredSubcommandArguments: {
        mcp: ['--socket', '--grant'],
        serve: [
          '--socket',
          '--permission-mode',
          '--capability-manifest',
          '--approve-capability-manifest',
          '--embedded',
        ],
        stop: ['--socket'],
      },
    })
    expect(lock.artifacts.map((artifact) => artifact.sha256)).toEqual([
      '52fdabd1947c9b252d881a257d3169372ed1a2d4ea90cdcce7dd624e8360d133',
      '0f864381d3bcf29e7caf20d4b93bdf8476faf4e1ba986ce03890162beba5c3ee',
      'b21dd46691b9fb268f9668a9a3c0537578df39bea29d4ac54e5d6a663bdb0d17',
      'a068b6e477893b77ced74bceccf7db7483cf140e8d54150ce5849b6252b90bcf',
      'a863951ef0699fd25091adb87bd114d69709b887fdfc059e795aca49ef8ac19c',
    ])
    expect(lock.artifacts.map((artifact) => [artifact.name, artifact.size])).toEqual([
      ['cua-driver-rs-0.28.1-darwin-universal.tar.gz', 70074359],
      ['cua-driver-rs-0.28.1-windows-x86_64.zip', 28931191],
      ['cua-driver-rs-0.28.1-windows-arm64.zip', 27246614],
      ['cua-driver-rs-0.28.1-linux-x86_64.tar.gz', 30563145],
      ['cua-driver-rs-0.28.1-linux-arm64.tar.gz', 30588021],
    ])
    expect(lock.supportArtifacts.map((artifact) => artifact.sha256)).toEqual([
      '3fbd1e7540e9084e294d03f92a0e933427fa60cbbba6e94844e5d55af679d17f',
      '317ba3a49fdba10f2a7f1b9f392c1bc1b7657f3aae85e1e2e43684cf17a1bf3b',
      '0399d004dfc4cb7c3f02cb1486365a630bf053211ede9a6de581e8320571daac',
    ])
    expect(lock.supportArtifacts.map((artifact) => [artifact.name, artifact.size])).toEqual([
      ['cua-driver-rs-v0.28.1-skills.tar.gz', 83209],
      ['install.sh', 5692],
      ['install.ps1', 81831],
    ])
  })

  it('accepts the checked-in candidate while keeping admission closed', () => {
    expect(inspectComputerUseDriverLock(candidate)).toMatchObject({ ok: true })
    const decision = evaluateComputerUseDriverAdmission(candidate)
    expect(decision.allowed).toBe(false)
    expect(decision.blockers).toContain('lock:status')
    expect(decision.blockers).toContain('artifact:win32:signature')
    expect(decision.blockers).toContain('fixture:som')
    expect(decision.blockers).toContain('lab:linuxWayland')
    expect(decision.blockers).toContain('lkg:platform-verification')
  })

  it.each([
    ['missing required field', (lock: MutableLock) => delete lock.source.commit],
    ['unknown top-level field', (lock: MutableLock) => (lock.untrusted = true)],
    ['invalid state', (lock: MutableLock) => (lock.status = 'approved')],
    ['invalid digest', (lock: MutableLock) => (lock.artifacts[0].sha256 = 'not-a-digest')],
    [
      'verified Windows evidence without chain and timestamp',
      (lock: MutableLock) =>
        (lock.artifacts[1].signatureEvidence = {
          status: 'verified',
          kind: 'windows-authenticode',
          publisher: 'Cua AI, Inc.',
        }),
    ],
    [
      'verified evidence reference without digest',
      (lock: MutableLock) =>
        (lock.fixtures.manifest = {
          status: 'verified',
          evidencePath: 'packages/host/test/computer-use/evidence/manifest.json',
        }),
    ],
    [
      'provenance without artifact binding and attestation reference',
      (lock: MutableLock) =>
        (lock.artifacts[3].signatureEvidence = {
          status: 'verified',
          kind: 'linux-provenance',
          provenanceType: 'slsa',
          issuer: 'issuer',
          subject: 'subject',
          sourceRepository: 'https://github.com/trycua/cua',
          sourceCommit: lock.source.commit,
          verifier: 'verifier',
          verifiedAt: '2026-09-16T00:00:00Z',
        }),
    ],
    [
      'evidence path traversal',
      (lock: MutableLock) =>
        (lock.fixtures.manifest = {
          status: 'verified',
          evidencePath: 'packages/host/test/computer-use/evidence/../outside.json',
          sha256: '0'.repeat(64),
        }),
    ],
  ])('rejects %s', (_name, mutate) => {
    const lock = cloneCandidate()
    mutate(lock)
    expect(inspectComputerUseDriverLock(lock)).toMatchObject({ ok: false })
    expect(evaluateComputerUseDriverAdmission(lock).allowed).toBe(false)
  })
})

describe('computer-use driver admission gate', () => {
  it('admits only the reviewed Windows x64 platform candidate', () => {
    expect(evaluateFixedComputerUsePlatformAdmission('win32', 'x64')).toEqual({
      allowed: true,
      blockers: [],
    })
    expect(evaluateFixedComputerUsePlatformAdmission('win32', 'arm64')).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining(['platform:win32/arm64:signature', 'platform:win32/arm64:evidence']),
    })
    expect(evaluateFixedComputerUsePlatformAdmission('linux', 'x64')).toMatchObject({ allowed: false })
  })

  it.each(['arm64', 'x86_64', 'x64'] as const)(
    'admits the reviewed universal macOS experimental driver on %s',
    (architecture) => {
      expect(evaluateFixedComputerUsePlatformAdmission('darwin', architecture)).toEqual({
        allowed: true,
        blockers: [],
      })
    },
  )

  it('keeps macOS experimental admission closed when the reviewed artifact identity drifts', () => {
    const changed = cloneCandidate()
    changed.artifacts[0].sha256 = '0'.repeat(64)
    const changedDecision = evaluateComputerUsePlatformAdmission(changed, 'darwin', 'arm64')
    expect(changedDecision).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining(['platform:darwin/arm64:artifact-digest']),
    })
  })

  it.each([
    [
      'platform state',
      (lock: MutableLock) => (lock.platformAdmissions.win32.status = 'candidate'),
      'platform:win32:status',
    ],
    [
      'platform admission bit',
      (lock: MutableLock) => (lock.platformAdmissions.win32.admissionEnabled = false),
      'platform:win32:admission-disabled',
    ],
    [
      'artifact digest',
      (lock: MutableLock) => (lock.artifacts[1].sha256 = '0'.repeat(64)),
      'platform:win32/x86_64:artifact-digest',
    ],
    [
      'lab evidence digest',
      (lock: MutableLock) => (lock.platformLabs.win32.sha256 = '0'.repeat(64)),
      'platform:win32/x86_64:lab-evidence',
    ],
  ])('keeps Windows x64 closed when %s drifts', (_name, mutate, blocker) => {
    const lock = cloneCandidate()
    mutate(lock)
    expect(evaluateComputerUsePlatformAdmission(lock, 'win32', 'x64')).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining([blocker]),
    })
  })

  it('inspects the checked-in fixed lock without installing, probing or launching a driver', () => {
    expect(evaluateFixedComputerUseDriverAdmission()).toEqual(evaluateComputerUseDriverAdmission(candidate))
    expect(evaluateFixedComputerUseDriverAdmission()).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining(['lock:status', 'lock:admission-disabled']),
    })
    expect(evaluateComputerUseDriverAdmission(undefined)).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining([expect.stringMatching(/^schema:/u)]),
    })
  })

  it('does not trust self-asserted Linux or support identities', () => {
    const { lock, evidence } = nearReadyLock()
    const decision = evaluateComputerUseDriverAdmission(lock, evidence)
    expect(decision.allowed).toBe(false)
    expect(decision.blockers).toContain('verifier:not-implemented')
    expect(decision.blockers).toContain('artifact:linux:provenance-identity')
    expect(decision.blockers).toContain('support:skills:provenance-identity')
  })

  it.each([
    [
      'release signature',
      (lock: MutableLock) => (lock.source.releaseCommitSignature.verified = false),
      'source:release-commit-signature',
    ],
    ['lock state', (lock: MutableLock) => (lock.status = 'candidate'), 'lock:status'],
    ['admission bit', (lock: MutableLock) => (lock.admissionEnabled = false), 'lock:admission-disabled'],
    [
      'release manifest URL',
      (lock: MutableLock) =>
        (lock.source.releaseManifest.url =
          'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.0/release-manifest.json'),
      'source:release-manifest-url',
    ],
    [
      'checksums URL',
      (lock: MutableLock) =>
        (lock.source.checksums.url =
          'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.0/checksums.txt'),
      'source:checksums-url',
    ],
    [
      'artifact filename',
      (lock: MutableLock) => (lock.artifacts[1].name = 'wrong.zip'),
      'artifact:win32:identity',
    ],
    [
      'platform evidence kind',
      (lock: MutableLock) =>
        (lock.artifacts[1].signatureEvidence = structuredClone(lock.artifacts[0].signatureEvidence)),
      'artifact:win32:evidence-kind',
    ],
    [
      'platform signature',
      (lock: MutableLock) =>
        (lock.artifacts[1].signatureEvidence = {
          status: 'pending',
          kind: 'windows-authenticode',
        }),
      'artifact:win32:signature',
    ],
    [
      'Windows publisher identity',
      (lock: MutableLock) => (lock.artifacts[1].signatureEvidence.publisher = 'Untrusted Publisher'),
      'artifact:win32:publisher',
    ],
    [
      'support artifact set',
      (lock: MutableLock) => (lock.supportArtifacts[0].kind = 'installer-posix'),
      'support:kinds',
    ],
    [
      'support evidence kind',
      (lock: MutableLock) =>
        (lock.supportArtifacts[0].signatureEvidence = structuredClone(lock.artifacts[0].signatureEvidence)),
      'support:skills:evidence-kind',
    ],
    [
      'fixture evidence digest',
      (lock: MutableLock) => (lock.fixtures.result.sha256 = '0'.repeat(64)),
      'fixture:result',
    ],
    [
      'lab evidence',
      (lock: MutableLock) => (lock.platformLabs.linuxX11 = { status: 'unassigned' }),
      'lab:linuxX11',
    ],
    ['LKG state', (lock: MutableLock) => (lock.lastKnownGood.status = 'candidate'), 'lkg:status'],
  ])('reports the exact blocker when %s is not green', (_name, mutate, blocker) => {
    const { lock, evidence } = nearReadyLock()
    mutate(lock)
    expect(evaluateComputerUseDriverAdmission(lock, evidence).blockers).toContain(blocker)
  })

  it('rejects ready-with-pending instead of trusting the ready labels', () => {
    const lock = cloneCandidate()
    lock.status = 'ready'
    lock.admissionEnabled = true
    const decision = evaluateComputerUseDriverAdmission(lock)
    expect(decision.allowed).toBe(false)
    expect(decision.blockers).toContain('artifact:win32:signature')
    expect(decision.blockers).toContain('support:skills:provenance')
    expect(decision.blockers).toContain('fixture:manifest')
  })
})
