import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import { actor, fakeProvider, openSession, textTurn } from '@agnes/core/testkit'
import type { MemoryFilePort, MemoryProvider, MemorySession } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
  type Revocation,
} from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryView } from '../../src/runtime/refinement/registry-view.js'
import { savedParagraphs } from '../../src/runtime/refinement/saved-paragraphs.js'
import { createWorkspaceRefs } from '../../src/runtime/refinement/workspace-refs.js'

const DAY = 86_400_000
const T0 = 1_800_000_000_000
const ROOT = '/work/repo'
const AT = { key: 'session-b', lane: 'main' }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-workspace-refs-'))
  dirs.push(dir)
  return dir
}
const registryFile = (dataDir: string) =>
  join(dataDir, 'refinement', 'workspaces', `${createHash('sha256').update(ROOT).digest('hex')}.json`)

const TEXT = 'Use pnpm here\nInstall with pnpm, never npm.'
const SOME = 'Some title\nSome text.'

const paragraph = (over: Partial<RegistryParagraph> = {}): RegistryParagraph => ({
  id: 'r0000000001',
  source: {
    sessionKey: 'session-a',
    kind: 'memory',
    entryId: 'use-pnpm',
    contentHash: 'h1',
    initiator: 'auto',
  },
  contentHash: 'h1',
  reviewAfter: T0 + 10 * DAY,
  state: 'active',
  fileHash: 'f1',
  ...over,
})

/** A memory session whose stored index holds `texts` by paragraph id; it records every write call. */
function memory(texts: Record<string, string>, mode: 'off' | 'ask' | 'auto' = 'auto') {
  const writes: string[] = []
  const write = (name: string) => () => {
    writes.push(name)
    throw new Error('no write expected')
  }
  const session = {
    root: '/memory',
    snapshot: async () => undefined,
    files: write('files'),
    inspect: async () => ({ root: '/memory', settings: { mode }, files: [], bytes: 0 }),
    configure: write('configure'),
    readFile: async () => {
      throw new Error('no raw index available')
    },
    editFile: write('editFile'),
    paragraphs: () => ({
      list: async () => ({
        hash: 'f1',
        paragraphs: Object.entries(texts).map(([id, text]) => ({ id, text, validity: 'valid' as const })),
      }),
      propose: write('propose'),
      commit: write('commit'),
    }),
  } as unknown as MemorySession
  return { session, writes }
}

function setup(
  o: { paragraphs?: RegistryParagraph[]; revocations?: Revocation[]; memory?: MemorySession } = {},
) {
  const dataDir = scratch()
  const clock = vi.fn(() => T0)
  const registry = new RefinementRegistry(dataDir, ROOT, clock)
  if (o.paragraphs || o.revocations)
    registry.update((draft) => {
      draft.paragraphs.push(...(o.paragraphs ?? []))
      draft.revocations.push(...(o.revocations ?? []))
    }, registry.read().revision)
  const mem = memory({ r0000000001: TEXT })
  const where = { workspaceRoot: ROOT, memory: o.memory ?? mem.session }
  const refs = createWorkspaceRefs({ dataDir, session: () => where, clock })
  return { dataDir, registry, refs, writes: mem.writes, clock, where }
}

