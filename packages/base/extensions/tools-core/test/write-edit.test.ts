import { createHash } from 'node:crypto'
import { checkToolDef, type ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { withFileLock } from '../src/guards/mutation-queue.js'
import { editTool } from '../src/tools/edit.js'
import { writeTool } from '../src/tools/write.js'

const dec = new TextDecoder()
function textOf(r: ToolResult): string {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(first)
}

describe('write', () => {
  it('has a complete definition', () => {
    expect(checkToolDef(writeTool)).toEqual({ ok: true })
    expect(writeTool.meta).toMatchObject({
      isDestructive: true,
      replay: 'idempotent',
      requiresApproval: 'destructive',
    })
  })

  it('creates a file and says so, with the byte count in details', async () => {
    const ctx = fakeToolContext()
    const r = await writeTool.execute({ path: 'n.txt', content: 'héllo' }, ctx)
    expect(dec.decode(ctx.mem.files.get('/work/proj/n.txt'))).toBe('héllo')
    expect(textOf(r)).toBe('created n.txt (5 chars)')
    // Bytes, not characters: the UI and the slots read `details`, and a two-byte character makes
    // the two numbers differ, which is the only way to tell which one was recorded.
    expect(r.details).toEqual({ path: 'n.txt', bytes: 6 })
    expect(r.structured).toEqual({
      codec: 'agnes-host-tool-fact-v1',
      tool: 'write',
      target: { kind: 'file', path: '/work/proj/n.txt' },
      write: {
        acknowledged: true,
        versionSource: 'submitted-utf8-bytes-sha256',
        size: 6,
        digest: createHash('sha256')
          .update(ctx.mem.files.get('/work/proj/n.txt') ?? new Uint8Array())
          .digest('hex'),
      },
    })
  })

  it.each(['', 'x'.repeat(10)])('overwrites existing content %j and says overwrote', async (old) => {
    const ctx = fakeToolContext({ files: { 'a.txt': old } })
    const r = await writeTool.execute({ path: 'a.txt', content: 'y'.repeat(10) }, ctx)
    expect(textOf(r)).toBe('overwrote a.txt (10 chars)')
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.txt'))).toBe('y'.repeat(10))
  })

  it('refuses a truncated overwrite and leaves the file alone', async () => {
    const ctx = fakeToolContext({ files: { 'big.ts': 'x'.repeat(100) } })
    const r = await writeTool.execute({ path: 'big.ts', content: 'y'.repeat(10) }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('truncation guard')
    expect(r.structured).toBeUndefined()
    expect(dec.decode(ctx.mem.files.get('/work/proj/big.ts'))).toBe('x'.repeat(100))
  })

  it('refuses to empty a non-empty file', async () => {
    const ctx = fakeToolContext({ files: { 'big.ts': 'x'.repeat(100) } })
    const r = await writeTool.execute({ path: 'big.ts', content: '' }, ctx)
    expect(r.isError).toBe(true)
    expect(dec.decode(ctx.mem.files.get('/work/proj/big.ts'))).toBe('x'.repeat(100))
  })

  it.each([
    ['EACCES', 'EACCES: permission denied'],
    ['E_FS_DENIED', 'E_FS_DENIED: /locked.ts is outside every allow rule'],
  ])(
    'reports %s before writing and does not mistake an unreadable file for a new one',
    async (code, message) => {
      // Only "the file is not there" may be read as a new file. A permission error, a directory, or
      // a sandbox refusal arriving as "no previous content" would switch the truncation guard off on
      // exactly the reads that failed for a reason, and the overwrite would go ahead unchecked. This
      // is a branch a memory filesystem never produces on its own, which is why it needs a fixture.
      const ctx = fakeToolContext({
        files: { 'locked.ts': 'x'.repeat(100) },
        readErrors: { 'locked.ts': { code, message } },
      })
      const result = await writeTool.execute({ path: 'locked.ts', content: 'y' }, ctx)
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe(`write failed before writing: ${message}`)
      expect(dec.decode(ctx.mem.files.get('/work/proj/locked.ts'))).toBe('x'.repeat(100))
    },
  )
})

describe('edit', () => {
  it('has a complete definition', () => {
    expect(checkToolDef(editTool)).toEqual({ ok: true })
    expect(editTool.meta).toMatchObject({
      isDestructive: true,
      replay: 'idempotent',
      requiresApproval: 'destructive',
    })
  })

  it('applies unique edits in order and reports the line delta', async () => {
    const ctx = fakeToolContext({ files: { 'a.ts': 'const a = 1\nconst b = 2\n' } })
    const r = await editTool.execute(
      {
        path: 'a.ts',
        edits: [
          { oldText: 'a = 1', newText: 'a = 10' },
          { oldText: 'b = 2', newText: 'b = 20\nconst c = 30' },
        ],
      },
      ctx,
    )
    expect(r.isError).toBeUndefined()
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.ts'))).toBe(
      'const a = 10\nconst b = 20\nconst c = 30\n',
    )
    expect(textOf(r)).toBe('applied 2 edit(s) to a.ts (+1 lines)')
    expect(r.details).toEqual({ path: 'a.ts', bytes: 39 })
    expect(r.structured).toMatchObject({
      codec: 'agnes-host-tool-fact-v1',
      tool: 'edit',
      target: { kind: 'file', path: '/work/proj/a.ts' },
      write: {
        acknowledged: true,
        versionSource: 'submitted-utf8-bytes-sha256',
        size: 39,
        digest: createHash('sha256')
          .update(ctx.mem.files.get('/work/proj/a.ts') ?? new Uint8Array())
          .digest('hex'),
      },
    })
  })

  it.each([
    ['x x', 'x'],
    ['aaa', 'aa'],
  ])('rejects missing or ambiguous oldText in %j without writing', async (original, oldText) => {
    const ctx = fakeToolContext({ files: { 'a.ts': original } })
    const missing = await editTool.execute({ path: 'a.ts', edits: [{ oldText: 'zzz', newText: '' }] }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.structured).toBeUndefined()
    expect(textOf(missing)).toContain('not found')
    const ambiguous = await editTool.execute({ path: 'a.ts', edits: [{ oldText, newText: 'y' }] }, ctx)
    expect(ambiguous.isError).toBe(true)
    expect(textOf(ambiguous)).toContain('ambiguous (2 matches)')
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.ts'))).toBe(original)
  })

  it('replaces the match literally, not as a replacement pattern', async () => {
    // String.replace expands `$&` and friends in the replacement, so a newText carrying one would
    // otherwise write text that appears nowhere in the model's request.
    const ctx = fakeToolContext({ files: { 'a.ts': 'const a = 1\n' } })
    await editTool.execute({ path: 'a.ts', edits: [{ oldText: 'a = 1', newText: 'a = "$&"' }] }, ctx)
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.ts'))).toBe('const a = "$&"\n')
  })

  it('reports a read failure instead of writing', async () => {
    const ctx = fakeToolContext()
    const r = await editTool.execute({ path: 'nope.ts', edits: [{ oldText: 'a', newText: 'b' }] }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('edit failed')
    expect(ctx.mem.files.has('/work/proj/nope.ts')).toBe(false)
  })

  it.each([
    [new Uint8Array([0x61, 0x00, 0xff, 0x62]), 'binary'],
    [new Uint8Array([0x61, 0xff, 0x62]), 'UTF-8'],
    [new Uint8Array([0x61, 0xc3]), 'UTF-8'],
  ])('refuses non-text bytes %j without writing', async (bytes, error) => {
    // Decoding bytes that are not text and writing the decoded form back replaces every byte that
    // is not valid UTF-8 with a replacement character, which corrupts the file silently.
    const ctx = fakeToolContext({ files: { 'b.bin': bytes } })
    const r = await editTool.execute({ path: 'b.bin', edits: [{ oldText: 'a', newText: 'z' }] }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(error)
    expect([...(ctx.mem.files.get('/work/proj/b.bin') as Uint8Array)]).toEqual([...bytes])
  })

  it('preserves a UTF-8 BOM and counts its bytes in the result', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]) } })
    const r = await editTool.execute({ path: 'a.txt', edits: [{ oldText: 'a', newText: 'z' }] }, ctx)
    expect(r.isError).toBeUndefined()
    expect([...(ctx.mem.files.get('/work/proj/a.txt') as Uint8Array)]).toEqual([0xef, 0xbb, 0xbf, 0x7a, 0x62])
    expect(r.details).toEqual({ path: 'a.txt', bytes: 5 })
  })

  it('refuses an edit that truncates the file', async () => {
    const ctx = fakeToolContext({ files: { 'a.ts': `${'x'.repeat(100)}DROP` } })
    const r = await editTool.execute(
      { path: 'a.ts', edits: [{ oldText: 'x'.repeat(100), newText: '' }] },
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('truncation guard')
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.ts'))).toBe(`${'x'.repeat(100)}DROP`)
  })
})

