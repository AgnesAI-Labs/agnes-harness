import type { ServiceContext, ServiceDef } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { ShellSchema, SignalSchema } from './pty-tools.js'
import type { JobOwner, ShellJobs } from './registry.js'

const owner = (ctx: ServiceContext): JobOwner => {
  if (!ctx.session) throw new Error('Host has no session-bound jobs service')
  return { session: { ...ctx.session, toolUseId: '', depth: 0, generationDepth: 0 } }
}
const outputSchema = { type: 'object', additionalProperties: true }
export const jobsReadSchema = Type.Object(
  { jobId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
)
export const jobsControlSchema = Type.Object(
  {
    operation: Type.Union(['open', 'send', 'resize', 'signal', 'kill'].map((value) => Type.Literal(value))),
    jobId: Type.Optional(Type.String({ minLength: 1 })),
    shell: Type.Optional(ShellSchema),
    text: Type.Optional(Type.String({ maxLength: 65536 })),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    signal: Type.Optional(SignalSchema),
  },
  { additionalProperties: false },
)
export const jobsServiceCapabilities = [
  {
    name: 'jobs.read',
    kind: 'query' as const,
    inputSchema: {
      type: 'object' as const,
      properties: jobsReadSchema.properties,
      additionalProperties: false as const,
    },
    outputSchema,
    timeoutMs: 10000,
    maxResultBytes: 1048576,
  },
  {
    name: 'jobs.control',
    kind: 'effect' as const,
    inputSchema: {
      type: 'object' as const,
      properties: jobsControlSchema.properties,
      required: ['operation'] as string[],
      additionalProperties: false as const,
    },
    outputSchema,
    timeoutMs: 10000,
    maxResultBytes: 1048576,
  },
] as const
const objectInput = (input: JsonValue): Record<string, JsonValue> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('object input required')
  return input
}
export function createJobsServices(jobs: ShellJobs): ServiceDef[] {
  return [
    {
      ...jobsServiceCapabilities[0]!,
      async handler(raw, ctx): Promise<JsonValue> {
        const input = objectInput(raw)
        const scope = owner(ctx)
        await jobs.syncChildren({ ...scope, cwd: ctx.cwd }, ctx.childJobs)
        const result: Record<string, JsonValue> = {
          jobs: jobs.list(scope).map(({ stdout, stderr, ...job }) => job),
          completions: jobs.completions(scope).map((job) => ({ ...job })),
        }
        if (typeof input.jobId === 'string') {
          const job = await jobs.wait({ ...scope, signal: ctx.signal }, input.jobId, 0)
          result.job = { ...job, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-65536) }
        }
        return result
      },
    },
    {
      ...jobsServiceCapabilities[1]!,
      async handler(raw, ctx): Promise<JsonValue> {
        const input = objectInput(raw)
        const scope = owner(ctx)
        await jobs.syncChildren({ ...scope, cwd: ctx.cwd }, ctx.childJobs)
        if (input.operation === 'open') {
          if (!ctx.sandbox?.openProcess)
            throw new Error('SANDBOX_UNAVAILABLE: interactive process service is unavailable')
          const shell = input.shell ?? 'bash'
          if (shell !== 'bash' && shell !== 'zsh' && shell !== 'pwsh') throw new Error('invalid shell')
          const job = await jobs.openTerminal(
            { ...scope, cwd: ctx.cwd, fs: ctx.fs, signal: ctx.signal, sandbox: ctx.sandbox },
            shell,
            ctx.cwd,
            {
              columns: typeof input.columns === 'number' ? input.columns : 100,
              rows: typeof input.rows === 'number' ? input.rows : 30,
            },
          )
          return { ...job }
        }
        if (typeof input.jobId !== 'string') throw new Error('jobId is required')
        if (input.operation === 'send' && typeof input.text === 'string')
          await jobs.send(scope, input.jobId, input.text)
        else if (
          input.operation === 'resize' &&
          typeof input.columns === 'number' &&
          typeof input.rows === 'number'
        )
          await jobs.resize(scope, input.jobId, input.columns, input.rows)
        else if (
          input.operation === 'signal' &&
          (input.signal === 'SIGINT' || input.signal === 'SIGTERM' || input.signal === 'SIGHUP')
        )
          await jobs.signal(scope, input.jobId, input.signal)
        else if (input.operation === 'kill') return { ...(await jobs.kill(scope, input.jobId)) }
        else throw new Error('invalid job operation')
        return { ok: true }
      },
    },
  ]
}
