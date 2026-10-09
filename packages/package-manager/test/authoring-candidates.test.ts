import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePackageAdminData } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthoringCandidates } from '../src/authoring-candidates.js'
import { discoverLocalPlugins, localPluginRoots } from '../src/local-source.js'
import { emptyLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const origin = {
  sessionKey: 'synthetic-session',
  toolUseId: 'call-1',
  turn: 2,
  packageId: '@agnes/base',
  snapshotId: 'builtin',
  rowId: 'ext:creator/main',
}
const files = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'reviewed-tool',
      version: '1.0.0',
      type: 'module',
      license: 'MIT',
      exports: './index.mjs',
      agnes: {
        capabilities: {},
        plugins: [
          { apiRange: '^1.4.0', export: 'main', id: 'ext:reviewed-tool/main', inject: ['extension'] },
        ],
      },
    }),
  },
  { path: 'index.mjs', content: 'export const main={inject:["extension"],apply(){}}\n' },
  { path: 'test/tool.test.mjs', content: '// host runner fixture\n' },
]
function setup(pass = true) {
  const root = mkdtempSync(join(tmpdir(), 'agh-authoring-'))
  roots.push(root)
  const profile = join(root, 'profiles/test')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('test', '0.0.0'),
    resolvedProfileHash: 'sha256-' + '0'.repeat(64),
    seams: Object.fromEntries(
      [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'platform',
        'harness',
      ].map((k) => [k, '@agnes/base']),
    ),
  })
  const manager = createPackageManager({
    dataDir: join(root, 'data'),
    agnesVersion: '0.0.0',
    references: async () => [],
  })
  const runner = vi.fn(async () => ({
    state: pass ? ('passed' as const) : ('failed' as const),
    count: pass ? 1 : 0,
    runner: 'node-test' as const,
    output: 'synthetic result',
  }))
  return { root, profile, manager, runner, candidates: new AuthoringCandidates(manager, runner) }
}
async function review(s: ReturnType<typeof setup>, command = 'draft') {
  const d = await s.candidates.create(s.profile, files, 'owner', command, origin)
  expect(validatePackageAdminData('AuthoringCandidate', d).ok).toBe(true)
  await s.candidates.test(s.profile, d.candidateId, 'owner', d.candidateHash, new AbortController().signal)
  return s.candidates.submit(s.profile, d.candidateId, 'owner', d.candidateHash)
}
it('keeps drafts outside discovery and binds tests, diffs, capabilities and provenance to one review; editing invalidates the old decision', async () => {
  const s = setup()
  const r = await review(s)
  expect(discoverLocalPlugins(localPluginRoots(join(s.root, 'home'), join(s.root, 'workspace')))).toEqual([])
  expect((await s.manager.inventory(s.profile)).packages).toEqual([])
  expect(r).toMatchObject({
    state: 'review',
    baseHash: null,
    installer: 'agent',
    origin,
    tests: { state: 'passed', hash: r.candidateHash, count: 1 },
  })
  expect(r.files.find((f) => f.path === 'index.mjs')).toMatchObject({
    before: null,
    after: files[1]?.content,
  })
  expect(r.reviewHash).toMatch(/^sha256-/)
  expect(r.preview?.capabilityHash).toMatch(/^[a-f0-9]{64}$/)
  const next = await s.candidates.write(
    s.profile,
    r.candidateId,
    'owner',
    r.candidateHash,
    files.map((f) => (f.path === 'index.mjs' ? { ...f, content: f.content + '// edit\n' } : f)),
  )
  expect(next).toMatchObject({ state: 'draft', tests: null, reviewHash: null })
  expect(next.candidateHash).not.toBe(r.candidateHash)
  const publish = vi.fn(async () => {})
  await expect(
    s.candidates.decide(s.profile, r.candidateId, 'owner', r.candidateHash, r.reviewHash!, true, publish),
  ).rejects.toThrow('Candidate changed')
  expect(publish).not.toHaveBeenCalled()
  expect((await s.manager.inventory(s.profile)).packages).toEqual([])
  await s.candidates.test(
    s.profile,
    next.candidateId,
    'owner',
    next.candidateHash,
    new AbortController().signal,
  )
  const fresh = await s.candidates.submit(s.profile, next.candidateId, 'owner', next.candidateHash)
  await s.candidates.decide(
    s.profile,
    fresh.candidateId,
    'owner',
    fresh.candidateHash,
    fresh.reviewHash!,
    false,
    publish,
  )
  await expect(
    s.candidates.decide(
      s.profile,
      fresh.candidateId,
      'owner',
      fresh.candidateHash,
      fresh.reviewHash!,
      true,
      publish,
    ),
  ).rejects.toThrow('Review is stale')
  expect(publish).not.toHaveBeenCalled()
})
it('refuses failed tests, foreign owners, unsafe files, symlinks and source edits made during testing', async () => {
  const s = setup(false)
  const d = await s.candidates.create(s.profile, files, 'owner', 'draft', origin)
  expect(
    (
      await s.candidates.test(
        s.profile,
        d.candidateId,
        'owner',
        d.candidateHash,
        new AbortController().signal,
      )
    ).state,
  ).toBe('failed')
  await expect(s.candidates.submit(s.profile, d.candidateId, 'owner', d.candidateHash)).rejects.toThrow(
    'Passing tests',
  )
  expect(() => s.candidates.show(s.profile, d.candidateId, 'other')).toThrow('unavailable')
  for (const path of ['../escape', 'node_modules/code.mjs', 'src/CON.mjs', 'INDEX.mjs'])
    await expect(
      s.candidates.write(s.profile, d.candidateId, 'owner', d.candidateHash, [
        ...files,
        { path, content: '' },
      ]),
    ).rejects.toThrow()
  s.runner.mockImplementationOnce(async () => {
    const record = JSON.parse(
      readFileSync(join(s.profile, '.authoring-candidates', d.candidateId, 'record.json'), 'utf8'),
    )
    writeFileSync(join(record.tree, 'index.mjs'), 'changed during test')
    return { state: 'passed', count: 1, runner: 'node-test', output: 'claimed pass' }
  })
  await expect(
    s.candidates.test(s.profile, d.candidateId, 'owner', d.candidateHash, new AbortController().signal),
  ).rejects.toThrow('Candidate changed')
  const recordPath = join(s.profile, '.authoring-candidates', d.candidateId, 'record.json')
  const beforeEvidence = readFileSync(recordPath, 'utf8')
  expect(() => s.candidates.evidence(s.profile, d.candidateId, 'owner')).toThrow('evidence is unavailable')
  expect(readFileSync(recordPath, 'utf8')).toBe(beforeEvidence)
  const current = s.candidates.show(s.profile, d.candidateId, 'owner')
  expect(current.tests).toBeNull()
  expect(current.candidateHash).not.toBe(d.candidateHash)
  const record = JSON.parse(
    readFileSync(join(s.profile, '.authoring-candidates', d.candidateId, 'record.json'), 'utf8'),
  )
  symlinkSync('index.mjs', join(record.tree, 'link.mjs'))
  expect(() => s.candidates.show(s.profile, d.candidateId, 'owner')).toThrow('symbolic link')
})
it.each(['trust failed', 'reviewed bytes changed'] as const)(
  'publishes only the approved bytes and never replays failure or interrupted publication: %s',
  async (failure) => {
    const s = setup()
    const r = await review(s)
    const publish = vi.fn<Parameters<AuthoringCandidates['decide']>[6]>(async (source, value) => {
      if (failure === 'reviewed bytes changed')
        writeFileSync(join(source.ref.slice('file:'.length), 'index.mjs'), 'altered after human approval')
      await s.manager.install(s.profile, source, {
        expectedIntegrity: value.candidateHash,
        installer: 'agent',
      })
      throw new Error('trust failed')
    })
    await expect(
      s.candidates.decide(s.profile, r.candidateId, 'owner', r.candidateHash, r.reviewHash!, true, publish),
    ).rejects.toThrow(failure === 'trust failed' ? 'trust failed' : 'package preview is stale')
    if (failure === 'trust failed') {
      expect((await s.manager.provenance(s.profile, r.packageId)).installer).toBe('agent')
      const row = (await s.manager.inventory(s.profile)).packages[0]
      expect(row).toMatchObject({ trusted: false, enabled: false })
    } else expect((await s.manager.inventory(s.profile)).packages).toEqual([])
    const reopened = new AuthoringCandidates(s.manager, s.runner)
    await expect(
      reopened.decide(s.profile, r.candidateId, 'owner', r.candidateHash, r.reviewHash!, true, publish),
    ).rejects.toThrow('Review is stale')
    expect(publish).toHaveBeenCalledOnce()
    const file = join(s.profile, '.authoring-candidates', r.candidateId, 'record.json'),
      record = JSON.parse(readFileSync(file, 'utf8'))
    record.value.state = 'publishing'
    writeFileSync(file, JSON.stringify(record))
    const beforeEvidence = readFileSync(file, 'utf8')
    if (failure === 'trust failed')
      expect(reopened.evidence(s.profile, r.candidateId, 'owner').state).toBe('interrupted')
    else expect(() => reopened.evidence(s.profile, r.candidateId, 'owner')).toThrow('evidence is unavailable')
    expect(readFileSync(file, 'utf8')).toBe(beforeEvidence)
    expect(() => reopened.evidence(s.profile, r.candidateId, 'foreign')).toThrow('unavailable')
    expect(reopened.show(s.profile, r.candidateId, 'owner').state).toBe('interrupted')
    expect(publish).toHaveBeenCalledOnce()
  },
)
it('reports that published executable tools are available in new sessions and preserves that guidance after reopening', async () => {
  const s = setup()
  const r = await review(s)
  const published = await s.candidates.decide(
    s.profile,
    r.candidateId,
    'owner',
    r.candidateHash,
    r.reviewHash!,
    true,
    async (source, value) => {
      await s.manager.install(s.profile, source, {
        expectedIntegrity: value.candidateHash,
        installer: 'agent',
      })
    },
  )
  expect(published.state).toBe('published')
  expect(published.message).toContain('new sessions')
  expect(published.message).toContain('existing sessions keep their pins')
  expect(new AuthoringCandidates(s.manager, s.runner).show(s.profile, r.candidateId, 'owner').message).toBe(
    published.message,
  )
})
it('detects installed baseline changes and damaged immutable snapshots before any publication', async () => {
  const s = setup()
  const r = await review(s),
    publish = vi.fn(async () => {})
  const file = join(s.profile, '.authoring-candidates', r.candidateId, 'record.json'),
    record = JSON.parse(readFileSync(file, 'utf8'))
  await s.manager.install(
    s.profile,
    { type: 'file', ref: 'file:' + record.tree },
    { expectedIntegrity: r.candidateHash },
  )
  await expect(
    s.candidates.decide(s.profile, r.candidateId, 'owner', r.candidateHash, r.reviewHash!, true, publish),
  ).rejects.toThrow('Installed version changed')
  expect(publish).not.toHaveBeenCalled()
  writeFileSync(join(record.snapshot, 'index.mjs'), 'changed review bytes')
  await expect(
    s.candidates.decide(s.profile, r.candidateId, 'owner', r.candidateHash, r.reviewHash!, true, publish),
  ).rejects.toThrow('Review is stale')
  expect(publish).not.toHaveBeenCalled()
})