describe('withFileLock', () => {
  it('serializes writers per path and lets other paths run in parallel', async () => {
    const order: string[] = []
    await Promise.all([
      withFileLock('/p', async () => {
        await new Promise((r) => setTimeout(r, 20))
        order.push('a')
      }),
      withFileLock('/p', async () => {
        order.push('b')
      }),
      withFileLock('/q', async () => {
        order.push('c')
      }),
    ])
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order).toContain('c')
  })

  it('keeps the queue running after a writer fails, without an unhandled rejection', async () => {
    // The chain has to be cleaned up whatever the writer did. A cleanup hooked onto the raw
    // promise creates a second rejection nobody awaits, which crashes the process on a failure the
    // caller already handled.
    const seen: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      seen.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(withFileLock('/r', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
      await new Promise((r) => setTimeout(r, 20))
      await expect(withFileLock('/r', async () => 'after')).resolves.toBe('after')
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(seen).toEqual([])
  })
})

describe('the mutation queue keys on the file, not on the spelling', () => {
  it('puts two spellings of one path on the same chain', async () => {
    // `a.ts` and `/work/proj/a.ts` are one file. Keyed on the raw argument they took two different
    // locks, so two writers to the same file ran at once and the last one to finish won.
    const ctx = fakeToolContext({ files: { 'race.txt': 'x'.repeat(100) } })
    const [first, second] = await Promise.all([
      writeTool.execute({ path: 'race.txt', content: 'A'.repeat(1000) }, ctx),
      writeTool.execute({ path: '/work/proj/race.txt', content: 'B'.repeat(100) }, ctx),
    ])
    // Serialized, the second writer reads what the first wrote and the truncation guard sees a
    // ninety-percent shrink. On two chains both writers read the original hundred characters, the
    // guard is satisfied, and whichever finishes last silently wins.
    expect(first.isError).toBeUndefined()
    expect(second.isError).toBe(true)
    expect(dec.decode(ctx.mem.files.get('/work/proj/race.txt'))).toBe('A'.repeat(1000))
  })
})