describe('entries saved to the workspace, for the planner', () => {
  it('lists each paragraph in force with its text, content version and origin', async () => {
    const t = setup({ paragraphs: [paragraph()] })
    expect(await t.refs.list(AT)).toEqual([
      {
        ref: 'workspace-memory/r0000000001',
        title: 'Use pnpm here',
        summary: 'Install with pnpm, never npm.',
        // The version is the text the planner is shown, not the hash the registry stored at save time.
        version: normalizedContentHash(TEXT),
        source: { sessionKey: 'session-a', kind: 'memory', entryId: 'use-pnpm' },
      },
    ])
    expect(t.writes).toEqual([])
  })

  it('lists nothing that is expired, removed, converted, revoked or gone from the file', async () => {
    const t = setup({
      paragraphs: [
        paragraph({ id: 'r0000000002', reviewAfter: T0 }),
        paragraph({ id: 'r0000000003', state: 'removed' }),
        paragraph({ id: 'r0000000004', state: 'converted' }),
        paragraph({
          id: 'r0000000005',
          source: { ...paragraph().source, entryId: 'withdrawn', contentHash: 'h5' },
        }),
        paragraph({ id: 'r0000000006' }),
      ],
      revocations: [
        {
          sessionKey: 'session-a',
          kind: 'memory',
          entryId: 'withdrawn',
          contentHash: 'h5',
          action: 'memory-withdrawn',
          at: T0 - DAY,
        },
      ],
      memory: memory(
        Object.fromEntries(['2', '3', '4', '5'].map((n) => [`r000000000${n}`, 'Some title\nSome text.'])),
      ).session,
    })
    expect(await t.refs.list(AT)).toEqual([])
  })

  it.each(['<!-- ref:r0000000001 -->', 'ref: r0000000001'])(
    'lists, delivers and renews a dependent paragraph only while its source is in force (%s)',
    async (ref) => {
      const source = paragraph()
      const id = 'r0000000002'
      const text = `Follow-up\n${ref}`
      const dependent = paragraph({
        id,
        source: { ...source.source, entryId: 'follow-up', contentHash: 'h2' },
      })
      const ws = setup({ paragraphs: [source, dependent], memory: memory({ [id]: text }).session })
      const version = normalizedContentHash(text)
      expect(await ws.refs.entries?.(AT)).toMatchObject([{ ref: `ws.${id}`, version }])
      expect(await ws.refs.list(AT)).toMatchObject([{ ref: `workspace-memory/${id}`, version }])
      expect(await ws.refs.renew(AT, `workspace-memory/${id}`, version)).toBe(true)
      ws.clock.mockReturnValue(source.reviewAfter)
      const hidden = async () => {
        expect(await ws.refs.entries?.(AT)).toEqual([])
        expect(await ws.refs.list(AT)).toEqual([])
        expect(await ws.refs.renew(AT, `workspace-memory/${id}`, version)).toBe(false)
      }
      await hidden()
      ws.clock.mockReturnValue(T0)
      ws.registry.update((draft) => {
        draft.revocations.push({ ...source.source, action: 'memory-withdrawn', at: T0 })
      }, ws.registry.read().revision)
      await hidden()
      ws.registry.update((draft) => {
        draft.revocations = []
        draft.paragraphs.splice(0, 1, { ...source, state: 'removed' })
      }, ws.registry.read().revision)
      await hidden()
    },
  )

  it('hides expired and invalid blocks and versions the remaining visible text', async () => {
    const id = 'r0000000001'
    const text = { [id]: '<!-- expires_at: 2027-02-30 -->\nInvalid' }
    const ws = setup({ paragraphs: [paragraph()], memory: memory(text).session })
    expect(await ws.refs.entries?.(AT)).toEqual([])
    expect(await ws.refs.list(AT)).toEqual([])
    expect(await ws.refs.renew(AT, `workspace-memory/${id}`, normalizedContentHash(text[id]))).toBe(false)
    const expired = new Date(T0 + 1).toISOString()
    text[id] = `<!-- expires_at: ${expired} -->\nStill visible`
    expect(await ws.refs.entries?.(AT)).toMatchObject([{ version: normalizedContentHash(text[id]) }])
    // A cached delivery cannot outlive the deadline, even when the registry stays unchanged.
    const revision = ws.refs.revision?.(AT)
    ws.clock.mockReturnValue(T0 + 1)
    expect(ws.refs.revision?.(AT)).not.toBe(revision)
    expect(await ws.refs.entries?.(AT)).toEqual([])
    const kept = 'Keep this title\n\nKeep these details'
    text[id] = `Keep this title\n<!-- expires_at: ${expired} -->\nExpired details\n\nKeep these details`
    const version = normalizedContentHash(kept)
    expect(await ws.refs.entries?.(AT)).toMatchObject([
      { title: 'Keep this title', content: 'Keep these details', version },
    ])
    expect(await ws.refs.list(AT)).toMatchObject([
      { title: 'Keep this title', summary: 'Keep these details', version },
    ])
    expect(await ws.refs.renew(AT, `workspace-memory/${id}`, version)).toBe(true)
  })

  it('memory off or a provider without paragraphs lists nothing', async () => {
    expect(
      await setup({ paragraphs: [paragraph()], memory: memory({}, 'off').session }).refs.list(AT),
    ).toEqual([])
    const bare = { ...memory({}).session, paragraphs: undefined } as unknown as MemorySession
    expect(await setup({ paragraphs: [paragraph()], memory: bare }).refs.list(AT)).toEqual([])
  })

  it('a workspace that never saved anything reads no memory and writes no registry', async () => {
    const inspect = vi.fn()
    const t = setup({ memory: { ...memory({}).session, inspect } as unknown as MemorySession })
    expect(await t.refs.list(AT)).toEqual([])
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', 'h1')).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
    expect(() => readFileSync(registryFile(t.dataDir))).toThrow()
  })
})

