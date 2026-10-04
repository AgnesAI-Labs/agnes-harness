import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as R from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest as hash,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { syncDirectorySync } from '@agnes/system-node'

interface Measurements {
  pid: number
  final: boolean
  reason: string
  code: number
  signal: number
  cpuMs: number
  rss: number
  processes: number
  files: number
  outputBytes: number
  intervalMs: number
  maxGapMs: number
  remaining: number
  ownershipVerified: boolean
  residualObserved: number
  ownership: string
  committedBytes?: number
  filesEnforced?: boolean
}
interface CabinetEntry {
  id: string
  owner: string
  digest: string
  ref: R.ExecutionRef
  reply: Outcome<R.ExecResult> | null
  value: R.ExecResult | null
  counters: Measurements | null
  pins: R.RetentionRef[] | null
}
export interface ReferenceExecOptions {
  directory: string
  authorityId: string
  tenantId: string
  scope: R.ScopeRef
  sandbox: {
    withExecution<T>(
      request: R.ExecRequest,
      context: CallContext,
      execute: (launch: {
        argv: readonly string[]
        cwd: string
        signal: AbortSignal
        cwdFd: number
        rootFd: number
        cwdRoot: string
      }) => Promise<T>,
    ): Promise<Outcome<T>>
  }
  identity: {
    resolve(input: R.IdentityResolveRequest, context: CallContext): Promise<Outcome<R.AuthenticatedIdentity>>
  }
  authorize(context: CallContext): boolean | Promise<boolean>
  environment: Readonly<Record<string, string>>
  literalNames: readonly string[]
  content: {
    read(ref: R.BytesRef, context: CallContext): Promise<Uint8Array>
    retain(bytes: Uint8Array, context: CallContext): Promise<{ ref: R.BytesRef; retention: R.RetentionRef }>
  }
}
class Problem {
  constructor(
    readonly detail: string,
    readonly category: R.RuntimeError['code'] = 'denied',
  ) {}
}
function reject(
  detail: string,
  category: R.RuntimeError['code'] = 'denied',
  entry?: CabinetEntry,
): Outcome<never> {
  return {
    ok: false,
    error: {
      diagnosticId: 'reference-exec',
      detailCode: detail,
      code: category,
      message: 'Execution request refused',
      retryAdvice: entry
        ? { kind: 'reconcile', ownerRef: { kind: 'reconciliation', id: entry.id } }
        : { kind: 'never' },
      ...(entry
        ? {
            safeDetail: {
              executionRef: entry.ref,
              ...(entry.counters
                ? { metrics: entry.counters }
                : {
                    ownership: {
                      verified: false,
                      remaining: null,
                      reason: 'Ownership terminal evidence is missing',
                    },
                  }),
            } as unknown as R.JsonValue,
          }
        : {}),
    },
  }
}
const equal = (a: unknown, b: unknown) => hash(a as R.JsonValue) === hash(b as R.JsonValue)
function data(value: R.JsonValue): R.DataRef {
  return {
    kind: 'inline',
    digest: hash(value),
    bytes: Buffer.byteLength(JSON.stringify(value)),
    value,
    schema: RuntimeMethodSchemaRefs['agh.exec'].reconcile.input,
  }
}
async function bounded<T>(signal: AbortSignal, promise: Promise<T>) {
  let cancel!: () => void
  const interrupted = new Promise<never>((_, fail) => {
    cancel = () => fail(new Problem('exec_cancelled', 'cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([interrupted, promise])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
export function createReferenceExec(raw: ReferenceExecOptions) {
  const options = {
    ...raw,
    scope: structuredClone(raw.scope),
    environment: { ...raw.environment },
    literalNames: [...raw.literalNames],
  }
  const binding: R.BindingRef = {
    contract: 'agh.exec',
    providerId: 'agh.reference/exec',
    bindingId: 'agh.reference/exec/binding',
    logicalName: 'exec',
  }
  const providerDigest = hash({
    contract: binding.contract,
    implementation: 'hard-gate-refusal-linked-event-owner-array-cabinet',
  })
  // guards-allow-platform: qualification follows the native reference's supported backend.
  const supported = process.platform === 'darwin'
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  chmodSync(options.directory, 0o700)
  const cabinet = join(options.directory, 'exec-cabinet.json')
  const entries = existsSync(cabinet) ? (JSON.parse(readFileSync(cabinet, 'utf8')) as CabinetEntry[]) : []
  const shutdown = new AbortController(),
    work: Promise<unknown>[] = []
  let closing: Promise<void> | undefined
  function flush() {
    if (!supported) return
    const temp = `${cabinet}.${randomUUID()}`
    writeFileSync(temp, JSON.stringify(entries), { flag: 'wx', mode: 0o600 })
    const fd = openSync(temp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, cabinet)
    syncDirectorySync(options.directory)
  }
  flush()
  function signal(context: CallContext) {
    const milliseconds = Date.parse(context.deadline) - Date.now()
    if (context.signal.aborted || !Number.isFinite(milliseconds) || milliseconds <= 0)
      throw new Problem('exec_cancelled', 'cancelled')
    return AbortSignal.any([
      context.signal,
      shutdown.signal,
      AbortSignal.timeout(Math.min(milliseconds, 60000)),
    ])
  }
  async function authorize(context: CallContext) {
    if (shutdown.signal.aborted) throw new Problem('exec_closed')
    const clock = signal(context),
      identity = await bounded(
        clock,
        options.identity.resolve({ principalRef: context.principalRef }, context),
      )
    if (
      !identity.ok ||
      !validateRuntime('AuthenticatedIdentity', identity.value).ok ||
      identity.value.principalRef !== context.principalRef ||
      identity.value.tenantRef !== options.tenantId ||
      Date.parse(identity.value.expiresAt) <= Date.now() ||
      !equal(context.scope, options.scope) ||
      !(await bounded(clock, Promise.resolve(options.authorize(context))))
    )
      throw new Problem('exec_denied')
    clock.throwIfAborted()
  }
  const ownerOf = (context: CallContext) => hash({ principal: context.principalRef, scope: context.scope })
  function track<T>(task: Promise<T>) {
    work.push(task)
    void task.finally(() => {
      const position = work.indexOf(task)
      if (position >= 0) work.splice(position, 1)
    })
    return task
  }
  async function run(input: unknown, context: CallContext): Promise<Outcome<R.ExecResult>> {
    try {
      await authorize(context)
      const parsed = validateRuntime('ExecRequest', input)
      if (!parsed.ok) throw new Problem('exec_schema', 'invalid_input')
      const request = parsed.value
      if (request.env.find((item) => item.value.kind === 'secret'))
        throw new Problem('exec_secret_env_unsupported', 'incompatible')
      if (request.argv.length === 0 || request.argv.find((item) => item.includes('\0')))
        throw new Problem('exec_argv', 'invalid_input')
      for (const field of Object.keys(request.limits) as (keyof R.ResourceLimits)[])
        if (request.limits[field] === 0) throw new Problem(`exec_zero_${field}`, 'quota')
      if (!supported)
        // guards-allow-platform: mandatory Windows File ceilings cannot be sampled.
        throw new Problem(
          process.platform === 'win32' ? 'exec_limit_openFiles_unsupported' : 'exec_platform_unsupported',
          'incompatible',
        )
      throw new Problem('exec_limit_memoryBytes_unsupported', 'incompatible')
    } catch (problem) {
      return problem instanceof Problem
        ? reject(problem.detail, problem.category)
        : reject(shutdown.signal.aborted ? 'exec_closed' : 'exec_unavailable')
    }
  }
  async function reconcile(input: unknown, context: CallContext): Promise<Outcome<R.ReconcileResult>> {
    try {
      await authorize(context)
      const parsed = validateRuntime('ExecReconcileRequest', input)
      if (!parsed.ok) throw new Problem('exec_schema', 'invalid_input')
      const entry = entries.find((row) => row.id === parsed.value.executionRef.executionId)
      if (!entry || entry.owner !== ownerOf(context) || !equal(entry.ref, parsed.value.executionRef))
        throw new Problem('exec_owner')
      if (!entry.value || entry.value.effectStatus === 'unknown' || !entry.pins)
        return {
          ok: true,
          value: {
            kind: 'unknown',
            evidence: data({ executionRef: entry.ref }),
            reason: 'External effect cannot be verified; no replay is permitted',
          },
        }
      return {
        ok: true,
        value: {
          kind: 'resolved',
          evidence: data({ executionRef: entry.ref }),
          result: {
            outcome: entry.value.exitCode === 0 ? 'succeeded' : 'failed',
            result: {
              ...data(entry.value as R.JsonValue),
              schema: RuntimeMethodSchemaRefs['agh.exec'].run.output,
            },
            ...(entry.value.exitCode === 0
              ? {}
              : {
                  error: {
                    code: 'internal' as const,
                    detailCode: 'exec_exit',
                    message: 'Command exited unsuccessfully',
                    diagnosticId: 'reference-exec',
                    retryAdvice: { kind: 'never' as const },
                  },
                }),
            usage: [],
            references: entry.pins,
            externalRequests: [],
          },
        },
      }
    } catch (problem) {
      return problem instanceof Problem ? reject(problem.detail, problem.category) : reject('exec_denied')
    }
  }
  return {
    binding,
    providerDigest,
    features: [],
    run(input: unknown, context: CallContext) {
      return track(run(input, context))
    },
    reconcile(input: unknown, context: CallContext) {
      return track(reconcile(input, context))
    },
    close() {
      closing ??= (async () => {
        shutdown.abort()
        await Promise.allSettled([...work])
      })()
      return closing
    },
  }
}

// Raw qualification entry, deliberately disconnected from advertised Exec services.
// Job membership cannot replace filesystem/network sandbox admission.
export function referenceWindowsOwnerPath() {
  return fileURLToPath(new URL('../../dist/native/execution-owner.exe', import.meta.url))
}
export async function runReferenceWindowsExecution(request: {
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  stdin: Uint8Array
  limits: R.ResourceLimits | Omit<R.ResourceLimits, 'openFiles'>
  signal: AbortSignal
  governor?: string
  fileMode?: 'files' | 'five-limits'
}): Promise<{ stdout: Uint8Array; stderr: Uint8Array; metrics: Measurements }> {
  if (request.signal.aborted) throw new Error('exec_cancelled')
  const numbers = ['cpuMs', 'wallMs', 'memoryBytes', 'outputBytes', 'processes'] as const
  const budget = request.limits
  if ('openFiles' in budget || request.fileMode !== 'five-limits')
    throw new Error('exec_limit_openFiles_unsupported')
  if (
    numbers.some((name) => !Number.isSafeInteger(budget[name]) || budget[name] < 1) ||
    budget.cpuMs > 922337203685477 ||
    budget.wallMs >= 4294967295 ||
    budget.outputBytes > 67108864 ||
    budget.processes > 65535 ||
    request.stdin.byteLength > 1048576 ||
    request.argv.length === 0 ||
    request.argv.some((argument) => argument.indexOf('\0') !== -1)
  )
    throw new Error('exec_resource_bounds')
  const supervisor = spawn(
    request.governor ?? referenceWindowsOwnerPath(),
    [...numbers.map((name) => String(budget[name])), request.fileMode, ...request.argv],
    { cwd: request.cwd, env: Object.assign({}, request.env), windowsHide: true, stdio: 'pipe' },
  )
  const cancel = () => {
    supervisor.stdin.end('cancel')
  }
  supervisor.stdin.on('error', () => {})
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32LE(request.stdin.byteLength)
  supervisor.stdin.write(size)
  supervisor.stdin.write(request.stdin)
  request.signal.addEventListener('abort', cancel, { once: true })
  if (request.signal.aborted) cancel()
  let text = '',
    corrupt = false,
    retained = 0
  let last: Measurements | null = null,
    denied: string | null = null
  const chunks: [Buffer[], Buffer[]] = [[], []]
  supervisor.stderr.resume()
  supervisor.stdout.on('data', (bytes: Buffer) => {
    text += bytes.toString('utf8')
    const records = text.split('\n')
    text = records.pop() ?? ''
    for (const record of records) {
      try {
        if (record.length > 4096) throw new Error()
        const value = JSON.parse(record) as Record<string, unknown>
        if (last !== null || denied !== null) throw new Error()
        switch (value.kind) {
          case 'refusal':
            if (
              retained !== 0 ||
              ![
                'exec_resource_bounds',
                'exec_limit_openFiles_unsupported',
                'exec_runner_unavailable',
                'exec_cleanup_unknown',
              ].includes(String(value.detailCode))
            )
              throw new Error()
            denied = String(value.detailCode)
            break
          case 'output': {
            if (value.stream !== 0 && value.stream !== 1) throw new Error()
            if (
              typeof value.hex !== 'string' ||
              value.hex.length > 2048 ||
              value.hex.length % 2 !== 0 ||
              /[^a-f0-9]/u.test(value.hex)
            )
              throw new Error()
            const decoded = Buffer.from(value.hex, 'hex')
            retained += decoded.length
            if (retained > budget.outputBytes) throw new Error()
            chunks[value.stream].push(decoded)
            break
          }
          case 'metrics': {
            const counter = value as unknown as Measurements
            const quantities = [
              'pid',
              'cpuMs',
              'rss',
              'committedBytes',
              'processes',
              'files',
              'outputBytes',
              'intervalMs',
              'maxGapMs',
              'residualObserved',
            ]
            if (
              quantities.some(
                (key) =>
                  typeof value[key] !== 'number' ||
                  !Number.isSafeInteger(value[key]) ||
                  Number(value[key]) < 0,
              )
            )
              throw new Error()
            if (
              counter.pid === 0 ||
              counter.final !== true ||
              counter.remaining !== 0 ||
              counter.ownership !== 'strong' ||
              counter.ownershipVerified !== true ||
              counter.intervalMs !== 10 ||
              counter.residualObserved !== 0 ||
              counter.filesEnforced !== false ||
              !Number.isSafeInteger(counter.code) ||
              counter.signal !== 0 ||
              counter.outputBytes < retained ||
              ![
                'completed',
                'cpuMs',
                'wallMs',
                'memoryBytes',
                'outputBytes',
                'processes',
                'cancel',
                'owner',
                'residual',
                'unavailable',
              ].includes(counter.reason) ||
              (counter.reason === 'completed' && counter.outputBytes > budget.outputBytes)
            )
              throw new Error()
            last = counter
            break
          }
          default:
            throw new Error()
        }
      } catch {
        corrupt = true
        cancel()
      }
    }
    if (text.length > 4096) {
      corrupt = true
      cancel()
      text = ''
    }
  })
  return await new Promise((accept, reject) => {
    supervisor.once('error', () => {
      request.signal.removeEventListener('abort', cancel)
      reject(new Error('exec_runner_unavailable'))
    })
    supervisor.once('close', (exit) => {
      request.signal.removeEventListener('abort', cancel)
      if (corrupt || text !== '' || (exit !== 0 && exit !== 125)) reject(new Error('exec_cleanup_unknown'))
      else if (exit === 125 && denied !== null) reject(new Error(denied))
      else if (exit !== 0 || last === null) reject(new Error('exec_cleanup_unknown'))
      else accept({ stdout: Buffer.concat(chunks[0]), stderr: Buffer.concat(chunks[1]), metrics: last })
    })
  })
}
