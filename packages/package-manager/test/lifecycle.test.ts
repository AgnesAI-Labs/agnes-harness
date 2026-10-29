import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  isOfficialMcpDefinition,
  type ManagerOptions,
  packageDir,
  parseSource,
  readLock,
  verifyNpmProvenance,
  writeLock,
} from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  id = 'acme/pkg-a',
  source = parseSource('file:./source')
let root: string, profile: string, sourceDir: string
const seams = ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals']
function manager(extra: Partial<ManagerOptions> = {}) {
  return createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => '2026-09-13T00:00:00Z',
    ...extra,
  })
}
const emptyRefs = async () => []
const load = () => readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
async function install(m = manager()) {
  const p = await m.inspect(profile, source)
  await m.install(profile, source, { expectedIntegrity: p.integrity })
  return m
}
async function decision(m = manager()) {
  const row = (await m.inventory(profile)).packages.find((p) => p.id === id)
  if (!row) throw Error('missing')
  return { integrity: row.entry.integrity, capabilityHash: row.capabilityHash }
}
function version(value: string) {
  for (const filename of ['package.json']) {
    const f = join(sourceDir, filename),
      data = JSON.parse(readFileSync(f, 'utf8'))
    data.version = value
    writeFileSync(f, JSON.stringify(data))
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-lifecycle-'))
  profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  sourceDir = join(root, 'source')
  cpSync(join(fixtures, 'pkg-a'), sourceDir, { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seams.map((n) => [n, { provider: 'local' }])),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('uses a stable frozen inventory, exact trust snapshot, desired-only enable, local offline rollback and tombstone', async () => {
  const m = await install(manager({ references: emptyRefs })),
    initial = await m.inventory(profile)
  expect(await m.provenance(profile, id)).toMatchObject({
    sourceKind: 'local-folder',
    resolvedLocation: realpathSync(join(root, 'source')),
    version: '1.0.0',
    treeIntegrity: initial.packages[0]?.entry.treeIntegrity,
    installedAt: '2026-09-13T00:00:00Z',
    installer: 'user',
    trustDecision: 'pending',
    verification: 'unverified',
  })
  expect(initial.hash).toBe((await m.inventory(profile)).hash)
  expect(Object.isFrozen(initial.packages[0]?.entry.state)).toBe(true)
  await expect(m.trust(profile, id)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  await m.trust(profile, id, await decision(m))
  expect((await m.provenance(profile, id)).trustDecision).toBe('confirmed')
  await m.setEnabled(profile, id, true)
  expect((await m.inventory(profile)).packages[0]).toMatchObject({ trusted: true, enabled: true })
  version('2.0.0')
  const p = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: p.integrity })
  expect(load().packages[id]).toMatchObject({ version: '2.0.0', state: { trusted: null, enabled: false } })
  await expect(m.setEnabled(profile, id, true)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  rmSync(sourceDir, { recursive: true })
  const rolled = await m.rollback(profile, id)
  expect(rolled).toMatchObject({
    version: '1.0.0',
    state: { enabled: false, trusted: null },
  })
  expect((await m.inventory(profile)).packages[0]?.trusted).toBe(false)
  await m.remove(profile, id)
  expect(load().packages[id]).toBeUndefined()
  expect(readdirSync(join(profile, 'packages'))).toEqual([])
  const events = readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(events.map((e) => e.operation)).toEqual([
    'install',
    'trust',
    'enable',
    'update',
    'rollback',
    'remove',
  ])
  expect(events.at(-1)).toMatchObject({ next: 'removed', actor: 'package-manager', result: 'committed' })
  expect(JSON.stringify(events)).not.toContain(root)
})
it('revokes trust and blocks update or rollback activation from resurrecting the package', async () => {
  const m = await install(manager({ references: emptyRefs }))
  await m.trust(profile, id, await decision(m))
  await m.setEnabled(profile, id, true)
  const trusted = await decision(m)

  await m.untrust(profile, id, trusted)
  expect(load().packages[id]).toMatchObject({ state: { trusted: null, enabled: false } })
  expect((await m.inventory(profile)).packages[0]).toMatchObject({ trusted: false, enabled: false })

  version('2.0.0')
  const target = await m.inspect(profile, source)
  await expect(
    m.update(profile, id, source, {
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: trusted.integrity,
        trust: { integrity: target.integrity, capabilityHash: target.capabilityHash ?? '' },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  await m.update(profile, id, source, { expectedIntegrity: target.integrity })
  const current = await decision(m)
  await expect(
    m.rollback(profile, id, {
      expectedTargetIntegrity: trusted.integrity,
      activation: {
        expectedInstalledIntegrity: current.integrity,
        trust: { integrity: trusted.integrity, capabilityHash: trusted.capabilityHash },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  expect(load().packages[id]).toMatchObject({ state: { trusted: null, enabled: false } })
})
it('atomically binds installed and target digests when update or rollback also trusts and enables', async () => {
  const m = await install(manager({ references: emptyRefs }))
  const initial = (await m.inventory(profile)).packages[0]
  if (!initial) throw new Error('missing initial package')
  await m.trust(profile, id, {
    integrity: initial.entry.integrity,
    capabilityHash: initial.capabilityHash,
  })
  await m.setEnabled(profile, id, true)

  version('2.0.0')
  const target = await m.inspect(profile, source)
  await expect(
    m.update(profile, id, source, {
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: initial.entry.integrity,
        trust: { integrity: target.integrity, capabilityHash: '0'.repeat(64) },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  expect(load().packages[id]?.integrity).toBe(initial.entry.integrity)
  const updated = await m.update(profile, id, source, {
    expectedIntegrity: target.integrity,
    activation: {
      expectedInstalledIntegrity: initial.entry.integrity,
      trust: { integrity: target.integrity, capabilityHash: target.capabilityHash ?? '' },
    },
  })
  expect(updated).toMatchObject({
    version: '2.0.0',
    state: { trusted: '2026-09-13T00:00:00Z', enabled: true },
    trustDecision: { integrity: target.integrity, capabilityHash: target.capabilityHash },
  })

  version('3.0.0')
  const third = await m.inspect(profile, source)
  await expect(
    m.update(profile, id, source, {
      expectedIntegrity: third.integrity,
      activation: {
        expectedInstalledIntegrity: initial.entry.integrity,
        trust: { integrity: third.integrity, capabilityHash: third.capabilityHash ?? '' },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  expect(load().packages[id]?.integrity).toBe(target.integrity)

  const rolled = await m.rollback(profile, id, {
    expectedTargetIntegrity: initial.entry.integrity,
    activation: {
      expectedInstalledIntegrity: target.integrity,
      trust: { integrity: initial.entry.integrity, capabilityHash: initial.capabilityHash },
    },
  })
  expect(rolled).toMatchObject({
    version: '1.0.0',
    state: { trusted: '2026-09-13T00:00:00Z', enabled: true },
    trustDecision: { integrity: initial.entry.integrity, capabilityHash: initial.capabilityHash },
  })
})

it('rejects stale enable and rollback targets while preserving the current desired state', async () => {
  const m = await install(manager({ references: emptyRefs }))
  const initial = (await m.inventory(profile)).packages[0]
  if (!initial) throw new Error('missing initial package')
  await expect(
    m.setEnabled(profile, id, true, { expectedInstalledIntegrity: `sha256-${'0'.repeat(64)}` }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  expect(load().packages[id]?.state.enabled).toBe(false)

  version('2.0.0')
  const target = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: target.integrity })
  await expect(
    m.rollback(profile, id, { expectedTargetIntegrity: `sha256-${'0'.repeat(64)}` }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  expect(load().packages[id]?.integrity).toBe(target.integrity)
})
it.each(['integrity', 'capabilityHash'] as const)(
  'refuses wrong %s and does not allow legacy facade methods to bypass modern trust',
  async (field) => {
    const m = await install(),
      d = await decision(m)
    d[field] = field === 'integrity' ? `sha256-${'0'.repeat(64)}` : '0'.repeat(64)
    await expect(m.trust(profile, id, d)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
    await expect(m.enable(profile, id, true)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
    expect(load().packages[id]?.state.trusted).toBeNull()
  },
)
it.each(['disable', 'update', 'rollback', 'remove'] as const)(
  'missing runtime reference authority blocks %s',
  async (operation) => {
    const m = await install(manager({ references: emptyRefs }))
    version('2.0.0')
    const p = await m.inspect(profile, source)
    await m.update(profile, id, source, { expectedIntegrity: p.integrity })
    const unbound = manager(),
      run =
        operation === 'disable'
          ? () => unbound.setEnabled(profile, id, false)
          : operation === 'update'
            ? () => unbound.update(profile, id, source, { expectedIntegrity: p.integrity })
            : () => unbound[operation](profile, id)
    await expect(run()).rejects.toMatchObject({
      code: 'E_PACKAGE_BLOCKED',
      detail: { blockers: [{ code: 'generation', references: ['reference-authority-unavailable'] }] },
    })
    expect(load().packages[id]?.version).toBe('2.0.0')
  },
)
it('blocks dependency/Profile and deployment refs, passing only controlled operation identity', async () => {
  const refs = vi.fn(async () => [{ code: 'deployment' as const, references: ['web'] }]),
    m = await install(manager({ references: refs }))
  const lock = load(),
    entry = lock.packages[id]
  if (!entry) throw Error('missing')
  const dependent = structuredClone(entry)
  delete dependent.contributions
  delete dependent.treeIntegrity
  dependent.dependencies = { [id]: '1.0.0' }
  lock.packages['acme/dependent'] = dependent
  lock.provider.package = id
  writeLock(profile, lock)
  await expect(m.remove(profile, id)).rejects.toMatchObject({
    detail: {
      blockers: [
        { code: 'dependency', references: ['acme/dependent'] },
        { code: 'profile', references: ['provider'] },
        { code: 'deployment', references: ['web'] },
      ],
    },
  })
  expect(refs).toHaveBeenCalledWith('local-dev', id, 'remove', [])
  expect(existsSync(packageDir(root, 'local-dev', id))).toBe(true)
})
it('rejects tree/lock metadata tampering and unknown legacy contribution stays blocked', async () => {
  const m = await install(),
    dir = packageDir(root, 'local-dev', id)
  writeFileSync(join(dir, 'tamper'), 'changed')
  await expect(m.inventory(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  await expect(m.provenance(profile, id)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  rmSync(join(dir, 'tamper'))
  const lock = load(),
    entry = lock.packages[id]
  if (!entry) throw Error('missing')
  delete entry.contributions
  delete entry.treeIntegrity
  writeLock(profile, lock)
  expect((await m.inventory(profile)).packages[0]?.blockers).toEqual([
    { code: 'unknown-contribution', references: ['static-inventory-migration-required'] },
  ])
})
it('legacy add cannot replace a modern package or overwrite a flattened-ID collision', async () => {
  const m = await install()
  await expect(m.add(profile, source.ref)).rejects.toThrow('digest-bound update')
  const pkgFile = join(sourceDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.name = 'acme__pkg-a'
  pkg.agnes = { contributions: [{ kind: 'skill', id: 'acme/skill', path: './index.ts' }] }
  writeFileSync(pkgFile, JSON.stringify(pkg))
  const p = await m.inspect(profile, source)
  await expect(m.install(profile, source, { expectedIntegrity: p.integrity })).rejects.toMatchObject({
    detail: { reason: 'package-path-collision' },
  })
  expect(load().packages[id]?.version).toBe('1.0.0')
})
it('manager recovers a committed update before exposing inventory, without duplicate audit', async () => {
  const m = await install(manager({ references: emptyRefs }))
  version('2.0.0')
  const p = await m.inspect(profile, source)
  const crash = manager({
    references: emptyRefs,
    checkpoint: (point) => {
      if (point === 'lock-written') throw Error('crash')
    },
  })
  await expect(crash.update(profile, id, source, { expectedIntegrity: p.integrity })).rejects.toThrow('crash')
  expect((await m.inventory(profile)).packages[0]?.entry.version).toBe('2.0.0')
  await m.recover(profile)
  expect(readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
})

it('does not apply an extension capability ceiling to a Cordis plugin row', async () => {
  const m = await install()
  await m.trust(profile, id, await decision(m))
  const tightened = manager({ ceiling: [] })
  await tightened.setEnabled(profile, id, true)
  expect((await tightened.inventory(profile)).packages[0]?.blockers).toEqual([])
  expect(load().packages[id]?.state.enabled).toBe(true)
})
it('protects provider adapters even when no external runtime references exist', async () => {
  const m = await install(manager({ references: emptyRefs })),
    lock = load()
  lock.provider.adapters = [id]
  writeLock(profile, lock)
  await expect(m.remove(profile, id)).rejects.toMatchObject({
    detail: { blockers: [{ code: 'profile', references: ['provider.adapter'] }] },
  })
  expect(existsSync(packageDir(root, 'local-dev', id))).toBe(true)
})
it('returns the same public preview hash used by the installed trust decision', async () => {
  const m = manager(),
    p = await m.inspect(profile, source)
  expect(p.capabilityHash).toMatch(/^[a-f0-9]{64}$/)
  await m.install(profile, source, { expectedIntegrity: p.integrity })
  expect((await decision(m)).capabilityHash).toBe(p.capabilityHash)
  await m.trust(profile, id, { integrity: p.integrity, capabilityHash: p.capabilityHash ?? '' })
})
it('keeps missing-profile status compatible and inventory hashes independent of location', async () => {
  const m = await install()
  expect(await m.status(join(root, 'missing'))).toEqual([])
  expect(existsSync(join(root, 'missing'))).toBe(false)
  const p = await m.inventory(profile),
    mirror = join(root, 'mirror')
  mkdirSync(join(mirror, 'profiles'), { recursive: true })
  cpSync(profile, join(mirror, 'profiles', 'local-dev'), { recursive: true })
  const moved = createPackageManager({ dataDir: mirror, agnesVersion: '0.1.0' })
  expect((await moved.inventory(join(mirror, 'profiles', 'local-dev'))).hash).toBe(p.hash)
})

it('the Host read-only lock adapter refuses a changed modern trust snapshot', async () => {
  const { lockState } = await import('../src/index.js'),
    m = await install()
  await m.trust(profile, id, await decision(m))
  const lock = load(),
    entry = lock.packages[id]
  if (!entry) throw Error('missing')
  entry.dependencies['acme/new'] = '1.0.0'
  expect(() => lockState(lock, { profileDir: profile })).toThrow('trust snapshot differs')
})

it('enforces administrator source policy and exact Ed25519 catalog tuples at installation', async () => {
  const m = manager(),
    preview = await m.inspect(profile, source)
  const config = join(profile, 'package-sources.json')
  writeFileSync(config, JSON.stringify({ allowedSources: 'official-only' }))
  await expect(m.install(profile, source, { expectedIntegrity: preview.integrity })).rejects.toMatchObject({
    code: 'E_PACKAGE_SOURCE_POLICY',
  })
  expect(load().packages[id]).toBeUndefined()
  const keys = generateKeyPairSync('ed25519')
  const definition = {
    serverId: 'official-fixture',
    displayName: 'Official fixture',
    transport: { kind: 'stdio' as const, executable: '/usr/bin/example', args: [] },
    secretBinding: { kind: 'none' as const },
  }
  const { jcs } = await import('@agnes/protocol')
  const statement = {
    mcpDefinitions: [`sha256-${createHash('sha256').update(jcs(definition)).digest('hex')}`],
    keyId: 'development-test',
    issuedAt: '2026-09-13T00:00:00Z',
    entries: [
      {
        id,
        version: preview.version,
        source,
        treeIntegrity: preview.provenance.treeIntegrity!,
        publisher: 'Agnes test maintainer',
      },
    ],
  }
  const { canonical } = await import('../src/integrity.js')
  const signature = sign(null, Buffer.from(canonical(statement)), keys.privateKey).toString('base64')
  const policy = {
    allowedSources: 'official-only' as const,
    officialKeys: { 'development-test': keys.publicKey.export({ type: 'spki', format: 'pem' }) as string },
    officialCatalog: { statement, signature },
  }
  expect(isOfficialMcpDefinition(policy, definition)).toBe(true)
  expect(isOfficialMcpDefinition(policy, { ...definition, displayName: 'Changed' })).toBe(false)
  writeFileSync(config, JSON.stringify(policy))
  await m.install(profile, source, { expectedIntegrity: preview.integrity })
  expect(await m.provenance(profile, id)).toMatchObject({
    sourceKind: 'official-catalog',
    verification: 'official-ed25519',
    publisher: 'Agnes test maintainer',
    signatureVerified: true,
  })
  const { officialCatalogVerifier } = await import('../src/provenance.js')
  const installedProvenance = await m.provenance(profile, id)
  const round = officialCatalogVerifier(policy)
  // The round must own its keys and signed statement rather than trusting a later mutation of
  // the caller's configuration after the first successful signature check.
  expect(round(id, installedProvenance).verification).toBe('official-ed25519')
  const changedPolicy = structuredClone(policy)
  const independentRound = officialCatalogVerifier(changedPolicy)
  const changedTuple = changedPolicy.officialCatalog.statement.entries[0]
  if (!changedTuple) throw new Error('missing official tuple')
  changedTuple.treeIntegrity = `sha256-${'9'.repeat(64)}`
  changedPolicy.officialKeys['development-test'] = 'invalid key'
  expect(independentRound(id, installedProvenance).verification).toBe('official-ed25519')
  expect(() => officialCatalogVerifier(changedPolicy)(id, installedProvenance)).toThrow('signature')
  expect(round('acme/not-in-catalog', installedProvenance).verification).toBe('unverified')
  expect(() => round(id, { ...installedProvenance, treeIntegrity: `sha256-${'9'.repeat(64)}` })).toThrow(
    'integrity differs',
  )
  writeFileSync(
    config,
    JSON.stringify({
      ...policy,
      officialCatalog: { statement: { ...statement, issuedAt: '2026-09-14T00:00:00Z' }, signature },
    }),
  )
  await expect(m.inspect(profile, source)).rejects.toMatchObject({ code: 'E_PACKAGE_PROVENANCE' })
  await expect(m.provenance(profile, id)).rejects.toMatchObject({ code: 'E_PACKAGE_PROVENANCE' })
  writeFileSync(config, JSON.stringify({ allowedSources: 'official-only' }))
  await expect(m.provenance(profile, id)).rejects.toMatchObject({ code: 'E_PACKAGE_SOURCE_POLICY' })
})
it('binds npm verified identity to exact package subject and actual archive digest', async () => {
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
  const bundle = {
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(
        JSON.stringify({
          subject: [
            { name: 'pkg:npm/fixture@1.0.0', digest: { sha512: Buffer.alloc(64, 1).toString('hex') } },
          ],
        }),
      ).toString('base64'),
    },
  }
  const verified = async () => ({
    identity: {
      subjectAlternativeName: 'https://github.com/fixture/repo/.github/workflows/release.yml@refs/heads/main',
    },
  })
  expect(
    await verifyNpmProvenance({ name: 'fixture', version: '1.0.0', integrity, bundle }, verified),
  ).toMatchObject({ verification: 'npm-sigstore', signatureVerified: true })
  await expect(
    verifyNpmProvenance({ name: 'fixture', version: '2.0.0', integrity, bundle }, verified),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PROVENANCE' })
  await expect(
    verifyNpmProvenance({ name: 'fixture', version: '1.0.0', integrity, bundle }, async () => {
      throw Error('invalid certificate')
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PROVENANCE' })
})

it.each(['1.0.0', '1.1.0-alpha.2'])(
  'requires the reviewed parent %s before enabling an example and blocks its runtime when the parent is disabled',
  async (parentVersion) => {
    const parentFile = join(sourceDir, 'package.json')
    const parentManifest = JSON.parse(readFileSync(parentFile, 'utf8'))
    parentManifest.version = parentVersion
    writeFileSync(parentFile, JSON.stringify(parentManifest))
    const childDir = join(root, 'child')
    cpSync(sourceDir, childDir, { recursive: true })
    const pkg = JSON.parse(readFileSync(join(childDir, 'package.json'), 'utf8'))
    pkg.name = 'acme/example'
    pkg.agnes.plugins[0].id = 'ext:acme/example/main'
    pkg.dependencies[id] = parentVersion.includes('-') ? parentVersion : '^1.0.0'
    pkg.agnes.metadata = {
      displayName: 'Example',
      summary: 'Example',
      description: 'Example',
      exampleOf: id,
    }
    writeFileSync(join(childDir, 'package.json'), JSON.stringify(pkg))
    const m = manager({ references: emptyRefs })
    const childSource = parseSource('file:./child')
    const missing = await m.inspect(profile, childSource)
    const blocker = { code: 'dependency', references: ['example-parent-unavailable', id] }
    expect(missing.blockers).toContainEqual(blocker)
    await m.install(profile, childSource, { expectedIntegrity: missing.integrity })
    await expect(m.enable(profile, pkg.name, true)).rejects.toMatchObject({ code: 'E_PACKAGE_BLOCKED' })
    expect(load().packages[pkg.name]?.state.enabled).toBe(false)
    expect(load().packages[id]).toBeUndefined()
    await install(m)
    await m.trust(profile, id, await decision(m))
    expect((await m.inspect(profile, childSource)).blockers).toContainEqual(blocker)
    await m.enable(profile, id, true)
    const reviewedRange = pkg.dependencies[id]
    pkg.dependencies[id] = '99.0.0-alpha.1'
    writeFileSync(join(childDir, 'package.json'), JSON.stringify(pkg))
    expect((await m.inspect(profile, childSource)).blockers).toContainEqual(blocker)
    pkg.dependencies[id] = reviewedRange
    writeFileSync(join(childDir, 'package.json'), JSON.stringify(pkg))
    const ready = await m.inspect(profile, childSource)
    expect(ready.blockers).toEqual([])
    await m.trust(profile, pkg.name, { integrity: ready.integrity, capabilityHash: ready.capabilityHash! })
    await m.enable(profile, pkg.name, true)
    expect((await m.inventory(profile)).packages.find((row) => row.id === pkg.name)).toMatchObject({
      enabled: true,
      trusted: true,
      blockers: [],
    })
    await m.enable(profile, id, false)
    expect((await m.inventory(profile)).packages.find((row) => row.id === pkg.name)?.blockers).toContainEqual(
      blocker,
    )
    await expect(m.enable(profile, pkg.name, true)).rejects.toMatchObject({ code: 'E_PACKAGE_BLOCKED' })
    await m.enable(profile, id, true)
    expect((await m.inventory(profile)).packages.find((row) => row.id === pkg.name)?.blockers).toEqual([])
  },
)

async function installDependent(m: ReturnType<typeof manager>, range: string) {
  const childDir = join(root, 'dependent')
  cpSync(sourceDir, childDir, { recursive: true })
  const file = join(childDir, 'package.json'),
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.name = 'acme/dependent'
  pkg.agnes.plugins[0].id = 'ext:acme/dependent/main'
  pkg.dependencies[id] = range
  pkg.agnes.metadata = {
    displayName: 'Dependent',
    summary: 'Fixture',
    description: 'Fixture',
    exampleOf: id,
  }
  writeFileSync(file, JSON.stringify(pkg))
  const childSource = parseSource('file:./dependent'),
    preview = await m.inspect(profile, childSource)
  await m.install(profile, childSource, { expectedIntegrity: preview.integrity })
  await m.trust(profile, pkg.name, { integrity: preview.integrity, capabilityHash: preview.capabilityHash! })
  await m.enable(profile, pkg.name, true)
  return { file, pkg, source: childSource, preview }
}
it.each(['^1.0.0', '*', '1.0.0'])(
  'updates a parent only when its installed dependent range %s admits the candidate',
  async (range) => {
    const m = await install(manager({ references: emptyRefs }))
    await m.trust(profile, id, await decision(m))
    await m.enable(profile, id, true)
    const child = await installDependent(m, range)
    const before = (await decision(m)).integrity
    if (range === '1.0.0') writeFileSync(join(sourceDir, 'revision.txt'), 'same version, new release bytes')
    else version('1.1.0')
    const target = await m.inspect(profile, source)
    expect(target.blockers).toEqual([])
    await m.update(profile, id, source, {
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: before,
        trust: { integrity: target.integrity, capabilityHash: target.capabilityHash! },
      },
    })
    expect((await m.inventory(profile)).packages.find((row) => row.id === child.preview.id)).toMatchObject({
      enabled: true,
      trusted: true,
      blockers: [],
    })
    version('2.0.0')
    if (range !== '*') {
      const incompatible = await m.inspect(profile, source)
      expect(incompatible.blockers).toContainEqual({ code: 'dependency', references: [child.preview.id] })
      await expect(
        m.update(profile, id, source, { expectedIntegrity: incompatible.integrity }),
      ).rejects.toMatchObject({
        code: 'E_PACKAGE_BLOCKED',
        detail: { blockers: [{ code: 'dependency', references: [child.preview.id] }] },
      })
      expect(load().packages[id]?.integrity).toBe(target.integrity)
    }
  },
)
it.each([
  'none',
  'disabled',
  'prepared',
  'old-moved',
  'new-moved',
  'second-new-moved',
  'lock-written',
  'audit-written',
  'previous-saved',
] as const)(
  'commits or recovers a reviewed parent/dependent update at %s without an incompatible pair',
  async (point) => {
    const m = await install(manager({ references: emptyRefs }))
    await m.trust(profile, id, await decision(m))
    await m.enable(profile, id, true)
    const child = await installDependent(m, '1.0.0'),
      before = await decision(m)
    if (point === 'disabled') await m.enable(profile, child.preview.id, false)
    version('1.1.0')
    child.pkg.version = '1.1.0'
    child.pkg.dependencies[id] = '1.1.0'
    writeFileSync(child.file, JSON.stringify(child.pkg))
    const target = await m.inspect(profile, source),
      dependent = await m.inspect(profile, child.source)
    const options = {
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: before.integrity,
        trust: { integrity: target.integrity, capabilityHash: target.capabilityHash! },
      },
      dependents: [
        {
          id: dependent.id,
          source: child.source,
          expectedIntegrity: dependent.integrity,
          activation: {
            expectedInstalledIntegrity: child.preview.integrity,
            expectedActiveIntegrity: null,
            trust: { integrity: dependent.integrity, capabilityHash: dependent.capabilityHash! },
          },
        },
      ],
    }
    await expect(
      m.update(profile, id, source, {
        ...options,
        dependents: options.dependents.map((d) => ({ ...d, expectedIntegrity: child.preview.integrity })),
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
    expect(load().packages[id]?.integrity).toBe(before.integrity)
    let moved = 0
    const crash = manager({
      references: emptyRefs,
      checkpoint: (at) => {
        if (at === 'new-moved') moved++
        if (at === point || (point === 'second-new-moved' && at === 'new-moved' && moved === 2))
          throw Error('crash')
      },
    })
    if (point === 'none' || point === 'disabled') await crash.update(profile, id, source, options)
    else await expect(crash.update(profile, id, source, options)).rejects.toThrow('crash')
    await m.recover(profile)
    const inventory = await m.inventory(profile),
      next = ['none', 'disabled', 'lock-written', 'audit-written', 'previous-saved'].includes(point)
    for (const packageId of [id, dependent.id])
      expect(inventory.packages.find((row) => row.id === packageId)).toMatchObject({
        enabled: packageId !== dependent.id || point !== 'disabled',
        trusted: true,
        blockers: [],
        entry: { version: next ? '1.1.0' : '1.0.0' },
      })
  },
)

it.each(
  (['install', 'update', 'trust', 'enable'] as const).flatMap((operation) =>
    (['queued', 'prepared', 'new-moved', 'lock-flushed'] as const).flatMap((boundary) =>
      (['epoch', 'deadline'] as const).map((loss) => ({ operation, boundary, loss })),
    ),
  ),
)(
  'revokes $operation at $boundary after losing $loss without publishing state',
  async ({ operation, boundary, loss }) => {
    let epoch = 1,
      now = 0,
      armed = false
    const expire = () => {
      if (loss === 'epoch') epoch++
      else now = 10
    }
    const assertActive = () => {
      if (epoch !== 1 || now >= 10) throw Error('permission unavailable')
    }
    const admission = { verify: async () => assertActive(), assertActive }
    const m = manager({
      references: emptyRefs,
      checkpoint: (point) => {
        if (armed && point === boundary) expire()
      },
    })
    if (operation !== 'install') await install(m)
    if (operation === 'enable') await m.trust(profile, id, await decision(m))
    if (operation === 'update') version('2.0.0')
    const preview = await m.inspect(profile, source)
    const trust = operation === 'trust' ? await decision(m) : undefined
    const before = load()
    const directory = packageDir(root, 'local-dev', id)
    const { hashDirectory } = await import('../src/sources.js')
    const beforeTree = existsSync(directory) ? hashDirectory(directory, { exclude: [] }) : null
    const lockfile = await import('../src/lockfile.js')
    const prepare = lockfile.prepareLockPublication
    const spy = vi.spyOn(lockfile, 'prepareLockPublication').mockImplementation((...args) => {
      const pending = prepare(...args)
      if (armed && boundary === 'lock-flushed') expire()
      return pending
    })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held =
      boundary === 'queued'
        ? lockfile.withLock(profile, async () => {
            entered()
            await gate
          })
        : undefined
    if (held) await holding
    armed = true
    try {
      const result =
        operation === 'install'
          ? m.install(profile, source, { expectedIntegrity: preview.integrity, admission })
          : operation === 'update'
            ? m.update(profile, id, source, { expectedIntegrity: preview.integrity, admission })
            : operation === 'trust'
              ? m.trust(profile, id, trust!, { admission })
              : m.enable(profile, id, true, { admission })
      const refusal = expect(result).rejects.toThrow('permission unavailable')
      if (held) {
        expire()
        release()
        await held
      }
      await refusal
      expect(load()).toEqual(before)
      expect(existsSync(directory) ? hashDirectory(directory, { exclude: [] }) : null).toBe(beforeTree)
      expect(
        readdirSync(profile).filter((name) => name.includes('transaction') || name.endsWith('.tmp')),
      ).toEqual([])
      armed = false
      // Ordinary administrator operations do not inherit the failed private admission.
      if (operation === 'install') await m.install(profile, source, { expectedIntegrity: preview.integrity })
      else if (operation === 'update')
        await m.update(profile, id, source, { expectedIntegrity: preview.integrity })
      else if (operation === 'trust') await m.trust(profile, id, trust!)
      else await m.enable(profile, id, true)
    } finally {
      release()
      await held
      spy.mockRestore()
    }
  },
)

it.each(['revocation', 'abort', 'expiry', 'epoch', 'stale-proof'])(
  'shared proof: refuses package %s at final publication',
  async (loss) => {
    const { permissionEffectAdmission } = await import('@agnes/protocol')
    let active = true,
      now = 0,
      epoch = 0,
      version = 1
    const controller = new AbortController()
    const proof = permissionEffectAdmission({
      signals: [controller.signal],
      expiresAt: 10,
      clock: () => now,
      unavailable: () => Error('permission unavailable'),
      assertBound: () => {
        if (!active || epoch !== 0 || version !== 1) throw Error('permission unavailable')
      },
    })
    const lose = () => {
      if (loss === 'revocation') active = false
      if (loss === 'abort') controller.abort()
      if (loss === 'expiry') now = 10
      if (loss === 'epoch') epoch++
      if (loss === 'stale-proof') version++
    }
    let flushed = false
    const admission = {
      ...proof,
      verify: async () => {
        await proof.verify()
        if (flushed) lose()
      },
    }
    const m = manager({ references: emptyRefs })
    const preview = await m.inspect(profile, source)
    const before = load()
    const lockfile = await import('../src/lockfile.js')
    const prepare = lockfile.prepareLockPublication
    const spy = vi.spyOn(lockfile, 'prepareLockPublication').mockImplementation((...args) => {
      const staged = prepare(...args)
      flushed = true
      return staged
    })
    try {
      await expect(
        m.install(profile, source, { expectedIntegrity: preview.integrity, admission }),
      ).rejects.toThrow('permission unavailable')
    } finally {
      spy.mockRestore()
    }
    expect(load()).toEqual(before)
    expect(existsSync(packageDir(root, 'local-dev', id))).toBe(false)
    expect(
      readdirSync(profile).filter((name) => name.includes('transaction') || name.endsWith('.tmp')),
    ).toEqual([])
  },
)
