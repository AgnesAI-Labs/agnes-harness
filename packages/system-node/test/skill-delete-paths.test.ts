import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deleteSkillEntrySync, skillDeletionPath } from '../src/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, 'agnes-skill-path-'))
  roots.push(root)
  const path = join(root, '中文 skill.txt')
  writeFileSync(path, 'keep until authorized')
  const stat = lstatSync(path),
    identity = lstatSync(path, { bigint: true })
  return {
    root,
    entry: {
      path,
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      directory: false,
    },
  }
}
it('deletes unicode paths and refuses replaced identities', () => {
  const { entry } = fixture()
  expect(() => deleteSkillEntrySync({ ...entry, ino: (BigInt(entry.ino) + 1n).toString() })).toThrow()
  expect(existsSync(entry.path)).toBe(true)
  deleteSkillEntrySync(entry)
  expect(existsSync(entry.path)).toBe(false)
})
// guards-allow-platform: exercises actual platform native paths, not a mocked platform.
it.skipIf(process.platform !== 'win32')('refuses UNC during preflight without accessing a share', () => {
  expect(() => skillDeletionPath('\\\\server\\share\\skills')).toThrow('local drive')
})
// guards-allow-platform: macOS system aliases require a real Darwin filesystem and binary.
it.skipIf(process.platform !== 'darwin').each(['/tmp', '/var/tmp'])(
  'accepts %s aliases in JS and native',
  (parent) => {
    const { entry } = fixture(parent)
    expect(skillDeletionPath(entry.path)).toBe(realpathSync(entry.path))
    const native = createRequire(import.meta.url)('@agnes/system-node/native')
    native.deleteSkillEntry(
      entry.path,
      BigInt(entry.dev),
      BigInt(entry.ino),
      entry.size,
      entry.mtimeMs,
      false,
    )
    expect(existsSync(entry.path)).toBe(false)
  },
)
it('keeps rejecting user-created directory links', () => {
  const { root, entry } = fixture()
  const actual = join(root, 'actual')
  mkdirSync(actual)
  const file = join(actual, 'keep.txt')
  writeFileSync(file, 'outside')
  const link = join(root, 'link')
  symlinkSync(actual, link, 'junction')
  const stat = lstatSync(file),
    identity = lstatSync(file, { bigint: true })
  expect(() =>
    deleteSkillEntrySync({
      ...entry,
      path: join(link, 'keep.txt'),
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }),
  ).toThrow()
  expect(existsSync(file)).toBe(true)
})