describe('renewing a confirmed entry', () => {
  it('a confirmation renews reviewAfter and writes no memory file', async () => {
    const t = setup({ paragraphs: [paragraph()] })
    t.clock.mockReturnValue(T0 + 5 * DAY)
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', normalizedContentHash(TEXT))).toBe(true)
    const [renewed] = t.registry.read().paragraphs
    expect(renewed).toEqual({ ...paragraph(), reviewAfter: T0 + 5 * DAY + REVIEW_AFTER_MS })
    // Only the registry changed: no memory write of any kind was asked for.
    expect(t.writes).toEqual([])
  })

  it('renewal is refused for a removed, converted, revoked or changed entry', async () => {
    const t = setup({
      paragraphs: [
        paragraph({ id: 'r0000000003', state: 'removed' }),
        paragraph({ id: 'r0000000004', state: 'converted' }),
        paragraph({
          id: 'r0000000005',
          source: { ...paragraph().source, entryId: 'withdrawn', contentHash: 'h5' },
        }),
        paragraph({ id: 'r0000000006' }),
      ],
      revocations: [
        {
          sessionKey: 'session-a',
          kind: 'memory',
          entryId: 'withdrawn',
          contentHash: 'h5',
          action: 'memory-withdrawn',
          at: T0 - DAY,
        },
      ],
      memory: memory(
        Object.fromEntries(['3', '4', '5', '6'].map((n) => [`r000000000${n}`, 'Some title\nSome text.'])),
      ).session,
    })
    const before = readFileSync(registryFile(t.dataDir), 'utf8')
    for (const id of ['r0000000003', 'r0000000004', 'r0000000005'])
      expect(await t.refs.renew(AT, `workspace-memory/${id}`, normalizedContentHash(SOME))).toBe(false)
    // The content changed since the planner saw it.
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000006', 'h0')).toBe(false)
    // Not a reference this host keeps.
    expect(await t.refs.renew(AT, 'workspace-skill/lint', 'h1')).toBe(false)
    expect(readFileSync(registryFile(t.dataDir), 'utf8')).toBe(before)
    // The one in force, at the version it was listed at, is renewed.
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000006', normalizedContentHash(SOME))).toBe(true)
  })

  it('a paragraph edited in place since it was listed is not renewed and lists as a new version', async () => {
    const texts: Record<string, string> = { r0000000001: TEXT }
    const t = setup({ paragraphs: [paragraph()], memory: memory(texts).session })
    const [shown] = await t.refs.list(AT)
    texts.r0000000001 = 'Use yarn here\nInstall with yarn, never npm.'
    const before = readFileSync(registryFile(t.dataDir), 'utf8')
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', shown?.version as string)).toBe(false)
    expect(readFileSync(registryFile(t.dataDir), 'utf8')).toBe(before)
    const [edited] = await t.refs.list(AT)
    expect(edited?.version).toBe(normalizedContentHash(texts.r0000000001 as string))
    expect(edited?.version).not.toBe(shown?.version)
  })

  it('a paragraph past its review date is not renewed by a confirmation made before', async () => {
    const t = setup({ paragraphs: [paragraph()] })
    const [shown] = await t.refs.list(AT)
    t.clock.mockReturnValue(T0 + 10 * DAY)
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', shown?.version as string)).toBe(false)
    expect(t.registry.read().paragraphs[0]?.reviewAfter).toBe(T0 + 10 * DAY)
  })

  it('a registry write between the check and the renewal refuses it', async () => {
    const mem = memory({ r0000000001: TEXT })
    const t = setup({ paragraphs: [paragraph()], memory: mem.session })
    const [shown] = await t.refs.list(AT)
    // Another writer (a merge, a revocation) saves the registry while the memory file is being read.
    const inspect = mem.session.inspect.bind(mem.session)
    ;(mem.session as { inspect: unknown }).inspect = async () => {
      t.registry.update((draft) => {
        const p = draft.paragraphs[0] as RegistryParagraph
        p.contentHash = 'merged'
      }, t.registry.read().revision)
      return inspect()
    }
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', shown?.version as string)).toBe(false)
    expect(t.registry.read().paragraphs[0]).toMatchObject({
      contentHash: 'merged',
      reviewAfter: T0 + 10 * DAY,
    })
  })

  it('a paragraph a person deleted from the file is not renewed', async () => {
    const t = setup({ paragraphs: [paragraph()], memory: memory({}).session })
    const before = readFileSync(registryFile(t.dataDir), 'utf8')
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', 'h1')).toBe(false)
    expect(readFileSync(registryFile(t.dataDir), 'utf8')).toBe(before)
  })

  it('an unreadable registry lists nothing and renews nothing, and is left as it was', async () => {
    const t = setup()
    mkdirSync(join(t.dataDir, 'refinement', 'workspaces'), { recursive: true })
    writeFileSync(registryFile(t.dataDir), '{"version":1,"revision":"x","paragraphs":"broken"}')
    expect(await t.refs.list(AT)).toEqual([])
    expect(await t.refs.renew(AT, 'workspace-memory/r0000000001', 'h1')).toBe(false)
    expect(readFileSync(registryFile(t.dataDir), 'utf8')).toBe(
      '{"version":1,"revision":"x","paragraphs":"broken"}',
    )
  })

  it('a session not open here lists and renews nothing', async () => {
    const refs = createWorkspaceRefs({ dataDir: scratch(), session: () => undefined, clock: () => T0 })
    expect(await refs.list(AT)).toEqual([])
    expect(await refs.renew(AT, 'workspace-memory/r0000000001', 'h1')).toBe(false)
  })
})

