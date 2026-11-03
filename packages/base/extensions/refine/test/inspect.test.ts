import { refinementFacade, ToolRegistry } from '@agnes/core'
import { actor, applyRefine, fakeProvider, openSession, textTurn, toolTurn } from '@agnes/core/testkit'
import type { ToolDef, ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createInspectTool } from '../src/inspect-tool.js'
import { connectedToolPort, ENTRIES_ARE_DATA, type RefinementRuns } from '../src/port.js'

type Session = Awaited<ReturnType<typeof openSession>>['session']

const text = (result: ToolResult) => result.content.map((part) => ('text' in part ? part.text : '')).join('')

/** The host's runs for the sessions given, found by the key and lane of the calling tool. */
function runsFor(sessions: Session[]): RefinementRuns {
  const find = (at: { key: string; lane: string }) =>
    sessions.find((s) => s.key === at.key && s.lane === at.lane)
  return {
    propose: async () => ({ refused: 'unavailable' }),
    request: async () => ({ refused: 'unavailable' }),
    inspect: async (at, request) => {
      const session = find(at)
      return session ? refinementFacade(session).inspect(request) : { refused: 'unavailable' }
    },
  }
}

async function open(
  o: { key?: string; registry?: ToolRegistry; scripts?: Parameters<typeof fakeProvider>[0] } = {},
) {
  const provider = fakeProvider(o.scripts ?? [textTurn('answer')])
  const { session } = await openSession({
    provider,
    ...(o.key ? { key: o.key } : {}),
    ...(o.registry ? { registry: o.registry } : {}),
    refinement: {
      settings: () => ({ enabled: true, mode: 'manual', revision: 'r1' }),
      planner: () => undefined,
    },
    refinementEnabled: () => true,
  })
  return { session, provider }
}

async function seed(
  s: Session,
  entries: { kind: 'memory' | 'skill'; id: string; title: string; content: string }[],
) {
  const edits = entries.map((e) => ({
    op: 'upsert' as const,
    entry: { ...e, scope: 'local' as const, version: 1, source: 'refine' },
  }))
  await s.locked(() =>
    applyRefine(
      s,
      {
        proposalId: 'seed',
        runId: 'seed',
        trigger: 'manual',
        edits,
        baseline: [],
        rationale: 'r',
        evidenceSeqs: [],
      },
      { maxEdits: 100, maxChars: 2000, safetyCap: 200 },
    ),
  )
}

const contextOf = (s: Session) => {
  const ctx = fakeToolContext()
  return { ...ctx, session: { ...ctx.session, key: s.key, lane: s.lane } } as typeof ctx
}

