import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
import { fileMemoryProvider } from '@agnes/memory-file'
import { afterEach, describe, expect, it } from 'vitest'
import { editTool } from '../extensions/tools-core/src/tools/edit.js'
import { readTool } from '../extensions/tools-core/src/tools/read.js'
import { writeTool } from '../extensions/tools-core/src/tools/write.js'
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
  humanBottom = false,
) {
  const home = await mkdtemp(join(tmpdir(), 'agh-edit-hidden-'))
  dirs.push(home)
  let expired = false
  const session = fileMemoryProvider.open({
    home,
    workspaceRoot: home,
    sessionKey: 's',
    validity: {
      revision: () => (expired ? 'v2' : 'v1'),
      validity: (id) =>
        id === EXPIRED ? (expired ? 'expired' : 'valid') : id === 'rvisible001' ? 'valid' : 'unknown',
    },
  })
  await session.configure?.({ mode: 'auto' })
  const index = join(session.root, 'MEMORY.md')
  const seedSignal = new AbortController().signal
  const seedApprove = async () => ({ status: 'approved' as const })
  const seedPort = (turn: number) =>
    session.files(outside, { sessionKey: 's', turn, toolUseId: 'seed' }, seedSignal, seedApprove)
  const paragraphs = session.paragraphs!({ sessionKey: 's', turn: 0 }, seedSignal)
  if (stored === STORED) {
    await seedPort(1).write(index, 'Keep tests small.\nUse pnpm.\n')
    await paragraphs.commit(
      await paragraphs.propose({ op: 'put', id: EXPIRED, text: 'HIDDEN-PARAGRAPH-BODY' }),
    )
    const withManaged = await session.readFile('MEMORY.md')
    const content = `${withManaged.content}\nBottom line.\n`
    if (humanBottom) await session.editFile('MEMORY.md', content, withManaged.hash)
    else await seedPort(2).write(index, content)
    expired = true
  } else {
    await paragraphs.commit(
      await paragraphs.propose({ op: 'put', id: 'rvisible001', text: 'Prefer small PRs.' }),
    )
    await seedPort(2).write(index, stored)
  }
  expect(await readFile(index, 'utf8')).toBe(stored)
  await session.configure?.({ mode: 'ask' })
  let asked = 0
  const port = session.files(
    outside,
    { sessionKey: 's', turn: 3, toolUseId: 't' },
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

  it.each(['MEMORY_APPROVAL_REJECTED', 'MEMORY_HUMAN_EDITED'])(
    'reports exactly which edits were applied when a later replacement fails with %s',
    async (code) => {
      const { ctx, index, asked } = await setup(
        STORED,
        (n) => (n === 2 ? 'rejected' : 'approved'),
        code === 'MEMORY_HUMAN_EDITED',
      )
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
      expect(asked()).toBe(code === 'MEMORY_APPROVAL_REJECTED' ? 2 : 1)
      expect(result.isError).toBe(true)
      expect(result.structured).toMatchObject({ index: 1, written: true, applied: [0], notApplied: [1] })
      const text = JSON.stringify(result)
      expect(text).toContain(code)
      expect(text).not.toContain('Nothing was written')
      expect(text).not.toContain('HIDDEN-PARAGRAPH-BODY')
      expect(await readFile(index, 'utf8')).toBe(STORED.replace('Use pnpm.', 'Use pnpm 10.'))
    },
  )

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

  it.each(['MEMORY_HUMAN_EDITED', 'MEMORY_PREFERENCE_CONFLICT'])(
    'returns explicit non-written guidance on %s without throwing from write or edit',
    async (code) => {
      const { ctx, index } = await setup()
      ctx.fs.write = async () => {
        throw Object.assign(new Error(code), { code })
      }
      ctx.fs.replaceExact = async () => {
        throw Object.assign(new Error(code), { code })
      }
      const wRes = await writeTool.execute(
        { path: index, content: STORED.replace('Use pnpm.', 'Use npm.') },
        ctx,
      )
      expect(wRes.isError).toBe(true)
      expect(JSON.stringify(wRes)).toContain('Nothing was written')
      expect(JSON.stringify(wRes)).toContain(code)

      const eRes = await editTool.execute(
        { path: index, edits: [{ oldText: 'Use pnpm.', newText: 'Use npm.' }] },
        ctx,
      )
      expect(eRes.isError).toBe(true)
      expect(JSON.stringify(eRes)).toContain('Nothing was written')
      expect(JSON.stringify(eRes)).toContain(code)
    },
  )
})
