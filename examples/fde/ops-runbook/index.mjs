import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { checked, makeBundle, modelText, readMeta, text, tool, value, writeMeta } from './runtime.mjs'

const runbook = JSON.parse(readFileSync(new URL('./fixtures/runbook.json', import.meta.url)))
export const tools = [
  tool(
    'fde_ops_read',
    'Read a synthetic runbook; commands are fixed by the author.',
    Type.Object({}),
    () => ({ steps: runbook }),
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
      const output = checked(
        await ctx.tools.execute(
          {
            name: 'shell',
            args: {
              command: 'node -e \'process.stdout.write("synthetic-service: degraded")\'',
              background: true,
              timeoutMs: 1000,
            },
          },
          signal,
        ),
      )
      if (typeof output.details?.jobId !== 'string') throw new Error('No session-owned diagnostic job')
      return { diagnosticJob: output.details.jobId }
    },
  },
  {
    name: 'wait-for-diagnostic',
    async run(ctx, state, signal) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const output = checked(
          await ctx.tools.execute(
            { name: 'job_output', args: { jobId: state.data.diagnosticJob, waitMs: 1000 } },
            signal,
          ),
        )
        if (output.details?.status === 'running') continue
        if (output.details?.status !== 'completed' || output.details.code !== 0 || output.details.truncated)
          throw new Error('Diagnostic job failed or evidence is incomplete')
        return { diagnostic: { status: text(output), jobId: state.data.diagnosticJob } }
      }
      throw new Error(
        'Diagnostic still running; inspect job_list/job_output or stop the owned job with job_kill',
      )
    },
  },
  {
    name: 'restart',
    confirm: () => 'Execute the fixed synthetic restart step after reviewing the diagnostic?',
    async run(ctx, state, signal) {
      return {
        action: value(
          await ctx.tools.execute(
            { name: 'fde_ops_restart', args: { step: state.data.steps[1].id } },
            signal,
          ),
        ),
      }
    },
  },
  {
    name: 'verify',
    async run(ctx, state, signal) {
      const verification = value(
        await ctx.tools.execute(
          { name: 'fde_ops_verify', args: { receipt: state.data.action.receipt } },
          signal,
        ),
      )
      return {
        verification,
        commentary: await modelText(
          ctx,
          'Explain this synthetic runbook result and its verification scope.',
          state.data,
          signal,
        ),
      }
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({ name: 'ops-runbook', tools, stages })
