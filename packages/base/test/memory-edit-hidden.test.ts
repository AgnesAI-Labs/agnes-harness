import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
import { fileMemoryProvider } from '@agnes/memory-file'
import { afterEach, describe, expect, it } from 'vitest'
import { editTool } from '../extensions/tools-core/src/tools/edit.js'
import { readTool } from '../extensions/tools-core/src/tools/read.js'
import { fakeToolContext } from '../testkit/tool-context.js'

// The real memory provider behind the real edit tool: a stored paragraph that expired is hidden from
// the agent, and editing the visible lines must leave it alone.

const EXPIRED = 'rexpired001'
const block = (id: string, text: string) => `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->\n`
const STORED = `Keep tests small.\nUse pnpm.\n\n${block(EXPIRED, 'HIDDEN-PARAGRAPH-BODY')}\nBottom line.\n`

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const outside: MemoryFilePort = {
  read: () => Promise.reject(new Error('outside memory')),
  write: () => Promise.reject(new Error('outside memory')),
  list: () => Promise.reject(new Error('outside memory')),
  stat: () => Promise.reject(new Error('outside memory')),
}

async function setup(
  stored = STORED,
  decide: (n: number, proposal: MemoryProposal) => 'approved' | 'rejected' = () => 'approved',
) {
  const home = await mkdtemp(join(tmpdir(), 'agh-edit-hidden-'))
  dirs.push(home)
  const session = fileMemoryProvider.open({
    home,
    workspaceRoot: home,
    sessionKey: 's',
    validity: {
      revision: () => 'v1',
      validity: (id) => (id === EXPIRED ? 'expired' : id === 'rvisible001' ? 'valid' : 'unknown'),
    },
  })
  await session.configure?.({ mode: 'ask' })
  const index = join(session.root, 'MEMORY.md')
  await writeFile(index, stored)
  let asked = 0
  const port = session.files(
    outside,
    { sessionKey: 's', turn: 1, toolUseId: 't' },
    new AbortController().signal,
    async (proposal) => {
      asked += 1
      return decide(asked, proposal) === 'approved' ? { status: 'approved' } : { status: 'rejected' }
    },
  )
  const ctx = fakeToolContext({ sessionKey: `real-${dirs.length}-${Math.random()}` })
  ctx.fs.read = async (path) => port.read(path)
  ctx.fs.write = async (path, data) =>
    port.write(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
  if (port.replaceExact) ctx.fs.replaceExact = (path, a, b) => port.replaceExact!(path, a, b)
  await readTool.execute({ path: index }, ctx)
  return { ctx, index, asked: () => asked }
}

describe('edit through the memory provider with a hidden paragraph', () => {
  it('changes visible lines in one call and keeps the hidden paragraph byte for byte', async () => {
    const { ctx, index } = await setup()
    const result = await editTool.execute(
      {
        path: index,
        edits: [
          { oldText: 'Use pnpm.', newText: 'Use pnpm 10.' },
          { oldText: 'Bottom line.', newText: 'Bottom line, updated.' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(index, 'utf8')).toBe(
      STORED.replace('Use pnpm.', 'Use pnpm 10.').replace('Bottom line.', 'Bottom line, updated.'),
    )
  })

  it('reports exactly which edits were applied when a later approval is declined', async () => {
    const { ctx, index, asked } = await setup(STORED, (n) => (n === 2 ? 'rejected' : 'approved'))
    const result = await editTool.execute(
      {
        path: index,
        edits: [
          { oldText: 'Use pnpm.', newText: 'Use pnpm 10.' },
          { oldText: 'Bottom line.', newText: 'Bottom line, updated.' },
        ],
      },
      ctx,
    )
    expect(asked()).toBe(2)
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ index: 1, written: true, applied: [0], notApplied: [1] })
    const text = JSON.stringify(result)
    expect(text).toContain('MEMORY_APPROVAL_REJECTED')
    expect(text).not.toContain('HIDDEN-PARAGRAPH-BODY')
    expect(await readFile(index, 'utf8')).toBe(STORED.replace('Use pnpm.', 'Use pnpm 10.'))
  })

  it('edits the text of a visible managed paragraph, which a whole-file rewrite may not, with nothing hidden', async () => {
    const { ctx, index } = await setup(`${block('rvisible001', 'Prefer small PRs.')}Use pnpm.\n`)
    const result = await editTool.execute(
      { path: index, edits: [{ oldText: 'Prefer small PRs.', newText: 'Prefer small, reviewed PRs.' }] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(index, 'utf8')).toBe(
      `${block('rvisible001', 'Prefer small, reviewed PRs.')}Use pnpm.\n`,
    )
  })

  it('refuses an edit that reaches into the hidden paragraph without leaking it', async () => {
    const { ctx, index } = await setup()
    const result = await editTool.execute(
      { path: index, edits: [{ oldText: 'HIDDEN-PARAGRAPH-BODY', newText: 'x' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(await readFile(index, 'utf8')).toBe(STORED)
  })
})
