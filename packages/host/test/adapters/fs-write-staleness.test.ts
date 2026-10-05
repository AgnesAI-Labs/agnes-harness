import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOLS_CORE } from '@agnes/base'
import { fakeToolContext } from '@agnes/base/testkit'
import { testFsPolicy } from '@agnes/core/testkit'
import type { ToolContext, ToolDef, ToolResult } from '@agnes/extension-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFs } from '../../src/adapters/fs.js'

// The tools-core unit tests run against a memory file system, whose read returns the stored bytes
// whatever it is asked. The real adapter answers a windowed read (the one `read` makes) with the
// text decoded and re-encoded, so the bytes `read` sees and the bytes `write` sees can differ for
// the same file. These cases run the real tools on the real adapter, because the version of a file
// has to come out the same on both sides for the check to be right about it.

const tool = (name: string): ToolDef => {
  const t = TOOLS_CORE.find((x) => x.name === name)
  if (!t) throw new Error(`no ${name} tool`)
  return t
}
const text = (r: ToolResult): string => {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : ''
}

describe('write staleness on the real file system adapter', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-stale-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  let sessions = 0
  // One session: a key held across calls, over the real adapter.
  const session = (): ToolContext => {
    const fs = createFs(() => ({ policy: testFsPolicy(root), caseSensitive: true }))
    const ctx = fakeToolContext({ cwd: root, sessionKey: `real-fs-${sessions++}` })
    return Object.assign(ctx, { fs })
  }
  const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) =>
    tool(name).execute(args as never, ctx)

  it.each([
    ['a byte that is not UTF-8', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])],
    ['a byte order mark', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x0a])],
    ['CRLF line endings', Buffer.from('one\r\ntwo\r\n')],
    ['text with no final newline', Buffer.from('one\ntwo')],
  ])('does not call a file with %s changed when only it was read', async (_label, bytes) => {
    const path = join(root, 'f.txt')
    writeFileSync(path, bytes)
    const ctx = session()
    expect((await run('read', { path: 'f.txt' }, ctx)).isError).toBeUndefined()
    expect(text(await run('write', { path: 'f.txt', content: 'rewritten\n'.repeat(3) }, ctx))).toMatch(
      /^overwrote/,
    )
    expect(readFileSync(path, 'utf8')).toBe('rewritten\n'.repeat(3))
  })

  it('refuses after another writer changed the file, and accepts once it is read again', async () => {
    const path = join(root, 'f.txt')
    writeFileSync(path, 'one\ntwo\nthree\n')
    const ctx = session()
    await run('read', { path: 'f.txt' }, ctx)
    const other = session()
    await run('edit', { path: 'f.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }, other)
    const refused = await run('write', { path: 'f.txt', content: 'one\ntwo\nTHREE\n' }, ctx)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('write refused (stale read)')
    expect(readFileSync(path, 'utf8')).toBe('one\nTWO\nthree\n')
    await run('read', { path: 'f.txt' }, ctx)
    expect((await run('write', { path: 'f.txt', content: 'one\nTWO\nTHREE\n' }, ctx)).isError).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('one\nTWO\nTHREE\n')
  })

  it('refuses after a shell command rewrote the file, which no tool call recorded', async () => {
    const path = join(root, 'f.txt')
    writeFileSync(path, 'one\ntwo\n')
    const ctx = session()
    await run('read', { path: 'f.txt' }, ctx)
    writeFileSync(path, 'one\ntwo\nappended\n')
    expect(text(await run('write', { path: 'f.txt', content: 'one\ntwo\nx\n' }, ctx))).toContain('stale read')
  })

  it('lets a session write a file it created and then write it again', async () => {
    const ctx = session()
    expect(text(await run('write', { path: 'n.txt', content: 'first\n' }, ctx))).toMatch(/^created/)
    expect(text(await run('write', { path: 'n.txt', content: 'second\n' }, ctx))).toMatch(/^overwrote/)
  })
})
