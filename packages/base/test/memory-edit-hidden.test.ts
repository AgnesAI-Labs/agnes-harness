import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, fakeSeams, openSession, textTurn, toolTurn } from '@agnes/core/testkit'
import type { MemoryFilePort, MemorySession } from '@agnes/extension-api'
import { fileMemoryProvider, isMemoryPreEffectRefusal } from '@agnes/memory-file'
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
const sessions = new Set<MemorySession>()
afterEach(async () => {
  for (const session of sessions) await session.close?.()
  sessions.clear()
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
  decide: (n: number) => 'approved' | 'rejected' = () => 'approved',
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
  sessions.add(session)
  await session.configure?.({ mode: 'auto' })
  const index = join(session.root, 'MEMORY.md')
  const seedSignal = new AbortController().signal
  const seedApprove = async () => ({ status: 'approved' as const })
  const seedPort = (turn: number) =>
    session.files(outside, { sessionKey: 's', turn, toolUseId: 'seed' }, seedSignal, seedApprove)
  const paragraphs = session.paragraphs!({ sessionKey: 's', turn: 0 }, seedSignal)
  if (stored === STORED) {
    await seedPort(0).write(index, 'Keep tests small.\nUse pnpm.\n')
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
  async function run(
    args: Parameters<typeof editTool.execute>[0] | Parameters<typeof writeTool.execute>[0],
    memory = session,
    proof = isMemoryPreEffectRefusal,
  ) {
    const name = 'edits' in args ? 'edit' : 'write'
    const registry = new ToolRegistry()
    for (const tool of [readTool, writeTool, editTool])
      registry.add(tool, {
        source: 'test',
        trust: 'builtin',
        packageIdentity: '@agnes/base',
        packageVersion: '1.0.0-test',
      })
    const opened = await openSession({
      key: 's',
      commandPathScope: async () => ({ root: session.root }),
      provider: fakeProvider([toolTurn('read', { path: index }), toolTurn(name, args), textTurn('done')]),
      registry,
      memory,
      trustedMemorySession: (candidate) => candidate === session,
      memoryPreEffectProof: proof,
      seams: fakeSeams({
        approval: {
          ask: async (request) => ({
            verdict:
              request.scope?.startsWith('memory:') && decide(++asked) === 'rejected'
                ? 'rejected'
                : 'allowed-once',
            answeredBy: actor,
          }),
        },
      }),
    })
    try {
      await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'update' }] })
      await opened.session.run({ until: 'turn-end', signal: seedSignal })
      const results = await opened.log.scan({ type: 'tool/result', limit: 5 })
      expect(results).toHaveLength(2)
      expect(results[0]?.data).toMatchObject({ isError: false })
      return results[1]?.data
    } finally {
      await opened.session.close()
      sessions.delete(session)
    }
  }
  return { run, session, index, asked: () => asked }
}

