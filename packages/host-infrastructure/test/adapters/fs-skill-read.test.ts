import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertFsEnforces, type FsPolicy } from '@agnes/core'
import { testFsPolicy } from '@agnes/core/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFs } from '../../src/adapters/fs.js'

const denied = { code: 'E_FS_DENIED' }

describe('fs adapter: Skill directories open for reading', () => {
  let base: string
  let root: string
  let skill: string
  let policy: FsPolicy
  let roots: string[]
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-skill-read-')))
    root = join(base, 'work')
    skill = join(base, 'skills', 'review')
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(skill, 'references'), { recursive: true })
    mkdirSync(join(skill, 'private'), { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\n---\nbody')
    writeFileSync(join(skill, 'references', 'a.md'), 'ref')
    writeFileSync(join(skill, 'private', 'k'), 'secret')
    mkdirSync(join(base, 'skills', 'review2'))
    writeFileSync(join(base, 'skills', 'review2', 'x'), 'x')
    writeFileSync(join(base, 'elsewhere'), 'nope')
    symlinkSync(join(base, 'elsewhere'), join(skill, 'leak'))
    const plain = testFsPolicy(root, { deny: ['.git'] })
    policy = {
      ...plain,
      rules: [...plain.rules, { effect: 'deny', path: join(skill, 'private'), source: 'preset', hard: true }],
    }
    roots = [skill]
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  const fs = () =>
    createFs(
      () => ({ policy, caseSensitive: true }),
      undefined,
      () => roots,
    )

  it('reads, lists and stats inside a listed Skill directory', async () => {
    const f = fs()
    expect(new TextDecoder().decode(await f.read(join(skill, 'references', 'a.md')))).toBe('ref')
    expect((await f.list(skill)).map((e) => e.name).sort()).toEqual([
      'SKILL.md',
      'leak',
      'private',
      'references',
    ])
    expect((await f.stat(join(skill, 'SKILL.md'))).kind).toBe('file')
  })

  it('never writes, creates or removes there', async () => {
    const f = fs()
    await expect(f.write(join(skill, 'new.md'), new Uint8Array([1]))).rejects.toMatchObject(denied)
    await expect(f.mkdir(join(skill, 'd'))).rejects.toMatchObject(denied)
    await expect(f.rm(join(skill, 'SKILL.md'))).rejects.toMatchObject(denied)
  })

  it('keeps resolveInside and realpath strict, so a shell cwd cannot move there', async () => {
    const f = fs()
    await expect(f.resolveInside(skill)).rejects.toMatchObject(denied)
    await expect(f.realpath(join(skill, 'SKILL.md'))).rejects.toMatchObject(denied)
  })

  it('lets a matching deny win, and refuses a sibling prefix and a link leading out', async () => {
    const f = fs()
    await expect(f.read(join(skill, 'private', 'k'))).rejects.toMatchObject(denied)
    await expect(f.read(join(base, 'skills', 'review2', 'x'))).rejects.toMatchObject(denied)
    await expect(f.read(join(skill, 'leak'))).rejects.toMatchObject(denied)
    await expect(f.read(join(base, 'elsewhere'))).rejects.toMatchObject(denied)
  })

  it('ignores a root that is the workspace or above it', async () => {
    roots = [dirname(root)]
    await expect(fs().read(join(base, 'elsewhere'))).rejects.toMatchObject(denied)
  })

  it('closes as soon as the Skill leaves the list', async () => {
    const f = fs()
    await f.read(join(skill, 'SKILL.md'))
    roots = []
    await expect(f.read(join(skill, 'SKILL.md'))).rejects.toMatchObject(denied)
  })

  it('still passes the enforcement probes', async () => {
    roots = [skill, dirname(root)]
    await expect(assertFsEnforces(fs(), policy)).resolves.toBeUndefined()
  })
})
