import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { makeBundle, modelText, readMeta, tool, value, writeMeta } from './runtime.mjs'

const runbook = JSON.parse(readFileSync(new URL('./fixtures/runbook.json', import.meta.url)))
export const tools = [
  tool(
    'fde_ops_read',
    'Read a synthetic runbook; commands are fixed by the author.',
    Type.Object({}),
    () => ({ steps: runbook }),
  ),
  tool(
    'fde_ops_check',
    'Run a fixed read-only diagnostic through the selected Host execution/sandbox provider.',
    Type.Object({}),
    async (_, ctx) => {
      const output = await ctx.exec(['node', '-e', 'process.stdout.write("synthetic-service: degraded")'])
      if (output.code !== 0) throw new Error('Diagnostic failed')
      return { status: output.stdout, sandbox: ctx.sandbox.enforcement() }
    },
  ),
  tool(
    'fde_ops_restart',
    'After human confirmation, execute only the synthetic restart command through Host exec.',
    Type.Object({ step: Type.Literal('restart-synthetic-service') }),
    async (_, ctx) => {
      const output = await ctx.exec([
        'node',
        '-e',
        'process.stdout.write("synthetic-service: restart acknowledged")',
      ])
      if (output.code !== 0) throw new Error('Restart command failed; inspect before retry')
      return { receipt: output.stdout, status: 'simulated-restart' }
    },
    writeMeta,
  ),
  tool(
    'fde_ops_verify',
    'Verify the simulated restart receipt without repeating the command.',
    Type.Object({ receipt: Type.String() }),
    ({ receipt }) => {
      if (receipt !== 'synthetic-service: restart acknowledged')
        throw new Error('Missing or unknown restart receipt')
      return { verified: true, scope: 'synthetic fixture only' }
    },
    readMeta,
  ),
]
const stages = [
  {
    name: 'runbook',
    async run(ctx, _state, signal) {
      return value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal))
    },
  },
  {
    name: 'diagnose',
    async run(ctx, _state, signal) {
      return { diagnostic: value(await ctx.tools.execute({ name: tools[1].name, args: {} }, signal)) }
    },
  },
  {
    name: 'restart',
    async run(ctx, state, signal) {
      return {
        action: value(
          await ctx.tools.execute({ name: tools[2].name, args: { step: state.data.steps[1].id } }, signal),
        ),
      }
    },
  },
  {
    name: 'verify',
    async run(ctx, state, signal) {
      const verification = value(
        await ctx.tools.execute(
          { name: tools[3].name, args: { receipt: state.data.action.receipt } },
          signal,
        ),
      )
      return {
        verification,
        commentary: await modelText(
          ctx,
          state.target,
          'Explain this synthetic runbook result and its verification scope.',
          state.data,
          signal,
        ),
      }
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({ name: 'ops-runbook', tools, stages })