/** A memory session with a workspace index and a user index, each holding texts by paragraph id. */
function layered(
  workspace: Record<string, string>,
  user: Record<string, string>,
  o: { mode?: 'off' | 'ask' | 'auto'; userEnabled?: boolean } = {},
) {
  const port = (texts: Record<string, string>) => () => ({
    list: async () => ({
      hash: 'f1',
      paragraphs: Object.entries(texts).map(([id, text]) => ({ id, text, validity: 'delivered' as const })),
    }),
    propose: async () => {
      throw new Error('no write expected')
    },
    commit: async () => {
      throw new Error('no write expected')
    },
  })
  return {
    root: '/memory',
    snapshot: async () => undefined,
    inspect: async () => ({
      root: '/memory',
      settings: { mode: o.mode ?? 'auto', userEnabled: o.userEnabled ?? true },
      files: [],
      bytes: 0,
    }),
    paragraphs: port(workspace),
    userParagraphs: port(user),
  } as unknown as MemorySession
}

describe('entries saved earlier, for the experience snapshot', () => {
  const both = (memory: MemorySession, user: RegistryParagraph[] = []) => {
    const dataDir = scratch()
    const clock = () => T0
    const registry = new RefinementRegistry(dataDir, ROOT, clock)
    const userRegistry = RefinementRegistry.user(scratch(), clock)
    if (user.length)
      userRegistry.update((draft) => {
        draft.paragraphs.push(...user)
      }, userRegistry.read().revision)
    const refs = createWorkspaceRefs({
      dataDir,
      session: () => ({ workspaceRoot: ROOT, memory }),
      clock,
      userRegistry: () => userRegistry,
    })
    return { registry, userRegistry, refs }
  }
  const seed = (registry: RefinementRegistry, paragraphs: RegistryParagraph[]) =>
    registry.update((draft) => {
      draft.paragraphs.push(...paragraphs)
    }, registry.read().revision)

  it('lists saved workspace paragraphs in full, with whether a person edited them since', async () => {
    const t = both(layered({ r0000000001: TEXT, r0000000002: SOME }, {}))
    seed(t.registry, [
      paragraph({ contentHash: normalizedContentHash(TEXT) }),
      paragraph({
        id: 'r0000000002',
        contentHash: 'stored-before-a-person-edited-it',
        source: { sessionKey: 's', kind: 'prompt', entryId: 'p2', contentHash: 'x', initiator: 'auto' },
      }),
    ])
    expect(await t.refs.entries?.(AT)).toEqual([
      {
        ref: 'ws.r0000000001',
        kind: 'memory',
        title: 'Use pnpm here',
        content: 'Install with pnpm, never npm.',
        version: normalizedContentHash(TEXT),
        savedAt: T0 + 10 * DAY - REVIEW_AFTER_MS,
        untouched: true,
        source: { sessionKey: 'session-a', kind: 'memory', entryId: 'use-pnpm' },
      },
      {
        ref: 'ws.r0000000002',
        kind: 'prompt',
        title: 'Some title',
        content: 'Some text.',
        version: normalizedContentHash(SOME),
        savedAt: T0 + 10 * DAY - REVIEW_AFTER_MS,
        untouched: false,
        source: { sessionKey: 's', kind: 'prompt', entryId: 'p2' },
      },
    ])
  })

  it('lists user sections only while user memory is enabled, and nothing while memory is off', async () => {
    const user = [paragraph({ id: 'r0000000009', contentHash: normalizedContentHash(SOME) })]
    const on = both(layered({}, { r0000000009: SOME }), user)
    expect((await on.refs.entries?.(AT))?.map((e) => e.ref)).toEqual(['user.r0000000009'])
    const disabled = both(layered({}, { r0000000009: SOME }, { userEnabled: false }), user)
    expect(await disabled.refs.entries?.(AT)).toEqual([])
    const off = both(layered({ r0000000001: TEXT }, { r0000000009: SOME }, { mode: 'off' }), user)
    seed(off.registry, [paragraph()])
    expect(await off.refs.entries?.(AT)).toEqual([])
  })

  it('skips a saved paragraph that now looks like a secret', async () => {
    const t = both(layered({ r0000000001: 'Deploy key\napi_key = abcdefghijklmnop' }, {}))
    seed(t.registry, [paragraph()])
    expect(await t.refs.entries?.(AT)).toEqual([])
  })

  it('fingerprints only bounded regular files on a symlink-free path', () => {
    const root = join(realpathSync(scratch()), 'memory', 'workspaces', 'w')
    mkdirSync(root, { recursive: true })
    const t = both({ ...layered({}, {}), root })
    const missing = t.refs.revision?.(AT)
    const file = join(root, 'MEMORY.md')
    writeFileSync(file, Buffer.alloc(1024 * 1024))
    expect(t.refs.revision?.(AT)).not.toBe(missing)
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 1))
    expect(t.refs.revision?.(AT)).toBe(missing)
    // The user index sits under a directory link and the workspace index itself is a link.
    const external = realpathSync(scratch())
    writeFileSync(join(external, 'MEMORY.md'), TEXT)
    rmSync(file)
    symlinkSync(join(external, 'MEMORY.md'), file)
    symlinkSync(external, join(root, '..', '..', 'user'), 'dir')
    expect(t.refs.revision?.(AT)).toBe(missing)
  })

  it('its revision moves when a paragraph is saved, withdrawn or passes its review date', () => {
    const t = both(layered({}, {}))
    const first = t.refs.revision?.(AT)
    seed(t.registry, [paragraph()])
    const saved = t.refs.revision?.(AT)
    expect(saved).not.toBe(first)
    expect(t.refs.revision?.(AT)).toBe(saved)
  })
})

