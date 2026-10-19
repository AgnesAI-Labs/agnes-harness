import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileMentionSource, listWorkspaceFiles, mentionToken } from '../../src/tui/commands.js'

describe('mentionToken', () => {
  it('reads the mention before the cursor, quoted or bare, only at the start of a word', () => {
    expect(mentionToken('see @src/a')).toEqual({ start: 4, query: 'src/a' })
    expect(mentionToken('@')).toEqual({ start: 0, query: '' })
    expect(mentionToken('@"my no')).toEqual({ start: 0, query: 'my no' })
    expect(mentionToken('a@b')).toBeUndefined()
    expect(mentionToken('@src ')).toBeUndefined()
    expect(mentionToken('@"my notes.md" ')).toBeUndefined()
  })
})

describe('FileMentionSource', () => {
  const FILES = ['README.md', 'docs/README.md', 'src/app.ts', 'src/tui/editor.ts', 'src/tui/app.ts']
  const ready = async (files: readonly string[] = FILES) => {
    const changed = vi.fn()
    const source = new FileMentionSource(async () => files, changed)
    expect(source.get('')).toEqual({ status: 'loading', items: [] })
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    const ids = (query: string) =>
      source.get(query).items.map((item) => (item.directory ? `${item.id}/` : item.id))
    return { source, ids }
  }

  it('lists the top level, folders first, for a bare @', async () => {
    const { ids } = await ready()
    expect(ids('')).toEqual(['docs/', 'src/', 'README.md'])
  })

  it('filters on every keystroke: names before paths, shallow before deep, folders as choices', async () => {
    const { ids } = await ready()
    expect(ids('readme')).toEqual(['README.md', 'docs/README.md'])
    expect(ids('tui')).toEqual(['src/tui/', 'src/tui/app.ts', 'src/tui/editor.ts'])
    expect(ids('stuied')).toEqual(['src/tui/editor.ts'])
    expect(ids('zzz')).toEqual([])
  })

  it('inside a typed folder offers what it holds, not the folder again', async () => {
    const { ids } = await ready()
    expect(ids('src/')).toEqual(['src/tui/', 'src/app.ts', 'src/tui/app.ts', 'src/tui/editor.ts'])
  })

  it('turns a failed listing into a state, never a throw', async () => {
    const changed = vi.fn()
    const source = new FileMentionSource(() => {
      throw new Error('unreadable')
    }, changed)
    expect(() => source.get('x')).not.toThrow()
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(source.get('x')).toEqual({ status: 'failed', items: [] })
  })

  it('rebuilds a stale index in the background and keeps answering from the old one meanwhile', async () => {
    let now = 0
    let files = ['a.ts']
    const changed = vi.fn()
    const source = new FileMentionSource(
      async () => files,
      changed,
      () => now,
    )
    source.get('')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    files = ['a.ts', 'b.ts']
    now = 6_000
    expect(source.get('').items.map((item) => item.id)).toEqual(['a.ts'])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(source.get('').items.map((item) => item.id)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('listWorkspaceFiles', () => {
  it('outside git, walks the folder and skips node_modules and .git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-list-'))
    try {
      for (const file of ['a.txt', 'src/b.ts', 'node_modules/x/index.js', '.git/HEAD']) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        writeFileSync(join(dir, file), '')
      }
      expect((await listWorkspaceFiles(dir)).sort()).toEqual(['a.txt', 'src/b.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('inside git, hides what the workspace file service hides: ignored, .aghignore, secrets, links, AGH home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-list-git-'))
    const files = [
      'kept.ts',
      'dist/out.js',
      'tracked.log',
      'sub/a.md',
      'sub/b.md',
      'notes/x.md',
      '.agh/secrets/key',
      'home/cfg',
    ]
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        writeFileSync(join(dir, file), '')
      }
      writeFileSync(join(dir, '.gitignore'), 'dist/\n')
      // Tracked, yet hidden by .aghignore; nested .aghignore applies below its folder only.
      writeFileSync(join(dir, '.aghignore'), '*.log\nnotes/\n')
      writeFileSync(join(dir, 'sub', '.aghignore'), 'b.md\n')
      execFileSync('git', ['add', 'tracked.log'], { cwd: dir })
      symlinkSync(join(dir, 'kept.ts'), join(dir, 'link.ts'))
      vi.stubEnv('AGH_HOME', join(dir, 'home'))
      expect((await listWorkspaceFiles(dir)).sort()).toEqual([
        '.aghignore',
        '.gitignore',
        'kept.ts',
        'sub/.aghignore',
        'sub/a.md',
      ])
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects for a folder it cannot read', async () => {
    await expect(listWorkspaceFiles('/nonexistent-agnes-list')).rejects.toThrow()
  })
})
