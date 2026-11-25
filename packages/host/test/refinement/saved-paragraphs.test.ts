import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import type { WorkspaceSaveRequest } from '@agnes/core'
import type { MemoryProvider } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
} from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { manageMemory } from '../../src/runtime/memory/admin.js'
import { WORKSPACE_MEMORY_KEY } from '../../src/runtime/refinement/reconcile.js'
import { registryView } from '../../src/runtime/refinement/registry-view.js'
import { describeParagraphs, savedParagraphs } from '../../src/runtime/refinement/saved-paragraphs.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 10, 4)
const DAY = 86_400_000
const A = 'ra000000001'
const B = 'rb000000001'
const C = 'rc000000001'
const marked = (id: string, text: string) => `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->`
const paragraph = (id: string, text: string, reviewAfter: number): RegistryParagraph => ({
  id,
  source: {
    sessionKey: 'session-1',
    kind: 'memory',
    entryId: `entry-${id}`,
    contentHash: normalizedContentHash(`entry ${id}`),
    initiator: 'auto',
  },
  contentHash: normalizedContentHash(text),
  reviewAfter,
  state: 'active',
  fileHash: 'f',
})

const provider = (): MemoryProvider => {
  let found: MemoryProvider | undefined
  memoryPlugin.apply({
    providers: {
      register: (_kind: unknown, value: MemoryProvider) => {
        found = value
      },
    },
  } as never)
  if (!found) throw new Error('memory provider not registered')
  return found
}

/** A workspace with a registry and the bundled file memory, opened the way the Host opens it. */
async function workspace(mode: 'off' | 'ask' | 'auto' = 'auto') {
  const home = mkdtempSync(join(tmpdir(), 'agnes-saved-paragraphs-'))
  dirs.push(home)
  const root = join(home, 'ws')
  mkdirSync(root)
  const dataDir = join(home, 'data')
  const now = { value: T0 }
  const clock = () => now.value
  const registry = () => new RefinementRegistry(dataDir, root, clock)
  const open = (sessionKey = 'human-editor') =>
    provider().open({
      home,
      workspaceRoot: root,
      sessionKey,
      // As sessions get it: paragraphs in force are delivered through the experience snapshot.
      validity: registryView(registry(), clock, undefined, 'delivered'),
    })
  const withSession = async <T>(
    fn: (memory: ReturnType<typeof open>) => Promise<T>,
    sessionKey?: string,
  ): Promise<T> => {
    const memory = open(sessionKey)
    try {
      return await fn(memory)
    } finally {
      await memory.close?.()
    }
  }
  await withSession((memory) => memory.configure({ mode }))
  const file = () => withSession(async (memory) => (await memory.readFile('MEMORY.md')).content)
  const write = (content: string) =>
    withSession(async (memory) => {
      await memory.editFile('MEMORY.md', content, (await memory.readFile('MEMORY.md')).hash)
    })
  const seed = (...paragraphs: RegistryParagraph[]) => {
    const store = registry()
    store.update((draft) => {
      draft.paragraphs.push(...paragraphs)
    }, store.read().revision)
  }
  const manage = savedParagraphs({ registry, clock })
  const run = (action: 'list' | 'renew' | 'withdraw' | 'convert', paragraphId?: string) =>
    withSession((memory) => manage(memory, root, { action, ...(paragraphId ? { paragraphId } : {}) }))
  return { root, now, clock, registry, open, file, write, seed, run, withSession }
}

const HUMAN = 'Human line.\n'
const LESSON_A = 'Lint first\nRun pnpm lint before committing.'
const LESSON_B = 'Short answers\nKeep answers short.'
const LESSON_C = 'Unconfirmed\nA save whose result is not known.'

