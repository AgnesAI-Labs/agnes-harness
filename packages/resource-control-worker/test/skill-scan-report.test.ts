import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeContextConfig } from '@agnes/base'
import { validateResourceControlData } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { scanSkills } from '../src/skill-bootstrap.js'

const cleanup: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const document = (name: string) => `---\nname: ${name}\ndescription: Useful\n---\nprivate instructions`
async function deployment() {
  const root = await mkdtemp(join(tmpdir(), 'agnes-worker-scan-report-'))
  cleanup.push(root)
  const home = join(root, 'os-home')
  const agnesHome = join(root, 'agnes-home')
  const custom = join(root, 'custom')
  await mkdir(custom)
  await mkdir(agnesHome)
  const scan = (lkg?: string, resourceIds?: readonly string[], snapshot?: string) =>
    scanSkills(undefined, snapshot, lkg, home, agnesHome, false, resourceIds)
  return { root, home, agnesHome, custom, scan }
}

it('reports valid, malformed, missing and non-directory custom locations from the real scan', async () => {
  const warnings: unknown[][] = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => {
    warnings.push(args)
  })
  const { root, agnesHome, custom, scan } = await deployment()
  await writeFile(join(custom, 'good.md'), document('review'))
  await writeFile(join(custom, 'same-name.md'), document('review'))
  await writeFile(join(custom, 'bad.md'), '---\nname: broken\ndescription: []\n---\nprivate instructions')
  const missing = join(root, 'missing')
  const notDirectory = join(root, 'plain-file')
  await writeFile(notDirectory, 'private instructions')
  writeContextConfig({ customSkillRoots: [custom, missing, notDirectory] }, agnesHome)
  const result = await scan()
  expect(JSON.stringify(warnings)).not.toMatch(/good\.md|bad\.md|same-name\.md|private instructions/)
  expect(JSON.stringify(warnings)).not.toContain(root)
  expect(result.skillScanObservation).toMatchObject({
    configurationRevision: digest(JSON.stringify([custom, missing, notDirectory])),
    complete: false,
    foundCount: 2,
    skippedCount: 1,
    unreadableDirectoryCount: 2,
    truncated: false,
    directories: [
      {
        directoryId: digest(custom),
        rootKey: 'user-agnes',
        state: 'partial',
        complete: true,
        foundCount: 2,
        skippedCount: 1,
        issues: [{ code: 'invalid-frontmatter', stage: 'parse' }],
      },
      {
        directoryId: digest(missing),
        state: 'unavailable',
        complete: false,
        skippedCount: 0,
        issues: [{ code: 'directory-missing', stage: 'list', osCode: 'ENOENT' }],
      },
      {
        directoryId: digest(notDirectory),
        state: 'unavailable',
        complete: false,
        skippedCount: 0,
        issues: [{ code: 'not-directory', stage: 'list', osCode: 'ENOTDIR' }],
      },
    ],
  })
  expect(validateResourceControlData('SkillScanObservation', result.skillScanObservation).ok).toBe(true)
  const safe = JSON.stringify(result.skillScanObservation)
  expect(safe).not.toContain(root)
  expect(safe).not.toMatch(/good\.md|bad\.md|same-name\.md|private instructions|stack|message/)
  expect(result.roots.flatMap((entry) => entry.candidates)).toHaveLength(1)
})

it('hashes normalized custom roots with stable order and deduplication', async () => {
  const { agnesHome, custom, root, scan } = await deployment()
  const second = join(root, 'second')
  await mkdir(second)
  // The worker consumes the same normalized configuration as the settings endpoint.
  await writeFile(
    join(agnesHome, 'context.json'),
    JSON.stringify({ customSkillRoots: [join(custom, '..', 'custom'), `${custom}/.`, second] }),
  )
  const first = await scan()
  expect(first.skillScanObservation).toMatchObject({
    configurationRevision: digest(JSON.stringify([resolve(custom), second])),
    directories: [{ directoryId: digest(custom) }, { directoryId: digest(second) }],
  })
  writeContextConfig({ customSkillRoots: [second, custom] }, agnesHome)
  expect((await scan()).skillScanObservation?.configurationRevision).toBe(
    digest(JSON.stringify([second, custom])),
  )
})

