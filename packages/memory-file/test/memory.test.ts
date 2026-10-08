import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { fileMemoryProvider } from '../src/index.js'

const homes: string[] = []
const fallback: MemoryFilePort = {
  read: async () => {
    throw new Error('outside memory')
  },
  write: async () => {
    throw new Error('outside memory')
  },
  list: async () => {
    throw new Error('outside memory')
  },
  stat: async () => {
    throw new Error('outside memory')
  },
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agh-memory-'))
  homes.push(home)
  const open = (sessionKey: string) => fileMemoryProvider.open({ home, workspaceRoot: home, sessionKey })
  const session = open('one')
  const files = (turn: number, approve: (proposal: MemoryProposal) => Promise<boolean> = async () => true) =>
    session.files(
      fallback,
      { sessionKey: 'one', turn, toolUseId: 'write' },
      new AbortController().signal,
      approve,
    )
  return { home, open, session, files, index: join(session.root, 'MEMORY.md') }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('file memory contract', () => {
  it('defaults off and refuses read/write/edit semantics even for aliases and symlinks', async () => {
    const f = await fixture()
    expect(await f.session.snapshot(1)).toBeUndefined()
    await f.session.configure({ mode: 'auto' })
    await f.files(1).write(f.index, 'Prefer concise answers.')
    await f.session.configure({ mode: 'off' })
    expect(await f.session.snapshot(1)).toBeUndefined()
    await expect(f.files(1).read(f.index)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' })
    await expect(f.files(1).write(join(f.session.root, '.', 'MEMORY.md'), 'changed')).rejects.toMatchObject({
      code: 'MEMORY_DISABLED',
    })
    const alias = join(f.home, 'alias')
    await symlink(f.session.root, alias)
    await expect(f.files(1).write(join(alias, 'MEMORY.md'), 'changed')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Prefer concise answers.')
  })

  it('reviews the exact file proposal, never injects rejected candidates, and detects approval drift', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'ask' })
    let proposal: MemoryProposal | undefined
    await expect(
      f
        .files(1, async (value) => {
          proposal = value
          return false
        })
        .write(f.index, 'Prefer concise answers.'),
    ).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_REJECTED' })
    expect(proposal).toMatchObject({
      path: f.index,
      source: { sessionKey: 'one', turn: 1, toolUseId: 'write' },
    })
    expect(proposal?.baseHash).not.toBe(proposal?.newHash)
    expect(proposal?.diff).toContain('+Prefer concise answers.')
    expect((await f.session.snapshot(1))?.content).not.toContain('Prefer concise answers.')
    await expect(
      f
        .files(2, async () => {
          const before = await f.session.readFile('MEMORY.md')
          await f.session.editFile('MEMORY.md', 'Human preference', before.hash)
          return true
        })
        .write(f.index, 'Agent preference'),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human preference')
    await f.session.configure({ mode: 'auto' })
    const lock = new DatabaseSync(join(f.session.root, 'commit.sqlite'))
    try {
      lock.exec('BEGIN EXCLUSIVE')
      const queued = f.files(5).write(f.index, 'Queued automatic candidate')
      const config = (await f.session.inspect()).settings
      await writeFile(join(f.session.root, 'settings.json'), JSON.stringify({ ...config, mode: 'ask' }))
      lock.exec('COMMIT')
      await expect(queued).rejects.toMatchObject({ code: 'MEMORY_POLICY_CHANGED' })
    } finally {
      lock.close()
    }
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human preference')
    await expect(
      f
        .files(3, async () => {
          await f.session.configure({ mode: 'off' })
          return true
        })
        .write(f.index, 'Approved too late'),
    ).rejects.toMatchObject({ code: 'MEMORY_DISABLED' })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human preference')
    await f.session.configure({ mode: 'ask' })
    const abort = new AbortController()
    const cancelled = f.session.files(fallback, { sessionKey: 'one', turn: 4 }, abort.signal, async () => {
      abort.abort(new Error('cancelled'))
      return true
    })
    await expect(cancelled.write(f.index, 'Cancelled candidate')).rejects.toThrow('cancelled')
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human preference')
  })

  it('keeps a per-turn revision, observes human edits next turn, and permits one winner across sessions', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto' })
    await f.files(1).write(f.index, 'Original preference')
    const first = await f.session.snapshot(2)
    const two = f.open('two')
    const other = two.files(
      fallback,
      { sessionKey: 'two', turn: 1 },
      new AbortController().signal,
      async () => true,
    )
    await two.snapshot(1)
    const outcomes = await Promise.allSettled([
      f.files(2).write(f.index, 'First wins'),
      other.write(f.index, 'Second wins'),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
      { reason: { code: 'MEMORY_CONFLICT' } },
    ])
    expect(await f.session.snapshot(2)).toEqual(first)
    expect((await f.session.snapshot(3))?.revision).not.toBe(first?.revision)
    expect(await f.files(3).revision?.(f.index)).toBe((await f.session.snapshot(3))?.revision)
    const disk = await f.session.readFile('MEMORY.md')
    expect(['First wins', 'Second wins']).toContain(disk.content)
    expect((await f.session.inspect()).lastWriter).toMatchObject({ turn: expect.any(Number) })
    await expect(f.session.editFile('MEMORY.md', 'stale editor', 'invalid-hash')).rejects.toMatchObject({
      code: 'MEMORY_CONFLICT',
    })
  })

  it('rejects over-cap or secret-like candidates without truncating or approving them', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'ask', indexMaxBytes: 200, indexMaxLines: 5 })
    let approved = false
    for (const content of ['x'.repeat(201), '1\n2\n3\n4\n5\n6', 'api_key=synthetic-sensitive-key']) {
      await expect(
        f
          .files(1, async () => {
            approved = true
            return true
          })
          .write(f.index, content),
      ).rejects.toMatchObject({
        code: content.startsWith('api_key') ? 'MEMORY_SECRET_LIKE_CONTENT' : 'MEMORY_CONSOLIDATION_REQUIRED',
      })
    }
    expect(approved).toBe(false)
    expect((await f.session.readFile('MEMORY.md')).content).toBe('')
    await f.session.configure({ mode: 'auto', indexMaxBytes: 16000, indexMaxLines: 200, tokenBudget: 128 })
    await f.files(2).write(f.index, 'stable convention '.repeat(40))
    const context = await f.session.snapshot(3)
    expect(context?.omitted).toBe(true)
    expect(context?.content).toContain('Memory omitted')
    expect(Buffer.byteLength(context?.content ?? '')).toBeLessThanOrEqual(128)
    expect((await f.session.readFile('MEMORY.md')).content).toBe('stable convention '.repeat(40))
  })

  it('denies cross-workspace, symlink/hardlink escapes and missing topic references', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto' })
    const other = fileMemoryProvider.open({ home: f.home, workspaceRoot: tmpdir(), sessionKey: 'elsewhere' })
    await expect(f.files(1).write(join(other.root, 'MEMORY.md'), 'cross workspace')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    const outside = join(f.home, 'outside.md')
    await writeFile(outside, 'outside')
    await symlink(outside, join(f.session.root, 'escape.md'))
    await expect(f.files(1).write(join(f.session.root, 'escape.md'), 'escape')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    await rm(join(f.session.root, 'escape.md'))
    await link(outside, join(f.session.root, 'linked.md'))
    await expect(f.files(1).write(join(f.session.root, 'linked.md'), 'escape')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    await rm(join(f.session.root, 'linked.md'))
    await expect(f.files(1).write(f.index, '[topic](missing.md)')).rejects.toMatchObject({
      code: 'MEMORY_MISSING_TOPIC',
    })
    await f.files(2).write(join(f.session.root, 'topic.md'), 'Convention details')
    await f.files(3).write(f.index, '[topic](topic.md)')
    expect(await readFile(f.index, 'utf8')).toBe('[topic](topic.md)')
    await rm(join(f.session.root, 'writer.json'))
    await mkdir(join(f.session.root, 'writer.json'))
    await expect(f.files(4).write(f.index, 'Committed file with failed provenance')).rejects.toMatchObject({
      code: 'MEMORY_COMMITTED_METADATA_FAILED',
    })
    expect(await readFile(f.index, 'utf8')).toBe('Committed file with failed provenance')
  })
  it('keeps optional user memory separately budgeted and read-only, with no secret injection', async () => {
    const f = await fixture()
    const user = join(f.home, 'memory', 'user')
    await mkdir(user, { recursive: true })
    await writeFile(join(user, 'MEMORY.md'), 'User preference: stable review checklist.')
    await f.session.configure({ mode: 'auto', userEnabled: true })
    await f.files(1).write(f.index, 'Workspace convention: focused changes.')
    const context = await f.session.snapshot(2)
    expect(context?.content).toContain('User preference: stable review checklist.')
    expect(context?.content).toContain('Workspace convention: focused changes.')
    await expect(f.files(2).write(join(user, 'MEMORY.md'), 'agent edit')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    await writeFile(join(user, 'MEMORY.md'), 'api_key=synthetic-sensitive-key')
    expect(await f.session.snapshot(2)).toEqual(context)
    expect((await f.session.snapshot(3))?.content).not.toContain('synthetic-sensitive-key')
    expect((await f.session.snapshot(3))?.content).toContain('User memory omitted')
    await writeFile(join(user, 'MEMORY.md'), 'User preference: '.repeat(100))
    await f.session.configure({ userTokenBudget: 128 })
    const bounded = await f.session.snapshot(4)
    expect(bounded?.content).toContain('Workspace convention: focused changes.')
    const userLayer = bounded?.content.split('User memory (read-only for the agent):\n')[1] ?? ''
    expect(Buffer.byteLength(userLayer)).toBeLessThanOrEqual(128)
    expect(userLayer).toContain('Memory omitted')
  })
})
