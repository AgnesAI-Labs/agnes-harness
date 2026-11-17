import type { FsEntry, ToolContext } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { readFindCandidate, scanFindCandidates } from '../src/uses/find-scan.js'

type Node = string | Uint8Array | FsEntry[] | 'symlink'
function filesystem(nodes: Record<string, Node>) {
  const reads: Array<{ path: string; limit: number | undefined }> = []
  const lists: string[] = []
  const stats: string[] = []
  const fs: Pick<ToolContext['fs'], 'read' | 'list' | 'stat'> = {
    async list(path) {
      lists.push(path)
      const value = nodes[path]
      if (!Array.isArray(value)) throw new Error('not a directory')
      return value
    },
    async stat(path) {
      stats.push(path)
      const value = nodes[path]
      if (value === undefined) throw new Error('missing')
      const kind = Array.isArray(value) ? 'dir' : value === 'symlink' ? 'symlink' : 'file'
      const size = typeof value === 'string' ? new TextEncoder().encode(value).length : value.length
      return { kind, size, mtimeMs: 1 }
    },
    async read(path, options) {
      reads.push({ path, limit: options?.limit })
      const value = nodes[path]
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new Error('not a file')
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
      return bytes.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? bytes.length))
    },
  }
  return { fs, reads, lists, stats }
}
const active = () => new AbortController().signal
const file = (name: string): FsEntry => ({ name, kind: 'file' })

it('filters credentials, links, unsafe names, builds and locks before selecting stable candidates', async () => {
  const f = filesystem({
    '/repo': [
      file('z.ts'),
      file('query.ts'),
      file('.env.production'),
      file('client.key'),
      file('pnpm-lock.yaml'),
      file('image.png'),
      file('../outside'),
      file('nested/x'),
      { name: 'link', kind: 'symlink' },
      { name: 'dist', kind: 'dir' },
      { name: 'src', kind: 'dir' },
    ],
    '/repo/z.ts': 'z',
    '/repo/query.ts': 'q',
    '/repo/src': [file('query.md')],
    '/repo/src/query.md': 'doc',
  })
  const result = await scanFindCandidates(f.fs, '/repo', 'query', active())
  expect(result.candidates.map((c) => c.path)).toEqual(['/repo/query.ts', '/repo/src/query.md', '/repo/z.ts'])
  expect(result.partial).toBe(false)
  expect(f.lists).toEqual(['/repo', '/repo/src'])
  expect(f.reads.map((read) => read.path)).toEqual(['/repo/query.ts', '/repo/z.ts', '/repo/src/query.md'])
})

it('bounds the candidate set and consumed entries and reports an incomplete scan', async () => {
  const entries = Array.from({ length: 10002 }, (_, i) => file(`file-${String(i).padStart(5, '0')}.ts`))
  const f = filesystem({
    '/repo': entries,
    ...Object.fromEntries(entries.map((entry) => [`/repo/${entry.name}`, 'ordinary'])),
  })
  const result = await scanFindCandidates(f.fs, '/repo', 'missing', active())
  expect(result.entriesVisited).toBe(10000)
  expect(result.candidates).toHaveLength(128)
  expect(result.candidates[0]?.path).toBe('/repo/file-00000.ts')
  expect(result.partial).toBe(true)
  expect(result.reasons).toContain('entry_limit')
  expect(result.reasons).toContain('candidate_limit')
})

it('rejects unsafe roots and root links before listing or reading', async () => {
  const f = filesystem({ '/repo/link': 'symlink', '/repo/.ssh': [] })
  for (const root of [
    '/repo/../outside',
    '/repo/.ssh',
    '/repo/link',
    'relative',
    '/repo:stream',
    '/repo\0evil',
  ]) {
    const result = await scanFindCandidates(f.fs, root, 'query', active())
    expect(result.candidates).toEqual([])
    expect(result.partial).toBe(true)
  }
  expect(f.lists).toEqual([])
  expect(f.reads).toEqual([])
})

