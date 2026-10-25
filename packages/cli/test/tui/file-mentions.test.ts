import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mentionText } from '@agnes/cli-tui'
import { describe, expect, it, vi } from 'vitest'
import {
  attachmentsFrom,
  createMentionSource,
  FileMentionSource,
  listWorkspaceFiles,
  mentionToken,
} from '../../src/tui/commands.js'

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

  it('keeps an exactly typed file offered, first, even when longer names share its prefix', async () => {
    const { ids } = await ready(['src/index.ts', 'src/index.tsx', 'Makefile', 'docs/Makefile.bak'])
    expect(ids('src/index.ts')).toEqual(['src/index.ts', 'src/index.tsx'])
    expect(ids('makefile')).toEqual(['Makefile', 'docs/Makefile.bak'])
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

  it('refuses a retired home variable before listing files', async () => {
    vi.stubEnv('AGNES_HOME', '/synthetic/old')
    try {
      await expect(listWorkspaceFiles('/synthetic/workspace')).rejects.toThrow(/AGNES_HOME.*clean home/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects for a folder it cannot read', async () => {
    await expect(listWorkspaceFiles('/nonexistent-agnes-list')).rejects.toThrow()
  })
})

describe('createMentionSource', () => {
  const found = (...ids: string[]) => ({
    items: ids.map((id) => ({ source: 'file', id, label: id })),
    truncated: false,
  })
  const settle = async (
    source: { get(q: string): { status: string } },
    query: string,
    changed: () => void,
  ) => {
    source.get(query)
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
  }

  it('remote: asks the daemon, never the local disk, and drops entries with control characters', async () => {
    const changed = vi.fn()
    const search = vi.fn(async () =>
      found(
        'srv/a.ts',
        'evil\u001b[2Jx.ts',
        '../../etc/passwd',
        '/etc/hosts',
        '~/.ssh/id_ed25519',
        'C:/x',
        'a/../../b',
      ),
    )
    const source = createMentionSource({
      session: { searchReferences: search },
      cwd: '/nonexistent/agh-b7-remote',
      remote: true,
      locale: 'en',
      changed,
    })
    await settle(source, 'a', changed)
    expect(search).toHaveBeenCalledWith('a')
    expect(source.get('a')).toEqual({ status: 'ready', items: [{ id: 'srv/a.ts', directory: false }] })
    // A session switch resets the source: the cached answer is dropped and the next `get` asks again.
    source.reset()
    expect(source.get('a')).toEqual({ status: 'loading', items: [] })
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  })

  it('remote: a missing method is a one-line reason, with no local fallback', async () => {
    const changed = vi.fn()
    const missing = Object.assign(new Error('nope'), { data: { code: 'METHOD_NOT_FOUND' } })
    const source = createMentionSource({
      session: { searchReferences: async () => Promise.reject(missing) },
      cwd: '/nonexistent/agh-b7-remote',
      remote: true,
      locale: 'zh-CN',
      changed,
    })
    await settle(source, '', changed)
    expect(source.get('')).toEqual({
      status: 'failed',
      items: [],
      reason: '此 daemon 不支持文件搜索',
    })
  })

  it('failure reason is sanitized to one line', async () => {
    const changed = vi.fn()
    const source = createMentionSource({
      session: { searchReferences: async () => Promise.reject(new Error('boom\n\u001b[31mred')) },
      cwd: '/nonexistent',
      remote: true,
      locale: 'en',
      changed,
    })
    await settle(source, 'q', changed)
    expect(source.get('q').reason).toBe('Cannot search files: boom [31mred')
  })

  it('embedded: shows the local index until the daemon answers, then the daemon answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-mention-warm-'))
    try {
      writeFileSync(join(dir, 'local-note.md'), 'x')
      const changed = vi.fn()
      let answer: (value: ReturnType<typeof found>) => void = () => {}
      const search = vi.fn(() => new Promise<ReturnType<typeof found>>((done) => (answer = done)))
      const source = createMentionSource({
        session: { searchReferences: search },
        cwd: dir,
        remote: false,
        locale: 'en',
        changed,
      })
      await vi.waitFor(() =>
        expect(source.get('note')).toEqual({
          status: 'ready',
          items: [{ id: 'local-note.md', directory: false }],
        }),
      )
      answer(found('srv/note.ts'))
      await vi.waitFor(() =>
        expect(source.get('note').items).toEqual([{ id: 'srv/note.ts', directory: false }]),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks the daemon one query at a time and skips the ones typed meanwhile', async () => {
    const changed = vi.fn()
    const answers: Array<() => void> = []
    const search = vi.fn(
      (query: string) =>
        new Promise<ReturnType<typeof found>>((done) => answers.push(() => done(found(`${query}.ts`)))),
    )
    const source = createMentionSource({
      session: { searchReferences: search },
      cwd: '/nonexistent/agh-mention-serial',
      remote: true,
      locale: 'en',
      changed,
    })
    source.get('a')
    source.get('ab')
    source.get('abc')
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    answers[0]?.()
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(search.mock.calls.map(([query]) => query)).toEqual(['a', 'abc'])
    answers[1]?.()
    await vi.waitFor(() => expect(source.get('abc').items).toEqual([{ id: 'abc.ts', directory: false }]))
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('embedded: falls back to the local workspace only when the daemon lacks the method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-b7-embedded-'))
    try {
      writeFileSync(join(dir, 'local-note.md'), 'x')
      const changed = vi.fn()
      const missing = Object.assign(new Error('nope'), { data: { code: 'CAPABILITY_DENIED' } })
      const source = createMentionSource({
        session: { searchReferences: async () => Promise.reject(missing) },
        cwd: dir,
        remote: false,
        locale: 'en',
        changed,
      })
      await settle(source, 'local', changed)
      await vi.waitFor(() =>
        expect(source.get('local').items).toEqual([{ id: 'local-note.md', directory: false }]),
      )
      // Any other error is reported, not papered over with the disk.
      const failing = createMentionSource({
        session: { searchReferences: async () => Promise.reject(new Error('down')) },
        cwd: dir,
        remote: false,
        locale: 'en',
        changed,
      })
      await vi.waitFor(() => expect(failing.get('local').status).toBe('failed'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('accepted mentions with an @ in the path', () => {
  it('attach the whole file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-mention-at-'))
    try {
      mkdirSync(join(dir, 'packages', '@scope'), { recursive: true })
      writeFileSync(join(dir, 'packages', '@scope', 'x.ts'), 'x')
      writeFileSync(join(dir, 'icon@2x.png'), 'x')
      for (const id of ['packages/@scope/x.ts', 'icon@2x.png']) {
        const links = attachmentsFrom(`look at ${mentionText({ id, directory: false })}`, dir).slice(1)
        expect(links.map((l) => (l.type === 'resource_link' ? l.name : ''))).toEqual([id])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
