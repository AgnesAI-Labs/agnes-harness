import { defineExtension, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { guardedResult } from '../../tools-core/src/guards/output.js'
import { type ShellJobs, standaloneShellJobs } from './registry.js'

export function createJobTools(jobs: ShellJobs) {
  const meta = {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe' as const,
    costHint: {},
    deferLoading: false,
    requiresApproval: 'never' as const,
  }
  return [
    defineTool({
      name: 'job_list',
      description: "List this session and lane's background shell jobs, including completed jobs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      meta,
      async execute(_args, ctx) {
        return guardedResult(ctx, JSON.stringify(jobs.list(ctx).map(({ stdout, stderr, ...view }) => view)))
      },
    }),
    defineTool({
      name: 'job_output',
      description:
        'Read captured output and status of a background shell job. Long output spills to a readable artifact. waitMs optionally waits, without stopping the job.',
      parameters: Type.Object(
        { jobId: Type.String(), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })) },
        { additionalProperties: false },
      ),
      meta,
      async execute(args, ctx) {
        try {
          const job = await jobs.wait(ctx, args.jobId, Math.min(args.waitMs ?? 0, ctx.timeoutMs))
          return {
            ...(await guardedResult(
              ctx,
              `${job.stdout}${job.stderr ? `\n[stderr]\n${job.stderr}` : ''}\n[${job.status}; exit ${job.code ?? 'pending'}]${job.truncated ? ' [capture limit reached]' : ''}`,
            )),
            details: { jobId: job.id, status: job.status, code: job.code, truncated: job.truncated },
          }
        } catch (e) {
          return { content: [{ type: 'text', text: String(e) }], isError: true }
        }
      },
    }),
    defineTool({
      name: 'job_kill',
      description: 'Stop a background shell job and its process group owned by this session/lane.',
      parameters: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
      meta: { ...meta, isReadOnly: false, isDestructive: true, replay: 'idempotent' as const },
      async execute(args, ctx) {
        try {
          const job = await jobs.kill(ctx, args.jobId)
          return { content: [{ type: 'text', text: `${job.id}: ${job.status}` }] }
        } catch (e) {
          return { content: [{ type: 'text', text: String(e) }], isError: true }
        }
      },
    }),
  ]
}
export function createJobsExtension(jobs: ShellJobs) {
  return defineExtension((agnes) => {
    const disposers = createJobTools(jobs).map((tool) => agnes.registerTool(tool))
    disposers.push(
      agnes.registerHook('shutdown', async (_payload, ctx) => {
        await jobs.closeSession(ctx.session.key, ctx.session.lane)
      }),
    )
    return async () => {
      for (const dispose of disposers) dispose()
      await jobs.dispose()
    }
  })
}
export default createJobsExtension(standaloneShellJobs)
