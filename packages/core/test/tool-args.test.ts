import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { noopHooks } from '../src/step/session.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const parameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    count: Type.Integer({ minimum: 1 }),
    mode: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    tags: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
)
const good = { path: 'file', count: 1, mode: 'read' }
async function check(args: unknown, schema = parameters) {
  const reached: string[] = []
  const registry = new ToolRegistry()
  const def: ToolDef = {
    name: 'checked',
    description: 'schema-checked',
    parameters: schema,
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'always',
    },
    async execute(value) {
      reached.push('execute')
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    },
  }
  registry.add(def, { source: 'test', trust: 'builtin' })
  const seams = fakeSeams({
    principals: {
      authorize: async () => {
        reached.push('authorize')
        return { effect: 'allow', decisionId: 'a', reason: 'ok' }
      },
    },
    approval: {
      ask: async () => {
        reached.push('approval')
        return 'allowed-once'
      },
    },
  })
  const provider = fakeProvider([toolTurn('checked', args), textTurn('handled')])
  const { session, log } = await openSession({
    provider,
    registry,
    seams,
    hooks: {
      ...noopHooks,
      toolCall: async () => {
        reached.push('hook')
        return { allow: true }
      },
    },
  })
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  return {
    reached,
    result: (await log.scan({ type: 'tool/result', toSeq: log.lastSeq }))[0]?.data,
    toolEffects: (await log.scan({ type: 'effect/intent', toSeq: log.lastSeq })).filter(
      (e) => (e.data as { kind: string }).kind === 'tool',
    ),
    provider,
  }
}

describe('tool argument boundary', () => {
  it.each([
    {},
    { ...good, count: '1' },
    { ...good, count: 0 },
    { ...good, count: 1.5 },
    { ...good, mode: 'private' },
    { ...good, path: '' },
    { ...good, extra: true },
    { ...good, tags: [1] },
    null,
  ])('refuses invalid arguments before hooks, authorization, approval, and effects: %j', async (args) => {
    const out = await check(args)
    expect(out.reached).toEqual([])
    expect(out.toolEffects).toEqual([])
    expect(out.result).toMatchObject({ isError: true, code: 'TOOL_ARGS_INVALID' })
    expect(out.provider.calls).toBe(2)
    expect(JSON.stringify(out.provider.requests[1]?.messages)).toContain('tool arguments do not match')
  })
  it('runs valid arguments through every existing guard, with omitted optional tags preserved', async () => {
    const out = await check(good)
    expect(out.reached).toEqual(['hook', 'authorize', 'approval', 'execute'])
    expect(out.toolEffects).toHaveLength(1)
    expect(out.result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(good) }],
    })
  })
  it('fails closed if a registered schema cannot be interpreted', async () => {
    const malformed = { type: 'object' } as unknown as typeof parameters
    const out = await check(good, malformed)
    expect(out.reached).toEqual([])
    expect(out.toolEffects).toEqual([])
    expect(out.result).toMatchObject({ isError: true, code: 'TOOL_ARGS_INVALID' })
  })
})
