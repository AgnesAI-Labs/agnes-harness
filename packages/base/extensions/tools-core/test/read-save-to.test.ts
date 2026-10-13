import { checkToolDef, type FsStat, resolveToolCallPolicy, type ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { type FakeToolContext, fakeToolContext } from '../../../testkit/tool-context.js'
import { readTool, SAVE_TO_MAX_BYTES } from '../src/tools/read.js'

const textOf = (r: ToolResult): string => (r.content[0] as { type: 'text'; text: string }).text
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5])

type Original = { name: string; mimeType: string; bytes: Uint8Array }

/** The fake context with an attachment reader and a counted write; `stats` overrides what stat reports. */
function ctxWith(
  o: {
    original?: Original | (() => Promise<Original | undefined>)
    files?: Record<string, string | Uint8Array>
    stats?: Record<string, FsStat | Error>
    writeErrors?: Record<string, { code?: string; message?: string }>
  } = {},
) {
  const base = fakeToolContext({
    files: o.files ?? {},
    ...(o.writeErrors ? { writeErrors: o.writeErrors } : {}),
  })
  const writes: string[] = []
  const asked: unknown[] = []
  const original = o.original ?? { name: 'insects.zip', mimeType: 'application/zip', bytes: ZIP }
  const ctx: FakeToolContext = {
    ...base,
    session: {
      ...base.session,
      readAttachment: async (input) => {
        asked.push(input)
        return typeof original === 'function' ? original() : original
      },
    },
    fs: {
      ...base.fs,
      write: async (path, data) => {
        writes.push(path)
        return base.fs.write(path, data)
      },
      stat: async (path) => {
        const forced = o.stats?.[path]
        if (forced instanceof Error) throw forced
        if (forced) return forced
        return base.fs.stat(path)
      },
    },
  }
  return { ctx, writes, asked, mem: base.mem }
}

const save = (ctx: FakeToolContext, saveTo: string, path = 'session-file://5/1') =>
  readTool.execute({ path, saveTo }, ctx)

