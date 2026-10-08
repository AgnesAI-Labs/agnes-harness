import { checkToolDef, type ToolResult } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { type FakeToolContextOpts, fakeToolContext } from '../../../testkit/tool-context.js'
import { fileChangeReceipt } from '../src/file-change.js'
import { withFileLock } from '../src/guards/mutation-queue.js'
import { MAX_OBSERVED_ENTRIES } from '../src/guards/observed.js'
import { createEditTool, editTool } from '../src/tools/edit.js'
import { MAX_READ_BYTES, readTool } from '../src/tools/read.js'
import { createWriteTool, writeTool } from '../src/tools/write.js'

// What a session has seen of a file is kept per session key for the life of the process, so every
// context a test builds is a session of its own unless the test says otherwise. Contexts built
// with one key are one session: that is what the kernel does with the calls of one conversation.
let sessions = 0
function ctxOf(opts: FakeToolContextOpts = {}) {
  return fakeToolContext({ sessionKey: `test-session-${sessions++}`, ...opts })
}

async function observedCtxOf(opts: FakeToolContextOpts = {}) {
  const ctx = ctxOf(opts)
  for (const path of ctx.mem.files.keys()) await readTool.execute({ path }, ctx)
  return ctx
}

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
    const ctx = await observedCtxOf()
    const r = await writeTool.execute({ path: 'n.txt', content: 'héllo' }, ctx)
    expect(dec.decode(ctx.mem.files.get('/work/proj/n.txt'))).toBe('héllo')
    expect(textOf(r)).toBe('created n.txt (5 chars)')
    // Bytes, not characters: the UI and the slots read `details`, and a two-byte character makes
    // the two numbers differ, which is the only way to tell which one was recorded.
    expect(r.details).toEqual({ path: 'n.txt', bytes: 6 })
  })

  it.each(['', 'x'.repeat(10)])('overwrites existing content %j and says overwrote', async (old) => {
    const ctx = await observedCtxOf({ files: { 'a.txt': old } })
    const r = await writeTool.execute({ path: 'a.txt', content: 'y'.repeat(10) }, ctx)
    expect(textOf(r)).toBe('overwrote a.txt (10 chars)')
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.txt'))).toBe('y'.repeat(10))
  })

  it('refuses a truncated overwrite and leaves the file alone', async () => {
    const ctx = await observedCtxOf({ files: { 'big.ts': 'x'.repeat(100) } })
    const r = await writeTool.execute({ path: 'big.ts', content: 'y'.repeat(10) }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('truncation guard')
    expect(dec.decode(ctx.mem.files.get('/work/proj/big.ts'))).toBe('x'.repeat(100))
  })

  it('refuses to empty a non-empty file', async () => {
    const ctx = await observedCtxOf({ files: { 'big.ts': 'x'.repeat(100) } })
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
      const ctx = await observedCtxOf({
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

describe('a file that is readable but not writable', () => {
  const message = 'E_FS_DENIED: /work/proj/state.yaml is denied by policy'
  const locked = () =>
    observedCtxOf({
      files: { 'state.yaml': 'name: a\n' },
      writeErrors: { 'state.yaml': { code: 'E_FS_DENIED', message } },
    })

  it('write names the refusal and leaves the file alone', async () => {
    const ctx = await locked()
    const result = await writeTool.execute({ path: 'state.yaml', content: 'name: b\n' }, ctx)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(`write failed before writing: ${message}`)
    expect(dec.decode(ctx.mem.files.get('/work/proj/state.yaml'))).toBe('name: a\n')
  })

  it('edit names the refusal and leaves the file alone', async () => {
    const ctx = await locked()
    const result = await editTool.execute(
      { path: 'state.yaml', edits: [{ oldText: 'name: a', newText: 'name: b' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(`edit failed: ${message}`)
    expect(dec.decode(ctx.mem.files.get('/work/proj/state.yaml'))).toBe('name: a\n')
  })

  it('still lets any other write failure propagate', async () => {
    const ctx = await observedCtxOf({
      files: { 'state.yaml': 'name: a\n' },
      writeErrors: { 'state.yaml': { code: 'EIO', message: 'EIO: disk' } },
    })
    await expect(writeTool.execute({ path: 'state.yaml', content: 'name: b\n' }, ctx)).rejects.toThrow('EIO')
    await expect(
      editTool.execute({ path: 'state.yaml', edits: [{ oldText: 'name: a', newText: 'name: b' }] }, ctx),
    ).rejects.toThrow('EIO')
  })
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
    const ctx = await observedCtxOf({ files: { 'a.ts': 'const a = 1\nconst b = 2\n' } })
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
  })

  it.each([
    ['x x', 'x'],
    ['aaa', 'aa'],
  ])('rejects missing or ambiguous oldText in %j without writing', async (original, oldText) => {
    const ctx = await observedCtxOf({ files: { 'a.ts': original } })
    const missing = await editTool.execute({ path: 'a.ts', edits: [{ oldText: 'zzz', newText: '' }] }, ctx)
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('not found')
    const ambiguous = await editTool.execute({ path: 'a.ts', edits: [{ oldText, newText: 'y' }] }, ctx)
    expect(ambiguous.isError).toBe(true)
    expect(textOf(ambiguous)).toContain('ambiguous (2 matches)')
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.ts'))).toBe(original)
  })

  it('replaces the match literally, not as a replacement pattern', async () => {
    // String.replace expands `$&` and friends in the replacement, so a newText carrying one would
    // otherwise write text that appears nowhere in the model's request.
    const ctx = await observedCtxOf({ files: { 'a.ts': 'const a = 1\n' } })
    await editTool.execute({ path: 'a.ts', edits: [{ oldText: 'a = 1', newText: 'a = "$&"' }] }, ctx)
    expect(dec.decode(ctx.mem.files.get('/work/proj/a.ts'))).toBe('const a = "$&"\n')
  })

  it('reports a read failure instead of writing', async () => {
    const ctx = await observedCtxOf()
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
    const ctx = await observedCtxOf({ files: { 'b.bin': bytes } })
    const r = await editTool.execute({ path: 'b.bin', edits: [{ oldText: 'a', newText: 'z' }] }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(error)
    expect([...(ctx.mem.files.get('/work/proj/b.bin') as Uint8Array)]).toEqual([...bytes])
  })

  it('preserves a UTF-8 BOM and counts its bytes in the result', async () => {
    const ctx = await observedCtxOf({ files: { 'a.txt': new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]) } })
    const r = await editTool.execute({ path: 'a.txt', edits: [{ oldText: 'a', newText: 'z' }] }, ctx)
    expect(r.isError).toBeUndefined()
    expect([...(ctx.mem.files.get('/work/proj/a.txt') as Uint8Array)]).toEqual([0xef, 0xbb, 0xbf, 0x7a, 0x62])
    expect(r.details).toEqual({ path: 'a.txt', bytes: 5 })
  })

  it('refuses an edit that truncates the file', async () => {
    const ctx = await observedCtxOf({ files: { 'a.ts': `${'x'.repeat(100)}DROP` } })
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
    const ctx = await observedCtxOf({ files: { 'race.txt': 'x'.repeat(100) } })
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

const A = '/work/proj/shared.txt'

// Two sessions on one workspace: one memory filesystem, two session keys.
function twoSessions(content: string) {
  const a = ctxOf({ files: { 'shared.txt': content } })
  const b = ctxOf({ mem: a.mem })
  return { a, b }
}
const put = (ctx: ReturnType<typeof ctxOf>, text: string) =>
  ctx.mem.files.set(A, new TextEncoder().encode(text))
const onDisk = (ctx: ReturnType<typeof ctxOf>) => dec.decode(ctx.mem.files.get(A))
const read = (ctx: ReturnType<typeof ctxOf>) => readTool.execute({ path: 'shared.txt' }, ctx)
const overwrite = (ctx: ReturnType<typeof ctxOf>, content: string) =>
  writeTool.execute({ path: 'shared.txt', content }, ctx)

describe('write refuses to replace a file that changed after it was read', () => {
  const base = 'line one\nline two\nline three\n'

  it('refuses, names the cause and the way out, and leaves the other writer’s content', async () => {
    const { a, b } = twoSessions(base)
    await read(a)
    // Another session changes the file between a's read and a's write.
    await read(b)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }, b)
    const r = await overwrite(a, 'line one\nline two\nline THREE\n')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('write refused (stale read)')
    expect(textOf(r)).toContain('shared.txt changed after you last read it')
    expect(textOf(r)).toContain('Read the file again')
    expect(textOf(r)).toContain('use edit')
    expect(r.details).toEqual({ code: 'FS_STALE_VERSION', path: 'shared.txt' })
    expect(onDisk(a)).toBe('line one\nline TWO\nline three\n')
  })

  it('lets the write through once the file is read again, and the merged content lands', async () => {
    const { a, b } = twoSessions(base)
    await read(a)
    await read(b)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }, b)
    expect((await overwrite(a, 'x'.repeat(base.length))).isError).toBe(true)
    await read(a)
    const merged = 'line one\nline TWO\nline THREE\n'
    expect((await overwrite(a, merged)).isError).toBeUndefined()
    expect(onDisk(a)).toBe(merged)
  })

  it('does not count the refusal as having seen the file', async () => {
    const { a } = twoSessions(base)
    await read(a)
    put(a, 'changed outside\n'.repeat(3))
    expect((await overwrite(a, 'first try, same size as it was\n')).isError).toBe(true)
    // Trying the same thing again is refused again; only reading moves the version forward.
    expect((await overwrite(a, 'second try, same size as it was\n')).isError).toBe(true)
  })

  it('refuses after a shell command changed the file, which no tool call recorded', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': base } })
    await read(ctx)
    put(ctx, 'line one\nline two\nline three\nappended by sed\n')
    expect((await overwrite(ctx, 'rewritten from the old view\n')).isError).toBe(true)
  })

  it('compares the version, not the time: a rewrite that keeps size and time is still caught', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': 'aaaa\n' } })
    await read(ctx)
    put(ctx, 'bbbb\n')
    expect((await overwrite(ctx, 'cccc\n')).isError).toBe(true)
  })

  it('ignores a modification time that moved while the content did not', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': base } })
    await read(ctx)
    ctx.mem.mtimes.set(A, 99_999)
    expect((await overwrite(ctx, 'line one\nline two\nline four\n')).isError).toBeUndefined()
  })

  it('treats two spellings of one path as one file', async () => {
    const { a, b } = twoSessions(base)
    await readTool.execute({ path: '/work/proj/shared.txt' }, a)
    put(b, 'someone else\n')
    const r = await writeTool.execute({ path: './sub/../shared.txt', content: 'mine\n' }, a)
    expect(textOf(r)).toContain('stale read')
  })

  it('checks staleness before the truncation guard, which is the less specific reason', async () => {
    const { a, b } = twoSessions('x'.repeat(100))
    await read(a)
    put(b, 'y'.repeat(100))
    expect(textOf(await overwrite(a, 'z'))).toContain('stale read')
  })

  it('refuses a file that was read and then deleted, and read of the missing file clears the way', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': base } })
    await read(ctx)
    ctx.mem.files.delete(A)
    expect(textOf(await overwrite(ctx, 'new\n'))).toContain('stale read')
    // The model re-reads as the message says, finds the file gone, and may then create it: a
    // refusal that read could never clear would be a dead end.
    expect((await read(ctx)).isError).toBe(true)
    expect((await overwrite(ctx, 'new\n')).isError).toBeUndefined()
    expect(onDisk(ctx)).toBe('new\n')
  })

  it('does not call a file with a byte that is not UTF-8 changed because of how a read returns it', async () => {
    // The real file adapter returns a windowed read as decoded and re-encoded text, so U+FFFD stands
    // where the byte was, while the plain read inside write returns the byte itself. Hashed as each
    // arrives the file would differ from itself and every write would be refused.
    const raw = new Uint8Array([0x61, 0xe9, 0x62, 0x0a])
    const ctx = ctxOf({ files: { 'shared.txt': raw } })
    const plain = ctx.fs.read
    ctx.fs.read = async (p, o) => {
      const bytes = await plain(p, o)
      return o === undefined ? bytes : new TextEncoder().encode(new TextDecoder().decode(bytes))
    }
    expect((await read(ctx)).isError).toBeUndefined()
    expect((await overwrite(ctx, 'ab\n\n')).isError).toBeUndefined()
  })
})

describe('write leaves alone what the session has not seen', () => {
  it('refuses an existing file that was never read', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': 'old\n' } })
    expect((await overwrite(ctx, 'new\n')).details).toEqual({ code: 'FS_NOT_OBSERVED', path: 'shared.txt' })
    expect(onDisk(ctx)).toBe('old\n')
  })

  it('does not take another session’s read as its own', async () => {
    const { a, b } = twoSessions('old\n')
    await read(a)
    put(a, 'changed\n')
    // b never looked at the file; only a's view is out of date.
    expect((await overwrite(b, 'by b\n')).details).toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('creates a file that does not exist without a check', async () => {
    const ctx = ctxOf()
    expect((await overwrite(ctx, 'fresh\n')).isError).toBeUndefined()
  })

  it('does not record what read could not show: a binary file, a missing file or a stored output', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': new Uint8Array([0x61, 0x00, 0x62]) } })
    expect((await read(ctx)).isError).toBe(true)
    put(ctx, 'text now\n')
    expect((await overwrite(ctx, 'mine\n')).details).toMatchObject({ code: 'FS_NOT_OBSERVED' })
    const other = ctxOf({ files: { 'shared.txt': 'old\n' } })
    expect((await readTool.execute({ path: `artifact://${'0'.repeat(64)}?size=3` }, other)).isError).toBe(
      true,
    )
    put(other, 'changed\n')
    expect((await overwrite(other, 'mine\n')).details).toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('keeps a file that was read again recently over files read since it was first read', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': 'old\n' } })
    await read(ctx)
    for (let i = 0; i < MAX_OBSERVED_ENTRIES - 2; i++) {
      ctx.mem.files.set(`/work/proj/g${i}`, new TextEncoder().encode('x'))
      await readTool.execute({ path: `g${i}` }, ctx)
    }
    await read(ctx) // the most recent record now, though the first one made
    for (let i = 0; i < 10; i++) {
      ctx.mem.files.set(`/work/proj/h${i}`, new TextEncoder().encode('x'))
      await readTool.execute({ path: `h${i}` }, ctx)
    }
    put(ctx, 'changed\n')
    expect(textOf(await overwrite(ctx, 'mine\n'))).toContain('stale read')
  })

  it('forgets the oldest files first when the table is full', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': 'old\n' } })
    await read(ctx)
    // Each of these files is read once; the table keeps the most recent MAX_OBSERVED_ENTRIES, and
    // shared.txt is the oldest of them all.
    for (let i = 0; i < MAX_OBSERVED_ENTRIES; i++) {
      ctx.mem.files.set(`/work/proj/f${i}`, new TextEncoder().encode('x'))
      await readTool.execute({ path: `f${i}` }, ctx)
    }
    put(ctx, 'changed\n')
    expect((await overwrite(ctx, 'mine\n')).details).toMatchObject({ code: 'FS_NOT_OBSERVED' })
    // A file inside the window is still held.
    put(ctx, 'last\n')
    await read(ctx)
    put(ctx, 'moved\n')
    expect((await overwrite(ctx, 'mine again\n')).isError).toBe(true)
  })
})

describe('what a session writes itself is what it has seen', () => {
  it('lets one session write twice in a row', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': 'one\n' } })
    await read(ctx)
    expect((await overwrite(ctx, 'two\n')).isError).toBeUndefined()
    expect((await overwrite(ctx, 'three\n')).isError).toBeUndefined()
    expect(onDisk(ctx)).toBe('three\n')
  })

  it('lets a session write after its own edit', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': 'one\ntwo\n' } })
    await read(ctx)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'one', newText: 'ONE' }] }, ctx)
    expect((await overwrite(ctx, 'ONE\ntwo\nthree\n')).isError).toBeUndefined()
  })

  it('refuses an unobserved edit, then observes edits after a read', async () => {
    const { a, b } = twoSessions('one\ntwo\n')
    expect(
      (await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'one', newText: 'ONE' }] }, a))
        .details,
    ).toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await read(a)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'one', newText: 'ONE' }] }, a)
    await read(b)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }, b)
    expect(textOf(await overwrite(a, 'ONE\nthree\n'))).toContain('stale read')
  })

  it('records the file it created, so it notices when someone else changes it', async () => {
    const { a, b } = twoSessions('')
    a.mem.files.delete(A)
    expect((await overwrite(a, 'mine\n')).isError).toBeUndefined()
    put(b, 'theirs\n')
    expect(textOf(await overwrite(a, 'mine again\n'))).toContain('stale read')
  })
})

