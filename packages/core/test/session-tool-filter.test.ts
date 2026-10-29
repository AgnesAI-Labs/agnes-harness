import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import {
  foldToolFilter,
  mergeToolFilter,
  NO_TOOL_FILTER,
  parseToolFilterRequest,
  ToolFilterError,
} from '../src/step/tool-filter.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, sent, textTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, testWorkspaceInvocation } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const sessionOpts = {
  actor,
  resolvedProfileHash: 'h1',
  cwd: '/w',
  writerRunId: 'r1',
  workspaceInvocation: testWorkspaceInvocation(),
}
const run = (s: { run: (o: { until: 'turn-end'; signal: AbortSignal }) => Promise<{ reason: string }> }) =>
  s.run({ until: 'turn-end', signal: new AbortController().signal })

const base = (over: Partial<Parameters<typeof Kernel.create>[0]> = {}) =>
  Kernel.create({
    loops: defaultLoops(),
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider: fakeProvider([textTurn('ok')]),
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    ...over,
  })

/** Read-only but not concurrency-safe, so a batch runs its calls one after the other. */
const tool = (
  name: string,
  execute: ToolDef['execute'] = async () => ({ content: [{ type: 'text', text: name }] }),
) =>
  ({
    name,
    description: name,
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'safe' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute,
  }) as unknown as ToolDef
const own = { source: 'agnes/tools-core', trust: 'builtin' as const }
const names = (s: { currentTools(): { list(): { name: string }[] } }) =>
  s
    .currentTools()
    .list()
    .map((t) => t.name)
    .sort()
const batch = (...calls: string[]) => [
  sent(),
  ...calls.map((name, ordinal) => ({
    type: 'toolcall_end' as const,
    call: { toolUseId: '', name, args: {} as never, ordinal },
    via: 'native' as const,
  })),
  usage(),
  { type: 'done' as const, reason: 'toolUse' as const },
]
const results = async (s: { scan: (q: never) => Promise<{ data: unknown }[]> }) =>
  (await s.scan({ type: 'tool/result', limit: 20 } as never)).map(
    (e) => e.data as { isError?: boolean; code?: string },
  )
const prompt = (s: { enqueue: (k: 'next-turn', m: never) => Promise<unknown> }) =>
  s.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor } as never)

describe('session tool filter: request and merge', () => {
  it('only narrows: deny is a union, allow an intersection, one-sided allow is kept', () => {
    const a = mergeToolFilter(NO_TOOL_FILTER, parseToolFilterRequest({ allow: ['a', 'b', 'c'], deny: ['x'] }))
    expect(a).toEqual({ allow: ['a', 'b', 'c'], deny: ['x'] })
    expect(mergeToolFilter(a, parseToolFilterRequest({ deny: ['y'] }))).toEqual({
      allow: ['a', 'b', 'c'],
      deny: ['x', 'y'],
    })
    expect(mergeToolFilter(a, parseToolFilterRequest({ allow: ['b', 'c', 'd'] }))).toEqual({
      allow: ['b', 'c'],
      deny: ['x'],
    })
    // Disjoint allows leave nothing allowed; a later request never brings a tool back.
    const none = mergeToolFilter(a, parseToolFilterRequest({ allow: ['z'] }))
    expect(none.allow).toEqual([])
    expect(mergeToolFilter(none, parseToolFilterRequest({ allow: ['a', 'z'] })).allow).toEqual([])
  })

  it.each([
    [{}, 'names no tools'],
    [{ allow: [] }, 'non-empty'],
    [{ deny: [] }, 'non-empty'],
    [{ deny: ['a'], allow: [] }, 'non-empty'],
    [{ deny: ['bash*'] }, 'not tool names'],
    [{ deny: ['two words'] }, 'not tool names'],
    [{ deny: [7] }, 'not tool names'],
    [{ deny: 'a' }, 'non-empty list'],
    [{ deny: Array.from({ length: 129 }, (_, n) => `t${n}`) }, 'more than 128'],
    [{ deny: ['a'], widen: true }, 'unknown fields'],
    [null, 'must be an object'],
    [['a'], 'must be an object'],
  ])('refuses %j', (request, message) => {
    expect(() => parseToolFilterRequest(request)).toThrow(ToolFilterError)
    expect(() => parseToolFilterRequest(request)).toThrow(message)
  })

  it('folds rows in order and refuses a damaged one instead of reading it as no filter', () => {
    expect(foldToolFilter([{ data: { deny: ['a'] } }, { data: { deny: ['b'] } }])).toEqual({
      deny: ['a', 'b'],
    })
    expect(foldToolFilter([])).toBe(NO_TOOL_FILTER)
    expect(() => foldToolFilter([{ data: { deny: ['a'] } }, { data: { deny: 5 } }])).toThrow(ToolFilterError)
  })
})