describe('read saveTo', () => {
  it('copies an attachment original into the workspace once and says where and how much', async () => {
    const { ctx, writes, mem, asked } = ctxWith()
    const result = await save(ctx, 'data/insects.zip')
    expect(result.isError).toBeUndefined()
    expect(writes).toEqual(['/work/proj/data/insects.zip'])
    expect(mem.files.get('/work/proj/data/insects.zip')).toEqual(ZIP)
    expect(textOf(result)).toContain('data/insects.zip')
    expect(textOf(result)).toContain(`${ZIP.byteLength} bytes`)
    expect(asked).toEqual([{ path: 'session-file://5/1', maxBytes: SAVE_TO_MAX_BYTES }])
  })

  it('copies an image original too', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const { ctx, mem } = ctxWith({ original: { name: 'image', mimeType: 'image/png', bytes: png } })
    const result = await save(ctx, 'shot.png', 'session-image://7/2')
    expect(result.isError).toBeUndefined()
    expect(mem.files.get('/work/proj/shot.png')).toEqual(png)
  })

  it('never replaces an existing file, link or directory', async () => {
    for (const stats of [
      undefined,
      { '/work/proj/data/insects.zip': { kind: 'symlink' as const, size: 0, mtimeMs: 0 } },
      { '/work/proj/data/insects.zip': { kind: 'dir' as const, size: 0, mtimeMs: 0 } },
    ]) {
      const { ctx, writes, mem } = ctxWith({
        files: stats ? { 'data/other': 'x' } : { 'data/insects.zip': 'old' },
        ...(stats ? { stats } : {}),
      })
      const result = await save(ctx, 'data/insects.zip')
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('already exists')
      expect(writes).toEqual([])
      if (!stats) expect(new TextDecoder().decode(mem.files.get('/work/proj/data/insects.zip'))).toBe('old')
    }
  })

  it('refuses a target whose directory is reached through a symbolic link or is not a directory', async () => {
    const link = ctxWith({ stats: { '/work/proj/data': { kind: 'symlink', size: 0, mtimeMs: 0 } } })
    const linked = await save(link.ctx, 'data/deep/insects.zip')
    expect(linked.isError).toBe(true)
    expect(textOf(linked)).toContain('symbolic link')
    expect(link.writes).toEqual([])
    const file = ctxWith({ files: { data: 'a file' } })
    const blocked = await save(file.ctx, 'data/insects.zip')
    expect(blocked.isError).toBe(true)
    expect(file.writes).toEqual([])
  })

  it('refuses a stat it cannot answer instead of treating it as absent', async () => {
    const denied = Object.assign(new Error('E_FS_DENIED: denied by policy'), { code: 'E_FS_DENIED' })
    const { ctx, writes } = ctxWith({ stats: { '/work/proj/secret.zip': denied } })
    const result = await save(ctx, 'secret.zip')
    expect(result.isError).toBe(true)
    expect(writes).toEqual([])
  })

  it.each([
    '/etc/passwd',
    '/work/proj/data/insects.zip',
    'C:/x.zip',
    '../outside.zip',
    'data/../../outside.zip',
    'data/./insects.zip',
    'data//insects.zip',
    'data/',
    'data\\insects.zip',
    'data/in\u0000sects.zip',
    'data/in\nsects.zip',
    'data/a:b.zip',
    `${'n'.repeat(256)}.zip`,
  ])('refuses %j as a target', async (saveTo) => {
    const { ctx, writes, asked } = ctxWith()
    const result = await save(ctx, saveTo)
    expect(result.isError).toBe(true)
    expect(writes).toEqual([])
    expect(asked).toEqual([])
  })

  it('refuses an attachment larger than 256 MiB and names the raw export', async () => {
    const huge = {
      name: 'big.zip',
      mimeType: 'application/zip',
      bytes: { byteLength: SAVE_TO_MAX_BYTES + 1 } as Uint8Array,
    }
    const { ctx, writes } = ctxWith({ original: huge })
    const result = await save(ctx, 'big.zip')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('agh export --raw')
    expect(writes).toEqual([])
    // The reader may refuse before reading a byte; that is reported the same way.
    const refused = ctxWith({
      original: () =>
        Promise.reject(
          Object.assign(new Error('E_ENVELOPE: too large'), {
            code: 'E_ENVELOPE',
            detail: { code: 'ATTACHMENT_TOO_LARGE' },
          }),
        ),
    })
    const early = await save(refused.ctx, 'big.zip')
    expect(early.isError).toBe(true)
    expect(textOf(early)).toContain('agh export --raw')
  })

  it('reports a missing or unreadable original without writing', async () => {
    const missing = ctxWith({ original: async () => undefined })
    expect(textOf(await save(missing.ctx, 'a.zip'))).toContain('not found')
    const corrupt = ctxWith({
      original: () =>
        Promise.reject(
          Object.assign(new Error('E_ENVELOPE: The stored attachment is corrupt'), { code: 'E_ENVELOPE' }),
        ),
    })
    const result = await save(corrupt.ctx, 'a.zip')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('corrupt')
    expect([...missing.writes, ...corrupt.writes]).toEqual([])
  })

  it('reports a failed write', async () => {
    const { ctx } = ctxWith({
      writeErrors: { 'a.zip': { code: 'EACCES', message: 'EACCES: permission denied' } },
    })
    const result = await save(ctx, 'a.zip')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('permission denied')
  })

  it('only copies session attachments', async () => {
    for (const path of [
      'notes.txt',
      `artifact://${'a'.repeat(64)}?size=3`,
      'session-file://list',
      'session-image://list',
    ]) {
      const { ctx, writes, asked } = ctxWith({ files: { 'notes.txt': 'hello' } })
      const result = await save(ctx, 'copy.txt', path)
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('session-file://')
      expect(writes).toEqual([])
      expect(asked).toEqual([])
    }
  })

  it('classifies a saving call as a write that is not replayed, and plain reads as before', () => {
    expect(checkToolDef(readTool).ok).toBe(true)
    expect(resolveToolCallPolicy(readTool, { path: 'a.txt' })).toMatchObject({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe',
      requiresApproval: 'never',
    })
    expect(resolveToolCallPolicy(readTool, { path: 'session-file://5/1', saveTo: 'a.zip' })).toMatchObject({
      isReadOnly: false,
      isDestructive: false,
      replay: 'never',
      requiresApproval: 'destructive',
    })
  })
})
