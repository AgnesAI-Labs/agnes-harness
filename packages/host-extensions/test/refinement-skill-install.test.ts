import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import { RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it } from 'vitest'
import { refinementSkillArchive, SKILL_ARCHIVE_KEEP } from '../src/resources/refinement-skill-archive.js'
import {
  createRefinementSkillInstallers,
  type RefinementSkillInstallContext,
  refinementSkillRefusal,
  type SkillDraft,
} from '../src/resources/refinement-skill-install.js'
import { inlineInstallBundle } from '../src/resources/skill-install-content.js'
import { readInstallBundle } from '../src/resources/skill-install-files.js'

const discovery = { roots: skillRoots, discover: discoverSkillRoot }
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const doc = (name: string, body: string) => `---\nname: ${name}\ndescription: Fixture skill\n---\n${body}\n`
const instructions = (name: string, body = 'Do it step by step.'): SkillDraft => ({
  name,
  class: 'instructions',
  files: [{ path: 'SKILL.md', content: doc(name, body) }],
})
type Entry = {
  descriptor: Record<string, unknown> & { resourceId: string; name: string; revision: string }
  trust: string
  desired: string
  removed: boolean
}
const workspaceRoot = (workspace: string, home: string) => {
  const root = skillRoots({ workspaceRoot: workspace, osHomeDir: home, agnesHomeDir: home })[0]
  if (!root) throw new Error('missing workspace skill root')
  return root
}
/** The one entry of a folder that should hold exactly one. */
const only = (folder: string): string => {
  const entries = readdirSync(folder)
  expect(entries).toHaveLength(1)
  return join(folder, String(entries[0]))
}
const notFound = () => Object.assign(new Error('not found'), { data: { code: 'RESOURCE_NOT_FOUND' } })

/** Resource control as the installer sees it, over the real skill folders of a temporary home. */
function fakeResources(workspace: string, home: string) {
  const entries = new Map<string, Entry>()
  const ops = new Map<string, string>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const fail: { method?: string; times: number } = { times: 0 }
  const scan = async () => {
    const found = []
    for (const root of skillRoots({ workspaceRoot: workspace, osHomeDir: home, agnesHomeDir: home })) {
      if (!existsSync(root.path)) continue
      for (const name of readdirSync(root.path)) {
        if (name.startsWith('.')) continue
        try {
          found.push((await readInstallBundle(join(root.path, name), root, [], discovery)).candidate)
        } catch {}
      }
    }
    return found
  }
  const refresh = async () => {
    const found = await scan()
    // A skill whose folder is gone drops out of the listing, as a real scan does.
    for (const [id, entry] of entries)
      if (!entry.removed && !found.some((candidate) => candidate.resourceId === id)) entries.delete(id)
    for (const candidate of found) {
      const previous = entries.get(candidate.resourceId)
      entries.set(candidate.resourceId, {
        descriptor: {
          kind: 'skill',
          resourceId: candidate.resourceId,
          name: candidate.name,
          revision: candidate.revision,
          sourceIdentity: candidate.sourceIdentity,
          priority: candidate.priority,
          stale: false,
        },
        trust: previous?.trust ?? 'trusted',
        desired: previous?.desired ?? 'enabled',
        removed: false,
      })
    }
  }
  const view = (entry: Entry) => ({
    ...entry.descriptor,
    resolution: { winner: !entry.removed, shadowed: [] },
    trust: entry.trust,
    desired: entry.desired,
    actual: !entry.removed && entry.trust === 'trusted' && entry.desired === 'enabled' ? 'ready' : 'disabled',
  })
  const done = (params: Record<string, unknown>, state = 'succeeded') => {
    const id = `op-${String(params.commandId)}`
    ops.set(id, state)
    return { operationId: id }
  }
  const resources = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params })
    if (fail.method === method && fail.times > 0) {
      fail.times--
      throw new Error('crashed')
    }
    if (method === '_agnes/v1/resources.list')
      return { items: [...entries.values()].filter((e) => !e.removed).map(view) }
    if (method === '_agnes/v1/resources.operation.get') return { state: ops.get(String(params.operationId)) }
    const entry = entries.get(String(params.resourceId))
    if (method === '_agnes/v1/resources.get') {
      if (!entry) throw notFound()
      return view(entry)
    }
    if (method === '_agnes/v1/skills.refresh') {
      await refresh()
      const reinstall = params.reinstall as { resourceId: string; expectedRevision: string } | undefined
      if (reinstall && entries.get(reinstall.resourceId)?.descriptor.revision !== reinstall.expectedRevision)
        return done(params, 'failed')
      return done(params)
    }
    if (!entry) throw notFound()
    if (params.expectedRevision !== entry.descriptor.revision) return done(params, 'failed')
    if (method === '_agnes/v1/skills.trust.set') entry.trust = String(params.trust)
    else if (method === '_agnes/v1/resources.desired.set') entry.desired = String(params.state)
    else if (method === '_agnes/v1/skills.remove') {
      const folder = join(workspace, '.agh', 'skills', entry.descriptor.name)
      const disk = await readInstallBundle(folder, workspaceRoot(workspace, home), [], discovery)
      if (disk.candidate.revision !== entry.descriptor.revision) return done(params, 'failed')
      rmSync(folder, { recursive: true })
      entry.removed = true
      entry.desired = 'disabled'
    } else throw new Error(`unexpected ${method}`)
    return done(params)
  }
  return { resources, calls, fail, refresh, entries }
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-refine-skill-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const dataDir = join(home, 'data')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const fake = fakeResources(workspace, home)
  const installers = () =>
    createRefinementSkillInstallers({
      dataDir,
      profile: 'local-dev',
      agnesHome: home,
      discovery,
      resources: (method, params) => fake.resources(method, params),
      pollMs: 1,
      timeoutMs: 2_000,
    })
  const make = () => installers()(workspace)
  const ctx = (receiptId = 'receipt-1'): RefinementSkillInstallContext => ({
    workspaceRoot: workspace,
    receiptId,
    source: {
      sessionKey: 'session',
      kind: 'skill',
      entryId: 'entry-1',
      contentHash: 'a'.repeat(64),
      initiator: 'auto',
    },
  })
  const skillDir = (name: string) => join(workspace, '.agh', 'skills', name)
  const registry = () => new RefinementRegistry(dataDir, workspace, Date.now).read()
  const effects = () =>
    fake.calls.filter(
      (call) =>
        call.method !== 'resources.get' && !call.method.endsWith('.get') && !call.method.endsWith('.list'),
    )
  return {
    root,
    workspace,
    home,
    dataDir,
    fake,
    installer: make(),
    make,
    installers,
    ctx,
    skillDir,
    registry,
    effects,
  }
}