describe('saved paragraphs on the memory page', () => {
  it('lists saved paragraphs with their review dates and the ones the agent does not see', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + 10 * DAY), paragraph(B, LESSON_B, T0 - DAY))
    await ws.write(`${HUMAN}\n${marked(A, LESSON_A)}\n\n${marked(B, LESSON_B)}\n\n${marked(C, LESSON_C)}\n`)
    const memory = ws.open()
    try {
      const listed = await memory
        .paragraphs?.({ sessionKey: 'human-editor', turn: 0 }, new AbortController().signal)
        .list()
      if (!listed) throw new Error('missing paragraph port')
      for (const [providerB, providerC, expectedB] of [
        ['valid', 'valid', 'expired'],
        ['unknown', 'expired', 'unknown'],
      ] as const) {
        const reported = {
          ...listed,
          paragraphs: listed.paragraphs.map((p) => ({
            ...p,
            validity: p.id === B ? providerB : p.id === C ? providerC : p.validity,
          })),
        }
        expect(
          await describeParagraphs(reported, memory, 'workspace', ws.registry(), ws.clock),
        ).toMatchObject([
          { id: A, validity: 'valid' },
          { id: B, validity: expectedB },
          { id: C, validity: 'unknown' },
        ])
      }
    } finally {
      await memory.close?.()
    }
    const { paragraphs } = await ws.run('list')
    expect(paragraphs).toEqual([
      {
        id: A,
        text: LESSON_A,
        renewable: true,
        validity: 'valid',
        reviewAfter: T0 + 10 * DAY,
        initiator: 'auto',
        kind: 'memory',
      },
      {
        id: B,
        text: LESSON_B,
        renewable: true,
        validity: 'expired',
        reviewAfter: T0 - DAY,
        initiator: 'auto',
        kind: 'memory',
      },
      // Nothing vouches for C (for example a save whose result is not known): hidden until a person acts.
      { id: C, text: LESSON_C, validity: 'unknown', renewable: false },
    ])
  })

  it('marks only valid paragraphs whose whole body is hidden', async () => {
    const ws = await workspace()
    const deadline = Date.UTC(2099, 0, 1)
    const partial = `Still visible\n\n<!-- ref:${C} -->\nHidden block`
    ws.seed(paragraph(A, LESSON_A, T0 + DAY), paragraph(B, partial, T0 + DAY))
    await ws.write(
      `<!-- expires_at: 2020-01-01 -->\n${marked(A, LESSON_A)}\n\n<!-- expires_at: ${new Date(deadline).toISOString()} -->\n${marked(B, partial)}`,
    )
    const { paragraphs } = await ws.run('list')
    expect(paragraphs[0]).toMatchObject({ id: A, text: LESSON_A, validity: 'valid', hidden: true })
    expect(paragraphs[1]).toMatchObject({
      id: B,
      text: partial,
      validity: 'valid',
      nextExpiry: deadline,
      renewable: false,
    })
    expect(paragraphs[1]).not.toHaveProperty('hidden')
    await expect(ws.run('renew', A)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_NOT_RENEWABLE' })
  })

  it('rejects a renewal if the verified registry changes before publication', async () => {
    const ws = await workspace()
    const target = paragraph(A, LESSON_A, T0 + DAY)
    ws.seed(target)
    await ws.write(marked(A, LESSON_A))
    const registry = ws.registry()
    const renew = registry.renew.bind(registry)
    vi.spyOn(registry, 'renew').mockImplementation((...args) => {
      registry.update((draft) => {
        draft.revocations.push({ ...target.source, action: 'memory-withdrawn', at: T0 })
      }, registry.read().revision)
      return renew(...args)
    })
    const manage = savedParagraphs({ registry: () => registry, clock: ws.clock })
    await expect(
      ws.withSession((memory) => manage(memory, ws.root, { action: 'renew', paragraphId: A })),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(registry.read().paragraphs).toEqual([target])
  })

  it('declines human renewal when the editor removed the listed paragraph', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    await ws.write(marked(A, LESSON_A))
    const before = ws.registry().read()
    await ws.withSession(async (memory) => {
      const manage = savedParagraphs(ws)
      const { stateRevision: _revision, ...legacy } = memory
      expect((await manage(legacy, ws.root, { action: 'list' })).paragraphs).toMatchObject([
        { renewable: false },
      ])
      await expect(manage(legacy, ws.root, { action: 'renew', paragraphId: A })).rejects.toMatchObject({
        code: 'MEMORY_PARAGRAPH_NOT_RENEWABLE',
      })
      const port = memory.paragraphs!({ sessionKey: 'human-editor', turn: 0 }, new AbortController().signal)
      const session = {
        ...memory,
        paragraphs: () => ({
          ...port,
          async list() {
            const listed = await port.list()
            await memory.editFile('MEMORY.md', '', listed.hash)
            return listed
          },
        }),
      }
      await expect(manage(session, ws.root, { action: 'renew', paragraphId: A })).rejects.toMatchObject({
        code: 'MEMORY_CONFLICT',
      })
    })
    expect(ws.registry().read()).toEqual(before)
  })

  it('withdraws a workspace paragraph while preserving an unrelated credential verbatim', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    const invalid = 'password=synthetic-example\r\n'
    const stored = `${invalid}\n${marked(A, LESSON_A)}\n`
    await ws.withSession(async (memory) => {
      writeFileSync(join(memory.root, 'MEMORY.md'), stored)
    })
    expect((await ws.run('list')).paragraphs).toMatchObject([{ id: A, hidden: true, renewable: false }])
    await expect(ws.run('convert', A)).rejects.toMatchObject({ code: 'MEMORY_SECRET_LIKE_CONTENT' })
    await expect(ws.write(stored.replace(LESSON_A, 'edited'))).rejects.toMatchObject({
      code: 'MEMORY_SECRET_LIKE_CONTENT',
    })
    expect((await ws.run('withdraw', A)).paragraphs).toEqual([])
    expect(await ws.file()).toBe(invalid)
    expect(ws.registry().read()).toMatchObject({
      paragraphs: [{ id: A, state: 'removed' }],
      revocations: [{ action: 'memory-withdrawn' }],
    })
  })

  it('keeps an oversized index manageable after lowering the line limit', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    const hand = 'First line.\nSecond line.\n'
    await ws.write(`${hand}\n${marked(A, LESSON_A)}\n`)
    await ws.withSession((memory) => memory.configure({ indexMaxLines: 1 }))
    expect((await ws.run('list')).paragraphs).toMatchObject([{ id: A, hidden: true, renewable: false }])
    await expect(ws.write('password=synthetic-example\nsecond')).rejects.toMatchObject({
      code: 'MEMORY_SECRET_LIKE_CONTENT',
    })
    await ws.withSession(async (memory) => {
      for (let i = 0; i < 128; i++) writeFileSync(join(memory.root, `topic-${i}.md`), 'Topic')
    })
    expect((await ws.run('list')).paragraphs).toMatchObject([{ id: A, hidden: true, renewable: false }])
    expect((await ws.run('withdraw', A)).paragraphs).toEqual([])
    expect(await ws.file()).toBe(hand)
  })

  it('withdraws a valid paragraph after an orphan opener', async () => {
    const ws = await workspace()
    const orphan = '<!-- refinement:r0000000001 -->\n'
    const id = 'r0000000002'
    ws.seed(paragraph(id, LESSON_B, T0 + DAY))
    await ws.write(orphan + marked(id, LESSON_B))
    expect((await ws.run('list')).paragraphs).toMatchObject([{ id, validity: 'valid' }])
    expect((await ws.run('withdraw', id)).paragraphs).toEqual([])
    expect(await ws.file()).toBe(orphan)
  })

  it('renewing gives a paragraph a new 30-day review period and touches no file', async () => {
    const ws = await workspace()
    ws.seed(paragraph(B, LESSON_B, T0 - DAY))
    await ws.write(`${HUMAN}\n${marked(B, LESSON_B)}\n`)
    const before = await ws.file()
    const { paragraphs } = await ws.run('renew', B)
    expect(paragraphs[0]).toMatchObject({ id: B, validity: 'valid', reviewAfter: T0 + REVIEW_AFTER_MS })
    expect(await ws.file()).toBe(before)
    await expect(ws.run('renew', C)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_NOT_RENEWABLE' })
    await expect(ws.run('renew')).rejects.toMatchObject({ code: 'MEMORY_INVALID_REQUEST' })
  })

  it('withdraw writes a revocation and the same content is not saved again automatically', async () => {
    const ws = await workspace()
    const save = createWorkspaceSave({
      registry: ws.registry,
      settings: () => ({ enabled: true, mode: 'auto', revision: 'r1' }),
      memory: () => ws.open(WORKSPACE_MEMORY_KEY),
      clock: ws.clock,
    })
    await ws.write(HUMAN)
    let commands = 0
    const request = (initiator: 'auto' | 'model' | 'user', id: string): WorkspaceSaveRequest => ({
      initiator,
      commandId: `cmd-${++commands}`,
      session: { key: `session-${id}`, lane: 'main', workspaceRoot: ws.root, lastSeq: 40, child: false },
      settingsRevision: 'r1',
      entry: {
        kind: 'memory',
        id,
        version: 1,
        contentHash: 'core-hash',
        title: 'Lint first',
        content: 'Run pnpm lint before committing.',
        applicability: 'session',
      },
      evidenceSeqs: [4, 9],
      evidenceTurn: 1,
      confirmations: 2,
    })
    const first = await save.save(request('model', 'build'))
    expect(first).toMatchObject({ outcome: 'saved' })
    const [saved] = (await ws.run('list')).paragraphs
    if (!saved) throw new Error('nothing saved')
    expect(saved).toMatchObject({ validity: 'valid', initiator: 'model' })

    const actor = 'workspace-owner'
    await ws.withSession(async (editor) => {
      const editFile = vi.fn<typeof editor.editFile>(async (...args) => {
        await editor.editFile(...args)
        throw Object.assign(new Error('metadata write failed'), { code: 'MEMORY_COMMITTED_METADATA_FAILED' })
      })
      const { hash } = await editor.readFile('MEMORY.md')
      const { paragraphs } = await savedParagraphs({ registry: ws.registry, clock: ws.clock })(
        { ...editor, editFile },
        ws.root,
        { action: 'withdraw', paragraphId: saved.id, actor },
      )
      expect(editFile).toHaveBeenCalledWith('MEMORY.md', HUMAN, hash, { actor })
      expect(paragraphs).toEqual([])
    })
    // The paragraph is cut with its separator; the person's text stays byte for byte.
    expect(await ws.file()).toBe(HUMAN)
    const store = ws.registry().read()
    expect(store.paragraphs.find((entry) => entry.id === saved.id)?.state).toBe('removed')
    expect(store.revocations).toEqual([
      expect.objectContaining({
        sessionKey: 'session-build',
        entryId: 'build',
        action: 'memory-withdrawn',
        actor,
      }),
    ])
    // The same content is not saved again automatically or by the model, even under another entry id.
    for (const initiator of ['auto', 'model'] as const)
      expect(await save.save(request(initiator, 'build-again'))).toMatchObject({
        outcome: 'refused',
        reason: 'user-revoked',
      })
    expect(await ws.file()).toBe(HUMAN)
    // The person's own save still brings it back.
    expect(await save.save(request('user', 'build-again'))).toMatchObject({ outcome: 'saved' })
  })

  it('converting keeps the text as ordinary memory and the agent sees it as such', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 - DAY))
    await ws.write(`${HUMAN}\n${marked(A, LESSON_A)}\n`)
    expect((await ws.withSession((memory) => memory.snapshot(1), 'reader'))?.content).not.toContain(
      'Run pnpm lint',
    )
    expect((await ws.run('convert', A)).paragraphs).toEqual([])
    expect(await ws.file()).toBe(`${HUMAN}\n${LESSON_A}\n`)
    const store = ws.registry().read()
    expect(store.paragraphs[0]?.state).toBe('converted')
    expect(store.revocations).toEqual([])
    // Ordinary memory has no review date: the agent sees it although the old date has passed.
    expect((await ws.withSession((memory) => memory.snapshot(1), 'reader'))?.content).toContain(
      'Run pnpm lint',
    )
  })

  it('works in every memory mode, like the editor, and refuses what it cannot find', async () => {
    const ws = await workspace('off')
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    await ws.write(`${HUMAN}\n${marked(A, LESSON_A)}\n\n${marked(C, LESSON_C)}\n`)
    // A save whose result was never settled can be withdrawn too.
    expect((await ws.run('withdraw', C)).paragraphs.map((entry) => entry.id)).toEqual([A])
    expect((await ws.run('withdraw', A)).paragraphs).toEqual([])
    expect(ws.registry().read().revocations).toEqual([
      expect.objectContaining({ action: 'memory-withdrawn', actor: 'human' }),
    ])
    expect(await ws.file()).toBe(HUMAN)
    await expect(ws.run('withdraw', A)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_NOT_FOUND' })
    await expect(ws.run('convert', 'rz000000001')).rejects.toMatchObject({
      code: 'MEMORY_PARAGRAPH_NOT_FOUND',
    })
  })

  it('a paragraph whose markers were damaged by hand is left to the editor', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    // The opener appears twice: the provider lists nothing under that id, so nothing is cut.
    await ws.write(`${HUMAN}\n${marked(A, LESSON_A)}\n<!-- refinement:${A} -->\n`)
    const before = await ws.file()
    await expect(ws.run('withdraw', A)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_NOT_FOUND' })
    expect(await ws.file()).toBe(before)
    const nested = marked(C, marked(A, LESSON_A))
    await ws.write(nested)
    await expect(ws.run('withdraw', A)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_NOT_FOUND' })
    expect(await ws.file()).toBe(nested)
  })

  it('the admin memory request serves the saved paragraphs and refuses mixing them with an edit', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    await ws.write(`${HUMAN}\n${marked(A, LESSON_A)}\n`)
    const manage = savedParagraphs({ registry: ws.registry, clock: ws.clock })
    const result = await ws.withSession((memory) =>
      manageMemory(memory, { cwd: ws.root, saved: { action: 'list' } }, manage),
    )
    expect(result.saved?.paragraphs.map((entry) => entry.id)).toEqual([A])
    expect(result.inspection.settings.mode).toBe('auto')
    await expect(
      ws.withSession((memory) =>
        manageMemory(memory, { cwd: ws.root, saved: { action: 'list' }, file: 'MEMORY.md' }, manage),
      ),
    ).rejects.toMatchObject({ data: { reason: 'MEMORY_INVALID_REQUEST' } })
    // A host without saved-paragraph management answers an empty list rather than failing the page.
    expect(
      (await ws.withSession((memory) => manageMemory(memory, { cwd: ws.root, saved: { action: 'list' } })))
        .saved,
    ).toEqual({
      paragraphs: [],
    })
  })

  it('completes withdrawal and preserves same-turn isolation when real index.sqlite is corrupt', async () => {
    const ws = await workspace()
    ws.seed(paragraph(A, LESSON_A, T0 + DAY))
    await ws.write(`${HUMAN}\n${marked(A, LESSON_A)}\n`)
    const reader = ws.open('reader')
    const outside = async (): Promise<never> => {
      throw new Error('outside')
    }
    try {
      const turn1 = reader.files(
        { read: outside, write: outside, list: outside, stat: outside },
        { sessionKey: 'reader', turn: 1 },
        new AbortController().signal,
        async () => ({ status: 'approved' }),
      )
      expect(Buffer.from(await turn1.read(join(reader.root, 'MEMORY.md'))).toString('utf8')).toContain(
        'Lint first',
      )
      mkdirSync(join(reader.root, 'meta'), { recursive: true })
      writeFileSync(join(reader.root, 'meta', 'index.sqlite'), 'corrupt')

      const withdrawn = await ws.run('withdraw', A)
      expect(withdrawn.paragraphs).toEqual([])
      expect(await ws.file()).toBe(HUMAN)
      expect(ws.registry().read().paragraphs[0]?.state).toBe('removed')
      expect(ws.registry().read().revocations).toHaveLength(1)
      expect(Buffer.from(await turn1.read(join(reader.root, 'MEMORY.md'))).toString('utf8')).not.toContain(
        'Lint first',
      )
      expect((await turn1.recall?.({ query: 'Lint' }))?.hits).toEqual([])
      const turn2 = reader.files(
        { read: outside, write: outside, list: outside, stat: outside },
        { sessionKey: 'reader', turn: 2 },
        new AbortController().signal,
        async () => ({ status: 'approved' }),
      )
      await expect(turn2.recall?.({ query: 'Lint' })).rejects.toMatchObject({
        code: 'MEMORY_RECALL_UNAVAILABLE',
      })
    } finally {
      await reader.close?.()
    }
  })
})
