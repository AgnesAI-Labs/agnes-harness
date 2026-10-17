import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryApprovalResult, MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { fileMemoryProvider } from '../src/index.js'

type ReviewSnapshot = { revision: string; files: { path: string; hash: string; content: string }[] }
type ReviewProposal = {
  groups: { kind: string; reason: string; sources: { path: string; hash: string }[] }[]
  edits: {
    path: string
    content: string
    baseHash: string
    reason: string
    sources: { path: string; hash: string }[]
  }[]
}
type Review = {
  version: number
  revision: string
  groups: ReviewProposal['groups']
  edits: (ReviewProposal['edits'][number] & { newHash: string; diff: string })[]
}
const review = (await import(
  new URL('../../package-manager/bundled-plugins/memory-review/src/review.mjs', import.meta.url).href
)) as {
  hash(text: string): string
  memoryScope(view: unknown): { root: string; revision: string }
  scan(
    scope: { root: string; revision: string },
    fs: MemoryFilePort,
    signal: AbortSignal,
  ): Promise<ReviewSnapshot>
  preview(snapshot: ReviewSnapshot, proposal: ReviewProposal): Review
  applyReview(
    scope: { root: string; revision: string },
    snapshot: ReviewSnapshot,
    candidate: Review,
    fs: MemoryFilePort,
    signal: AbortSignal,
  ): Promise<{ status: string; committed: { path: string; hash: string }[]; failed?: string; code?: string }>
}

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

