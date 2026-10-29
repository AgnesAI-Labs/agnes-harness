import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryApprovalResult, MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
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
  const files = (
    turn: number,
    approve: (proposal: MemoryProposal) => Promise<MemoryApprovalResult> = async () => ({
      status: 'approved',
    }),
  ) =>
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
  it.each([
    'same-volume',
    ...(process.platform === 'win32' &&
    parse(tmpdir()).root.toLowerCase() !== parse(process.cwd()).root.toLowerCase()
      ? ['other-volume']
      : []),
  ])('delegates ordinary %s files without granting memory access', async (volume) => {
    const f = await fixture()
    const workspace =
      volume === 'same-volume' ? f.home : await mkdtemp(join(process.cwd(), '.agh-memory-test-'))
    if (workspace !== f.home) homes.push(workspace)
    const path = join(workspace, '..draft.md')
    const session = fileMemoryProvider.open({
      home: f.home,
      workspaceRoot: workspace,
      sessionKey: 'ordinary',
    })
    const bytes = Buffer.from('ordinary document')
    const ordinary: MemoryFilePort = {
      read: async (requested) => {
        expect(requested).toBe(path)
        return bytes
      },
      write: async (requested, content) => {
        expect(requested).toBe(path)
        await writeFile(requested, content)
      },
      list: async () => [],
      stat: async (requested) => {
        expect(requested).toBe(path)
        return { kind: 'file', size: bytes.length, mtimeMs: 0 }
      },
    }
    const files = session.files(
      ordinary,
      { sessionKey: 'ordinary', turn: 1 },
      new AbortController().signal,
      async () => {
        throw new Error('ordinary file must not ask for memory approval')
      },
    )
    await files.write(path, bytes)
    expect(await readFile(path)).toEqual(bytes)
    expect(await files.read(path)).toEqual(bytes)
    expect(await files.stat(path)).toMatchObject({ kind: 'file', size: bytes.length })
    await expect(files.read(join(session.root, 'MEMORY.md'))).rejects.toMatchObject({
      code: 'MEMORY_DISABLED',
    })
  })

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
    await symlink(f.session.root, alias, 'junction')
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
          return { status: 'rejected' }
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
    for (const reason of [
      'deadline',
      'no-approver',
      'policy_denied',
      'subagent_scope',
      'no-handler',
      'transport',
      'detached',
      'stopped',
      'invalid-answer',
    ] as const) {
      await expect(
        f
          .files(1, async () => ({ status: 'unanswered' as const, reason }))
          .write(f.index, 'Unanswered candidate'),
      ).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_UNANSWERED', reason })
      expect((await f.session.readFile('MEMORY.md')).content).toBe('')
    }

    await expect(
      f
        .files(2, async () => {
          const before = await f.session.readFile('MEMORY.md')
          await f.session.editFile('MEMORY.md', 'Human preference', before.hash)
          return { status: 'approved' }
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
          return { status: 'approved' }
        })
        .write(f.index, 'Approved too late'),
    ).rejects.toMatchObject({ code: 'MEMORY_DISABLED' })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human preference')
    await f.session.configure({ mode: 'ask' })
    const abort = new AbortController()
    const cancelled = f.session.files(fallback, { sessionKey: 'one', turn: 4 }, abort.signal, async () => {
      abort.abort(new Error('cancelled'))
      return { status: 'approved' }
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
      async () => ({ status: 'approved' }),
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

  it('reports files changed outside the provider once while still injecting them', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto' })
    // No baseline yet: the first observation records one instead of reporting a change.
    await writeFile(f.index, 'Pre-existing preference')
    expect((await f.session.snapshot(1))?.externalChanges).toBeUndefined()
    // Agent writes through the provider, human edits and other sessions' commits are acknowledged.
    await f.files(1).write(f.index, 'Agent preference')
    expect((await f.session.snapshot(2))?.externalChanges).toBeUndefined()
    const current = await f.session.readFile('MEMORY.md')
    await f.session.editFile('MEMORY.md', 'Human preference', current.hash)
    expect((await f.session.snapshot(3))?.externalChanges).toBeUndefined()
    const two = f.open('two')
    await two
      .files(fallback, { sessionKey: 'two', turn: 1 }, new AbortController().signal, async () => ({
        status: 'approved',
      }))
      .write(f.index, 'Other session preference')
    expect((await f.session.snapshot(4))?.externalChanges).toBeUndefined()
    // A shell under full access writes the files directly.
    await writeFile(f.index, 'Shell preference')
    await writeFile(join(f.session.root, 'topic.md'), 'Shell topic')
    const tampered = await f.session.snapshot(5)
    expect(tampered?.externalChanges).toEqual(['MEMORY.md', 'topic.md'])
    expect(tampered?.content).toContain('Shell preference')
    expect(await f.session.snapshot(5)).toEqual(tampered)
    expect((await f.session.snapshot(6))?.externalChanges).toBeUndefined()
    await rm(join(f.session.root, 'topic.md'))
    expect((await f.session.snapshot(7))?.externalChanges).toEqual(['topic.md'])
    // Memory off injects nothing and so reports nothing.
    await writeFile(f.index, 'Shell while off')
    await f.session.configure({ mode: 'off' })
    expect(await f.session.snapshot(8)).toBeUndefined()
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
            return { status: 'approved' }
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

  it('denies cross-workspace and hardlink escapes and missing topic references', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto' })
    const other = fileMemoryProvider.open({ home: f.home, workspaceRoot: tmpdir(), sessionKey: 'elsewhere' })
    await expect(f.files(1).write(join(other.root, 'MEMORY.md'), 'cross workspace')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    const outside = join(f.home, 'outside.md')
    await writeFile(outside, 'outside')
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
  it('refuses symbolic memory files where the OS permits creating a file symlink', async ({ skip }) => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto' })
    const outside = join(f.home, 'outside.md')
    await writeFile(outside, 'outside')
    try {
      await symlink(outside, join(f.session.root, 'escape.md'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    await expect(f.files(1).write(join(f.session.root, 'escape.md'), 'escape')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    expect(await readFile(outside, 'utf8')).toBe('outside')
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

it.each(
  (['queued', 'temp-flushed'] as const).flatMap((boundary) =>
    (['epoch', 'deadline'] as const).map((loss) => ({ boundary, loss })),
  ),
)('refuses memory publication when $loss is lost at $boundary', async ({ boundary, loss }) => {
  const f = await fixture()
  await f.session.configure({ mode: 'ask' })
  let epoch = 1,
    now = 0
  const expire = () => {
    if (loss === 'epoch') epoch++
    else now = 10
  }
  const assertActive = () => {
    if (epoch !== 1 || now >= 10) throw Error('permission unavailable')
  }
  const admission = { verify: async () => assertActive(), assertActive }
  const { MemoryStore } = await import('../src/store.js')
  const { vi } = await import('vitest')
  const { readdir } = await import('node:fs/promises')
  const atomic = MemoryStore.prototype.atomic
  const spy = vi.spyOn(MemoryStore.prototype, 'atomic').mockImplementation(function (
    this: import('../src/store.js').MemoryStore,
    path,
    content,
    verify,
  ) {
    return atomic.call(this, path, content, () => {
      if (boundary === 'temp-flushed' && path === f.index) expire()
      verify?.()
    })
  })
  const lock = boundary === 'queued' ? new DatabaseSync(join(f.session.root, 'commit.sqlite')) : undefined
  lock?.exec('BEGIN EXCLUSIVE')
  try {
    const write = f
      .files(1, async () => ({ status: 'approved', admission }))
      .write(f.index, 'Reviewed preference.')
    const refused = expect(write).rejects.toThrow('permission unavailable')
    if (lock) {
      await Promise.resolve()
      expire()
      lock.exec('COMMIT')
    }
    await refused
    expect((await f.session.readFile('MEMORY.md')).content).toBe('')
    expect(await readdir(f.session.root)).not.toContain('writer.json')
    expect((await readdir(f.session.root)).filter((path) => path.endsWith('.tmp'))).toEqual([])
    spy.mockRestore()
    await f.files(2).write(f.index, 'Human-approved preference.')
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human-approved preference.')
  } finally {
    spy.mockRestore()
    lock?.close()
  }
})

it.each(['revocation', 'abort', 'expiry', 'epoch', 'stale-proof'])(
  'shared proof: refuses memory %s at final publication',
  async (loss) => {
    const { permissionEffectAdmission } = await import('@agnes/protocol')
    let active = true,
      now = 0,
      epoch = 0,
      version = 1
    const controller = new AbortController()
    const proof = permissionEffectAdmission({
      signals: [controller.signal],
      expiresAt: 10,
      clock: () => now,
      unavailable: () => Error('permission unavailable'),
      assertBound: () => {
        if (!active || epoch !== 0 || version !== 1) throw Error('permission unavailable')
      },
    })
    const lose = () => {
      if (loss === 'revocation') active = false
      if (loss === 'abort') controller.abort()
      if (loss === 'expiry') now = 10
      if (loss === 'epoch') epoch++
      if (loss === 'stale-proof') version++
    }
    const admission = {
      ...proof,
      verify: async () => {
        await proof.verify()
        lose()
      },
    }
    const f = await fixture()
    const { MemoryStore } = await import('../src/store.js')
    const { file } = await import('../src/content.js')
    const { roots } = await import('../src/paths.js')
    const store = new MemoryStore(roots(f.home, f.home).protectedRoot, f.session.root)
    const base = store.read('MEMORY.md').hash
    const candidate = file('MEMORY.md', 'Reviewed preference.')
    await expect(
      store.commit(candidate, base, { sessionKey: 'one', turn: 1 }, false, undefined, admission),
    ).rejects.toThrow('permission unavailable')
    expect(store.read('MEMORY.md').content).toBe('')
    expect(store.writer()).toBeUndefined()
    await store.commit(candidate, base, { sessionKey: 'one', turn: 1 }, false)
    await expect(store.commit(candidate, base, { sessionKey: 'one', turn: 1 }, false)).rejects.toThrow(
      'MEMORY_CONFLICT',
    )
  },
)