const files = (folder: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      else out[`${prefix}${entry.name}`] = readFileSync(join(dir, entry.name), 'utf8')
    }
  }
  walk(folder, '')
  return out
}
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code
  }
  return 'no error'
}

describe('background installer for saved skills', () => {
  it('install publishes, trusts, enables and reaches ready without a turn', async () => {
    const s = setup()
    const result = await s.installer.install(instructions('tidy-notes'), s.ctx())
    expect(result).toMatchObject({
      authorizedBy: 'refinement-enabled',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    if (!('resourceId' in result)) throw new Error('not installed')
    expect(files(s.skillDir('tidy-notes'))).toEqual({ 'SKILL.md': doc('tidy-notes', 'Do it step by step.') })
    expect(s.effects().map((call) => call.method)).toEqual([
      '_agnes/v1/skills.refresh',
      '_agnes/v1/skills.trust.set',
      '_agnes/v1/resources.desired.set',
    ])
    expect(s.fake.calls.find((c) => c.method === '_agnes/v1/skills.refresh')?.params).toMatchObject({
      rootKey: 'workspace-agnes',
      reinstall: { resourceId: result.resourceId, expectedRevision: result.revision },
    })
    expect(s.fake.entries.get(result.resourceId)).toMatchObject({ trust: 'trusted', desired: 'enabled' })
    const [record] = s.registry().skills
    expect(record).toMatchObject({
      name: 'tidy-notes',
      resourceId: result.resourceId,
      revision: result.revision,
      state: 'active',
      source: { entryId: 'entry-1', initiator: 'auto' },
      archive: [result.revision],
    })
    // The archive and the journal live in the data directory, never in the workspace.
    expect(existsSync(join(s.dataDir, 'refinement', 'skill-archive'))).toBe(true)
    expect(readdirSync(join(s.workspace, '.agh'))).toEqual(['skills'])
    // Asking again with the same content is the same install.
    expect(await s.installer.install(instructions('tidy-notes'), s.ctx('receipt-2'))).toEqual(result)
  })

  it('a name owned by a human skill is refused and nothing is written', async () => {
    const s = setup()
    // In the workspace folder, in the other workspace folders, and listed from the user's folder.
    mkdirSync(s.skillDir('mine'), { recursive: true })
    writeFileSync(join(s.skillDir('mine'), 'SKILL.md'), doc('mine', 'Written by hand.'))
    mkdirSync(join(s.workspace, '.claude', 'skills', 'theirs'), { recursive: true })
    writeFileSync(join(s.workspace, '.claude', 'skills', 'theirs', 'SKILL.md'), doc('theirs', 'Hand.'))
    mkdirSync(join(s.home, 'skills', 'personal'), { recursive: true })
    writeFileSync(join(s.home, 'skills', 'personal', 'SKILL.md'), doc('personal', 'Hand.'))
    await s.fake.refresh()
    for (const name of ['mine', 'theirs', 'personal']) {
      const error = await s.installer
        .install(instructions(name, 'Machine text.'), s.ctx(`r-${name}`))
        .catch((e) => e)
      expect(error.code, name).toBe('SKILL_TARGET_CONFLICT')
      expect(refinementSkillRefusal(error)).toBe('static-check')
    }
    expect(readFileSync(join(s.skillDir('mine'), 'SKILL.md'), 'utf8')).toBe(doc('mine', 'Written by hand.'))
    expect(readdirSync(join(s.workspace, '.agh', 'skills'))).toEqual(['mine'])
    expect(s.effects()).toEqual([])
    expect(s.registry().skills).toEqual([])
    // A front matter name other than the folder would dodge the name check: refused.
    const renamed = { ...instructions('alias'), files: [{ path: 'SKILL.md', content: doc('mine', 'x') }] }
    expect(await codeOf(s.installer.install(renamed, s.ctx('r-alias')))).toBe('SKILL_NAME_MISMATCH')
    expect(existsSync(s.skillDir('alias'))).toBe(false)
  })

  it('names from a plan are checked before anything is touched', async () => {
    const s = setup()
    for (const name of ['../escape', 'Upper', 'con', 'nul.txt', 'a/b', 'x.', '.hidden', 'com1', '', 'a\\b'])
      expect(await codeOf(s.installer.install(instructions(name), s.ctx())), name).toBe('SKILL_NAME_INVALID')
    expect(existsSync(join(s.workspace, '.agh'))).toBe(false)
    expect(existsSync(join(s.root, 'escape'))).toBe(false)
    expect(s.fake.calls).toEqual([])
  })

  it('user scope is never used', async () => {
    const s = setup()
    await s.installer.install(instructions('tidy-notes'), s.ctx())
    await s.installer.install(instructions('second-skill'), s.ctx('r2'))
    expect(existsSync(join(s.home, 'skills'))).toBe(false)
    for (const call of s.fake.calls.filter((c) => c.method === '_agnes/v1/skills.refresh'))
      expect(call.params.rootKey).toBe('workspace-agnes')
    expect([...s.fake.entries.keys()].every((id) => id.startsWith('skill/workspace/workspace-agnes/'))).toBe(
      true,
    )
  })

  it('a crash between publish and trust resumes from the receipt and never publishes twice', async () => {
    const s = setup()
    s.fake.fail.method = '_agnes/v1/skills.trust.set'
    s.fake.fail.times = 1
    expect(await codeOf(s.installer.install(instructions('tidy-notes'), s.ctx()))).toBe(undefined)
    const published = statSync(join(s.skillDir('tidy-notes'), 'SKILL.md')).ino
    expect(s.registry().skills).toEqual([])
    // A new process: the same receipt finishes the work from where it stopped.
    const restarted = s.make()
    const result = await restarted.install(instructions('tidy-notes'), s.ctx())
    expect(result).toMatchObject({ authorizedBy: 'refinement-enabled' })
    expect(statSync(join(s.skillDir('tidy-notes'), 'SKILL.md')).ino).toBe(published)
    expect(readdirSync(join(s.workspace, '.agh'))).toEqual(['skills'])
    expect(s.registry().skills).toMatchObject([{ name: 'tidy-notes', state: 'active' }])
    // The journal is gone once the registry holds the result.
    expect(readdirSync(only(join(s.dataDir, 'refinement', 'skill-installs')))).toEqual([])
    // Another receipt for different content is refused: the name is taken by the first install.
    expect(await codeOf(s.make().install(instructions('tidy-notes', 'Other.'), s.ctx('r9')))).toBe(
      'SKILL_TARGET_CONFLICT',
    )
  })

  it('recover finishes an install the crash left behind, even before the journal moved on', async () => {
    const s = setup()
    s.fake.fail.method = '_agnes/v1/skills.refresh'
    s.fake.fail.times = 1
    await codeOf(s.installer.install(instructions('tidy-notes'), s.ctx()))
    // Published, but the journal was not advanced before the crash.
    const path = only(only(join(s.dataDir, 'refinement', 'skill-installs')))
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), phase: 'prepared' }))
    const inode = statSync(join(s.skillDir('tidy-notes'), 'SKILL.md')).ino
    expect(await s.make().recover()).toBe(1)
    expect(statSync(join(s.skillDir('tidy-notes'), 'SKILL.md')).ino).toBe(inode)
    expect(s.registry().skills).toMatchObject([{ name: 'tidy-notes', state: 'active' }])
    expect(await s.make().recover()).toBe(0)
  })

  it('an update stopped after the old revision was removed is finished from the archive', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    // The removal goes through, then the process dies before the new files are published.
    s.fake.fail.method = '_agnes/v1/resources.operation.get'
    s.fake.fail.times = 1
    expect(
      await codeOf(
        s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), { revision: first.revision }),
      ),
    ).toBe(undefined)
    expect(existsSync(s.skillDir('tidy-notes'))).toBe(false)
    expect(await s.make().recover()).toBe(1)
    expect(files(s.skillDir('tidy-notes'))).toEqual({ 'SKILL.md': doc('tidy-notes', 'Two.') })
    const [record] = s.registry().skills
    expect(record?.revision).not.toBe(first.revision)
    expect(record).toMatchObject({ state: 'active', archive: [first.revision, record?.revision] })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({
      removed: false,
      trust: 'trusted',
      desired: 'enabled',
    })
  })

  it('two installs of one name at once: one installs, the other is refused', async () => {
    const s = setup()
    const results = await Promise.allSettled([
      s.installer.install(instructions('tidy-notes', 'First.'), s.ctx('r1')),
      s.installer.install(instructions('tidy-notes', 'Second.'), s.ctx('r2')),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.code).toBe('SKILL_TARGET_CONFLICT')
    expect(s.registry().skills).toHaveLength(1)
  })

  it('update with a stale revision writes nothing and returns changed-since', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    const before = s.effects().length
    expect(
      await s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), {
        revision: 'f'.repeat(64),
      }),
    ).toEqual({
      draft: 'changed-since',
    })
    // A person edits the file: the recorded revision no longer matches what is on disk.
    writeFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), doc('tidy-notes', 'Edited by a person.'))
    expect(
      await s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), {
        revision: first.revision,
      }),
    ).toEqual({
      draft: 'changed-since',
    })
    expect(readFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(
      doc('tidy-notes', 'Edited by a person.'),
    )
    expect(s.effects()).toHaveLength(before)
    // Nor is a human-changed or human-written skill disabled or removed.
    expect(await codeOf(s.installer.disable('tidy-notes', { revision: first.revision }))).toBe(
      'SKILL_CHANGED_SINCE',
    )
    expect(await codeOf(s.installer.uninstall('tidy-notes'))).toBe('SKILL_CHANGED_SINCE')
    expect(await codeOf(s.installer.rollback('tidy-notes', first.revision))).toBe('SKILL_CHANGED_SINCE')
    mkdirSync(s.skillDir('mine'), { recursive: true })
    writeFileSync(join(s.skillDir('mine'), 'SKILL.md'), doc('mine', 'Hand.'))
    await s.fake.refresh()
    expect(await codeOf(s.installer.uninstall('mine'))).toBe('SKILL_NOT_INSTALLED_BY_REFINEMENT')
    expect(await codeOf(s.installer.update('mine', instructions('mine'), { revision: first.revision }))).toBe(
      'SKILL_NOT_INSTALLED_BY_REFINEMENT',
    )
    expect(existsSync(join(s.skillDir('mine'), 'SKILL.md'))).toBe(true)
    expect(s.effects()).toHaveLength(before)
  })

  it('rollback restores the archived files and their revision', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    const second = await s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), {
      revision: first.revision,
    })
    if (!('revision' in second)) throw new Error('not updated')
    expect(second.revision).not.toBe(first.revision)
    expect(readFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(doc('tidy-notes', 'Two.'))
    expect(s.registry().skills[0]).toMatchObject({
      revision: second.revision,
      archive: [first.revision, second.revision],
    })
    expect(await s.installer.rollback('tidy-notes', first.revision)).toEqual({ revision: first.revision })
    expect(files(s.skillDir('tidy-notes'))).toEqual({ 'SKILL.md': doc('tidy-notes', 'One.') })
    expect(s.registry().skills[0]).toMatchObject({ revision: first.revision, state: 'active' })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({
      trust: 'trusted',
      desired: 'enabled',
      removed: false,
    })
    expect(await codeOf(s.installer.rollback('tidy-notes', 'e'.repeat(64)))).toBe('SKILL_ARCHIVE_MISSING')
  })

  it('the archive keeps a bounded number of earlier revisions', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'v0'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    let revision = first.revision
    for (let n = 1; n <= 7; n++) {
      const next = await s.installer.update('tidy-notes', instructions('tidy-notes', `v${n}`), { revision })
      if (!('revision' in next)) throw new Error('not updated')
      revision = next.revision
    }
    const [record] = s.registry().skills
    expect(record?.archive).toHaveLength(SKILL_ARCHIVE_KEEP + 1)
    expect(record?.archive.at(-1)).toBe(revision)
    expect(record?.archive).not.toContain(first.revision)
    expect(readdirSync(only(only(join(s.dataDir, 'refinement', 'skill-archive')))).sort()).toEqual(
      [...(record?.archive ?? [])].sort(),
    )
  })

  it('disable and uninstall act only on an unchanged skill this installer installed', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    expect(await codeOf(s.installer.disable('tidy-notes', { revision: 'f'.repeat(64) }))).toBe(
      'SKILL_CHANGED_SINCE',
    )
    await s.installer.disable('tidy-notes', { revision: first.revision })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled' })
    expect(s.registry().skills[0]).toMatchObject({ state: 'review-disabled' })
    await s.installer.uninstall('tidy-notes')
    expect(existsSync(s.skillDir('tidy-notes'))).toBe(false)
    expect(s.registry().skills[0]).toMatchObject({ state: 'uninstalled' })
    // The name is free again for a new install.
    await s.installer.install(instructions('tidy-notes', 'Again.'), s.ctx('r2'))
    expect(s.registry().skills[0]).toMatchObject({ state: 'active' })
  })

  it('the review switches a skill off only while its review date is still the one it read', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes'), s.ctx())
    const read = s.registry().skills[0]
    if (!read) throw new Error('not recorded')
    // A confirmation renews it after the review read the registry.
    new RefinementRegistry(s.dataDir, s.workspace, () => read.reviewAfter + 1).renew({
      skillName: 'tidy-notes',
    })
    expect(
      await codeOf(
        s.installer.disable('tidy-notes', { revision: first.revision, reviewAfter: read.reviewAfter }),
      ),
    ).toBe('SKILL_REVIEW_RENEWED')
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'enabled' })
    expect(s.registry().skills[0]).toMatchObject({ state: 'active' })
    const renewed = s.registry().skills[0]?.reviewAfter
    await s.installer.disable('tidy-notes', { revision: first.revision, reviewAfter: renewed as number })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled' })
    expect(s.registry().skills[0]).toMatchObject({ state: 'review-disabled' })
  })

  it("work held for a name waits for the installer's operation on it, and the installer waits for it", async () => {
    const s = setup()
    const installers = s.installers()
    const installer = installers(s.workspace)
    const first = await installer.install(instructions('tidy-notes'), s.ctx())
    const workspaceId = createHash('sha256').update(s.workspace).digest('hex')
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const holding = installers.exclusive(workspaceId, 'tidy-notes', async () => {
      order.push('held')
      await held
      order.push('released')
      return 'done'
    })
    const disabling = installer
      .disable('tidy-notes', { revision: first.revision })
      .then(() => order.push('disabled'))
    // Another name is not held up.
    await installer.install(instructions('other-notes'), s.ctx('r2'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['held'])
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'enabled' })
    release()
    expect(await holding).toBe('done')
    await disabling
    expect(order).toEqual(['held', 'released', 'disabled'])
    expect(() => installers.exclusive('../x', 'tidy-notes', async () => 1)).toThrowError(
      expect.objectContaining({ code: 'SKILL_INSTALL_INVALID' }),
    )
  })

  it('a skill is instructions only: scripts, executables and binaries are refused before anything is written', async () => {
    const s = setup()
    const withFile = (path: string, content: string): SkillDraft => ({
      ...instructions('tidy-notes'),
      files: [...instructions('tidy-notes').files, { path, content }],
    })
    const scriptClass = { ...instructions('tidy-notes'), class: 'script' } as unknown as SkillDraft
    expect(await codeOf(s.installer.install(scriptClass, s.ctx()))).toBe('SKILL_INSTALL_INVALID')
    const refused: [string, SkillDraft][] = [
      ['script folder', withFile('scripts/run.py', 'print(1)\n')],
      ['nested script folder', withFile('references/scripts/run.md', 'python3 run.py')],
      ['upper-case script folder', withFile('references/Scripts/notes.md', 'text')],
      ['shell file', withFile('references/run.sh', 'echo hi\n')],
      ['shebang', withFile('references/run.md', '#!/bin/sh\necho hi\n')],
      [
        'shebang in SKILL.md',
        {
          ...instructions('tidy-notes'),
          files: [{ path: 'SKILL.md', content: `#!/bin/sh\n${doc('tidy-notes', 'x')}` }],
        },
      ],
      ['binary bytes', withFile('references/data.txt', 'a\u0000b')],
      ['control bytes', withFile('references/data.txt', 'a\u0007b')],
      ['not UTF-8', withFile('references/data.txt', 'a\ud800b')],
      ['C1 control', withFile('references/data.txt', 'a\u0085b')],
      ['bidi override', withFile('references/data.md', 'safe \u202eedoc')],
      ['bidi isolate', withFile('references/data.md', 'safe \u2066text\u2069')],
      ['zero width space', withFile('references/data.md', 'hid\u200bden')],
      ['zero width joiner', withFile('references/data.md', 'hid\u200dden')],
      ['left-to-right mark', withFile('references/data.md', 'a\u200eb')],
      ['word joiner', withFile('references/data.md', 'a\u2060b')],
      ['inner byte order mark', withFile('references/data.md', 'a\ufeffb')],
      ['line separator', withFile('references/data.md', 'a\u2028b')],
      ['paragraph separator', withFile('references/data.md', 'a\u2029b')],
      ['instruction file', withFile('references/AGENTS.md', 'Always do this.')],
      ['local instruction file', withFile('references/notes.local.md', 'Always do this.')],
      ['package manifest', withFile('references/package.json', '{}')],
    ]
    for (const [label, draft] of refused) {
      const error = await s.installer.install(draft, s.ctx()).catch((e) => e)
      expect(error?.code, label).toMatch(/^SKILL_(FILE_REFUSED|CODE_REQUIRES_CANDIDATE)$/)
      expect(refinementSkillRefusal(error), label).toBe('static-check')
    }
    expect(existsSync(join(s.workspace, '.agh'))).toBe(false)
    expect(existsSync(join(s.dataDir, 'refinement'))).toBe(false)
    expect(s.fake.calls).toEqual([])
    // Text resources next to SKILL.md are fine: tabs, line ends, a leading byte order mark, other scripts.
    const ok = withFile('references/table.csv', '\ufeffa,b\r\n1\t2\n数学,é\n')
    expect(await s.installer.install(ok, s.ctx())).toMatchObject({ authorizedBy: 'refinement-enabled' })
  })

  it('update and rollback keep a skill the review switched off disabled unless asked to enable it', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    await s.installer.disable('tidy-notes', { revision: first.revision })
    const second = await s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), {
      revision: first.revision,
    })
    if (!('revision' in second)) throw new Error('not updated')
    expect(s.registry().skills[0]).toMatchObject({ revision: second.revision, state: 'review-disabled' })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled', removed: false })
    expect(await s.installer.rollback('tidy-notes', first.revision)).toEqual({ revision: first.revision })
    expect(s.registry().skills[0]).toMatchObject({ revision: first.revision, state: 'review-disabled' })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled' })
    // Asked to enable: on again, and active.
    expect(await s.installer.rollback('tidy-notes', second.revision, { enable: true })).toEqual({
      revision: second.revision,
    })
    expect(s.registry().skills[0]).toMatchObject({ revision: second.revision, state: 'active' })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'enabled', trust: 'trusted' })
    await s.installer.disable('tidy-notes', { revision: second.revision })
    const third = await s.installer.update(
      'tidy-notes',
      instructions('tidy-notes', 'Three.'),
      { revision: second.revision },
      { enable: true },
    )
    expect(third).toMatchObject({ revision: expect.any(String) })
    expect(s.registry().skills[0]).toMatchObject({ state: 'active' })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'enabled' })
  })

  it("a person's edit after publish abandons the unfinished install and frees the name", async () => {
    const s = setup()
    s.fake.fail.method = '_agnes/v1/skills.trust.set'
    s.fake.fail.times = 1
    await codeOf(s.installer.install(instructions('tidy-notes', 'One.'), s.ctx()))
    // A person changes the published folder before the retry.
    writeFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), doc('tidy-notes', 'Mine now.'))
    const journal = join(s.dataDir, 'refinement', 'skill-installs')
    expect(await codeOf(s.make().install(instructions('tidy-notes', 'One.'), s.ctx()))).toBe(
      'SKILL_CHANGED_SINCE',
    )
    expect(readdirSync(only(journal))).toEqual([])
    expect(await s.make().recover()).toBe(0)
    expect(readFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(
      doc('tidy-notes', 'Mine now.'),
    )
    expect(s.registry().skills).toEqual([])
    // The name is the person's now: refused as theirs, never stuck as unavailable.
    expect(await codeOf(s.make().install(instructions('tidy-notes', 'Two.'), s.ctx('r2')))).toBe(
      'SKILL_TARGET_CONFLICT',
    )
    expect(await codeOf(s.make().uninstall('tidy-notes'))).toBe('SKILL_NOT_INSTALLED_BY_REFINEMENT')
    // The person deletes it: the name is free again.
    rmSync(s.skillDir('tidy-notes'), { recursive: true })
    await s.fake.refresh()
    expect(await s.make().install(instructions('tidy-notes', 'Three.'), s.ctx('r3'))).toMatchObject({
      authorizedBy: 'refinement-enabled',
    })
  })

  it("a person's edit after a replacement was published abandons it and the record stops claiming the old revision", async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    s.fake.fail.method = '_agnes/v1/skills.trust.set'
    s.fake.fail.times = 1
    await codeOf(
      s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), { revision: first.revision }),
    )
    writeFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), doc('tidy-notes', 'Mine now.'))
    expect(await s.make().recover()).toBe(0)
    expect(readdirSync(only(join(s.dataDir, 'refinement', 'skill-installs')))).toEqual([])
    expect(s.registry().skills[0]?.revision).not.toBe(first.revision)
    // Treated as changed by a person from now on, never as stuck.
    expect(await codeOf(s.make().uninstall('tidy-notes'))).toBe('SKILL_CHANGED_SINCE')
    expect(
      await s.make().update('tidy-notes', instructions('tidy-notes', 'Three.'), { revision: first.revision }),
    ).toEqual({ draft: 'changed-since' })
    expect(readFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(
      doc('tidy-notes', 'Mine now.'),
    )
    rmSync(s.skillDir('tidy-notes'), { recursive: true })
    await s.fake.refresh()
    await s.make().uninstall('tidy-notes')
    expect(s.registry().skills[0]).toMatchObject({ state: 'uninstalled' })
    expect(await s.make().install(instructions('tidy-notes', 'Four.'), s.ctx('r4'))).toMatchObject({
      authorizedBy: 'refinement-enabled',
    })
  })

  it('installing the same content again reports the real state of the skill', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    expect(first).toMatchObject({ state: 'active', ready: true })
    if (!('revision' in first)) throw new Error('not installed')
    await s.installer.disable('tidy-notes', { revision: first.revision })
    expect(await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx('r2'))).toEqual({
      resourceId: first.resourceId,
      revision: first.revision,
      authorizedBy: 'refinement-enabled',
      state: 'review-disabled',
      ready: false,
    })
    writeFileSync(join(s.skillDir('tidy-notes'), 'SKILL.md'), doc('tidy-notes', 'Mine now.'))
    expect(await codeOf(s.installer.install(instructions('tidy-notes', 'One.'), s.ctx('r3')))).toBe(
      'SKILL_CHANGED_SINCE',
    )
  })

  it('enable takes effect even when the content does not change', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    await s.installer.disable('tidy-notes', { revision: first.revision })
    expect(
      await s.installer.update('tidy-notes', instructions('tidy-notes', 'One.'), {
        revision: first.revision,
      }),
    ).toEqual({ revision: first.revision })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled' })
    expect(
      await s.installer.update(
        'tidy-notes',
        instructions('tidy-notes', 'One.'),
        { revision: first.revision },
        { enable: true },
      ),
    ).toEqual({ revision: first.revision })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'enabled' })
    expect(s.registry().skills[0]).toMatchObject({ state: 'active', revision: first.revision })
    await s.installer.disable('tidy-notes', { revision: first.revision })
    expect(await s.installer.rollback('tidy-notes', first.revision, { enable: true })).toEqual({
      revision: first.revision,
    })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'enabled' })
    expect(s.registry().skills[0]).toMatchObject({ state: 'active' })
  })

  it('each capacity disable leaves a registry receipt and marks the skill switched off for capacity', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    const before = s.registry().receipts.length
    await s.installer.disable('tidy-notes', { revision: first.revision }, 'capacity')
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled', removed: false })
    expect(existsSync(join(s.skillDir('tidy-notes'), 'SKILL.md'))).toBe(true)
    const record = s.registry().skills[0]
    expect(record).toMatchObject({ state: 'review-disabled', disabledFor: 'capacity' })
    const receipts = s.registry().receipts.slice(before)
    expect(receipts).toEqual([
      expect.objectContaining({
        initiator: 'auto',
        source: record?.source,
        outcome: 'refused',
        steps: [{ step: 'capacity', verdict: 'fail' }],
        target: { kind: 'skill', name: 'tidy-notes', resourceId: first.resourceId, revision: first.revision },
      }),
    ])
    // Already off: nothing more is written.
    await s.installer.disable('tidy-notes', { revision: first.revision }, 'capacity')
    expect(s.registry().receipts.slice(before)).toHaveLength(1)
    // The review's own disable leaves no capacity mark and no receipt.
    await s.installer.install(instructions('other-notes'), s.ctx('r2'))
    const other = s.registry().skills.find((skill) => skill.name === 'other-notes')
    const count = s.registry().receipts.length
    await s.installer.disable('other-notes', { revision: other?.revision as string })
    expect(s.registry().skills.find((skill) => skill.name === 'other-notes')).not.toHaveProperty(
      'disabledFor',
    )
    expect(s.registry().receipts).toHaveLength(count)
  })

  it('an RSI update of a capacity-disabled skill keeps it disabled; enabling it clears the mark', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    await s.installer.disable('tidy-notes', { revision: first.revision }, 'capacity')
    const second = await s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), {
      revision: first.revision,
    })
    if (!('revision' in second)) throw new Error('not updated')
    expect(s.registry().skills[0]).toMatchObject({
      revision: second.revision,
      state: 'review-disabled',
      disabledFor: 'capacity',
    })
    expect(s.fake.entries.get(first.resourceId)).toMatchObject({ desired: 'disabled' })
    await s.installer.rollback('tidy-notes', first.revision, { enable: true })
    expect(s.registry().skills[0]).toMatchObject({ state: 'active' })
    expect(s.registry().skills[0]).not.toHaveProperty('disabledFor')
  })

  it('an update keeps the mark of a skill a person switched back on', async () => {
    const s = setup()
    const first = await s.installer.install(instructions('tidy-notes', 'One.'), s.ctx())
    if (!('revision' in first)) throw new Error('not installed')
    const registry = new RefinementRegistry(s.dataDir, s.workspace, Date.now)
    registry.update((draft) => {
      const found = draft.skills[0]
      if (found) found.enabledBy = 'person'
    }, registry.read().revision)
    await s.installer.update('tidy-notes', instructions('tidy-notes', 'Two.'), { revision: first.revision })
    expect(s.registry().skills[0]).toMatchObject({ state: 'active', enabledBy: 'person' })
  })

  it('a journal entry with a name that is not a skill name is never acted on', async () => {
    const s = setup()
    const journal = refinementSkillArchive(s.dataDir, s.workspace).journal
    const entry = {
      id: journal.idFor('install\0bad'),
      kind: 'install' as const,
      toRevision: 'a'.repeat(64),
      phase: 'published' as const,
      at: 1,
    }
    for (const name of ['../escape', 'Upper', 'con', 'a/b']) {
      journal.write({ ...entry, name })
      expect(journal.list(), name).toEqual([])
    }
    journal.write({ ...entry, name: 'fine-name' })
    expect(journal.list()).toHaveLength(1)
  })

  it('the Skill Helper install flow is unchanged', async () => {
    const s = setup()
    const root = workspaceRoot(s.workspace, s.home)
    const draft = {
      name: 'csv-columns',
      files: [
        { path: 'SKILL.md', content: doc('csv-columns', 'Run the script.') },
        { path: 'scripts/columns.py', content: 'print(1)\n' },
      ],
    }
    await expect(
      inlineInstallBundle(
        { action: 'prepare-content', name: draft.name, files: draft.files, scope: 'workspace', enable: true },
        root,
        discovery,
      ),
    ).rejects.toMatchObject({ code: 'SKILL_CODE_REQUIRES_CANDIDATE' })
  })
})