describe('observed edit matches current content', () => {
  it('applies to a file that changed since it was read, because its own match is the check', async () => {
    const { a, b } = twoSessions('one\ntwo\nthree\n')
    await read(a)
    await read(b)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'one', newText: 'ONE' }] }, b)
    const r = await editTool.execute(
      { path: 'shared.txt', edits: [{ oldText: 'three', newText: 'THREE' }] },
      a,
    )
    expect(r.isError).toBeUndefined()
    expect(onDisk(a)).toBe('ONE\ntwo\nTHREE\n')
  })

  it('still reports a missing oldText as before, without any staleness wording', async () => {
    const { a, b } = twoSessions('one\ntwo\n')
    await read(a)
    await read(b)
    await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }, b)
    const r = await editTool.execute({ path: 'shared.txt', edits: [{ oldText: 'two', newText: '2' }] }, a)
    expect(textOf(r)).toBe('edit 1: oldText not found')
  })

  it('lets two sessions make 25 edits each to one file, every one of them landing', async () => {
    // Each success moves the other session's recorded version, so a check on edit would turn this
    // into a pile of refusals. Edits match on content, and none of these overlap.
    const lines = Array.from({ length: 50 }, (_, i) => `L${String(i).padStart(2, '0')} base\n`).join('')
    const { a, b } = twoSessions(lines)
    await read(a)
    await read(b)
    const run = (ctx: ReturnType<typeof ctxOf>, who: string, parity: number) =>
      Promise.all(
        Array.from({ length: 25 }, (_, k) => {
          const n = String(k * 2 + parity).padStart(2, '0')
          return editTool.execute(
            { path: 'shared.txt', edits: [{ oldText: `L${n} base`, newText: `L${n} ${who}` }] },
            ctx,
          )
        }),
      )
    const results = [...(await run(a, 'A', 0)), ...(await run(b, 'B', 1))]
    expect(results.filter((r) => r.isError)).toEqual([])
    const final = onDisk(a).split('\n')
    expect(final.filter((l) => l.endsWith(' A'))).toHaveLength(25)
    expect(final.filter((l) => l.endsWith(' B'))).toHaveLength(25)
  })
})

