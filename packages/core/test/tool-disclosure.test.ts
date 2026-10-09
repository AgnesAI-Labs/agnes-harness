import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { discloseTools } from '../src/step/inference.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

it.each(['allowed-once', 'rejected'] as const)(
  'loads a deferred schema durably while preserving argument validation and %s approval',
  async (verdict) => {
    const registry = new ToolRegistry()
    const executed: unknown[] = []
    const checked: ToolDef = {
      ...(readTool(async (args) => {
        executed.push(args)
        return { content: [{ type: 'text', text: 'executed' }] }
      }) as ToolDef),
      name: 'later',
      parameters: Type.Object({ amount: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
      meta: { ...(readTool() as ToolDef).meta, deferLoading: true, requiresApproval: 'always' },
    }
    const describe: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'describe',
      parameters: Type.Object({ name: Type.String() }),
      async execute({ name }, ctx) {
        await ctx.tools.disclose!(name)
        return { content: [{ type: 'text', text: name }] }
      },
    }
    for (const tool of [describe, checked]) registry.add(tool, { source: 'test', trust: 'builtin' })
    const approvals: string[] = []
    const provider = fakeProvider([
      toolTurn('later', { amount: 1 }), // Merely knowing its name cannot bypass discovery.
      toolTurn('describe', { name: 'later' }),
      toolTurn('later', { amount: 0 }),
      toolTurn('later', { amount: 1 }),
      textTurn('done'),
    ])
    const seams = fakeSeams({
      approval: {
        ask: async (request) => {
          approvals.push(request.tool?.name ?? '')
          return verdict
        },
      },
    })
    const { session, storage } = await openSession({ provider, registry, seams })
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'discover' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(['describe'])
    expect(provider.requests[2]?.tools.find((tool) => tool.name === 'later')?.parameters).toEqual(
      JSON.parse(JSON.stringify(checked.parameters)),
    )
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
    expect(results[2]?.data).toMatchObject({ code: 'TOOL_ARGS_INVALID', isError: true })
    expect(executed).toEqual(verdict === 'allowed-once' ? [{ amount: 1 }] : [])
    expect(approvals).toHaveLength(1)
    await session.close()
    const reopened = await openSession({
      storage,
      registry,
      seams,
      provider: fakeProvider([textTurn('ready')]),
      writerRunId: 'r2',
    })
    try {
      await reopened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'continue' }] })
      await reopened.session.acceptInput()
      await reopened.session.runInference()
      expect(discloseTools(reopened.session)).toContain('later')
      const rows = await reopened.session.scan({
        type: 'x/core/tool-disclosed',
        toSeq: reopened.session.lastSeq,
      })
      expect(rows.map((row) => row.data)).toEqual([{ name: 'later' }])
    } finally {
      await reopened.session.close()
    }
  },
)
