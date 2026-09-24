import { checkToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { byteLength, OUTPUT_LIMITS } from '../src/guards/output.js'
import { MAX_READ_BYTES, readTool } from '../src/tools/read.js'

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

describe('read', () => {
  it('has a complete definition', () => {
    expect(checkToolDef(readTool)).toEqual({ ok: true })
    expect(readTool.name).toBe('read')
  })

  it('declares itself read-only, replay-safe and never in need of approval', () => {
    expect(readTool.meta).toEqual({
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: {},
      deferLoading: false,
      requiresApproval: 'never',
    })
  })

  it('returns numbered lines and honours offset/limit', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': 'l1\nl2\nl3\nl4' } })
    const all = await readTool.execute({ path: 'a.txt' }, ctx)
    expect(all.content[0]).toEqual({ type: 'text', text: '1\tl1\n2\tl2\n3\tl3\n4\tl4' })
    const part = await readTool.execute({ path: 'a.txt', offset: 2, limit: 2 }, ctx)
    expect(part.content[0]).toEqual({ type: 'text', text: '2\tl2\n3\tl3' })
  })

  it('treats a trailing newline as ending the last line, not starting an empty one', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': 'l1\nl2\n', 'b.txt': 'l1\nl2\n\n' } })
    expect(textOf(await readTool.execute({ path: 'a.txt' }, ctx))).toBe('1\tl1\n2\tl2')
    // A genuinely blank final line is still shown; only the terminator is dropped.
    expect(textOf(await readTool.execute({ path: 'b.txt' }, ctx))).toBe('1\tl1\n2\tl2\n3\t')
  })

  it('keeps carriage returns instead of guessing at line endings', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': 'l1\r\nl2\r\n' } })
    expect(textOf(await readTool.execute({ path: 'a.txt' }, ctx))).toBe('1\tl1\r\n2\tl2\r')
  })

  it('reports a range past the end of the file instead of returning nothing', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': 'l1\nl2' } })
    const r = await readTool.execute({ path: 'a.txt', offset: 9 }, ctx)
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('[no lines at offset 9; the file has 2 lines]')
  })

  it('reports missing file and binary file as errors', async () => {
    const ctx = fakeToolContext({ files: { 'b.bin': 'ab\u0000cd' } })
    const missing = await readTool.execute({ path: 'nope' }, ctx)
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('ENOENT')
    const bin = await readTool.execute({ path: 'b.bin' }, ctx)
    expect(bin.isError).toBe(true)
    expect(bin.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('binary') })
    expect(textOf(bin)).toContain('5 bytes')
  })

  it('scans only the first 8 KB for the NUL that marks a binary file', async () => {
    // The bound is what keeps the check cheap on a large file. It is pinned rather than left
    // implicit: a NUL past it is not detected, and that is a known consequence, not an accident.
    const ctx = fakeToolContext({
      files: { 'late.bin': `${'a'.repeat(8192)}\u0000`, 'early.bin': `${'a'.repeat(8191)}\u0000` },
    })
    expect((await readTool.execute({ path: 'late.bin' }, ctx)).isError).toBeUndefined()
    expect((await readTool.execute({ path: 'early.bin' }, ctx)).isError).toBe(true)
  })

  it('hands the filesystem the path it was given, unchanged', async () => {
    // Rewriting the path here would mean the layer that enforces the workspace boundary checks one
    // string while the tool opens another.
    const ctx = fakeToolContext({ files: { '/work/proj/a.txt': 'x' } })
    await readTool.execute({ path: './a.txt' }, ctx)
    expect(ctx.calls.read[0]?.path).toBe('./a.txt')
  })

  it('bounds how many bytes it pulls off the filesystem', async () => {
    const ctx = fakeToolContext({ files: { 'big.txt': 'a'.repeat(MAX_READ_BYTES + 100) } })
    const r = await readTool.execute({ path: 'big.txt' }, ctx)
    // The read itself is capped, so neither the process nor the artifact store sees the whole file.
    expect(ctx.calls.read[0]?.opts?.limit).toBe(MAX_READ_BYTES + 1)
    expect(textOf(r)).toContain(`only the first ${MAX_READ_BYTES} bytes`)
    expect(ctx.calls.artifacts[0]?.bytes.byteLength).toBeLessThan(MAX_READ_BYTES + 4096)
  })

  it('cuts the byte-capped text back to a line boundary instead of showing a half line', async () => {
    // The cap lands wherever 4 MiB lands, almost always mid-line. Numbering that fragment as if it
    // were a whole line invites an edit against text the file does not contain, so the fragment is
    // dropped. The excerpt the model sees is head-and-tail cut by the output guard, so the check is
    // on what was numbered: the stored artifact holds the whole numbered text.
    const width = 10
    const line = 'x'.repeat(width - 1)
    const whole = MAX_READ_BYTES / width
    expect(Number.isInteger(whole)).toBe(false)
    const lastWhole = Math.floor(whole)
    const ctx = fakeToolContext({ files: { 'big.txt': `${line}\n`.repeat(lastWhole + 10) } })
    await readTool.execute({ path: 'big.txt' }, ctx)
    const stored = new TextDecoder().decode(ctx.calls.artifacts[0]?.bytes as Uint8Array)
    expect(stored.slice(stored.lastIndexOf('\n') + 1)).toBe(`${lastWhole}\t${line}`)
    // The line the cap fell inside is absent entirely, not shown truncated.
    expect(stored).not.toContain(`${lastWhole + 1}\t`)
  })

  it('spills a long file to an artifact and returns a ref alongside the excerpt', async () => {
    const line = 'a'.repeat(80)
    const ctx = fakeToolContext({ files: { 'long.txt': Array(400).fill(line).join('\n') } })
    const r = await readTool.execute({ path: 'long.txt' }, ctx)
    expect(byteLength(textOf(r))).toBeLessThanOrEqual(OUTPUT_LIMITS.maxBytes)
    expect(textOf(r)).toContain('[truncated')
    expect(r.content[1]).toMatchObject({ type: 'ref', mime: 'text/plain' })
    expect(ctx.calls.artifacts).toHaveLength(1)
  })

  it('returns a result rather than letting a hostile store rejection escape execute()', async () => {
    // The output guard runs outside every `try` here, so a throw inside it ends the turn instead of
    // reaching the model as a failed call. A null-prototype rejection is not exotic: `JSON.parse`
    // revivers and several RPC clients produce them.
    const ctx = fakeToolContext({ files: { 'long.txt': `${'a'.repeat(80)}\n`.repeat(400) } })
    ctx.artifacts.put = () => Promise.reject(Object.create(null))
    const r = await readTool.execute({ path: 'long.txt' }, ctx)
    expect(textOf(r)).toContain('could not be stored')
    expect(r.content[1]).toBeUndefined()
  })

  it('does not attach a ref when the output fits', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': 'short' } })
    const r = await readTool.execute({ path: 'a.txt' }, ctx)
    expect(r.content).toHaveLength(1)
  })

  it('decodes invalid utf-8 instead of throwing', async () => {
    const ctx = fakeToolContext({ files: { 'a.txt': new Uint8Array([0xff, 0xfe, 0x41]) } })
    const r = await readTool.execute({ path: 'a.txt' }, ctx)
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('A')
  })
})
