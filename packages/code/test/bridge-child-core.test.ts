import { type ChildHandle, type ChildrenFactory, ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, openSession, textTurn, toolTurn } from '@agnes/core/testkit'
import { expect, it } from 'vitest'
import { createBridge } from '../src/extensions/code-mode/bridge.js'
import { tool } from './fixtures/sdk.js'

it('uses the returned childKey to collect an actual child session through core and bridge', async () => {
  const child = await openSession({
    key: 'actual-child',
    provider: fakeProvider([textTurn('actual child answer')]),
  })
  let running: Promise<{ text: string; lastSeq: number }> | undefined
  let finished: { text: string; lastSeq: number } | undefined
  let created = 0
  const handle: ChildHandle = {
    key: child.session.key,
    run(input) {
      running = (async () => {
        await child.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: input }] })
        const result = await child.session.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(result.reason).toBe('completed')
        const events = await child.session.scan({
          fromSeq: 1,
          toSeq: result.lastSeq,
          type: 'assistant/message',
        })
        const event = events.at(-1)
        if (!event) throw new Error('child produced no assistant message')
        const content = (event.data as { content: Array<{ type: string; text?: string }> }).content
        const text = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
        finished = { text, lastSeq: result.lastSeq }
        return finished
      })()
      return running
    },
    async status() {
      return finished ? { state: 'done', ...finished } : { state: 'running', lastSeq: child.session.lastSeq }
    },
    close: () => child.session.close(),
  }
  const children: ChildrenFactory = {
    async create() {
      created++
      return handle
    },
    get: (key) => (key === handle.key ? handle : undefined),
  }
  const registry = new ToolRegistry()
  const probe = tool('child_probe')
  const replies: unknown[] = []
  probe.execute = async (_args, ctx) => {
    const bridge = createBridge(ctx)
    const spawned = (await bridge({
      jsonrpc: '2.0',
      id: 1,
      method: 'bridge.subagent.spawn',
      params: { task: 'answer' },
    })) as { result?: { childKey?: string } }
    replies.push(spawned)
    await running
    replies.push(
      await bridge({
        jsonrpc: '2.0',
        id: 2,
        method: 'bridge.subagent.collect',
        params: { childKey: spawned.result?.childKey },
      }),
    )
    return { content: [{ type: 'text', text: JSON.stringify(replies) }] }
  }
  registry.add(probe, { source: 'fixture/child-bridge', trust: 'trusted' })
  const provider = fakeProvider([toolTurn('child_probe', {}), textTurn('parent done')])
  const parent = await openSession({ key: 'actual-parent', provider, registry, children })
  try {
    await parent.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'use a child' }] })
    expect(
      (await parent.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    expect(created).toBe(1)
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: 1, result: { childKey: 'actual-child' } },
      {
        jsonrpc: '2.0',
        id: 2,
        result: { childKey: 'actual-child', status: 'completed', text: 'actual child answer' },
      },
    ])
    expect(JSON.stringify(provider.requests[1])).toContain('actual child answer')
  } finally {
    await parent.session.close()
    await child.session.close()
  }
})

it.each([
  ['running', 'running'],
  ['done', 'completed'],
  ['error', 'failed'],
] as const)('maps internal child status %s to author status %s', async (state, expected) => {
  const registry = new ToolRegistry()
  const probe = tool('collect_probe')
  let observed: unknown
  probe.execute = async (_args, ctx) => {
    observed = await ctx.subagent.collect('known-child')
    return { content: [] }
  }
  registry.add(probe, { source: 'fixture/child-status', trust: 'trusted' })
  const children: ChildrenFactory = {
    create: async () => {
      throw new Error('collect must not create a child')
    },
    get: (key) =>
      key === 'known-child'
        ? {
            key,
            run: async () => {
              throw new Error('collect must not rerun a child')
            },
            status: async () => ({ state, lastSeq: 0, text: '' }),
            close: async () => {},
          }
        : undefined,
  }
  const { session } = await openSession({
    registry,
    children,
    provider: fakeProvider([toolTurn('collect_probe', {}), textTurn('done')]),
  })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'collect' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(observed).toEqual({ childKey: 'known-child', status: expected, text: '' })
  } finally {
    await session.close()
  }
})