it('omits observations on targeted scans including an empty selection', async () => {
  const { agnesHome, custom, scan } = await deployment()
  writeContextConfig({ customSkillRoots: [custom] }, agnesHome)
  await writeFile(join(custom, 'review.md'), document('review'))
  const complete = await scan()
  expect(complete.skillScanObservation).toMatchObject({ complete: true, foundCount: 1 })
  const id = complete.roots.flatMap((entry) => entry.candidates)[0]?.resourceId
  if (!id) throw new Error('missing test Skill')
  expect(await scan(undefined, [id])).not.toHaveProperty('skillScanObservation')
  expect(await scan(undefined, [])).not.toHaveProperty('skillScanObservation')
})

it('reports an explicitly observed empty configuration and keeps the diagnostic out of LKG', async () => {
  const { root, agnesHome, custom, scan } = await deployment()
  expect((await scan()).skillScanObservation).toEqual({
    configurationRevision: digest('[]'),
    complete: true,
    foundCount: 0,
    skippedCount: 0,
    unreadableDirectoryCount: 0,
    truncated: false,
    directories: [],
  })
  writeContextConfig({ customSkillRoots: [custom] }, agnesHome)
  await writeFile(join(custom, 'review.md'), document('review'))
  const lkg = join(root, 'lkg')
  await scan(lkg)
  for (const file of await readdir(lkg)) {
    const content = await readFile(join(lkg, file), 'utf8')
    expect(content).not.toMatch(
      /skillScanObservation|directoryScans|configurationRevision|foundCount|skippedCount/,
    )
  }
})

it('does not claim an unvisited custom directory was unreadable after the default root failed', async () => {
  const { agnesHome, custom, scan } = await deployment()
  writeContextConfig({ customSkillRoots: [custom] }, agnesHome)
  await writeFile(join(agnesHome, 'skills'), 'not a directory')
  await writeFile(join(custom, 'review.md'), document('review'))
  const result = await scan()
  expect(result.failedRoots).toContain('user-agnes')
  expect(result.skillScanObservation).toMatchObject({
    complete: false,
    foundCount: 0,
    skippedCount: 0,
    unreadableDirectoryCount: 0,
    directories: [{ state: 'unavailable', complete: false, unreadable: false, issues: [] }],
  })
})

it('caps aggregate issues at 128 while preserving counts and complete boundary rejections', async () => {
  const { root, agnesHome, custom, scan } = await deployment()
  const second = join(root, 'second')
  await mkdir(second)
  const outside = join(root, 'outside.md')
  await writeFile(outside, document('outside'))
  for (const directory of [custom, second]) {
    for (let i = 0; i < 70; i += 1) {
      const skill = join(directory, `outside-${i}`)
      await mkdir(skill)
      await symlink(outside, join(skill, 'SKILL.md'))
    }
  }
  writeContextConfig({ customSkillRoots: [custom, second] }, agnesHome)
  const observation = (await scan()).skillScanObservation
  expect(observation).toMatchObject({ complete: true, foundCount: 0, skippedCount: 140, truncated: true })
  expect(observation?.directories.reduce((sum, directory) => sum + directory.issues.length, 0)).toBe(128)
})

it('preserves entry budget lower bounds and rejects more than sixteen configured directories', async () => {
  const { root, agnesHome, custom, scan } = await deployment()
  for (let i = 0; i < 129; i += 1) await writeFile(join(custom, `${i}.md`), document(`skill-${i}`))
  writeContextConfig({ customSkillRoots: [custom] }, agnesHome)
  expect((await scan()).skillScanObservation).toMatchObject({
    complete: false,
    foundCount: 128,
    skippedCount: 1,
    truncated: true,
    directories: [{ issues: [{ code: 'entry-limit', stage: 'budget' }] }],
  })
  await writeFile(
    join(agnesHome, 'context.json'),
    JSON.stringify({ customSkillRoots: Array.from({ length: 17 }, (_, i) => join(root, `extra-${i}`)) }),
  )
  await expect(scan()).rejects.toThrow('invalid customSkillRoots')
})
