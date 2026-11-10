import type { HookContext, HookPayloadMap, HookReturnMap } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { guardedCommandResult, guardedResult } from '../../tools-core/src/guards/output.js'
import { deadlineWait } from '../../tools-core/src/shell-guidance.js'
import { createPtyTools } from './pty-tools.js'
import { type ShellJobs, standaloneShellJobs } from './registry.js'

/** The longest one job_output call waits for its job; a wait still ends as soon as the job does. */
export const JOB_OUTPUT_WAIT_MAX_MS = 300_000

/**
 * How long a job has run, always with its minutes (`0m05s`, `4m20s`, `1h02m03s`). Core's repeat
 * reminder blanks a bare `45s` as timing noise but keeps a figure written with minutes, so two polls
 * of a job that is still running never read as the same result.
 */
export function runningFor(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const [h, m, sec] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  const tail = `${String(sec).padStart(2, '0')}s`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${tail}` : `${m}m${tail}`
}

export function createJobTools(jobs: ShellJobs) {
  const meta = {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe' as const,
    costHint: {},
    // The model reaches for these as soon as it runs a background command; loading them through
    // tool_describe mid-session would change the tool list and force the whole context to be recomputed.
    deferLoading: false as const,
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
        'Read captured output and status of a background shell job. Long output spills to a readable artifact. waitMs optionally waits up to 5 minutes, without stopping the job, and returns as soon as the job ends. Pass the returned cursor to read only new output; gaps are reported. Cursors are session/lane/job scoped and invalid after restart.',
      parameters: Type.Object(
        {
          jobId: Type.String(),
          cursor: Type.Optional(Type.String({ maxLength: 4096 })),
          waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: JOB_OUTPUT_WAIT_MAX_MS })),
        },
        { additionalProperties: false },
      ),
      meta,
      async execute(args, ctx) {
        try {
          await jobs.syncChildren(ctx)
          await jobs.wait(
            ctx,
            args.jobId,
            // The job keeps running after the wait, as a continuing shell command does, so a timed turn
            // ends this wait where it ends a shell wait: with half of the usable time still left.
            deadlineWait(ctx, Math.min(args.waitMs ?? 0, ctx.timeoutMs), { continues: true }).waitMs,
          )
          const job = jobs.output(ctx, args.jobId, args.cursor)
          // The model now knows how a finished job ended; a completion notice would only repeat it.
          if (job.status !== 'running') jobs.acknowledge(ctx, job.id)
          const status =
            job.status === 'running' ? `running for ${runningFor(Date.now() - job.startedAt)}` : job.status
          return {
            structured: { jobId: job.id, status: job.status, cursor: job.cursor, gap: job.gap },
            ...(await guardedCommandResult(
              ctx,
              `${job.gap ? '[output gap: job buffer discarded unread output]\n' : ''}${job.stdout}${job.stderr ? `\n[stderr]\n${job.stderr}` : ''}\n[${status}; exit ${job.code ?? 'pending'}]${job.truncated ? ' [capture limit reached]' : ''}`,
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
          jobs.acknowledge(ctx, job.id)
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
 * The session's job hooks.
 *
 * `context` tells the model about jobs that ended since it was last told, on the next request rather
 * than whenever the turn's other context changes: it asks to run before every request. The notice is
 * a live note (`jobs:completed`) holding the newest batch. Core sends a live note only when its text
 * changes, so the batch reaches the model once, and a request with nothing newly ended carries
 * nothing new; a note in the shared hook-context message would instead be sent again, or cleared,
 * whenever another contributor's line changed. Jobs whose end a tool result already showed (a
 * foreground command, a read of a finished job, a kill) are left out.
 *
 * `turn_stopping` covers an unattended turn (`agh -p`, scheduled runs): jobs it leaves running
 * outlive the answer with nobody to stop them, and may disturb whatever runs next. Whether one is a
 * server the task asked to keep up cannot be told from the job, so the model is shown each
 * still-running job once and decides; nothing is stopped behind its back.
 */
export function jobHooks(jobs: ShellJobs) {
  const notices = new Map<string, string>()
  const listed = new Map<string, Set<string>>()
  const keyOf = (ctx: Pick<HookContext, 'session'>) => ctx.session.key + '\0' + ctx.session.lane
  return {
    async context(_payload: HookPayloadMap['context'], ctx: HookContext): Promise<HookReturnMap['context']> {
      const key = keyOf(ctx)
      const ended = jobs.announceCompletions(ownerOf(ctx))
      if (ended.length)
        notices.set(
          key,
          `Jobs completed: ${ended.map((job) => `${job.id}: ${job.status} (exit ${job.code})`).join(', ')}`,
        )
      const notice = notices.get(key)
      return {
        refreshOnRequest: true,
        ...(notice
          ? {
              sections: [
                { id: 'jobs:completed', order: 117, content: notice, delivery: 'live-note' as const },
              ],
            }
          : {}),
      }
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
      notices.delete(keyOf(ctx))
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