it('rechecks file kind, bounds reads, and discards binaries and changed files', async () => {
  const f = filesystem({
    '/repo/a.ts': 'a'.repeat(1048580),
    '/repo/bin': new Uint8Array([65, 0, 66]),
    '/repo/link': 'symlink',
  })
  const a = await readFindCandidate(f.fs, '/repo', '/repo/a.ts', active())
  expect(a.status).toBe('ok')
  if (a.status === 'ok') {
    expect(a.text).toHaveLength(1048576)
    expect(a.truncated).toBe(true)
  }
  expect(f.reads[0]).toEqual({ path: '/repo/a.ts', limit: 1048576 })
  expect((await readFindCandidate(f.fs, '/repo', '/repo/bin', active())).status).toBe('skipped')
  expect((await readFindCandidate(f.fs, '/repo', '/repo/link', active())).status).toBe('skipped')
  expect((await readFindCandidate(f.fs, '/repo', '/repo2/a.ts', active())).status).toBe('skipped')
  const original = f.fs.stat
  let count = 0
  f.fs.stat = async (path) => ({ ...(await original(path)), mtimeMs: ++count })
  expect(await readFindCandidate(f.fs, '/repo', '/repo/a.ts', active())).toMatchObject({
    status: 'failed',
    reason: 'changed',
  })
})

it('honors cancellation before operations and while a filesystem promise is pending', async () => {
  const f = filesystem({ '/repo': [] })
  const controller = new AbortController()
  controller.abort()
  const result = await scanFindCandidates(f.fs, '/repo', 'query', controller.signal)
  expect(result.reasons).toContain('cancelled')
  expect(f.stats).toEqual([])
  const waiting = new AbortController()
  const pending = scanFindCandidates(
    { ...f.fs, stat: () => new Promise(() => {}) },
    '/repo',
    'query',
    waiting.signal,
  )
  waiting.abort()
  expect((await pending).reasons).toContain('cancelled')
  let began: (() => void) | undefined
  let finish: ((bytes: Uint8Array) => void) | undefined
  const reading = new Promise<void>((resolve) => {
    began = resolve
  })
  const bytes = new Promise<Uint8Array>((resolve) => {
    finish = resolve
  })
  const cancellation = new AbortController()
  const work = scanFindCandidates(
    {
      ...f.fs,
      list: async () => [file('index.ts')],
      stat: async (path) => ({ kind: path === '/repo' ? 'dir' : 'file', size: 1, mtimeMs: 1 }),
      read: async () => {
        began?.()
        return bytes
      },
    },
    '/repo',
    'query',
    cancellation.signal,
  )
  await reading
  cancellation.abort()
  const stopped = await work
  expect(stopped).toMatchObject({ filesRead: 0, bytesRead: 0, partial: true })
  expect(stopped.reasons).toContain('cancelled')
  finish?.(new Uint8Array([65]))
  await Promise.resolve()
  expect(stopped.filesRead).toBe(0)
  expect(stopped.bytesRead).toBe(0)
})

it('discards changed revisions, listed directories replaced by links, and per-directory failures', async () => {
  const f = filesystem({
    '/repo': [
      { name: 'changed', kind: 'dir' },
      { name: 'denied', kind: 'dir' },
    ],
    '/repo/changed': 'symlink',
    '/repo/denied': [],
    '/repo/a.ts': 'safe',
  })
  const list = f.fs.list
  f.fs.list = async (path) => {
    if (path.endsWith('/denied')) throw new Error('denied')
    return list(path)
  }
  const scan = await scanFindCandidates(f.fs, '/repo', 'safe', active())
  expect(scan.partial).toBe(true)
  expect(scan.failures).toBe(1)
  expect(scan.reasons).toEqual(['changed', 'unreadable_directory'])
  let revision = 0
  expect(
    await readFindCandidate(
      { ...f.fs, revision: async () => String(++revision) },
      '/repo',
      '/repo/a.ts',
      active(),
    ),
  ).toEqual({ status: 'failed', reason: 'changed' })
})

