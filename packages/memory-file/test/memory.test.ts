import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  MemoryApprovalResult,
  MemoryFilePort,
  MemoryParagraphValidity,
  MemoryProposal,
  MemoryValidityView,
} from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildView,
  createDefaultPipeline,
  fileMemoryProvider,
  MetaStore,
  mapViewSpanToRawLines,
  openMemory,
  readAuditEntries,
} from '../src/index.js'
import { roots } from '../src/paths.js'
import { MemoryStore } from '../src/store.js'

const homes: string[] = []
const PINNED_REVISION = 'd3c51a67de415b2e6c0e255064e93eb77fee5963d901fa3d060bcd478f922787'
const PINNED_CONTENT = [
  'Agent memory (untrusted learned preferences; AGENTS.md and knowledge sources take precedence). Revision: d3c51a67de415b2e6c0e255064e93eb77fee5963d901fa3d060bcd478f922787.',
  "Workspace memory directory: <root>. Use normal read/write/edit tools; topic reads share this turn's revision.",
  'Policy: auto. Consolidate rather than append; never save secrets, one-off details, history or knowledge-base content.',
  'Workspace convention: focused changes.\n',
  'User memory (read-only for the agent):\n# Preferences\n\n- Answer in short sentences.\n- Prefer pnpm over npm.\n',
].join('\n\n')
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
      const queued = f.files(5).write(f.index, 'Human preference\n\nQueued automatic candidate')
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
        .write(f.index, 'Human preference\n\nApproved too late'),
    ).rejects.toMatchObject({ code: 'MEMORY_DISABLED' })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Human preference')
    await f.session.configure({ mode: 'ask' })
    const abort = new AbortController()
    const cancelled = f.session.files(fallback, { sessionKey: 'one', turn: 4 }, abort.signal, async () => {
      abort.abort(new Error('cancelled'))
      return { status: 'approved' }
    })
    await expect(cancelled.write(f.index, 'Human preference\n\nCancelled candidate')).rejects.toThrow(
      'cancelled',
    )
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
    await f.files(1).write(f.index, 'Pre-existing preference\n\nAgent preference')
    expect((await f.session.snapshot(2))?.externalChanges).toBeUndefined()
    const current = await f.session.readFile('MEMORY.md')
    await f.session.editFile('MEMORY.md', 'Human preference', current.hash)
    expect((await f.session.snapshot(3))?.externalChanges).toBeUndefined()
    const two = f.open('two')
    await two
      .files(fallback, { sessionKey: 'two', turn: 1 }, new AbortController().signal, async () => ({
        status: 'approved',
      }))
      .write(f.index, 'Human preference\n\nOther session preference')
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
    expect(context?.content).toContain('Memory truncated at the size limit')
    // The limit is the workspace layer's; the fixed header lines are not counted.
    expect(
      Buffer.byteLength((context?.content ?? '').split('\n\n').slice(3).join('\n\n')),
    ).toBeLessThanOrEqual(128)
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
    expect(userLayer).toContain('memory truncated at the size limit')
  })
})

