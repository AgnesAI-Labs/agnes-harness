import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  const scanned = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'))
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
  const scanned = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'))
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

  const scanned = await scanSkills(workspace, undefined, undefined, home, join(home, '.agh'))
  const status = scanned.rootStatuses.find((entry) => entry.rootKey === 'user-agents')
  expect(status).toMatchObject({ state: 'ready' })
  expect(status).not.toHaveProperty('diagnostic')
})
