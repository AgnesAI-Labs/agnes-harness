import { defineTool, type JobInfo, type ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../guards/output.js'
import { JobParams } from './schemas.js'

/** `[job-1 running]`, `[job-1 exited 0]`, `[job-1 stopped]`: the state a model reads last. */
export function jobState(job: JobInfo): string {
  const state = job.status === 'exited' ? `exited ${job.code ?? '?'}` : job.status
  return `[${job.id} ${state}]`
}

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export const jobTool = defineTool({
  name: 'job',
  description:
    'Look after the background jobs this session started with shell background: true. list names each job with its state; output returns what a job printed since the last read, and waitMs waits up to that long for something new or for the job to end (use it to wait for a server to be ready); stop ends a job together with everything it started. Jobs end when the session closes.',
  parameters: JobParams,
  meta: {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'never',
    costHint: {},
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute(args, ctx): Promise<ToolResult> {
    const jobs = ctx.jobs
    if (!jobs) return fail('background jobs are unavailable here')
    try {
      if (args.action === 'list') {
        const all = await jobs.list()
        return {
          content: [
            {
              type: 'text',
              text: all.length
                ? all.map((job) => `${jobState(job)} ${job.command}`).join('\n')
                : 'no background jobs in this session',
            },
          ],
        }
      }
      if (args.id === undefined) return fail(`action ${args.action} needs the id of a job`)
      if (args.action === 'stop') {
        const job = await jobs.stop(args.id)
        return { content: [{ type: 'text', text: `${jobState(job)} ${job.command}` }] }
      }
      // A wait is held inside this call's own limit, with a second left to answer in.
      const waitMs = args.waitMs === undefined ? 0 : Math.max(0, Math.min(args.waitMs, ctx.timeoutMs - 1000))
      const out = await jobs.output(args.id, waitMs > 0 ? { waitMs } : {})
      const parts: string[] = []
      if (out.dropped > 0) parts.push(`[${out.dropped} earlier characters were not kept]`)
      parts.push(out.text ? out.text.replace(/\n$/, '') : '[no new output]')
      parts.push(jobState(out))
      return guardedResult(ctx, parts.join('\n'))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
})