describe('edit through the memory provider with a hidden paragraph', () => {
  it('changes visible lines in one call and keeps the hidden paragraph byte for byte', async () => {
    const { run, index } = await setup()
    const result = await run({
      path: index,
      edits: [
        { oldText: 'Use pnpm.', newText: 'Use pnpm 10.' },
        { oldText: 'Bottom line.', newText: 'Bottom line, updated.' },
      ],
    })
    expect(result).toMatchObject({ isError: false })
    expect(await readFile(index, 'utf8')).toBe(
      STORED.replace('Use pnpm.', 'Use pnpm 10.').replace('Bottom line.', 'Bottom line, updated.'),
    )
  })

  it.each(['MEMORY_APPROVAL_REJECTED', 'MEMORY_HUMAN_EDITED', 'MEMORY_MARKER_CHANGED'])(
    'reports exactly which edits were applied when a later replacement fails with %s',
    async (code) => {
      const { run, index, asked } = await setup(
        STORED,
        (n) => (n === 2 ? 'rejected' : 'approved'),
        code === 'MEMORY_HUMAN_EDITED',
      )
      const result = await run({
        path: index,
        edits: [
          { oldText: 'Use pnpm.', newText: 'Use pnpm 10.' },
          {
            oldText: 'Bottom line.',
            newText:
              code === 'MEMORY_MARKER_CHANGED'
                ? block('rvisible001', 'Bottom line.')
                : 'Bottom line, updated.',
          },
        ],
      })
      expect(asked()).toBe(code === 'MEMORY_APPROVAL_REJECTED' ? 2 : 1)
      expect(result).toMatchObject({
        isError: true,
        structured: { index: 1, written: true, applied: [0], notApplied: [1] },
      })
      const text = JSON.stringify(result)
      expect(text).toContain(code)
      expect(text).not.toContain('Nothing was written')
      expect(text).not.toContain('HIDDEN-PARAGRAPH-BODY')
      expect(await readFile(index, 'utf8')).toBe(STORED.replace('Use pnpm.', 'Use pnpm 10.'))
    },
  )

  it.each(['write', 'edit'] as const)(
    'attests lock contention for the current %s invocation',
    async (name) => {
      let db: DatabaseSync | undefined
      const { run, session, index } = await setup(STORED, (n) => {
        if (n === (name === 'write' ? 1 : 2)) {
          db = new DatabaseSync(join(session.root, 'commit.sqlite'))
          db.exec('BEGIN EXCLUSIVE')
        }
        return 'approved'
      })
      const topic = join(session.root, 'new-topic.md')
      try {
        let proved = false
        const result = await run(
          name === 'write'
            ? { path: topic, content: 'New topic.' }
            : {
                path: index,
                edits: [
                  { oldText: 'Use pnpm.', newText: 'Use pnpm 10.' },
                  { oldText: 'Bottom line.', newText: 'Edited bottom.' },
                ],
              },
          session,
          (error, source) => {
            if ((error as Error)?.message === 'MEMORY_BUSY') {
              proved = isMemoryPreEffectRefusal(error, source)
              expect(
                isMemoryPreEffectRefusal(error, { ...source, toolUseId: `${source.toolUseId}-other` }),
              ).toBe(false)
            }
            return isMemoryPreEffectRefusal(error, source)
          },
        )
        expect(proved).toBe(true)
        if (name === 'write') {
          expect(result).toMatchObject({
            code: 'TOOL_REJECTED_BEFORE_EFFECT',
            structured: { effect: 'none', code: 'MEMORY_BUSY' },
          })
          await expect(readFile(topic)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          expect(result).toMatchObject({
            isError: true,
            structured: { index: 1, written: true, applied: [0], notApplied: [1] },
          })
          expect(JSON.stringify(result)).toContain('MEMORY_BUSY')
          expect(await readFile(index, 'utf8')).toBe(STORED.replace('Use pnpm.', 'Use pnpm 10.'))
        }
      } finally {
        db?.close()
        await session.close?.()
      }
    },
    15_000,
  )

  it('edits the text of a visible managed paragraph, which a whole-file rewrite may not, with nothing hidden', async () => {
    const { run, index } = await setup(`${block('rvisible001', 'Prefer small PRs.')}Use pnpm.\n`)
    const result = await run({
      path: index,
      edits: [{ oldText: 'Prefer small PRs.', newText: 'Prefer small, reviewed PRs.' }],
    })
    expect(result).toMatchObject({ isError: false })
    expect(await readFile(index, 'utf8')).toBe(
      `${block('rvisible001', 'Prefer small, reviewed PRs.')}Use pnpm.\n`,
    )
  })

  it('refuses an edit that reaches into the hidden paragraph without leaking it', async () => {
    const { run, index } = await setup()
    const result = await run({
      path: index,
      edits: [{ oldText: 'HIDDEN-PARAGRAPH-BODY', newText: 'x' }],
    })
    expect(result).toMatchObject({ isError: true })
    expect(await readFile(index, 'utf8')).toBe(STORED)
  })

  it.each(['MEMORY_HUMAN_EDITED', 'MEMORY_PREFERENCE_CONFLICT'])(
    'propagates raw %s from write and exact replacement',
    async (code) => {
      const path = '/work/proj/notes.txt'
      const ctx = fakeToolContext({ files: { [path]: 'old' } })
      await readTool.execute({ path }, ctx)
      const error = Object.assign(new Error(code), { code })
      ctx.fs.write = async () => {
        throw error
      }
      await expect(writeTool.execute({ path, content: 'new' }, ctx)).rejects.toBe(error)
      const edit = () => editTool.execute({ path, edits: [{ oldText: 'old', newText: 'new' }] }, ctx)
      await expect(edit()).rejects.toMatchObject({
        code,
        message: expect.stringContaining('"written":"unknown"'),
      })
      ctx.fs.write = async () => {
        throw Object.assign(new Error('hidden'), {
          name: 'ToolPreEffectRefusal',
          code: 'MEMORY_HIDDEN_PARAGRAPHS',
        })
      }
      ctx.fs.replaceExact = async () => {
        throw error
      }
      await expect(edit()).rejects.toMatchObject({
        code,
        message: expect.stringContaining('outcome unknown'),
      })
    },
  )

  it.each(['write', 'edit'] as const)(
    'settles %s as unknown when a provider publishes then denies',
    async (name) => {
      const stored = `${block('rvisible001', 'Prefer small PRs.')}Use pnpm.\n`
      const { run, session, index } = await setup(stored)
      const provider: MemorySession = {
        ...session,
        files(...args) {
          const files = session.files(...args)
          return {
            ...files,
            async write(path, data) {
              await files.write(path, data)
              throw Object.assign(new Error('provider failed after publishing'), { code: 'E_FS_DENIED' })
            },
          }
        },
      }
      const result = await run(
        name === 'write'
          ? { path: index, content: stored.replace('Use pnpm.', 'Use npm.') }
          : { path: index, edits: [{ oldText: 'Use pnpm.', newText: 'Use npm.' }] },
        provider,
      )
      expect(result).toMatchObject({ isError: true, code: 'TOOL_OUTCOME_UNKNOWN' })
      expect(await readFile(index, 'utf8')).toBe(stored.replace('Use pnpm.', 'Use npm.'))
    },
  )

  it.each([
    ['write', 'MEMORY_HUMAN_EDITED'],
    ['edit', 'MEMORY_HUMAN_EDITED'],
    ['write', 'MEMORY_PREFERENCE_CONFLICT'],
    ['edit', 'MEMORY_PREFERENCE_CONFLICT'],
  ] as const)('records the provider refusal before any effect for %s (%s)', async (name, code) => {
    const stored = `${block('rvisible001', 'Prefer small PRs.')}Use pnpm.\n`
    const { session, index, run } = await setup(stored)
    const original = await session.readFile('MEMORY.md')
    const human = `${stored}\nPreference: test_runner = Jest\n`
    const oldText = code === 'MEMORY_HUMAN_EDITED' ? 'Preference: test_runner = Jest' : 'Use pnpm.'
    const newText = 'test_runner = vitest'
    await session.editFile('MEMORY.md', human, original.hash)
    const result = await run(
      name === 'write'
        ? { path: index, content: human.replace(oldText, newText) }
        : { path: index, edits: [{ oldText, newText }] },
    )
    expect(result).toMatchObject({
      code: 'TOOL_REJECTED_BEFORE_EFFECT',
      structured: { effect: 'none', code },
    })
    expect(await readFile(index, 'utf8')).toBe(human)
  })
})
