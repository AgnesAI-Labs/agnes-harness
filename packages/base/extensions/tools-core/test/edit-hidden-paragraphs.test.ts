import type { ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { type FakeToolContextOpts, fakeToolContext } from '../../../testkit/tool-context.js'
import { editTool } from '../src/tools/edit.js'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'

// A memory file whose stored text holds one paragraph the agent must not see. The context serves
// the filtered view on read, refuses a whole-file write while the paragraph is hidden, and offers
// replaceExact on the stored text, the way the memory provider does.

const NOTICE = '[1 task-experience paragraphs omitted: expired or unverifiable]\n'
const HIDDEN = '<!-- refinement:r0000000001 -->\nSECRET-HIDDEN-TEXT\n<!-- /refinement:r0000000001 -->\n'

type Fault = { code?: string; message?: string }
type Opts = {
  before?: string
  after?: string
  /** Fail the nth replaceExact call (1-based) with this error. */
  failCall?: Record<number, Fault>
  /** Runs when the whole-file write is refused, before the refusal is raised. */
  onRefusedWrite?: (state: State) => void
  withReplaceExact?: boolean
  /** The code the whole-file write is refused with. */
  writeCode?: string
}
type State = { before: string; after: string }

function memoryCtx(opts: Opts = {}) {
  const state: State = {
    before: opts.before ?? 'alpha line\nbeta line\n',
    after: opts.after ?? 'gamma line\n',
  }
  const calls: [string, string][] = []
  const enc = new TextEncoder()
  const stored = () => state.before + HIDDEN + state.after
  const view = () => state.before + NOTICE + state.after
  const base: FakeToolContextOpts = { files: { 'memory/MEMORY.md': view() } }
  const ctx = fakeToolContext({ sessionKey: `hidden-${Math.random()}`, ...base })
  ctx.fs.read = async () => enc.encode(view())
  ctx.fs.write = async () => {
    opts.onRefusedWrite?.(state)
    const code = opts.writeCode ?? 'MEMORY_HIDDEN_PARAGRAPHS'
    throw Object.assign(new Error(code), { code })
  }
  if (opts.withReplaceExact !== false)
    ctx.fs.replaceExact = async (_path, oldText, newText) => {
      calls.push([oldText, newText])
      const fail = opts.failCall?.[calls.length]
      if (fail) throw Object.assign(new Error(fail.message ?? 'refused'), { code: fail.code })
      const text = view()
      const at = text.indexOf(oldText)
      if (at < 0 || text.indexOf(oldText, at + 1) >= 0)
        throw Object.assign(new Error('MEMORY_REPLACE_NOT_FOUND'), { code: 'MEMORY_REPLACE_NOT_FOUND' })
      const end = at + oldText.length
      const b = state.before.length
      if (end <= b) state.before = state.before.replace(oldText, () => newText)
      else if (at >= b + NOTICE.length) state.after = state.after.replace(oldText, () => newText)
      else throw Object.assign(new Error('MEMORY_HIDDEN_PARAGRAPHS'), { code: 'MEMORY_HIDDEN_PARAGRAPHS' })
    }
  return { ctx, state, calls, stored }
}

async function observed(opts?: Opts) {
  const made = memoryCtx(opts)
  await readTool.execute({ path: 'memory/MEMORY.md' }, made.ctx)
  return made
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
const everything = (r: ToolResult) => JSON.stringify(r)

describe('edit on a memory file that hides paragraphs', () => {
  it('edit falls back to exact replacement when the memory file hides paragraphs', async () => {
    const { ctx, calls, stored } = await observed()
    const result = await editTool.execute(
      {
        path: 'memory/MEMORY.md',
        edits: [
          { oldText: 'alpha line', newText: 'alpha changed' },
          { oldText: 'gamma line', newText: 'gamma changed' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('applied 2 edit(s)')
    expect(calls).toEqual([
      ['alpha line', 'alpha changed'],
      ['gamma line', 'gamma changed'],
    ])
    expect(stored()).toBe(`alpha changed\nbeta line\n${HIDDEN}gamma changed\n`)
  })

  it('falls back as well when the rewrite would change the text of a managed paragraph', async () => {
    const { ctx, calls, stored } = await observed({ writeCode: 'MEMORY_PARAGRAPH_TEXT_CHANGED' })
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha changed' }] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(calls).toEqual([['alpha line', 'alpha changed']])
    expect(stored()).toBe(`alpha changed\nbeta line\n${HIDDEN}gamma line\n`)
  })

  it('applies a later edit to the text an earlier edit just wrote', async () => {
    const { ctx, calls, stored } = await observed()
    const result = await editTool.execute(
      {
        path: 'memory/MEMORY.md',
        edits: [
          { oldText: 'alpha line', newText: 'alpha step' },
          { oldText: 'alpha step', newText: 'alpha final' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(stored()).toBe(`alpha final\nbeta line\n${HIDDEN}gamma line\n`)
  })

  it('keeps what the session knows of the file, so a later edit needs no new read', async () => {
    const { ctx } = await observed()
    const first = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha 2' }] },
      ctx,
    )
    expect(first.isError).toBeUndefined()
    const second = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'beta line', newText: 'beta 2' }] },
      ctx,
    )
    expect(second.isError).toBeUndefined()
  })

  it('validates every edit against the view before changing anything', async () => {
    const { ctx, calls, stored } = await observed()
    const before = stored()
    const result = await editTool.execute(
      {
        path: 'memory/MEMORY.md',
        edits: [
          { oldText: 'alpha line', newText: 'alpha changed' },
          { oldText: 'not in the view', newText: 'x' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ category: 'not_found', index: 1, written: false })
    expect(calls).toEqual([])
    expect(stored()).toBe(before)
  })

  it('cannot match text that only exists inside the hidden paragraph', async () => {
    const { ctx, calls } = await observed()
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'SECRET-HIDDEN-TEXT', newText: 'x' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('stops at the first replacement that fails and says exactly which edits were applied', async () => {
    const { ctx, calls, stored } = await observed({
      failCall: { 2: { code: 'MEMORY_APPROVAL_REJECTED' } },
    })
    const result = await editTool.execute(
      {
        path: 'memory/MEMORY.md',
        edits: [
          { oldText: 'alpha line', newText: 'alpha changed' },
          { oldText: 'beta line', newText: 'beta changed' },
          { oldText: 'gamma line', newText: 'gamma changed' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(2)
    expect(stored()).toBe(`alpha changed\nbeta line\n${HIDDEN}gamma line\n`)
    expect(result.structured).toMatchObject({
      category: 'write_failed',
      index: 1,
      written: true,
      applied: [0],
      notApplied: [1, 2],
    })
    expect(result.details).toMatchObject({ code: 'MEMORY_APPROVAL_REJECTED' })
    const text = textOf(result)
    expect(text).toContain('edit 1 was applied')
    expect(text).toContain('edit 2 failed (MEMORY_APPROVAL_REJECTED)')
    expect(text).toContain('edit 3 was not attempted')
    expect(text).toContain('managed paragraphs')
  })

  it('reports nothing applied when the first replacement fails', async () => {
    const { ctx, stored } = await observed({ failCall: { 1: { code: 'MEMORY_APPROVAL_REJECTED' } } })
    const before = stored()
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha changed' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ index: 0, written: false, applied: [], notApplied: [0] })
    expect(stored()).toBe(before)
  })

  it('does not start when the file changed between the read and the fallback', async () => {
    const { ctx, calls, stored } = await observed({
      onRefusedWrite: (state) => {
        state.after = 'gamma line, edited by a person\n'
      },
    })
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha changed' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ written: false, applied: [] })
    expect(calls).toEqual([])
    expect(stored()).toBe(`alpha line\nbeta line\n${HIDDEN}gamma line, edited by a person\n`)
  })

  it('never puts hidden text or a provider message into an error', async () => {
    const leak = 'provider says: SECRET-HIDDEN-TEXT and sk-live-0123456789abcdef0123456789abcdef'
    const { ctx } = await observed({ failCall: { 1: { message: leak } } })
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha changed' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(everything(result)).not.toContain('SECRET-HIDDEN-TEXT')
    expect(everything(result)).not.toContain('provider says')
    expect(everything(result)).not.toContain('sk-live')
    expect(result.details).toMatchObject({ code: 'FS_EDIT_REPLACE_FAILED' })
  })

  it('keeps the provider code when there is no exact replacement for a text change', async () => {
    const { ctx } = await observed({ withReplaceExact: false, writeCode: 'MEMORY_PARAGRAPH_TEXT_CHANGED' })
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha changed' }] },
      ctx,
    )
    expect(result.details).toMatchObject({ code: 'MEMORY_PARAGRAPH_TEXT_CHANGED' })
  })

  it('explains the refusal when there is no exact replacement to fall back on', async () => {
    const { ctx, stored } = await observed({ withReplaceExact: false })
    const before = stored()
    const result = await editTool.execute(
      { path: 'memory/MEMORY.md', edits: [{ oldText: 'alpha line', newText: 'alpha changed' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({ code: 'MEMORY_HIDDEN_PARAGRAPHS' })
    expect(textOf(result)).toContain('managed paragraphs')
    expect(result.structured).toMatchObject({ written: false })
    expect(stored()).toBe(before)
  })
})

describe('edit on an ordinary file', () => {
  it('edit on an ordinary file never calls replaceExact', async () => {
    const ctx = fakeToolContext({ sessionKey: 'ordinary-1', files: { 'a.txt': 'one\ntwo\n' } })
    const seen: unknown[] = []
    ctx.fs.replaceExact = async (...args) => {
      seen.push(args)
    }
    await readTool.execute({ path: 'a.txt' }, ctx)
    const result = await editTool.execute({ path: 'a.txt', edits: [{ oldText: 'one', newText: 'ONE' }] }, ctx)
    expect(result.isError).toBeUndefined()
    expect(seen).toEqual([])
    expect(new TextDecoder().decode(ctx.mem.files.get('/work/proj/a.txt'))).toBe('ONE\ntwo\n')
  })

  it.each(['E_FS_DENIED', 'EIO'])('does not fall back for a %s write failure', async (code) => {
    const ctx = fakeToolContext({
      sessionKey: `ordinary-${code}`,
      files: { 'a.txt': 'one\n' },
      writeErrors: { 'a.txt': { code, message: 'private' } },
    })
    const seen: unknown[] = []
    ctx.fs.replaceExact = async (...args) => {
      seen.push(args)
    }
    await readTool.execute({ path: 'a.txt' }, ctx)
    const run = editTool.execute({ path: 'a.txt', edits: [{ oldText: 'one', newText: 'ONE' }] }, ctx)
    if (code === 'EIO') await expect(run).rejects.toThrow('EIO')
    else expect((await run).details).toMatchObject({ code })
    expect(seen).toEqual([])
  })
})

describe('write on a memory file that hides paragraphs', () => {
  it('write is refused with a hint when paragraphs are hidden', async () => {
    const { ctx, calls, stored } = await observed()
    const before = stored()
    const result = await writeTool.execute(
      { path: 'memory/MEMORY.md', content: `alpha line\nbeta line\n${NOTICE}gamma line\nnew line\n` },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({ code: 'MEMORY_HIDDEN_PARAGRAPHS' })
    expect(textOf(result)).toContain('managed paragraphs')
    expect(textOf(result)).toContain('use edit')
    expect(everything(result)).not.toContain('SECRET-HIDDEN-TEXT')
    expect(calls).toEqual([])
    expect(stored()).toBe(before)
  })
})
