import { createHash } from 'node:crypto'
import { Type } from '@sinclair/typebox'
import { fixtureConnector } from './mcp-client.mjs'
import { makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'

function createTools(connector) {
  return [
    tool(
      'fde_crm_lookup',
      'Read a synthetic account through the bundled local MCP server.',
      Type.Object({ id: Type.String() }, { additionalProperties: false }),
      async (args, ctx) => value(await connector.call('lookup', args, ctx.signal)),
    ),
    tool(
      'fde_crm_note',
      'After confirmation, record the exact reviewed note in the local CRM simulator.',
      Type.Object(
        { id: Type.String(), text: Type.String({ minLength: 1, maxLength: 4000 }), key: Type.String() },
        { additionalProperties: false },
      ),
      async (args, ctx) => value(await connector.call('note', args, ctx.signal)),
      { ...writeMeta, replay: 'idempotent' },
    ),
  ]
}
export const tools = createTools(fixtureConnector(new URL('./mcp/server.mjs', import.meta.url)))
const stages = [
  {
    name: 'account',
    async run(ctx, _state, signal) {
      return {
        account: value(await ctx.tools.execute({ name: tools[0].name, args: { id: 'A-100' } }, signal)),
      }
    },
  },
  {
    name: 'playbook',
    async run(ctx, state, signal) {
      const suggestion = await modelText(
        ctx,
        state.target,
        'Apply the renewal playbook: cite account health and open tickets, propose an owner follow-up, do not invent discounts. Return only the CRM note.',
        state.data.account,
        signal,
      )
      return {
        note:
          state.target.route === 'demo'
            ? 'Renewal at risk: 3 open tickets. Account team should coordinate support follow-up before renewal.'
            : suggestion,
      }
    },
  },
  {
    name: 'approved-note',
    async run(ctx, state, signal) {
      return {
        receipt: value(
          await ctx.tools.execute(
            {
              name: tools[1].name,
              args: {
                id: state.data.account.id,
                text: state.data.note,
                key: `renewal:${createHash('sha256').update(ctx.sessionKey).digest('hex')}`,
              },
            },
            signal,
          ),
        ),
      }
    },
  },
]
const bundle = makeBundle({ name: 'crm-assistant', tools, stages })
export const { factory, createFactory, policy } = bundle
export const main = {
  ...bundle.main,
  apply(ctx, config) {
    const connector = fixtureConnector(new URL('./mcp/server.mjs', import.meta.url))
    ctx.effect(() => () => connector.close())
    makeBundle({ name: 'crm-assistant', tools: createTools(connector), stages }).main.apply(ctx, config)
  },
}
