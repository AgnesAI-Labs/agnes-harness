import type { HookContext, HookPayloadMap, HookReturnMap } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { guardedResult } from '../../tools-core/src/guards/output.js'
import { deadlineWait } from '../../tools-core/src/shell-guidance.js'
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
    deferLoading: 'auto' as const,
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
          const job = await jobs.wait(
            ctx,
            args.jobId,
            // A wait never runs into the turn's deadline; the job itself keeps running.
            deadlineWait(ctx, Math.min(args.waitMs ?? 0, ctx.timeoutMs)).waitMs,
          )
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
const ownerOf = (ctx: Pick<HookContext, 'session'>) => ({
  session: { ...ctx.session, toolUseId: '', depth: 0, generationDepth: 0 },
})

/**
 * The session's job hooks. `turn_stopping` covers an unattended turn (`agh -p`, scheduled runs): jobs
 * it leaves running outlive the answer with nobody to stop them, and may disturb whatever runs next.
 * Whether one is a server the task asked to keep up cannot be told from the job, so the model is
 * shown each still-running job once and decides; nothing is stopped behind its back.
 */
export function jobHooks(jobs: ShellJobs) {
  const notified = new Map<string, Set<string>>()
  const listed = new Map<string, Set<string>>()
  const keyOf = (ctx: Pick<HookContext, 'session'>) => ctx.session.key + '\0' + ctx.session.lane
  return {
    async context(_payload: HookPayloadMap['context'], ctx: HookContext): Promise<HookReturnMap['context']> {
      const key = keyOf(ctx)
      const seen = notified.get(key) ?? new Set<string>()
      const completed = jobs.completions(ownerOf(ctx)).filter((job) => !seen.has(job.id))
      for (const job of completed) seen.add(job.id)
      notified.set(key, seen)
      return completed.length
        ? {
            additionalContext:
              'Jobs completed: ' +
              completed.map((job) => job.id + ': ' + job.status + ' (exit ' + job.code + ')').join(', '),
          }
        : {}
    },
    async turn_stopping(
      _payload: HookPayloadMap['turn_stopping'],
      ctx: HookContext,
    ): Promise<HookReturnMap['turn_stopping']> {
      if (ctx.unattended !== true) return { action: 'stop' }
      const key = keyOf(ctx)
      const seen = listed.get(key) ?? new Set<string>()
      const running = jobs
        .list(ownerOf(ctx))
        .filter(
          (job) =>
            job.status === 'running' &&
            job.owner === 'agent' &&
            (job.kind === 'shell' || job.kind === 'pty') &&
            !seen.has(job.id),
        )
      if (!running.length) return { action: 'stop' }
      for (const job of running) seen.add(job.id)
      listed.set(key, seen)
      const items = running.map((job) => `${job.id} (${job.command.slice(0, 120)})`).join(', ')
      return {
        action: 'continue',
        note: `Before you finish: ${running.length === 1 ? 'this background job is' : 'these background jobs are'} still running, and nobody will stop ${running.length === 1 ? 'it' : 'them'} after your answer: ${items}. Stop with job_kill each one the task does not need; leave running only what the task asks to stay up, such as a server it serves from. Then give your final answer.`,
      }
    },
    async shutdown(_payload: HookPayloadMap['shutdown'], ctx: HookContext): Promise<void> {
      await jobs.closeSession(ctx.session.key, ctx.session.lane)
      notified.delete(keyOf(ctx))
      listed.delete(keyOf(ctx))
    },
  }
}

export function createJobsExtension(jobs: ShellJobs) {
  return defineAgnesPlugin({
    inject: ['tools', 'hooks'],
    apply(plugin: Context) {
      const disposers = [...createJobTools(jobs), ...createPtyTools(jobs)].map((tool) =>
        plugin.tools.register(tool),
      )
      const hooks = jobHooks(jobs)
      disposers.push(plugin.hooks.register('context', hooks.context))
      disposers.push(plugin.hooks.register('turn_stopping', hooks.turn_stopping))
      disposers.push(plugin.hooks.register('shutdown', hooks.shutdown))
      return async () => {
        for (const dispose of disposers) dispose()
        await jobs.dispose()
      }
    },
  })
}
export default createJobsExtension(standaloneShellJobs)