// The optional plugin consumes the real provider's public mediated file contract.
describe('reviewed memory consolidation', () => {
  async function prepared() {
    const f = await fixture()
    await f.session.configure({ mode: 'ask', tokenBudget: 4096 })
    await f.session.editFile('MEMORY.md', 'Use pnpm. See preferences.md.', review.hash(''))
    await f.session.editFile('preferences.md', 'Use pnpm. Use npm.', review.hash(''))
    const captured = await f.session.snapshot(1)
    const scope = review.memoryScope({
      prompt: { sections: [{ id: 'memory:index', source: 'memory', text: captured?.content }] },
    })
    const snapshot = await review.scan(scope, f.files(1), new AbortController().signal)
    const source = snapshot.files.map(({ path, hash }) => ({ path, hash }))
    const candidate = review.preview(snapshot, {
      groups: [{ kind: 'conflict', reason: 'The task confirms pnpm; the topic disagrees.', sources: source }],
      edits: snapshot.files.map((file) => ({
        path: file.path,
        baseHash: file.hash,
        content: file.path === 'MEMORY.md' ? 'Use pnpm. Retired preferences.md.' : '',
        reason: 'Keep the confirmed workspace convention; retire the conflicting duplicate.',
        sources: source,
      })),
    })
    return { ...f, scope, snapshot, candidate }
  }

  it('binds complete diffs and both hashes to native per-file approvals, preserving provenance and turn snapshots', async () => {
    const f = await prepared()
    const approvals: MemoryProposal[] = []
    // A durable JSON round trip may reorder object keys without changing the reviewed candidate.
    const candidate = JSON.parse(
      JSON.stringify(f.candidate, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    ) as Review
    const receipt = await review.applyReview(
      f.scope,
      f.snapshot,
      candidate,
      f.files(1, async (proposal) => {
        approvals.push(proposal)
        return { status: 'approved' }
      }),
      new AbortController().signal,
    )
    expect(receipt.status).toBe('completed')
    expect(approvals).toHaveLength(2)
    for (const [i, proposal] of approvals.entries()) {
      const edit = f.candidate.edits[i]
      if (!edit) throw new Error('Missing expected replacement')
      expect(proposal).toMatchObject({
        baseHash: edit.baseHash,
        newHash: edit.newHash,
        diff: edit.diff,
        source: { turn: 1, sessionKey: 'one' },
      })
      expect(edit.diff).toContain('+Memory review provenance')
      expect(edit.diff).toContain(f.scope.revision)
    }
    expect(approvals[0]?.path).toBe(join(f.session.root, 'preferences.md'))
    expect(await f.files(1).read(f.index)).toEqual(Buffer.from('Use pnpm. See preferences.md.'))
    expect((await f.session.snapshot(2))?.revision).not.toBe(f.scope.revision)
    expect((await f.session.readFile('preferences.md')).content).toContain(f.snapshot.files[0]?.hash)
  })

  it.each(['rejected', 'unanswered'] as const)('preserves memory on %s approval', async (status) => {
    const f = await prepared()
    const receipt = await review.applyReview(
      f.scope,
      f.snapshot,
      f.candidate,
      f.files(1, async () => (status === 'rejected' ? { status } : { status, reason: 'stopped' })),
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ status: 'failed', committed: [] })
    expect((await f.session.readFile('preferences.md')).content).toBe('Use pnpm. Use npm.')
  })

  it('reports a committed topic and refused index as partial without rollback or retry', async () => {
    const f = await prepared()
    const receipt = await review.applyReview(
      f.scope,
      f.snapshot,
      f.candidate,
      f.files(1, async (proposal) => ({
        status: proposal.path.endsWith('/MEMORY.md') ? 'rejected' : 'approved',
      })),
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({
      status: 'partial',
      failed: 'MEMORY.md',
      code: 'MEMORY_APPROVAL_REJECTED',
      committed: [{ path: 'preferences.md' }],
    })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('Use pnpm. See preferences.md.')
    expect((await f.session.readFile('preferences.md')).content).toContain('Memory review provenance')
  })

  it('preserves a concurrent human edit through the provider CAS, even though the turn snapshot stays unchanged', async () => {
    const f = await prepared()
    const receipt = await review.applyReview(
      f.scope,
      f.snapshot,
      f.candidate,
      f.files(1, async (proposal) => {
        await f.session.editFile('preferences.md', 'Human correction', proposal.baseHash)
        return { status: 'approved' }
      }),
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ status: 'failed', committed: [], code: 'MEMORY_CONFLICT' })
    expect((await f.session.readFile('preferences.md')).content).toBe('Human correction')
  })

  it('refuses off, auto, a forged scope, a stale revision, tampering, secret-like proposals and cross-workspace access', async () => {
    const f = await prepared()
    expect(() => review.memoryScope({ prompt: { sections: [] } })).toThrow('MEMORY_REVIEW_DISABLED')
    const section = {
      id: 'memory:index',
      source: 'memory',
      text: (await f.session.snapshot(1))?.content.replace('Policy: ask.', 'Policy: auto.'),
    }
    expect(() => review.memoryScope({ prompt: { sections: [section] } })).toThrow(
      'MEMORY_REVIEW_REQUIRES_ASK',
    )
    expect(() => review.memoryScope({ prompt: { sections: [{ ...section, source: 'user' }] } })).toThrow(
      'MEMORY_REVIEW_DISABLED',
    )
    await expect(
      review.applyReview(
        { ...f.scope, revision: 'stale' },
        f.snapshot,
        f.candidate,
        f.files(1),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MEMORY_REVIEW_STALE')
    const tampered = structuredClone(f.candidate)
    const changed = tampered.edits[0]
    if (!changed) throw new Error('Missing expected replacement')
    changed.diff += '\n+hidden'
    await expect(
      review.applyReview(f.scope, f.snapshot, tampered, f.files(1), new AbortController().signal),
    ).rejects.toThrow('MEMORY_REVIEW_INVALID_PROPOSAL')
    expect(() =>
      review.preview(f.snapshot, {
        groups: [],
        edits: [{ ...changed, content: 'api_key=synthetic_bad_credential' }],
      }),
    ).toThrow('MEMORY_SECRET_LIKE_CONTENT')
    const many = {
      revision: f.scope.revision,
      files: Array.from({ length: 8 }, (_, i) => ({
        path: `topic-${i}.md`,
        content: 'a'.repeat(8192),
        hash: review.hash('a'.repeat(8192)),
      })),
    }
    expect(() =>
      review.preview(many, {
        groups: [],
        edits: many.files.map((file) => ({
          path: file.path,
          baseHash: file.hash,
          content: 'b'.repeat(16000),
          reason: 'Bound the complete review, never truncate its diff.',
          sources: [{ path: file.path, hash: file.hash }],
        })),
      }),
    ).toThrow('MEMORY_REVIEW_LIMIT')
    const other = fileMemoryProvider.open({
      home: f.home,
      workspaceRoot: join(f.home, 'other-workspace'),
      sessionKey: 'other',
    })
    await other.configure({ mode: 'ask' })
    await expect(
      review.scan(
        f.scope,
        other.files(fallback, { sessionKey: 'other', turn: 1 }, new AbortController().signal, async () => ({
          status: 'approved',
        })),
        new AbortController().signal,
      ),
    ).rejects.toThrow('MEMORY_SCOPE_DENIED')
    await f.session.configure({ mode: 'off' })
    await expect(review.scan(f.scope, f.files(1), new AbortController().signal)).rejects.toThrow(
      'MEMORY_DISABLED',
    )
    await expect(f.files(1).write(f.index, 'No permission')).rejects.toThrow('MEMORY_DISABLED')
  })

  it('refuses cancelled publication and a policy change during exact approval', async () => {
    const f = await prepared()
    const signal = new AbortController()
    signal.abort()
    const cancelled = await review.applyReview(f.scope, f.snapshot, f.candidate, f.files(1), signal.signal)
    expect(cancelled).toMatchObject({ status: 'failed', committed: [], code: 'MEMORY_REVIEW_CANCELLED' })
    const receipt = await review.applyReview(
      f.scope,
      f.snapshot,
      f.candidate,
      f.files(1, async () => {
        await f.session.configure({ mode: 'auto' })
        return { status: 'approved' }
      }),
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ status: 'failed', committed: [], code: 'MEMORY_POLICY_CHANGED' })
  })
})