describe('session tool filter: a live session', () => {
  it('hides denied tools from the snapshot and refuses an unknown name without writing anything', async () => {
    const k = base()
    for (const name of ['read', 'write', 'search']) k.tools.add(tool(name), own)
    const s = await k.session('k1', sessionOpts)
    expect(names(s)).toEqual(['read', 'search', 'write'])
    await expect(s.setToolFilter({ deny: ['write', 'wrte'] })).rejects.toMatchObject({
      reason: 'unknown-tool',
      names: ['wrte'],
    })
    expect(s.toolFilter).toBe(NO_TOOL_FILTER)
    expect(await s.scan({ type: 'x/core/tool-filter', limit: 5 })).toEqual([])

    const before = s.lastSeq
    const { seq, filter } = await s.setToolFilter({ deny: ['write'] })
    expect(seq).toBeGreaterThan(before)
    expect(filter).toEqual({ deny: ['write'] })
    expect(names(s)).toEqual(['read', 'search'])
    expect(s.currentTools().snapshot(s.lastSeq).byName.has('write')).toBe(false)
    expect((await s.scan({ type: 'x/core/tool-filter', limit: 5 }))[0]).toMatchObject({
      seq,
      ignorable: true,
      data: { deny: ['write'] },
    })
    await s.setToolFilter({ allow: ['read', 'write'] })
    expect(names(s)).toEqual(['read'])
    await k.close()
  })

  it('cannot bring back a tool the preset already leaves out, and obeys tools added later', async () => {
    const k = base({ preset: { ...presetDefaults(), tools: { ...presetDefaults().tools, allow: ['read'] } } })
    for (const name of ['read', 'write']) k.tools.add(tool(name), own)
    const s = await k.session('k1', sessionOpts)
    expect(names(s)).toEqual(['read'])
    await s.setToolFilter({ allow: ['read', 'write'] })
    expect(names(s)).toEqual(['read'])
    expect(s.currentTools().resolve('write')).toBeUndefined()

    await k.close()

    const wide = base()
    for (const name of ['read', 'write', 'search']) wide.tools.add(tool(name), own)
    const open = await wide.session('k2', sessionOpts)
    await open.setToolFilter({ allow: ['read', 'write'] })
    wide.tools.add(tool('late'), own)
    expect(open.currentTools().resolve('late')).toBeUndefined()
    expect(open.currentTools().resolve('write')).toBeDefined()
    expect(open.currentTools().resolve('search')).toBeUndefined()
    await wide.close()
  })

  it('refuses a direct call to a tool filtered while the turn was running, from the next call on', async () => {
    const k = base({ provider: fakeProvider([batch('first', 'second'), textTurn('done')]) })
    const holder: { setFilter?: () => Promise<unknown> } = {}
    k.tools.add(
      tool('first', async () => {
        await holder.setFilter?.()
        return { content: [{ type: 'text', text: 'first ran' }] }
      }),
      own,
    )
    k.tools.add(tool('second'), own)
    const s = await k.session('k1', sessionOpts)
    holder.setFilter = () => s.setToolFilter({ deny: ['second'] })
    await prompt(s)
    expect((await run(s)).reason).toBe('completed')
    // The turn's snapshot still listed `second`; the live filter is what stopped it.
    expect(await results(s)).toEqual([
      expect.objectContaining({ isError: false }),
      expect.objectContaining({ isError: true, code: 'TOOL_NOT_FOUND' }),
    ])
    await k.close()
  })

  it('refuses a nested call made by a tool, such as one inside a code cell', async () => {
    const k = base({ provider: fakeProvider([batch('cell'), textTurn('done')]) })
    let outcome = ''
    const holder: { session?: { setToolFilter(r: unknown): Promise<unknown> } } = {}
    k.tools.add(tool('read'), own)
    k.tools.add(
      tool('cell', async (_args, ctx) => {
        await holder.session?.setToolFilter({ deny: ['read'] })
        try {
          await ctx.tools.invoke('read', {})
          outcome = 'ran'
        } catch (error) {
          outcome = (error as { code?: string }).code ?? String(error)
        }
        return { content: [{ type: 'text', text: outcome }] }
      }),
      own,
    )
    const s = await k.session('k1', sessionOpts)
    holder.session = s
    await prompt(s)
    expect((await run(s)).reason).toBe('completed')
    expect(outcome).toBe('TOOL_NOT_FOUND')
    await k.close()
  })

  it('survives a reopen, and a fork inherits only the rows before its boundary', async () => {
    const storage = new MemoryStorage()
    const k = base({ storage })
    for (const name of ['read', 'write', 'search']) k.tools.add(tool(name), own)
    const s = await k.session('k1', sessionOpts)
    await s.setToolFilter({ deny: ['write'] })
    const boundary = s.lastSeq
    await s.setToolFilter({ deny: ['search'], allow: ['read', 'search'] })
    const early = await k.session('early', { ...sessionOpts, parent: { key: 'k1', boundarySeq: boundary } })
    const late = await k.session('late', { ...sessionOpts, parent: { key: 'k1', boundarySeq: s.lastSeq } })
    expect(early.toolFilter).toEqual({ deny: ['write'] })
    expect(names(early)).toEqual(['read', 'search'])
    expect(late.toolFilter).toEqual({ allow: ['read', 'search'], deny: ['write', 'search'] })
    expect(names(late)).toEqual(['read'])
    await k.close()

    const again = base({ storage })
    for (const name of ['read', 'write', 'search']) again.tools.add(tool(name), own)
    const reopened = await again.session('k1', { ...sessionOpts, writerRunId: 'r2' })
    expect(reopened.toolFilter).toEqual({ allow: ['read', 'search'], deny: ['write', 'search'] })
    expect(names(reopened)).toEqual(['read'])
    await again.close()
  })

  it('refuses to open a session whose ledger holds a damaged filter row', async () => {
    const storage = new MemoryStorage()
    const k = base({ storage })
    k.tools.add(tool('read'), own)
    const s = await k.session('k1', sessionOpts)
    await s.d.log.append([s.ev('x/core/tool-filter', { deny: 'read' }, { ignorable: true })])
    await k.close()
    const again = base({ storage })
    again.tools.add(tool('read'), own)
    await expect(again.session('k1', { ...sessionOpts, writerRunId: 'r2' })).rejects.toThrow(ToolFilterError)
    expect(again.sessions.size).toBe(0)
    await again.close()
  })

  it('hands a child the parent session filter first, and the child can only narrow it further', async () => {
    const provider = fakeProvider([textTurn('child done')])
    Object.assign(provider, {
      models: () => [
        {
          id: 'm1',
          name: 'm1',
          api: 'openai-completions',
          route: 'default',
          baseUrl: 'https://example.invalid/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 128,
          toolCallFormats: ['native'],
          thinkingReplay: 'native',
          contract_id: null,
        },
      ],
    })
    const k = base({ provider, preset: { ...presetDefaults(), treeBudgetCredits: 100 } })
    for (const name of ['read', 'write', 'search']) k.tools.add(tool(name), own)
    const parent = await k.session('parent', sessionOpts)
    await parent.setToolFilter({ deny: ['write'] })
    const child = await parent.d.children.create({
      parent: parent.key,
      cwd: parent.d.cwd,
      input: 'go',
      toolFilter: { deny: ['search'] },
    })
    const opened = k.get(child.key)
    expect(opened && names(opened)).toEqual(['read'])
    await child.close()
    await k.close()
  })
})
