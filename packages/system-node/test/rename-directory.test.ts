import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createPrivateDirectorySync, renameDirectoryNoReplaceSync } from '../src/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-directory-publish-'))
  roots.push(root)
  const source = join(root, 'source'),
    target = join(root, 'target')
  createPrivateDirectorySync(source)
  writeFileSync(join(source, 'file'), 'new bytes')
  return { root, source, target }
}
describe('no-replace directory publication', () => {
  it('allows only one of two independent publishers to claim the target', async () => {
    const s = setup()
    const other = join(s.root, 'other')
    createPrivateDirectorySync(other)
    writeFileSync(join(other, 'file'), 'other bytes')
    const module = new URL('../src/index.ts', import.meta.url).href
    const invoke = promisify(execFile)
    const publish = (source: string) =>
      invoke(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { renameDirectoryNoReplaceSync } from ${JSON.stringify(module)}; renameDirectoryNoReplaceSync(${JSON.stringify(source)}, ${JSON.stringify(s.target)});`,
        ],
        { windowsHide: true, timeout: 10000 },
      )
    const results = await Promise.allSettled([publish(s.source), publish(other)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const sourceWon = !existsSync(s.source)
    expect(readFileSync(join(s.target, 'file'), 'utf8')).toBe(sourceWon ? 'new bytes' : 'other bytes')
    expect(existsSync(sourceWon ? other : s.source)).toBe(true)
  }, 15000)

  it('moves the complete directory to a missing target', () => {
    const s = setup()
    renameDirectoryNoReplaceSync(s.source, s.target)
    expect(existsSync(s.source)).toBe(false)
    expect(readFileSync(join(s.target, 'file'), 'utf8')).toBe('new bytes')
  })
  it.each(['empty', 'populated', 'file', 'link'])('preserves an existing %s target', (kind) => {
    const s = setup()
    if (kind === 'file') writeFileSync(s.target, 'existing')
    else if (kind === 'link') {
      const actual = join(s.root, 'actual')
      mkdirSync(actual)
      symlinkSync(actual, s.target, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      mkdirSync(s.target)
      if (kind === 'populated') writeFileSync(join(s.target, 'file'), 'existing')
    }
    expect(() => renameDirectoryNoReplaceSync(s.source, s.target)).toThrow()
    expect(readFileSync(join(s.source, 'file'), 'utf8')).toBe('new bytes')
    if (kind === 'file') expect(readFileSync(s.target, 'utf8')).toBe('existing')
    if (kind === 'populated') expect(readFileSync(join(s.target, 'file'), 'utf8')).toBe('existing')
  })
  it('rejects a linked source and an invalid path without moving it', () => {
    const s = setup()
    const alias = join(s.root, 'alias')
    symlinkSync(s.source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => renameDirectoryNoReplaceSync(alias, s.target)).toThrow()
    expect(() => renameDirectoryNoReplaceSync(s.source, `${s.target}\0suffix`)).toThrow()
    expect(existsSync(s.target)).toBe(false)
    expect(existsSync(s.source)).toBe(true)
  })
})
