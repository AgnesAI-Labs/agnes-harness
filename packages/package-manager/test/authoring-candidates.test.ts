import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
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
  feedbackId: 'feedback-1',
  feedbackRevision: 17,
  messageSeq: 12,
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
        plugins: [
          {
            apiRange: '^5.0.0',
            export: 'main',
            id: 'ext:reviewed-tool/main',
            inject: ['hooks', 'eventLog', 'self'],
            capabilities: {},
          },
        ],
      },
    }),
  },
  { path: 'index.mjs', content: 'export const main={inject:["extension"],apply(){}}\n' },
  { path: 'test/tool.test.mjs', content: '// host runner fixture\n' },
]
function setup(pass = true) {
  const root = mkdtempSync(join(tmpdir(), 'agh-authoring-中文 % # '))
  roots.push(root)
  const profile = join(root, 'profiles/test')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('test', '0.0.0'),
    policySnapshot: { capabilityCeiling: ['network'], workspacePackages: 'require-project-trust' },
    resolvedProfileHash: 'sha256-' + '0'.repeat(64),
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((k) => [
        k,
        { provider: 'local' },
      ]),
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
async function review(s: ReturnType<typeof setup>, command = 'draft', inputFiles = files) {
  const d = await s.candidates.create(s.profile, inputFiles, 'owner', command, origin)
  expect(s.candidates.forCommand(s.profile, command, 'owner')).toMatchObject({
    candidateId: d.candidateId,
    origin,
  })
  expect(s.candidates.forCommand(s.profile, 'absent-command', 'owner')).toBeNull()
  expect(() => s.candidates.forCommand(s.profile, command, 'other')).toThrow()
  expect(validatePackageAdminData('AuthoringCandidate', d).ok).toBe(true)
  await s.candidates.test(s.profile, d.candidateId, 'owner', d.candidateHash, new AbortController().signal)
  return s.candidates.submit(s.profile, d.candidateId, 'owner', d.candidateHash)
}
it('keeps drafts outside discovery and binds tests, diffs, capabilities and provenance to one review; editing invalidates the old decision', async () => {
  const s = setup()
  const copies: string[] = []
  s.runner.mockImplementation(async (...args: unknown[]) => {
    const directory = args[0] as string
    copies.push(directory)
    expect(directory.startsWith(s.profile)).toBe(false)
    expect(readFileSync(join(directory, 'index.mjs'), 'utf8')).toBe(files[1]?.content)
    return { state: 'passed', count: 1, runner: 'node-test', output: 'synthetic result' }
  })
  const r = await review(s)
  for (const directory of copies) expect(existsSync(directory)).toBe(false)
  s.runner
    .mockReset()
    .mockResolvedValue({ state: 'passed', count: 1, runner: 'node-test', output: 'synthetic result' })
  expect(r.origin).toMatchObject({ feedbackId: 'feedback-1', feedbackRevision: 17, messageSeq: 12 })
  expect(discoverLocalPlugins(localPluginRoots(join(s.root, 'home'), join(s.root, 'workspace')))).toEqual([])
  expect((await s.manager.inventory(s.profile)).packages).toEqual([])
  await expect(
    s.candidates.create(
      s.profile,
      [{ path: 'package.json', content: '{invalid json' }],
      'owner',
      'invalid-draft',
      origin,
    ),
  ).rejects.toThrow('invalid package.json')
  const reopened = new AuthoringCandidates(s.manager, s.runner)
  // An interrupted creation has no durable record and must not hide healthy reviews or fill their quota.
  for (let n = 0; n < 128; n++)
    mkdirSync(
      join(
        s.profile,
        '.authoring-candidates',
        'candidate-' + n.toString(16).padStart(32, '0'),
        'trees/unfinished',
      ),
      { recursive: true },
    )
  expect(reopened.list(s.profile, 'owner').map((row) => row.candidateId)).toEqual([r.candidateId])
  const another = await reopened.create(s.profile, files, 'owner', 'after-invalid', origin)
  expect(
    reopened
      .list(s.profile, 'owner')
      .map((row) => row.candidateId)
      .sort(),
  ).toEqual([r.candidateId, another.candidateId].sort())
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
    [{ ...files[1]!, content: files[1]!.content + '// edit\n' }],
    'merge',
  )
  expect(next).toMatchObject({ state: 'draft', tests: null, reviewHash: null })
  expect(next.candidateHash).not.toBe(r.candidateHash)
  expect(next.sourceFiles).toEqual(expect.arrayContaining([files[0], files[2]]))
  expect(next.writeSummary).toMatchObject({ added: [], removed: [], changed: ['index.mjs'] })
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
  const write = (delta: typeof files, remove: string[] = [], hash = d.candidateHash) =>
    s.candidates.write(s.profile, d.candidateId, 'owner', hash, delta, 'merge', remove)
  await expect(write([], [], `sha256-${'0'.repeat(64)}`)).rejects.toThrow('Candidate changed')
  for (const [delta, remove, code, path] of [
    [[files[1]!], ['index.mjs'], 'conflicting-write-path', 'index.mjs'],
    [[], ['absent.md'], 'missing-remove-path', 'absent.md'],
  ] as const) {
    await expect(write([...delta], [...remove])).rejects.toMatchObject({
      detail: { diagnostics: [{ code, path, field: 'remove', name: path }] },
    })
  }
  // Deltas individually fit: the resulting tree still must pass all ordinary validation.
  for (const delta of [
    [{ path: '../escape', content: '' }],
    [{ path: 'INDEX.mjs', content: '' }],
    [{ path: 'index.mjs/child', content: '' }],
    [{ path: 'binary.txt', content: '\0' }],
    [{ path: 'large.txt', content: 'x'.repeat(131073) }],
    Array.from({ length: 62 }, (_, i) => ({ path: `extra-${i}.txt`, content: '' })),
    [
      { path: 'a.txt', content: 'x'.repeat(131072) },
      { path: 'b.txt', content: 'x'.repeat(131072) },
    ],
  ])
    await expect(write(delta)).rejects.toThrow()
  await expect(write([], ['../escape'])).rejects.toThrow()
  expect(s.candidates.show(s.profile, d.candidateId, 'owner').candidateHash).toBe(d.candidateHash)
  const added = await write([{ path: 'notes.md', content: 'temporary' }])
  const removed = await write([], ['notes.md'], added.candidateHash)
  expect(removed.candidateHash).toBe(d.candidateHash)
  expect(removed.sourceFiles).toEqual(expect.arrayContaining(files))
  expect(removed.sourceFiles).toHaveLength(files.length)
  expect(removed.writeSummary).toMatchObject({ removed: ['notes.md'] })
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
  symlinkSync(record.tree, join(record.tree, 'linked'), 'junction')
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
    await reopened.create(s.profile, files, 'other', 'quota-inspection', origin)
    expect(JSON.parse(readFileSync(file, 'utf8')).value.state).toBe('publishing')
    expect(reopened.list(s.profile, 'other')).toHaveLength(1)
    expect(JSON.parse(readFileSync(file, 'utf8')).value.state).toBe('publishing')
    expect(readFileSync(file, 'utf8')).toBe(beforeEvidence)
    expect(reopened.show(s.profile, r.candidateId, 'owner').state).toBe('interrupted')
    expect(publish).toHaveBeenCalledOnce()
  },
)
it.each(['tool', 'skill'])(
  'publishes a reviewed %s package and preserves publication guidance after reopening',
  async (kind) => {
    const s = setup()
    let inputFiles = files
    if (kind === 'skill') {
      const { createSkillCandidate } = (await import(
        new URL('../bundled-plugins/skill-helper/src/candidate.mjs', import.meta.url).href
      )) as { createSkillCandidate: (args: unknown, checked: unknown, ctx: unknown) => Promise<unknown> }
      await createSkillCandidate(
        { name: 'review' },
        [
          {
            path: 'SKILL.md',
            content: Buffer.from(
              '---\r\nname: 复核助手\r\ndescription: 检查已批准的变更\r\ndisable-model-invocation: true\r\n---\r\nReviewed instructions',
            ),
          },
          { path: 'references/example.md', content: Buffer.from('approved reference') },
          { path: 'scripts/read.mjs', content: Buffer.from('export const reviewed = true;\n') },
        ],
        {
          pluginManage: {
            request: async (input: { files: typeof files }) => {
              inputFiles = input.files
              return {}
            },
          },
        },
      )
    }
    const r = await review(s, 'draft', inputFiles)
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
    if (kind === 'skill') {
      const installed = (await s.manager.inventory(s.profile)).packages[0]
      expect(installed?.contributions).toEqual([
        { kind: 'skill', id: 'agh-skill-review/main', path: './skills/review/SKILL.md' },
      ])
      expect(installed?.capabilityHash).toBe(r.preview?.capabilityHash)
    }
    expect(published.message).toContain('new sessions')
    expect(published.message).toContain('existing sessions keep their pins')
    expect(new AuthoringCandidates(s.manager, s.runner).show(s.profile, r.candidateId, 'owner').message).toBe(
      published.message,
    )
  },
)
it('detects installed baseline changes and damaged immutable snapshots before any publication', async () => {
  const s = setup()
  const r = await review(s),
    publish = vi.fn(async () => {})
  const file = join(s.profile, '.authoring-candidates', r.candidateId, 'record.json'),
    record = JSON.parse(readFileSync(file, 'utf8'))
  await s.manager.install(
    s.profile,
    { type: 'file', ref: 'file:' + record.tree.split(sep).join('/') },
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
    { type: 'file', ref: 'file:' + record.tree.split(sep).join('/') },
    { expectedIntegrity: initial.candidateHash },
  )
  const nextFiles = files.map((f) => {
    if (f.path !== 'package.json') return f
    const pkg = JSON.parse(f.content)
    pkg.version = '2.0.0'
    pkg.agnes.plugins[0].capabilities = { network: ['example.invalid'] }
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

it('retains incomplete replacement drafts with exact missing-file diagnostics and no stale evidence', async () => {
  const s = setup()
  const draft = await review(s)
  let current = draft
  for (const missing of ['index.mjs', 'package.json']) {
    const nextFiles = files.filter((f) => f.path !== missing)
    current = await s.candidates.write(
      s.profile,
      current.candidateId,
      'owner',
      current.candidateHash,
      nextFiles,
    )
    expect(current).toMatchObject({
      state: 'draft',
      tests: null,
      reviewHash: null,
      diagnostics: [{ code: 'missing-required-file', name: missing }],
      writeSummary: { missing: [missing] },
    })
    expect(current.sourceFiles).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ path: missing })]),
    )
    expect(validatePackageAdminData('AuthoringCandidate', current).ok).toBe(true)
    const reopened = new AuthoringCandidates(s.manager, s.runner)
    expect(reopened.show(s.profile, current.candidateId, 'owner').sourceFiles).toEqual(current.sourceFiles)
    for (const action of [
      () =>
        reopened.test(
          s.profile,
          current.candidateId,
          'owner',
          current.candidateHash,
          new AbortController().signal,
        ),
      () => reopened.submit(s.profile, current.candidateId, 'owner', current.candidateHash),
    ]) {
      await expect(action()).rejects.toMatchObject({ detail: { diagnostics: current.diagnostics } })
    }
    const repeated = await s.candidates.write(
      s.profile,
      current.candidateId,
      'owner',
      current.candidateHash,
      nextFiles,
    )
    expect(repeated).toMatchObject({
      candidateHash: current.candidateHash,
      writeSummary: { unchanged: true },
    })
    expect(repeated.message).toContain('No progress')
  }
  const restored = await s.candidates.write(
    s.profile,
    current.candidateId,
    'owner',
    current.candidateHash,
    files,
  )
  expect(restored).toMatchObject({ diagnostics: [], writeSummary: { added: ['package.json'], missing: [] } })
  expect(
    (
      await s.candidates.test(
        s.profile,
        restored.candidateId,
        'owner',
        restored.candidateHash,
        new AbortController().signal,
      )
    ).state,
  ).toBe('tested')
  const invalid = files.map((f) => (f.path === 'package.json' ? { ...f, content: '{invalid' } : f))
  await expect(
    s.candidates.write(s.profile, restored.candidateId, 'owner', restored.candidateHash, invalid),
  ).rejects.toThrow()
  await expect(
    s.candidates.write(
      s.profile,
      restored.candidateId,
      'owner',
      restored.candidateHash,
      invalid.map((f) => (f.path === 'package.json' ? { ...f, content: 'another invalid manifest' } : f)),
    ),
  ).rejects.toMatchObject({
    detail: { diagnostics: [expect.objectContaining({ code: 'no-progress' })] },
  })
  expect(s.candidates.show(s.profile, restored.candidateId, 'owner').candidateHash).toBe(
    restored.candidateHash,
  )
  const panelPkg = JSON.parse(files[0]!.content)
  panelPkg.exports = { '.': { import: './index.mjs', default: './index.mjs' } }
  panelPkg.main = './backup.mjs'
  panelPkg.agnes.clientDescriptors = [{ rowId: 'ext:reviewed-tool/main', path: './client/agnes.client.json' }]
  const panelFiles = files
    .map((f) => (f.path === 'package.json' ? { ...f, content: JSON.stringify(panelPkg) } : f))
    .concat([
      { path: 'backup.mjs', content: '// declared main' },
      { path: 'client/agnes.client.json', content: '{"client":{"entry":"./index.js"}}' },
      { path: 'client/index.js', content: 'export function apply() {}' },
    ])
  const panel = await s.candidates.write(
    s.profile,
    restored.candidateId,
    'owner',
    restored.candidateHash,
    panelFiles,
  )
  expect(panel.writeSummary).toMatchObject({
    changed: ['package.json'],
    entries: ['backup.mjs', 'client/agnes.client.json', 'client/index.js', 'index.mjs'],
  })
  const dropped = await s.candidates.write(
    s.profile,
    panel.candidateId,
    'owner',
    panel.candidateHash,
    [],
    'merge',
    ['client/index.js'],
  )
  expect(dropped).toMatchObject({
    diagnostics: [expect.objectContaining({ name: 'client/index.js', field: 'client.entry' })],
    writeSummary: { removed: ['client/index.js'] },
  })
  await expect(
    s.candidates.test(
      s.profile,
      dropped.candidateId,
      'owner',
      dropped.candidateHash,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ detail: { diagnostics: dropped.diagnostics } })
})