it('accepts only valid UTF-8 and preserves the valid prefix at a bounded multibyte cut', async () => {
  const f = filesystem({
    '/repo/cjk': '界'.repeat(349527),
    '/repo/binary': new Uint8Array([0xff, 0xfe, 0x41]),
  })
  const result = await readFindCandidate(f.fs, '/repo', '/repo/cjk', active())
  expect(result).toEqual({ status: 'ok', text: '界'.repeat(349525), truncated: true })
  expect((await readFindCandidate(f.fs, '/repo', '/repo/binary', active())).status).toBe('failed')
})

it('never enqueues or returns discovered paths beyond the bounded path length', async () => {
  const root = `/${'r'.repeat(2040)}`
  const f = filesystem({ [root]: [file('overlong-name.ts'), { name: 'overlong-dir', kind: 'dir' }] })
  const result = await scanFindCandidates(f.fs, root, 'name', active())
  expect(result.candidates).toEqual([])
  expect(f.lists).toEqual([root])
  expect(result.partial).toBe(true)
  expect(result.reasons).toContain('path_limit')
})

it('finds a content match in a generic filename before truncating the top 128', async () => {
  const names = Array.from({ length: 128 }, (_, i) => `a${String(i).padStart(3, '0')}.ts`)
  const f = filesystem({
    '/repo': [
      ...names.map(file),
      { name: 'z', kind: 'dir' },
      file('.env'),
      { name: 'link', kind: 'symlink' },
    ],
    ...Object.fromEntries(names.map((name) => [`/repo/${name}`, 'ordinary unrelated text'])),
    '/repo/z': [file('index.ts')],
    '/repo/z/index.ts': 'needle',
    '/repo/.env': 'password=needle',
    '/repo/link': 'symlink',
  })
  const result = await scanFindCandidates(f.fs, '/repo', 'needle', active())
  expect(result.candidates).toHaveLength(128)
  expect(result.candidates[0]?.path).toBe('/repo/z/index.ts')
  expect(result.candidates[0]?.lexicalScore).toBeGreaterThan(0)
  expect(result).toMatchObject({ filesRead: 129, bytesRead: 2950 })
  expect(f.reads.map((r) => r.path)).not.toContain('/repo/.env')
  expect(f.reads.map((r) => r.path)).not.toContain('/repo/link')
  expect(f.reads.every((r) => r.limit === 1048576)).toBe(true)
})

it('reports bounded local content coverage and freshly reads the later semantic source', async () => {
  const nodes: Record<string, Node> = {
    '/repo': [file('index.ts')],
    '/repo/index.ts': `${'x'.repeat(1048576)}needle`,
  }
  const f = filesystem(nodes)
  const result = await scanFindCandidates(f.fs, '/repo', 'needle', active())
  expect(result).toMatchObject({ filesRead: 1, bytesRead: 1048576, partial: true })
  expect(result.reasons).toContain('content_read_limit')
  nodes['/repo/index.ts'] = 'fresh needle'
  expect(await readFindCandidate(f.fs, '/repo', '/repo/index.ts', active())).toEqual({
    status: 'ok',
    text: 'fresh needle',
    truncated: false,
  })
  expect(f.reads).toEqual([
    { path: '/repo/index.ts', limit: 1048576 },
    { path: '/repo/index.ts', limit: 1048576 },
  ])
})

it('excludes a binary file even when its filename and decoded prefix match the query', async () => {
  const f = filesystem({
    '/repo': [file('needle.ts')],
    '/repo/needle.ts': new Uint8Array([110, 101, 101, 100, 108, 101, 0]),
  })
  const result = await scanFindCandidates(f.fs, '/repo', 'needle', active())
  expect(result.candidates).toEqual([])
  expect(result.filesRead).toBe(1)
  expect(result.bytesRead).toBe(7)
})