describe('user memory without saved sections', () => {
  // Recorded before user memory could hold saved task experience: a user memory file without any
  // marker must keep giving exactly these bytes and this revision.
  it('user memory without RSI sections keeps byte-identical content and revision', async () => {
    const f = await fixture()
    const user = join(f.home, 'memory', 'user')
    await mkdir(user, { recursive: true })
    await writeFile(
      join(user, 'MEMORY.md'),
      '# Preferences\n\n- Answer in short sentences.\n- Prefer pnpm over npm.\n',
    )
    await f.session.configure({ mode: 'auto', userEnabled: true })
    await f.files(1).write(f.index, 'Workspace convention: focused changes.\n')
    const snapshot = await f.session.snapshot(2)
    expect(snapshot?.revision).toBe(PINNED_REVISION)
    expect(snapshot?.content.split(f.session.root).join('<root>')).toBe(PINNED_CONTENT)
    expect(snapshot?.omitted).toBe(false)
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

describe('the injection limits, in bytes', () => {
  const layer = (content: string | undefined) => (content ?? '').split('\n\n').slice(3).join('\n\n')

  it('default to 8 KiB and 2 KiB; stored old defaults read as the new ones, other values are kept', async () => {
    const f = await fixture()
    expect((await f.session.inspect()).settings).toMatchObject({ tokenBudget: 8192, userTokenBudget: 2048 })
    await f.session.configure({ mode: 'auto' })
    await writeFile(
      join(f.session.root, 'settings.json'),
      JSON.stringify({ mode: 'auto', tokenBudget: 2048, userTokenBudget: 512 }),
    )
    expect((await f.session.inspect()).settings).toMatchObject({ tokenBudget: 8192, userTokenBudget: 2048 })
    await writeFile(
      join(f.session.root, 'settings.json'),
      JSON.stringify({ mode: 'auto', tokenBudget: 3000, userTokenBudget: 512 }),
    )
    expect((await f.session.inspect()).settings).toMatchObject({ tokenBudget: 3000, userTokenBudget: 512 })
  })

  it('the fixed header does not count toward the workspace limit', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto', tokenBudget: 256 })
    const text = `${'x'.repeat(250)}\n`
    await f.files(1).write(f.index, text)
    const snapshot = await f.session.snapshot(2)
    expect(snapshot?.omitted).toBe(false)
    expect(snapshot?.content).toContain(text.trimEnd())
  })

  it('cuts at a whole line and says how much is left, from which line of which file', async () => {
    const f = await fixture()
    await f.session.configure({ mode: 'auto', tokenBudget: 600 })
    const lines = Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 条：中文约定写在这里，一条一行。`)
    const text = `${lines.slice(0, 20).join('\n')}\n\n${lines.slice(20).join('\n')}\n`
    await f.files(1).write(f.index, text)
    const content = layer((await f.session.snapshot(2))?.content)
    const notice =
      /\[Memory truncated at the size limit: (\d+) more paragraphs \(about ([\d.]+) KB\) not shown, from line (\d+) of (.+)\. Read them with the read tool when they may matter\.\]$/u.exec(
        content,
      )
    expect(notice).not.toBeNull()
    const [, , kb, line, path] = notice as RegExpExecArray
    expect(path).toBe(f.index)
    const shown = content.slice(0, notice?.index).replace(/\n$/u, '')
    // Whole lines only, and never half a character.
    for (const row of shown.split('\n')) expect(row === '' || lines.includes(row)).toBe(true)
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(600)
    // Reading from that line gives the first line that was left out.
    const all = text.split('\n')
    expect(text.startsWith(shown)).toBe(true)
    expect(Number(line)).toBe(shown.split('\n').length + 1)
    expect(all.slice(Number(line) - 1).join('\n')).toBe(text.slice(shown.length + 1))
    expect(Number(kb)).toBeGreaterThan(0)
  })
})

describe('phase 0 view pipeline, same-turn R1-R6 overlay and audit log', () => {
  const block = (id: string, body: string) =>
    `<!-- refinement:${id} -->\n${body}\n<!-- /refinement:${id} -->\n`
  const makeValidity = (initial: Record<string, MemoryParagraphValidity>) => {
    const map = new Map(Object.entries(initial))
    let rev = 1
    return {
      view: {
        revision: () => `v${rev}`,
        validity: (id: string) => map.get(id) ?? 'unknown',
      } satisfies MemoryValidityView,
      set(id: string, val: MemoryParagraphValidity) {
        map.set(id, val)
        rev++
      },
    }
  }

  it('keeps snapshot(1) fixed while R2 overlay hides withdrawn, expired, deleted and emptied entries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agh-phase0-r2-'))
    homes.push(home)
    let now = 1_000
    const validity = makeValidity({ ra000000001: 'valid', rb000000002: 'expired' })
    const pipeline = createDefaultPipeline()
    pipeline.addViewFilter((entry, ctx) => {
      if (entry.path !== 'topic-exp.md' || ctx.now < 2_000) return []
      const at = entry.content.indexOf('EXPIRES_SOON')
      return at === -1
        ? []
        : [
            {
              start: at,
              end: entry.content.length,
              appliesTo: 'both',
              reason: 'test-expiry',
              notice: '[expired]',
            },
          ]
    })
    pipeline.addNextExpiry((files) => (files.some((f) => f.path === 'topic-exp.md') ? 2_000 : undefined))

    const session = openMemory({
      home,
      workspaceRoot: home,
      sessionKey: 'r2',
      validity: validity.view,
      clock: () => now,
      pipeline,
    })
    await session.configure({ mode: 'auto' })
    const index = join(session.root, 'MEMORY.md')
    const topicExp = join(session.root, 'topic-exp.md')
    const topicDel = join(session.root, 'topic-del.md')
    const emptyFile = join(session.root, 'empty.md')
    await writeFile(
      index,
      `${block('ra000000001', 'RULE_VALID')}${block('rb000000002', 'RULE_RENEWED')}- base\n`,
    )
    await writeFile(topicExp, 'keep\nEXPIRES_SOON\n')
    await writeFile(topicDel, 'gone soon\n')
    await writeFile(emptyFile, 'will clear\n')

    const s1a = await session.snapshot(1)
    const p1 = session.files(
      fallback,
      { sessionKey: 'r2', turn: 1, toolUseId: 't1' },
      new AbortController().signal,
      async () => ({ status: 'approved' }),
    )
    expect(Buffer.from(await p1.read(index)).toString('utf8')).toContain('RULE_VALID')
    expect(Buffer.from(await p1.read(topicExp)).toString('utf8')).toContain('EXPIRES_SOON')

    validity.set('ra000000001', 'unknown')
    validity.set('rb000000002', 'valid')
    now = 2_500
    await rm(topicDel)
    await writeFile(emptyFile, '')

    const s1b = await session.snapshot(1)
    expect(s1b?.revision).toBe(s1a?.revision)
    expect(s1b?.content).toBe(s1a?.content)

    const readIndex = Buffer.from(await p1.read(index)).toString('utf8')
    expect(readIndex).not.toContain('RULE_VALID')
    expect(readIndex).not.toContain('RULE_RENEWED')
    if (!p1.revision) throw new Error('expected revision port')
    expect(await p1.revision(index)).not.toBe(s1a?.revision)
    expect(Buffer.from(await p1.read(topicExp)).toString('utf8')).not.toContain('EXPIRES_SOON')
    await expect(p1.read(topicDel)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(p1.stat(topicDel)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(p1.revision(topicDel)).rejects.toMatchObject({ code: 'ENOENT' })
    const names = (await p1.list(session.root)).map((e) => e.name)
    expect(names).not.toContain('topic-del.md')
    expect(names).toContain('empty.md')
    expect(Buffer.from(await p1.read(emptyFile)).toString('utf8')).toBe('')
    expect((await p1.stat(emptyFile)).size).toBe(0)

    const s2 = await session.snapshot(2)
    expect(s2?.content).toContain('RULE_RENEWED')
    expect(s2?.content).not.toContain('RULE_VALID')
    expect(s2?.revision).not.toBe(s1a?.revision)
  })

  it('preserves R3 conflicts, R4 replaceExact + line mapping on hidden topics, R5 recall and R6 writes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agh-phase0-r35-'))
    homes.push(home)
    const validity = makeValidity({ rc000000003: 'valid' })
    const pipeline = createDefaultPipeline()
    const topicFilter = (entry: { path: string; content: string }) => {
      if (entry.path !== 'topic.md') return []
      const at = entry.content.indexOf('SECRET_HIDDEN\n')
      return at === -1
        ? []
        : [
            {
              start: at,
              end: at + 'SECRET_HIDDEN\n'.length,
              appliesTo: 'both' as const,
              reason: 'secret-hide',
              notice: '[hidden block]',
            },
          ]
    }
    pipeline.addViewFilter(topicFilter)
    pipeline.setRecall(async (query, env) => {
      const hits = []
      for (const entry of env.workspaceFiles) {
        const view = env.workspaceViews.get(entry.path)
        if (!view) continue
        const idx = view.content.indexOf(query.query)
        if (idx === -1) continue
        const span = mapViewSpanToRawLines(entry.content, view, idx, idx + query.query.length)
        if (span)
          hits.push({
            layer: 'workspace' as const,
            path: entry.path,
            lineStart: span.lineStart,
            lineEnd: span.lineEnd,
            text: query.query,
            score: 1,
          })
      }
      return { revision: env.revision, hits, truncated: false }
    })

    const session = openMemory({
      home,
      workspaceRoot: home,
      sessionKey: 'r35',
      validity: validity.view,
      pipeline,
    })
    await session.configure({ mode: 'auto' })
    const index = join(session.root, 'MEMORY.md')
    const topic = join(session.root, 'topic.md')
    const extra = join(session.root, 'extra.md')
    await writeFile(index, `${block('rc000000003', 'RECALL_ME')}tabs=2\n`)
    await session
      .files(
        fallback,
        { sessionKey: 'r35', turn: 0, toolUseId: 'seed' },
        new AbortController().signal,
        async () => ({ status: 'approved' }),
      )
      .write(topic, 'line1\nSECRET_HIDDEN\nvisible tail\n')

    const s1 = await session.snapshot(1)
    const p1 = session.files(
      fallback,
      { sessionKey: 'r35', turn: 1, toolUseId: 't' },
      new AbortController().signal,
      async () => ({ status: 'approved' }),
    )
    expect(Buffer.from(await p1.read(index)).toString('utf8')).toContain('tabs=2')

    await session.editFile(
      'MEMORY.md',
      `${block('rc000000003', 'RECALL_ME')}tabs=4\n`,
      (await session.readFile('MEMORY.md')).hash,
      { actor: 'bob' },
    )
    expect(Buffer.from(await p1.read(index)).toString('utf8')).toContain('tabs=2')
    await expect(
      p1.write(index, `${block('rc000000003', 'RECALL_ME')}tabs=2\nextra\n`),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })

    await expect(p1.write(topic, 'overwrite\n')).rejects.toMatchObject({ code: 'MEMORY_HIDDEN_PARAGRAPHS' })
    await expect(p1.replaceExact?.(topic, '[hidden block]', 'x')).rejects.toMatchObject({
      code: 'MEMORY_HIDDEN_PARAGRAPHS',
    })
    await expect(p1.replaceExact?.(topic, 'SECRET_HIDDEN', 'x')).rejects.toMatchObject({
      code: 'MEMORY_REPLACE_NOT_FOUND',
    })
    await p1.replaceExact?.(topic, 'visible tail', 'visible tail v2')
    expect(await readFile(topic, 'utf8')).toBe('line1\nSECRET_HIDDEN\nvisible tail v2\n')

    const rawTopic = await readFile(topic, 'utf8')
    const topicFile = {
      path: 'topic.md',
      content: rawTopic,
      hash: '',
      bytes: Buffer.byteLength(rawTopic),
      lines: 4,
    }
    const mappedView = buildView(topicFile, topicFilter(topicFile), 'read')
    const visAt = mappedView.content.indexOf('visible tail v2')
    expect(mapViewSpanToRawLines(rawTopic, mappedView, visAt, visAt + 'visible tail v2'.length)).toEqual({
      lineStart: 3,
      lineEnd: 3,
    })

    await p1.write(extra, 'BRAND_NEW_FACT\n')
    expect((await session.snapshot(1))?.revision).toBe(s1?.revision)
    expect((await p1.recall?.({ query: 'BRAND_NEW_FACT' }))?.hits).toEqual([])

    validity.set('rc000000003', 'unknown')
    expect((await p1.recall?.({ query: 'RECALL_ME' }))?.hits).toEqual([])
    const p2 = session.files(
      fallback,
      { sessionKey: 'r35', turn: 2, toolUseId: 't2' },
      new AbortController().signal,
      async () => ({ status: 'approved' }),
    )
    expect((await p2.recall?.({ query: 'BRAND_NEW_FACT' }))?.hits).toMatchObject([
      { path: 'extra.md', lineStart: 1, lineEnd: 1 },
    ])
  })

  it('writes audit entries, rejects before approve(), rotates at 1 MiB, and runs close hooks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agh-phase0-audit-'))
    homes.push(home)
    let closed = false
    const pipeline = createDefaultPipeline()
    pipeline.addGuard((intent) =>
      intent.origin !== 'human' && intent.candidate.content.includes('CLOBBER_HUMAN')
        ? { kind: 'refuse', code: 'MEMORY_HUMAN_EDITED', detail: 'protected' }
        : { kind: 'allow' },
    )
    pipeline.addCloseHook(() => {
      closed = true
    })

    const session = openMemory({
      home,
      workspaceRoot: home,
      sessionKey: 'aud',
      clock: () => 1_700_000_000_000,
      pipeline,
    })
    await session.configure({ mode: 'auto' })
    const topic = join(session.root, 'topic.md')
    await session.editFile(
      'topic.md',
      'SECRET_DO_NOT_LOG_BODY\n',
      (await session.readFile('topic.md')).hash,
      { actor: 'alice' },
    )
    let approveCalls = 0
    const pAuto = session.files(
      fallback,
      { sessionKey: 'aud', turn: 1, toolUseId: 'w1' },
      new AbortController().signal,
      async () => {
        approveCalls++
        return { status: 'approved' }
      },
    )
    await pAuto.write(topic, 'SECRET_DO_NOT_LOG_BODY\n\nAGENT_BODY\n')
    const para = session.paragraphs?.(
      { sessionKey: 'aud', turn: 0, maintenance: 'run-7' },
      new AbortController().signal,
    )
    await para?.commit(await para.propose({ op: 'put', id: 'ra000000001', text: 'HOST_BODY' }))

    await session.configure({ mode: 'ask' })
    const pAsk = session.files(
      fallback,
      { sessionKey: 'aud', turn: 2, toolUseId: 'w2' },
      new AbortController().signal,
      async () => {
        approveCalls++
        return { status: 'approved' }
      },
    )
    await expect(pAsk.write(topic, 'CLOBBER_HUMAN\n')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
    expect(approveCalls).toBe(0)

    const p = roots(home, home)
    const meta = new MetaStore(new MemoryStore(p.protectedRoot, p.root))
    const entries = readAuditEntries(meta)
    expect(entries.map((e) => [e.action, e.origin, e.actor, e.code ?? null])).toEqual([
      ['commit', 'human', 'alice', null],
      ['commit', 'agent', 'agent:aud:w1', null],
      ['commit', 'host', 'host:run-7', null],
      ['refused', 'agent', 'agent:aud:w2', 'MEMORY_HUMAN_EDITED'],
    ])
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('SECRET_DO_NOT_LOG_BODY')
    expect(serialized).not.toContain('CLOBBER_HUMAN')

    await writeFile(
      meta.pathOf('audit.jsonl'),
      `${JSON.stringify({ seq: 99, at: '2026-01-01T00:00:00.000Z', path: 'topic.md', action: 'commit', origin: 'human', actor: 'pad', beforeHash: '0', afterHash: '1', pad: 'x'.repeat(1024 * 1024) })}\n`,
    )
    await session.editFile('topic.md', 'AFTER_ROTATE\n', (await session.readFile('topic.md')).hash, {
      actor: 'alice',
    })
    expect(JSON.parse((await readFile(meta.pathOf('audit.jsonl'), 'utf8')).trim()).seq).toBe(100)
    expect(await readFile(meta.pathOf('audit.1.jsonl'), 'utf8')).toContain('"seq":99')

    await session.close?.()
    expect(closed).toBe(true)
  })
})