function fileProvider(): MemoryProvider {
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

describe('fixes after the branch review', () => {
  const failing = () =>
    ({
      root: '/memory',
      snapshot: async () => undefined,
      inspect: async () => {
        throw new Error('EBUSY')
      },
      paragraphs: () => ({
        list: async () => {
          throw new Error('EBUSY')
        },
      }),
      userParagraphs: () => ({
        list: async () => {
          throw new Error('EBUSY')
        },
      }),
    }) as unknown as MemorySession

  it('a failed memory read is a failure, never "nothing saved"', async () => {
    const dataDir = scratch()
    const registry = new RefinementRegistry(dataDir, ROOT, () => T0)
    registry.update((draft) => {
      draft.paragraphs.push(paragraph())
    }, registry.read().revision)
    const refs = createWorkspaceRefs({
      dataDir,
      session: () => ({ workspaceRoot: ROOT, memory: failing() }),
      clock: () => T0,
    })
    await expect(Promise.resolve(refs.entries?.(AT))).rejects.toThrow()
  })

  it('lists user sections for confirmation and renews them through the user registry', async () => {
    const dataDir = scratch()
    const userRegistry = RefinementRegistry.user(scratch(), () => T0)
    userRegistry.update((draft) => {
      draft.paragraphs.push(paragraph({ id: 'r0000000009', contentHash: normalizedContentHash(SOME) }))
    }, userRegistry.read().revision)
    const refs = createWorkspaceRefs({
      dataDir,
      session: () => ({ workspaceRoot: ROOT, memory: layered({}, { r0000000009: SOME }) }),
      clock: () => T0,
      userRegistry: () => userRegistry,
    })
    expect((await refs.list(AT)).map((r) => r.ref)).toContain('user-memory/r0000000009')
    expect(await refs.renew(AT, 'user-memory/r0000000009', normalizedContentHash(SOME))).toBe(true)
    expect(userRegistry.read().paragraphs[0]?.reviewAfter).toBe(T0 + REVIEW_AFTER_MS)
  })

  it.each(['expired annotation', 'memory off'])(
    'withdraws a cached delivery on the next request after %s',
    async (edit) => {
      const dataDir = scratch()
      const registry = new RefinementRegistry(dataDir, ROOT, () => T0)
      const memory = fileProvider().open({
        home: scratch(),
        workspaceRoot: ROOT,
        sessionKey: AT.key,
        validity: registryView(registry, () => T0),
      })
      try {
        await memory.configure({ mode: 'auto' })
        const id = paragraph().id
        const body = `<!-- refinement:${id} -->\n${TEXT}\n<!-- /refinement:${id} -->`
        await memory.editFile('MEMORY.md', body, (await memory.readFile('MEMORY.md')).hash)
        registry.update((draft) => {
          draft.paragraphs.push(paragraph())
        }, registry.read().revision)
        const refs = createWorkspaceRefs({
          dataDir,
          session: () => ({ workspaceRoot: ROOT, memory }),
          clock: () => T0,
        })
        const { session } = await openSession({
          provider: fakeProvider([textTurn('ok'), textTurn('ok')]),
          refinementEnabled: () => true,
          refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: refs },
        })
        const turn = async () => {
          await session.enqueue('next-turn', { content: [{ type: 'text', text: 'Continue' }], actor })
          await session.run({ until: 'turn-end', signal: new AbortController().signal })
        }
        await turn()
        expect(JSON.stringify(session.surface())).toContain(`[memory/ws.${id} v1] (saved)`)
        const before = refs.revision?.(AT)
        if (edit === 'memory off') await memory.configure({ mode: 'off' })
        else
          await memory.editFile(
            'MEMORY.md',
            `<!-- expires_at: 2020-01-01 -->\n${body}`,
            (await memory.readFile('MEMORY.md')).hash,
          )
        expect(refs.revision?.(AT)).not.toBe(before)
        expect(await refs.entries?.(AT)).toEqual([])
        expect(await refs.list(AT)).toEqual([])
        expect(await refs.renew(AT, `workspace-memory/${id}`, normalizedContentHash(TEXT))).toBe(false)
        await turn()
        expect(JSON.stringify(session.surface())).toContain(`[memory/ws.${id} v1] withdrawn:`)
      } finally {
        await memory.close?.()
      }
    },
  )

  it('applies user registry references, full-file expiry and user settings to the cached revision', async () => {
    const home = scratch()
    const dataDir = scratch()
    const clock = vi.fn(() => T0)
    const registry = RefinementRegistry.user(home, clock)
    const workspaceRegistry = new RefinementRegistry(dataDir, ROOT, clock)
    workspaceRegistry.update((draft) => {
      draft.paragraphs.push(paragraph())
    }, workspaceRegistry.read().revision)
    // The same id is in force in the workspace, but the user layer has withdrawn it.
    const source = paragraph({ state: 'removed' })
    const dependent = paragraph({ id: 'r0000000009' })
    registry.update((draft) => {
      draft.paragraphs.push(source, dependent)
    }, registry.read().revision)
    const memory = fileProvider().open({
      home,
      workspaceRoot: ROOT,
      sessionKey: AT.key,
      userValidity: registryView(registry, clock),
    })
    const refs = createWorkspaceRefs({
      dataDir,
      session: () => ({ workspaceRoot: ROOT, memory }),
      clock,
      userRegistry: () => registry,
    })
    const path = join(home, 'memory', 'user')
    mkdirSync(path, { recursive: true })
    const body = `<!-- refinement:${dependent.id} -->\n${TEXT}\n<!-- /refinement:${dependent.id} -->`
    const ref = `user-memory/${dependent.id}`
    const version = normalizedContentHash(TEXT)
    const hidden = async () => {
      expect(await refs.entries?.(AT)).toEqual([])
      expect(await refs.list(AT)).toEqual([])
      expect(await refs.renew(AT, ref, version)).toBe(false)
    }
    try {
      await memory.configure({ mode: 'auto', userEnabled: true })
      writeFileSync(
        join(path, 'MEMORY.md'),
        `<!-- expires_at: ${new Date(T0 + DAY).toISOString()} -->\n<!-- expires_at: ${new Date(T0 + 1).toISOString()} -->\n${body}`,
      )
      expect(await refs.entries?.(AT)).toMatchObject([{ ref: `user.${dependent.id}`, version }])
      const before = refs.revision?.(AT)
      clock.mockReturnValue(T0 + 1)
      expect(refs.revision?.(AT)).not.toBe(before)
      await hidden()
      const expired = refs.revision?.(AT)
      writeFileSync(join(path, 'MEMORY.md'), `${body}\nref: ${source.id}\n`)
      expect(refs.revision?.(AT)).not.toBe(expired)
      await hidden()
      writeFileSync(join(path, 'MEMORY.md'), body)
      expect(await refs.entries?.(AT)).toMatchObject([{ version }])
      const enabled = refs.revision?.(AT)
      await memory.configure({ userEnabled: false })
      expect(refs.revision?.(AT)).not.toBe(enabled)
      await hidden()
    } finally {
      await memory.close?.()
    }
  })

  it('excludes paragraphs citing a withdrawn source across read, recall, and Host entries', async () => {
    const home = scratch()
    const dataDir = scratch()
    const now = T0
    const registry = new RefinementRegistry(dataDir, ROOT, () => now)
    const mem = fileProvider().open({
      home,
      workspaceRoot: ROOT,
      sessionKey: 'reader',
      validity: registryView(registry, () => now),
    })
    const outside = async (): Promise<never> => {
      throw new Error('outside memory')
    }
    const fallback: MemoryFilePort = { read: outside, write: outside, list: outside, stat: outside }
    try {
      await mem.configure({ mode: 'auto' })
      const port = mem.paragraphs?.({ sessionKey: 's', turn: 0 }, new AbortController().signal)
      if (!port) throw new Error('Missing paragraph port')
      const sourceText = 'Source policy\nAlways run unit tests.'
      const derivedText = 'Derived rule\nUse vitest here <!-- ref:ra111111111 -->'
      await port.commit(
        await port.propose([
          { op: 'put', id: 'ra111111111', text: sourceText },
          { op: 'put', id: 'rb222222222', text: derivedText },
        ]),
      )
      const stored = await mem.readFile('MEMORY.md')
      registry.update((draft) => {
        draft.paragraphs.push(
          paragraph({
            id: 'ra111111111',
            contentHash: normalizedContentHash(sourceText),
            fileHash: stored.hash,
          }),
          paragraph({
            id: 'rb222222222',
            source: { ...paragraph().source, entryId: 'derived', contentHash: 'h2' },
            contentHash: normalizedContentHash(derivedText),
            fileHash: stored.hash,
          }),
        )
      }, registry.read().revision)

      const refs = createWorkspaceRefs({
        dataDir,
        session: () => ({ workspaceRoot: ROOT, memory: mem }),
        clock: () => now,
      })
      const turn1 = mem.files(
        fallback,
        { sessionKey: 'reader', turn: 1 },
        new AbortController().signal,
        async () => ({
          status: 'approved',
        }),
      )
      expect(Buffer.from(await turn1.read(join(mem.root, 'MEMORY.md'))).toString('utf8')).toContain(
        'Derived rule',
      )
      expect((await turn1.recall?.({ query: 'vitest' }))?.hits.map((h) => h.text).join('\n')).toContain(
        'Derived rule',
      )
      expect((await refs.entries?.(AT))?.map((e) => e.ref)).toEqual(['ws.ra111111111', 'ws.rb222222222'])

      await savedParagraphs({ registry: () => registry, clock: () => now })(mem, ROOT, {
        action: 'withdraw',
        paragraphId: 'ra111111111',
      })
      expect(Buffer.from(await turn1.read(join(mem.root, 'MEMORY.md'))).toString('utf8')).not.toContain(
        'Derived rule',
      )
      expect((await turn1.recall?.({ query: 'vitest' }))?.hits).toEqual([])
      expect(await refs.entries?.(AT)).toEqual([])
    } finally {
      await mem.close?.()
    }
  })
})