it('reviews capability increases against the installed hash, rejects altered review metadata, and respects normal capability policy', async () => {
  const s = setup()
  const initial = await review(s)
  const record = JSON.parse(
    readFileSync(join(s.profile, '.authoring-candidates', initial.candidateId, 'record.json'), 'utf8'),
  )
  await s.manager.install(
    s.profile,
    { type: 'file', ref: 'file:' + record.tree },
    { expectedIntegrity: initial.candidateHash },
  )
  const nextFiles = files.map((f) => {
    if (f.path !== 'package.json') return f
    const pkg = JSON.parse(f.content)
    pkg.version = '2.0.0'
    pkg.agnes.capabilities = { network: ['example.invalid'] }
    return { ...f, content: JSON.stringify(pkg) }
  })
  const draft = await s.candidates.create(s.profile, nextFiles, 'owner', 'upgrade', origin)
  await s.candidates.test(
    s.profile,
    draft.candidateId,
    'owner',
    draft.candidateHash,
    new AbortController().signal,
  )
  const r = await s.candidates.submit(s.profile, draft.candidateId, 'owner', draft.candidateHash)
  expect(r.baseHash).toBe(initial.candidateHash)
  expect(r.preview?.capabilityDiff.added).toContain('network:example.invalid')
  expect((await s.manager.inventory(s.profile)).packages[0]?.entry.integrity).toBe(initial.candidateHash)
  const file = join(s.profile, '.authoring-candidates', r.candidateId, 'record.json')
  const changed = JSON.parse(readFileSync(file, 'utf8'))
  changed.value.tests.output = 'altered result after review'
  writeFileSync(file, JSON.stringify(changed))
  const publish = vi.fn(async () => {})
  await expect(
    s.candidates.decide(s.profile, r.candidateId, 'owner', r.candidateHash, r.reviewHash!, true, publish),
  ).rejects.toThrow('Review is stale')
  expect(publish).not.toHaveBeenCalled()
  writeFileSync(join(s.profile, 'plugin-capabilities.json'), JSON.stringify({ deny: ['network:*'] }))
  await expect(s.candidates.submit(s.profile, r.candidateId, 'owner', r.candidateHash)).rejects.toThrow(
    'blocked',
  )
  expect((await s.manager.inventory(s.profile)).packages[0]?.entry.integrity).toBe(initial.candidateHash)
})
