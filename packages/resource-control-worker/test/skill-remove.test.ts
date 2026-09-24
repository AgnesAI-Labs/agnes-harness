import { renameSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillDescriptor } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { scanSkills } from '../src/skill-bootstrap.js'
import { removeFilesystemSkill } from '../src/skill-remove.js'

const fault = vi.hoisted(() => ({
  fail: false,
  syncFail: false,
  failAt: 2,
  calls: 0,
  before: undefined as (() => void) | undefined,
}))
vi.mock('@agnes/system-node', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agnes/system-node')>()
  return {
    ...original,
    syncDirectorySync: (path: string) => {
      if (fault.syncFail) throw new Error('directory sync failed')
      return original.syncDirectorySync(path)
    },
    deleteSkillEntrySync: (entry: Parameters<typeof original.deleteSkillEntrySync>[0]) => {
      if (fault.fail && ++fault.calls === fault.failAt)
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      const before = fault.before
      fault.before = undefined
      before?.()
      return original.deleteSkillEntrySync(entry)
    },
  }
})
let home = ''
afterEach(async () => {
  fault.fail = false
  fault.syncFail = false
  fault.failAt = 2
  fault.calls = 0
  fault.before = undefined
  if (home) await rm(home, { recursive: true, force: true })
})

it('rejects a parent replaced with a junction after JavaScript checks', async () => {
  const { directory, descriptor } = await fixture()
  const outside = join(home, 'outside')
  await mkdir(join(outside, 'scripts'), { recursive: true })
  await writeFile(join(outside, 'scripts', 'run.py'), 'outside file')
  await writeFile(join(outside, 'SKILL.md'), 'outside skill')
  fault.before = () => {
    renameSync(directory, `${directory}-original`)
    symlinkSync(outside, directory, 'junction')
  }
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow()
  expect(await readFile(join(outside, 'scripts', 'run.py'), 'utf8')).toBe('outside file')
  expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('outside skill')
  expect(await readFile(join(`${directory}-original`, 'scripts', 'run.py'), 'utf8')).toBe('print(1)\n')
})
async function fixture() {
  home = await mkdtemp(join(tmpdir(), 'skill-remove-'))
  const directory = join(home, '.agh', 'skills', 'example')
  await mkdir(join(directory, 'scripts'), { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    '---\nname: example\ndescription: test\n---\nRead this skill.\n',
  )
  await writeFile(join(directory, 'scripts', 'run.py'), 'print(1)\n')
  const scan = await scanSkills(undefined, undefined, undefined, home)
  const candidate = scan.roots.flatMap((root) => root.candidates)[0]
  if (!candidate) throw new Error('fixture skill was not discovered')
  const descriptor: SkillDescriptor = {
    ...candidate,
    kind: 'skill',
    resolution: { winner: true, shadowed: [] },
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    stale: false,
  }
  return { directory, descriptor }
}
it.each(['root', 'nested'])(
  'preserves every file when the %s directory was replaced before retry',
  async (kind) => {
    const { directory, descriptor } = await fixture()
    fault.syncFail = true
    await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow(
      'directory sync failed',
    )
    fault.syncFail = false
    const replaced = kind === 'root' ? directory : join(directory, 'scripts')
    const old = join(home, 'old-directory')
    await rename(replaced, old)
    await mkdir(replaced)
    for (const name of await readdir(old)) await rename(join(old, name), join(replaced, name))
    for (const validateOnly of [true, false]) {
      await expect(removeFilesystemSkill({ descriptor, osHomeDir: home, validateOnly })).rejects.toThrow(
        'SKILL_DELETE_REFUSED',
      )
      expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('name: example')
      expect(await readFile(join(directory, 'scripts', 'run.py'), 'utf8')).toBe('print(1)\n')
    }
  },
)

it('preserves remaining files when the root is rebuilt after a partial deletion', async () => {
  const { directory, descriptor } = await fixture()
  fault.fail = true
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toMatchObject({
    code: 'EBUSY',
  })
  fault.fail = false
  const paths = [join(directory, 'SKILL.md'), join(directory, 'scripts', 'run.py')]
  const before = await Promise.allSettled(paths.map((path) => readFile(path, 'utf8')))
  const old = join(home, 'old-directory')
  await rename(directory, old)
  await mkdir(directory)
  for (const name of await readdir(old)) await rename(join(old, name), join(directory, name))
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow('SKILL_DELETE_REFUSED')
  expect(await Promise.allSettled(paths.map((path) => readFile(path, 'utf8')))).toEqual(before)
})

it('resumes when an original child directory was already deleted before failure', async () => {
  const { directory, descriptor } = await fixture()
  fault.fail = true
  fault.failAt = 4
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toMatchObject({
    code: 'EBUSY',
  })
  expect(await readdir(directory)).toEqual([])
  fault.fail = false
  await removeFilesystemSkill({ descriptor, osHomeDir: home })
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('does not delete until the progress directory is synced, including on retry', async () => {
  const { directory, descriptor } = await fixture()
  fault.syncFail = true
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow(
      'directory sync failed',
    )
    expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('name: example')
    expect(await readFile(join(directory, 'scripts', 'run.py'), 'utf8')).toBe('print(1)\n')
  }
  fault.syncFail = false
  await removeFilesystemSkill({ descriptor, osHomeDir: home })
  await expect(readFile(join(directory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('deletes only the selected skill and permits a missing-target retry', async () => {
  const { directory, descriptor } = await fixture()
  await writeFile(join(home, 'keep.txt'), 'keep')
  await removeFilesystemSkill({ descriptor, osHomeDir: home })
  await expect(readFile(join(directory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('keep')
  await removeFilesystemSkill({ descriptor, osHomeDir: home })
})
it('refuses a changed revision before deleting any files', async () => {
  const { directory, descriptor } = await fixture()
  await writeFile(join(directory, 'SKILL.md'), '---\nname: example\ndescription: test\n---\nChanged.\n')
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow('SKILL_DELETE_REFUSED')
  expect(await readFile(join(directory, 'scripts', 'run.py'), 'utf8')).toBe('print(1)\n')
})
it('refuses managed sources and wrong workspace identity', async () => {
  const { descriptor } = await fixture()
  await expect(
    removeFilesystemSkill({
      descriptor: {
        ...descriptor,
        sourceIdentity: { ...descriptor.sourceIdentity, scope: 'package', rootKey: 'package' },
      },
      osHomeDir: home,
    }),
  ).rejects.toThrow()
  await expect(
    removeFilesystemSkill({
      descriptor: {
        ...descriptor,
        sourceIdentity: { ...descriptor.sourceIdentity, scope: 'workspace', rootKey: 'workspace-agnes' },
        workspaceId: '0'.repeat(64),
      },
      cwd: home,
      osHomeDir: home,
    }),
  ).rejects.toThrow()
})

it('refuses a directory junction without touching its outside target', async () => {
  const { directory, descriptor } = await fixture()
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await symlink(outside, join(directory, 'outside-link'), 'junction')
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow()
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('name: example')
})

it('resumes a partial permanent deletion using the original durable identities', async () => {
  const { directory, descriptor } = await fixture()
  fault.fail = true
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toMatchObject({
    code: 'EBUSY',
  })
  const remaining = await Promise.allSettled([
    readFile(join(directory, 'SKILL.md')),
    readFile(join(directory, 'scripts', 'run.py')),
  ])
  expect(remaining.filter((result) => result.status === 'rejected')).toHaveLength(1)
  fault.fail = false
  await removeFilesystemSkill({ descriptor, osHomeDir: home })
  await expect(readFile(join(directory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not delete files changed after a partial deletion', async () => {
  const { directory, descriptor } = await fixture()
  fault.fail = true
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toMatchObject({
    code: 'EBUSY',
  })
  fault.fail = false
  const paths = [join(directory, 'SKILL.md'), join(directory, 'scripts', 'run.py')]
  const results = await Promise.allSettled(paths.map((path) => readFile(path)))
  const remaining = paths[results.findIndex((result) => result.status === 'fulfilled')]
  if (!remaining) throw new Error('one original file must remain')
  await writeFile(remaining, 'new content must survive the stale deletion attempt')
  await expect(removeFilesystemSkill({ descriptor, osHomeDir: home })).rejects.toThrow('SKILL_DELETE_REFUSED')
  expect(await readFile(remaining, 'utf8')).toBe('new content must survive the stale deletion attempt')
})

it('preflights without removing files or creating deletion progress', async () => {
  const { directory, descriptor } = await fixture()
  const stateDirectory = join(home, 'preflight-state')
  await removeFilesystemSkill({ descriptor, osHomeDir: home, stateDirectory, validateOnly: true })
  expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('name: example')
  expect(await readFile(join(directory, 'scripts', 'run.py'), 'utf8')).toBe('print(1)\n')
  await expect(import('node:fs/promises').then((fs) => fs.stat(stateDirectory))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

async function describedSkill(workspace: string | undefined, name: string): Promise<SkillDescriptor> {
  const scan = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'))
  const candidate = scan.roots.flatMap((root) => root.candidates).find((item) => item.name === name)
  if (!candidate) throw new Error(`fixture skill ${name} was not discovered`)
  return {
    ...candidate,
    kind: 'skill',
    resolution: { winner: true, shadowed: [] },
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    stale: false,
  }
}

it('deletes a project Skill from .claude/skills and leaves the .agh ones alone', async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-remove-claude-'))
  const workspace = join(home, 'ws')
  const claude = join(workspace, '.claude', 'skills', 'claude-one')
  const agh = join(workspace, '.agh', 'skills', 'keep')
  await mkdir(claude, { recursive: true })
  await mkdir(agh, { recursive: true })
  await writeFile(join(claude, 'SKILL.md'), '---\nname: claude-one\ndescription: test\n---\nbody\n')
  await writeFile(join(agh, 'SKILL.md'), '---\nname: keep\ndescription: test\n---\nbody\n')
  const descriptor = await describedSkill(workspace, 'claude-one')
  await removeFilesystemSkill({
    descriptor,
    cwd: workspace,
    osHomeDir: home,
    agnesHomeDir: join(home, '.agh'),
    stateDirectory: join(home, 'state'),
  })
  await expect(readdir(join(workspace, '.claude', 'skills'))).resolves.toEqual([])
  expect(await readFile(join(agh, 'SKILL.md'), 'utf8')).toContain('name: keep')
})

it('refuses to delete a single-file Skill at preflight', async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-remove-single-'))
  await mkdir(join(home, '.agh', 'skills'), { recursive: true })
  await writeFile(join(home, '.agh', 'skills', 'solo.md'), '---\nname: solo\ndescription: test\n---\nbody\n')
  const descriptor = await describedSkill(undefined, 'solo')
  await expect(
    removeFilesystemSkill({
      descriptor,
      osHomeDir: home,
      agnesHomeDir: join(home, '.agh'),
      validateOnly: true,
    }),
  ).rejects.toThrow('SKILL_DELETE_REFUSED')
  expect(await readFile(join(home, '.agh', 'skills', 'solo.md'), 'utf8')).toContain('name: solo')
})