describe('a file longer than read returns in full', () => {
  const big = (ch: string) => new TextEncoder().encode(`${ch.repeat(MAX_READ_BYTES)}\nend\n`)

  it('is compared by size and modification time, which the file system reports', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    ctx.mem.mtimes.set(A, 1000)
    await read(ctx)
    // Same bytes, same time: nothing changed.
    expect((await overwrite(ctx, 'a'.repeat(MAX_READ_BYTES))).isError).toBeUndefined()
  })

  it('refuses when the time moved', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    ctx.mem.mtimes.set(A, 1000)
    await read(ctx)
    ctx.mem.mtimes.set(A, 2000)
    expect(textOf(await overwrite(ctx, 'z'))).toContain('stale read')
  })

  it('refuses when the size moved and the time did not', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    ctx.mem.mtimes.set(A, 1000)
    await read(ctx)
    ctx.mem.files.set(A, new TextEncoder().encode(`${'a'.repeat(MAX_READ_BYTES)}\nend of the file\n`))
    expect(textOf(await overwrite(ctx, 'z'))).toContain('stale read')
  })

  it('refuses when a large file was read and has since shrunk below the limit', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    await read(ctx)
    put(ctx, 'small now\n')
    expect(textOf(await overwrite(ctx, 'z'))).toContain('stale read')
  })

  it('does not refuse when the file system cannot give a version at the time of the read', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    ctx.fs.stat = () => Promise.reject(new Error('EIO'))
    await read(ctx)
    put(ctx, 'changed\n'.repeat(MAX_READ_BYTES / 4))
    expect((await overwrite(ctx, 'z'.repeat(MAX_READ_BYTES))).isError).toBeUndefined()
  })

  it('does not refuse when the file system cannot give a version at the time of the write', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    await read(ctx)
    ctx.fs.stat = () => Promise.reject(new Error('EIO'))
    expect((await overwrite(ctx, 'z'.repeat(MAX_READ_BYTES))).isError).toBeUndefined()
  })

  it('does not refuse a name that is a symlink, whose stat describes the link', async () => {
    const ctx = ctxOf({ files: { 'shared.txt': big('a') } })
    ctx.fs.stat = async () => ({ kind: 'symlink', size: 9, mtimeMs: 1 })
    await read(ctx)
    ctx.fs.stat = async () => ({ kind: 'symlink', size: 9, mtimeMs: 2 })
    ctx.mem.files.set(A, big('b'))
    expect((await overwrite(ctx, 'b'.repeat(MAX_READ_BYTES))).isError).toBeUndefined()
  })
})

