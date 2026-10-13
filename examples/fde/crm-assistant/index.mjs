import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  defineWorkflowLoop,
  workflowModelText as modelText,
  workflowTool as tool,
  workflowValue as value,
  writeTool,
} from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { fixtureConnector } from './mcp-client.mjs'

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
      { ...writeTool, replay: 'idempotent' },
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
        'Apply the renewal playbook: cite account health and open tickets, propose an owner follow-up, do not invent discounts. Return only the CRM note.',
        state.data.account,
        signal,
      )
      return {
        note:
          (await ctx.turn.view())?.model.id === 'demo-model'
            ? 'Renewal at risk: 3 open tickets. Account team should coordinate support follow-up before renewal.'
            : suggestion,
      }
    },
  },
  {
    name: 'approved-note',
    confirm: (state) =>
      `Record the reviewed renewal note for ${state.data.account.id}? Review the complete note deliverable before proceeding.`,
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
const workflowOptions = {
  id: 'fde.crm-assistant',
  version: '5.0.0',
  confirm: 'surface',
  deliverables: {
    directory: 'fde-output/crm-assistant',
  },
  skills: [
    {
      name: 'crm-assistant',
      description: 'Business playbook for crm-assistant',
      body: readFileSync(new URL('./skills/playbook/SKILL.md', import.meta.url), 'utf8'),
    },
  ],
  name: 'crm-assistant',
  stages,
}
const bundle = defineWorkflowLoop({ ...workflowOptions, tools })
export const { factory, createFactory, policy } = bundle
export const main = {
  ...bundle.main,
  apply(ctx, config) {
    const connector = fixtureConnector(new URL('./mcp/server.mjs', import.meta.url))
    ctx.effect(() => () => connector.close())
    defineWorkflowLoop({ ...workflowOptions, tools: createTools(connector) }).main.apply(ctx, config)
  },
}
