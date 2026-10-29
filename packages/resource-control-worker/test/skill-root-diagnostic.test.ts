import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeContextConfig } from '@agnes/base'
import { afterEach, expect, it } from 'vitest'
import { scanSkills } from '../src/skill-bootstrap.js'

/**
 * The DOM test for the Skill / MCP pane stubs the BFF, so it only pins how the page renders a
 * diagnostic it is handed. This covers the other half of the chain: the worker turning a failed
 * filesystem scan into the reason code that reaches the management DTO.
 */
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reports skipped entries without leaking a path or directory name, and keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-diagnostic-'))
  roots.push(root)
  const home = join(root, 'home')
  const skillDirectory = join(home, '.agents', 'skills', 'blank')
  await mkdir(skillDirectory, { recursive: true })
  // 2026-09-15 用户实际遇到的形状：description 为空。当时整根 38 个技能消失，而页面只能说"刷新失败"。
  await writeFile(join(skillDirectory, 'SKILL.md'), "---\nname: blank\ndescription: ''\n---\nbody")
  await mkdir(join(home, '.agents', 'skills', 'review'))
  await writeFile(
    join(home, '.agents', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review\n---\nbody',
  )
  const workspace = join(root, 'workspace')
  await mkdir(workspace)

  const scanned = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'), true)
  const status = scanned.rootStatuses.find((entry) => entry.rootKey === 'user-agents')
  expect(status).toMatchObject({
    rootKey: 'user-agents',
    scope: 'user',
    state: 'ready',
    diagnostic: { code: 'entries-skipped' },
  })
  expect(
    scanned.roots.find((entry) => entry.rootKey === 'user-agents')?.candidates.map((c) => c.name),
  ).toEqual(['review'])
  expect(scanned.skippedResourceIds).toHaveLength(1)
  expect(scanned.failedRoots).not.toContain('user-agents')
  // 原因码是给用户看"为什么"的，不能顺带把路径或出问题的目录名带出去。
  const serialized = JSON.stringify(status)
  expect(serialized).not.toContain(skillDirectory)
  expect(serialized).not.toContain('blank')
})

it('still fails the whole root when the directory itself cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-diagnostic-dir-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(join(home, '.agents'), { recursive: true })
  await writeFile(join(home, '.agents', 'skills'), 'not a directory')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const scanned = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'), true)
  expect(scanned.rootStatuses.find((entry) => entry.rootKey === 'user-agents')).toMatchObject({
    state: 'unavailable',
    diagnostic: { code: 'root-unreadable' },
  })
  expect(scanned.failedRoots).toContain('user-agents')
})

it('leaves a healthy root without a diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-diagnostic-ok-'))
  roots.push(root)
  const home = join(root, 'home')
  const skillDirectory = join(home, '.agents', 'skills', 'review')
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nbody')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)

  const scanned = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'), true)
  const status = scanned.rootStatuses.find((entry) => entry.rootKey === 'user-agents')
  expect(status).toMatchObject({ state: 'ready' })
  expect(status).not.toHaveProperty('diagnostic')
})

it('keeps the personal skills when an added skill folder cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-diagnostic-custom-'))
  roots.push(root)
  const home = join(root, 'home')
  const agnesHome = join(home, '.agh')
  const own = join(agnesHome, 'skills', 'review')
  await mkdir(own, { recursive: true })
  await writeFile(join(own, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nbody')
  // 另一个用户的目录、没有权限的目录、以及其实是个文件的路径：都是用户在"添加技能文件夹"里可能填的。
  const locked = join(root, 'locked')
  await mkdir(locked)
  await chmod(locked, 0o000)
  const notDirectory = join(root, 'not-a-directory')
  await writeFile(notDirectory, 'file')
  const readable = join(root, 'readable', 'notes')
  await mkdir(readable, { recursive: true })
  await writeFile(join(readable, 'SKILL.md'), '---\nname: notes\ndescription: Notes\n---\nbody')
  writeContextConfig({ customSkillRoots: [locked, notDirectory, join(root, 'readable')] }, agnesHome)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const scanned = await scanSkills(workspace, undefined, undefined, home, agnesHome, true)
    const status = scanned.rootStatuses.find((entry) => entry.rootKey === 'user-agnes')
    expect(status).toMatchObject({ state: 'ready', diagnostic: { code: 'entries-skipped' } })
    expect(
      scanned.roots
        .find((entry) => entry.rootKey === 'user-agnes')
        ?.candidates.map((c) => c.name)
        .sort(),
    ).toEqual(['notes', 'review'])
    expect(scanned.failedRoots).not.toContain('user-agnes')
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain(locked)
    expect(serialized).not.toContain(notDirectory)
  } finally {
    await chmod(locked, 0o700)
  }
})

it('still fails the personal root when its own directory cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-diagnostic-own-'))
  roots.push(root)
  const home = join(root, 'home')
  const agnesHome = join(home, '.agh')
  await mkdir(agnesHome, { recursive: true })
  await writeFile(join(agnesHome, 'skills'), 'not a directory')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const scanned = await scanSkills(workspace, undefined, undefined, home, agnesHome, true)
  expect(scanned.failedRoots).toContain('user-agnes')
})
