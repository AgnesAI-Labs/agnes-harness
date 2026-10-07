import { createHash } from 'node:crypto'
import { Type } from '@sinclair/typebox'
import { fixtureConnector } from './mcp-client.mjs'
import { makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'

function createTools(connector) {
  return [
    tool(
      'fde_device_status',
      'Read the local MCP device simulator.',
      Type.Object({}, { additionalProperties: false }),
      async (args, ctx) => value(await connector.call('status', args, ctx.signal)),
    ),
    tool(
      'fde_device_cool',
      'After human confirmation, request bounded cooling. dry_run defaults to true. No real device is connected.',
      Type.Object(
        {
          key: Type.String(),
          expectedVersion: Type.Integer(),
          targetC: Type.Number({ minimum: 20, maximum: 30 }),
          dry_run: Type.Optional(Type.Boolean({ default: true })),
        },
        { additionalProperties: false },
      ),
      async (args, ctx) => value(await connector.call('cool', args, ctx.signal)),
      { ...writeMeta, replay: 'idempotent' },
    ),
    tool(
      'fde_device_receipt',
      'Read a receipt to distinguish preview from simulated effect.',
      Type.Object({ key: Type.String() }, { additionalProperties: false }),
      async (args, ctx) => value(await connector.call('receipt', args, ctx.signal)),
    ),
  ]
}
export const tools = createTools(fixtureConnector(new URL('./mcp/server.mjs', import.meta.url)))
const stages = [
  {
    name: 'read-status',
    async run(ctx, _state, signal) {
      return { status: value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal)) }
    },
  },
  {
    name: 'detect-anomaly',
    async run(ctx, state, signal) {
      return {
        anomaly: state.data.status.temperatureC > state.data.status.limitC,
        assessment: await modelText(
          ctx,
          state.target,
          'Describe the temperature anomaly using the supplied limit; do not propose unlisted actions.',
          state.data.status,
          signal,
        ),
      }
    },
  },
  {
    name: 'human-confirmation-and-action',
    async run(ctx, state, signal) {
      if (!state.data.anomaly) return { action: null }
      return {
        action: value(
          await ctx.tools.execute(
            {
              name: tools[1].name,
              args: {
                key: `cool:${createHash('sha256').update(ctx.sessionKey).digest('hex')}`,
                expectedVersion: state.data.status.version,
                targetC: 25,
              },
            },
            signal,
          ),
        ),
      }
    },
  },
  {
    name: 'verify-receipt',
    async run(ctx, state, signal) {
      if (!state.data.action) return { verification: { actionNeeded: false } }
      const receipt = value(
        await ctx.tools.execute({ name: tools[2].name, args: { key: state.data.action.key } }, signal),
      )
      const status = value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal))
      if (
        receipt.outcome !== 'completed' ||
        receipt.key !== state.data.action.key ||
        receipt.deviceId !== status.deviceId ||
        (receipt.dry_run
          ? status.version !== state.data.status.version ||
            status.temperatureC !== state.data.status.temperatureC
          : status.temperatureC !== receipt.request.targetC)
      )
        throw new Error('Receipt verification failed: inspect state; do not repeat action')
      return {
        verification: {
          verified: true,
          dry_run: receipt.dry_run,
          effect: receipt.effect,
          temperatureC: status.temperatureC,
        },
      }
    },
  },
]
const bundle = makeBundle({ name: 'device-inspection', tools, stages })
export const { factory, createFactory, policy } = bundle
export const main = {
  ...bundle.main,
  apply(ctx, config) {
    const connector = fixtureConnector(new URL('./mcp/server.mjs', import.meta.url))
    ctx.effect(() => () => connector.close())
    makeBundle({ name: 'device-inspection', tools: createTools(connector), stages }).main.apply(ctx, config)
  },
}
