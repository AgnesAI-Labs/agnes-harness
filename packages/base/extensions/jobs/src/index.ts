import { defineExtension, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { guardedResult } from '../../tools-core/src/guards/output.js'
import { createPtyTools } from './pty-tools.js'
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
      description:
        "List this session and lane's background shell jobs, PTYs, persistent shells and child agents, including completed jobs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      meta,
      async execute(_args, ctx) {
        await jobs.syncChildren(ctx)
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
          await jobs.syncChildren(ctx)
          const job = await jobs.wait(ctx, args.jobId, Math.min(args.waitMs ?? 0, ctx.timeoutMs))
          return {
            structured: { jobId: job.id, status: job.status },
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
          await jobs.syncChildren(ctx)
          const job = await jobs.kill(ctx, args.jobId)
          return {
            content: [{ type: 'text', text: `${job.id}: ${job.status}` }],
            structured: { jobId: job.id, status: job.status },
          }
        } catch (e) {
          return { content: [{ type: 'text', text: String(e) }], isError: true }
        }
      },
    }),
  ]
}
export function createJobsExtension(jobs: ShellJobs) {
  return defineExtension((agnes) => {
    const disposers = [...createJobTools(jobs), ...createPtyTools(jobs)].map((tool) =>
      agnes.registerTool(tool),
    )
    const notified = new Map<string, Set<string>>()
    disposers.push(
      agnes.registerHook('context', async (_payload, ctx) => {
        const key = ctx.session.key + '\0' + ctx.session.lane
        const seen = notified.get(key) ?? new Set<string>()
        const completed = jobs
          .completions({ session: { ...ctx.session, toolUseId: '', depth: 0, generationDepth: 0 } })
          .filter((job) => !seen.has(job.id))
        for (const job of completed) seen.add(job.id)
        notified.set(key, seen)
        return completed.length
          ? {
              additionalContext:
                'Jobs completed: ' +
                completed.map((job) => job.id + ': ' + job.status + ' (exit ' + job.code + ')').join(', '),
            }
          : {}
      }),
    )
    disposers.push(
      agnes.registerHook('shutdown', async (_payload, ctx) => {
        await jobs.closeSession(ctx.session.key, ctx.session.lane)
        notified.delete(ctx.session.key + '\0' + ctx.session.lane)
      }),
    )
    return async () => {
      for (const dispose of disposers) dispose()
      await jobs.dispose()
    }
  })
}
export default createJobsExtension(standaloneShellJobs)