describe('the harness_inspect tool', () => {
  it('is read-only, deferred, and its output is recorded as untrusted data', () => {
    const tool = createInspectTool({ inspect: async () => ({ content: [] }) })
    expect(tool.name).toBe('harness_inspect')
    expect(tool.meta).toMatchObject({
      isReadOnly: true,
      isDestructive: false,
      isOpenWorld: true,
      replay: 'safe',
      deferLoading: true,
    })
  })

  it('inspect search returns 10, list pages by 20, get returns one entry', async () => {
    const { session } = await open()
    const many = Array.from({ length: 23 }, (_, i) => ({
      kind: 'skill' as const,
      id: `release-${String(i).padStart(2, '0')}`,
      title: `Release step ${i}`,
      content: `Draft the release notes from merged pull requests, part ${i}. ${'More words here. '.repeat(20)}`,
    }))
    await seed(session, many)
    const tool = createInspectTool(connectedToolPort(runsFor([session])))
    const ctx = contextOf(session)
    const run = (args: object) => tool.execute(args as never, ctx)

    const found = await run({ op: 'search', query: 'release notes' })
    const hits = text(found)
      .split('\n')
      .filter((line) => line.startsWith('- ['))
    expect(hits).toHaveLength(10)
    for (const line of hits) expect([...line.replace(/^- \[[^\]]+\] /, '')].length).toBeLessThanOrEqual(140)
    expect(text(found)).toContain('23 matching entries')
    expect(text(found)).toContain(ENTRIES_ARE_DATA)

    const page = await run({ op: 'list', kind: 'skill' })
    expect(
      text(page)
        .split('\n')
        .filter((line) => line.startsWith('- [')),
    ).toHaveLength(20)
    expect(text(page)).toContain('cursor "release-19"')
    const next = await run({ op: 'list', kind: 'skill', cursor: 'release-19' })
    expect(
      text(next)
        .split('\n')
        .filter((line) => line.startsWith('- [')),
    ).toEqual([
      expect.stringContaining('[skill/release-20 v1]'),
      expect.stringContaining('[skill/release-21 v1]'),
      expect.stringContaining('[skill/release-22 v1]'),
    ])
    expect(text(next)).not.toContain('cursor')

    const one = await run({ op: 'get', id: 'skill/release-07' })
    expect(one.isError).toBeUndefined()
    expect(text(one)).toContain('[skill/release-07 v1]')
    expect(text(one)).toContain(many[7]?.content)
    expect(text(one)).not.toContain('release-08')
    await session.close()
  })

  it('a full read of an entry whose resource is unusable now says so and keeps the text', async () => {
    const entry = {
      kind: 'skill' as const,
      id: 'notes',
      version: 1,
      title: 'Notes',
      content: 'KEEP-7a',
      truncated: false,
    }
    const runs = (unavailable: boolean): RefinementRuns => ({
      propose: async () => ({ refused: 'unused' }),
      request: async () => ({ refused: 'unused' }),
      inspect: async () => ({ op: 'get', entry: unavailable ? { ...entry, unavailable: true } : entry }),
    })
    const read = async (unavailable: boolean) =>
      text(
        await createInspectTool(connectedToolPort(runs(unavailable))).execute(
          { op: 'get', id: 'skill/notes' } as never,
          fakeToolContext(),
        ),
      )
    const marked = await read(true)
    expect(marked).toContain('cannot be used in this session now')
    expect(marked).toContain('KEEP-7a')
    expect(await read(false)).not.toContain('cannot be used')
  })

  it('inspect never returns another session’s entries', async () => {
    const a = await open({ key: 'a' })
    const b = await open({ key: 'b' })
    await seed(a.session, [{ kind: 'memory', id: 'only-a', title: 'Only in a', content: 'a private fact' }])
    const tool = createInspectTool(connectedToolPort(runsFor([a.session, b.session])))
    const fromB = (args: object) => tool.execute(args as never, contextOf(b.session))
    expect(text(await fromB({ op: 'search', query: 'private fact only-a' }))).toBe(
      'No entry in this session matches.',
    )
    expect(text(await fromB({ op: 'list', kind: 'memory' }))).toBe('No memory entries in this session.')
    const got = await fromB({ op: 'get', id: 'memory/only-a' })
    expect(got.structured).toEqual({ code: 'REFINEMENT_NOT_FOUND' })
    expect(JSON.stringify([got, await fromB({ op: 'list', kind: 'memory' })])).not.toContain('private fact')
    // The same call from a reads a's entry.
    expect(
      text(await tool.execute({ op: 'get', id: 'memory/only-a' } as never, contextOf(a.session))),
    ).toContain('a private fact')
    await a.session.close()
    await b.session.close()
  })

  it('the entry text reaches the next request inside an untrusted envelope', async () => {
    const registry = new ToolRegistry()
    let session: Session | undefined
    const real = createInspectTool(connectedToolPort(runsFor([])))
    // Offered eagerly here so the scripted call needs no tool search; everything else is the real tool.
    const offered: ToolDef = {
      ...real,
      meta: { ...real.meta, deferLoading: false },
      execute: (args, ctx) =>
        createInspectTool(connectedToolPort(runsFor(session ? [session] : []))).execute(args as never, ctx),
    } as ToolDef
    registry.add(offered, { source: 'agnes/refine', trust: 'builtin' })
    const opened = await open({
      registry,
      scripts: [toolTurn('harness_inspect', { op: 'get', id: 'memory/build' }), textTurn('done')],
    })
    session = opened.session
    await seed(session, [{ kind: 'memory', id: 'build', title: 'Build first', content: 'ENTRY-TEXT-7f3' }])
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'what is saved?' }], actor })
    expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
    const rows = await session.scan({ toSeq: session.lastSeq })
    const result = rows.find((row) => row.type === 'tool/result')
    expect(result?.trust).toBe('untrusted')
    const wire = JSON.stringify(opened.provider.requests.at(-1))
    expect(wire).toMatch(/<untrusted id=\\"[^"]+\\" bytes=\\"\d+\\">[^<]*ENTRY-TEXT-7f3[^<]*<\/untrusted/)
    await session.close()
  })
})