describe('successful file review receipts', () => {
  it('records confirmed write/edit bytes and keeps completed writes successful if recording fails', async () => {
    const ctx = await observedCtxOf()
    const receipts: unknown[] = []
    const record: Parameters<typeof createWriteTool>[0] = async (input, context) => {
      receipts.push(fileChangeReceipt(input, context))
    }
    const path = 'new\nfile.ts'
    expect((await createWriteTool(record).execute({ path, content: 'one\n' }, ctx)).isError).not.toBe(true)
    expect(
      (await createEditTool(record).execute({ path, edits: [{ oldText: 'one', newText: 'two' }] }, ctx))
        .isError,
    ).not.toBe(true)
    expect(receipts).toMatchObject([
      {
        path,
        operation: 'write',
        existed: false,
        before: '',
        after: 'one\n',
        turn: 1,
        toolUseId: ctx.session.toolUseId,
      },
      { path, operation: 'edit', existed: true, before: 'one\n', after: 'two\n' },
    ])
    const failedRecord = async () => {
      throw new Error('Event quota exceeded')
    }
    const result = await createWriteTool(failedRecord).execute(
      { path: 'another', content: 'confirmed write' },
      ctx,
    )
    expect(result.isError).not.toBe(true)
    expect(dec.decode(ctx.mem.files.get('/work/proj/another'))).toBe('confirmed write')
  })
  it('does not record refusal and caps binary, oversized or escaped JSON content', async () => {
    const recorder = vi.fn(async () => {})
    const ctx = await observedCtxOf({
      files: { locked: 'one\n' },
      writeErrors: { locked: { code: 'E_FS_DENIED', message: 'denied' } },
    })
    expect((await createWriteTool(recorder).execute({ path: 'locked', content: 'two\n' }, ctx)).isError).toBe(
      true,
    )
    expect(
      (
        await createEditTool(recorder).execute(
          { path: 'locked', edits: [{ oldText: 'one', newText: 'two' }] },
          ctx,
        )
      ).isError,
    ).toBe(true)
    expect(recorder).not.toHaveBeenCalled()
    const input = {
      path: 'a',
      operation: 'write' as const,
      existed: false,
      before: new Uint8Array(),
      after: new TextEncoder().encode('text'),
    }
    expect(fileChangeReceipt({ ...input, path: '../outside' }, ctx)).toBeUndefined()
    for (const [text, status] of [
      ['\0', 'binary'],
      ['x'.repeat(16385), 'too-large'],
      ['\x01'.repeat(16000), 'too-large'],
    ]) {
      const value = fileChangeReceipt({ ...input, after: new TextEncoder().encode(text) }, ctx)
      expect(value).toMatchObject({ status })
      expect(value).not.toHaveProperty('after')
      expect(value).not.toHaveProperty('before')
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(60000)
    }
  })
})
