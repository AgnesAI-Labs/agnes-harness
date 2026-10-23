import type { ServiceContext, ServiceDef } from '@agnes/extension-api'
import type { JsonValue, SessionJob } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { ShellSchema, SignalSchema } from './pty-tools.js'
import type { JobOwner, ShellJobs, ShellJobView } from './registry.js'

const owner = (ctx: ServiceContext): JobOwner => {
  if (!ctx.session) throw new Error('Host has no session-bound jobs service')
  return { session: { ...ctx.session, toolUseId: '', depth: 0, generationDepth: 0 } }
}
const RUN_COMMAND_MAX = 8192
const RUN_DEFAULT_TIMEOUT_MS = 120000
const outputSchema = { type: 'object', additionalProperties: true }
export const jobsReadSchema = Type.Object(
  { jobId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
)
export const jobsControlSchema = Type.Object(
  {
    operation: Type.Union(
      ['open', 'run', 'send', 'resize', 'signal', 'kill'].map((value) => Type.Literal(value)),
    ),
    jobId: Type.Optional(Type.String({ minLength: 1 })),
    shell: Type.Optional(ShellSchema),
    text: Type.Optional(Type.String({ maxLength: 65536 })),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    signal: Type.Optional(SignalSchema),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: RUN_COMMAND_MAX })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000 })),
  },
  { additionalProperties: false },
)
export const jobsServiceCapabilities = [
  {
    name: 'jobs.read',
    kind: 'query' as const,
    inputSchema: {
      type: 'object' as const,
      // Service metadata is JSON; TypeBox symbol annotations must not cross this boundary.
      properties: JSON.parse(JSON.stringify(jobsReadSchema.properties)),
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
      properties: JSON.parse(JSON.stringify(jobsControlSchema.properties)),
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
// Registry views also carry cleanup receipts and legacy shell selectors. Only this allowlist
// crosses the service boundary, so internal additions cannot invalidate strict RPC results.
function publicJob(job: ShellJobView, includeOutput = false): SessionJob {
  return {
    id: job.id,
    owner: job.owner,
    ownerSessionId: job.ownerSessionId,
    kind: job.kind,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    code: job.code,
    truncated: job.truncated || job.stdout.length > 65536 || job.stderr.length > 65536,
    ...(job.shell && job.shell !== 'powershell' ? { shell: job.shell } : {}),
    ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
    ...(includeOutput ? { stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-65536) } : {}),
  }
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
          jobs: jobs.list(scope).map((job) => publicJob(job)),
          completions: jobs.completions(scope).map((job) => publicJob(job)),
        }
        if (typeof input.jobId === 'string') {
          const job = await jobs.wait({ ...scope, signal: ctx.signal }, input.jobId, 0)
          result.job = publicJob(job, true)
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
            true,
            'human',
          )
          return publicJob(job)
        }
        if (input.operation === 'run') {
          const { command, timeoutMs = RUN_DEFAULT_TIMEOUT_MS } = input
          if (
            typeof command !== 'string' ||
            !command ||
            command.includes('\0') ||
            Buffer.byteLength(command) > RUN_COMMAND_MAX
          )
            throw new Error('invalid command')
          if (
            typeof timeoutMs !== 'number' ||
            !Number.isInteger(timeoutMs) ||
            timeoutMs < 1000 ||
            timeoutMs > 600000
          )
            throw new Error('invalid timeoutMs')
          if (!ctx.sandbox?.openProcess)
            throw new Error('SANDBOX_UNAVAILABLE: process service is unavailable')
          return publicJob(
            await jobs.run(
              { ...scope, cwd: ctx.cwd, fs: ctx.fs, signal: ctx.signal, sandbox: ctx.sandbox },
              command,
              timeoutMs,
              ctx.platform?.shell === 'powershell',
            ),
          )
        }
        if (typeof input.jobId !== 'string') throw new Error('jobId is required')
        const job = jobs.list(scope).find((candidate) => candidate.id === input.jobId)
        if (!job || job.owner !== 'human')
          throw new Error('CAPABILITY_DENIED: only human terminals can be controlled by the UI')
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
        else if (input.operation === 'kill') {
          const killed = await jobs.kill(scope, input.jobId)
          return publicJob(killed)
        } else throw new Error('invalid job operation')
        return { ok: true }
      },
    },
  ]
}
