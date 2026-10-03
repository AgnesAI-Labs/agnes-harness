import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
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
function execute(
  argv: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  bytes: Uint8Array,
  ceiling: R.ResourceLimits,
  signal: AbortSignal,
  directory: { cwdFd: number; rootFd: number; cwdRoot: string },
) {
  const locations = [
    new URL('../../native/execution-owner', import.meta.url),
    new URL('../../dist/native/execution-owner', import.meta.url),
  ]
  const binary = fileURLToPath(
    locations.find((location) => existsSync(location)) ??
      new URL('../../dist/native/execution-owner', import.meta.url),
  )
  // The executable has a separate event-driven implementation and no Host helper import.
  const process = spawn(
    binary,
    [
      ceiling.cpuMs,
      ceiling.wallMs,
      ceiling.memoryBytes,
      ceiling.outputBytes,
      ceiling.processes,
      ceiling.openFiles,
    ]
      .map((number) => number.toString())
      .concat([directory.cwdRoot, ...argv]),
    {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'ignore', directory.cwdFd, directory.rootFd],
    },
  )
  const stdout: Buffer[] = [],
    stderr: Buffer[] = []
  let held = 0,
    tail = '',
    final: Measurements | undefined,
    invalid = false
  const cancel = () => process.stdin?.end('stop')
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  process.stdin?.on('error', () => {})
  const input = process.stdio[4]
  if (input && 'end' in input) {
    input.on('error', () => {})
    input.end(Buffer.from(bytes))
  }
  const receive = (chunks: Buffer[]) => (chunk: Buffer) => {
    const part = chunk.subarray(0, Math.max(ceiling.outputBytes - held, 0))
    chunks.push(part)
    held += part.byteLength
    if (part.length !== chunk.length) {
      invalid = true
      cancel()
    }
  }
  process.stdout?.on('data', receive(stdout))
  process.stderr?.on('data', receive(stderr))
  process.stdio[3]?.on('data', (chunk: Buffer) => {
    tail += chunk.toString()
    if (tail.length > 16384) {
      invalid = true
      cancel()
      tail = ''
      return
    }
    const rows = tail.split('\n')
    tail = rows.pop() ?? ''
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row) as Measurements
        if (!Number.isSafeInteger(parsed.pid) || parsed.pid < 1 || typeof parsed.reason !== 'string')
          throw new Error()
        const numeric = [
          parsed.cpuMs,
          parsed.rss,
          parsed.processes,
          parsed.files,
          parsed.outputBytes,
          parsed.intervalMs,
          parsed.maxGapMs,
          parsed.residualObserved,
        ]
        if (
          numeric.some((value) => !Number.isSafeInteger(value) || value < 0) ||
          !Number.isSafeInteger(parsed.remaining) ||
          parsed.remaining < -1 ||
          typeof parsed.ownershipVerified !== 'boolean' ||
          typeof parsed.final !== 'boolean' ||
          (parsed.ownership !== 'cooperative' && parsed.ownership !== 'strong') ||
          !Number.isSafeInteger(parsed.code) ||
          !Number.isSafeInteger(parsed.signal) ||
          (parsed.final && parsed.ownershipVerified && parsed.remaining !== 0)
        )
          throw new Error()
        if (parsed.final) final = parsed
      } catch {
        invalid = true
        cancel()
      }
    }
  })
  return new Promise<{ out: Buffer; err: Buffer; counters: Measurements }>((resolve, fail) => {
    process.once('error', () => fail(new Problem('exec_runner_unavailable')))
    process.once('close', (status) => {
      signal.removeEventListener('abort', cancel)
      if (
        ![0, 125].includes(status ?? -1) ||
        invalid ||
        !final ||
        (final.reason === 'completed' && (!final.ownershipVerified || final.remaining !== 0))
      )
        fail(new Problem('exec_cleanup_unknown', 'unknown_effect'))
      else resolve({ out: Buffer.concat(stdout), err: Buffer.concat(stderr), counters: final })
    })
  })
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
    implementation: 'linked-event-owner-array-cabinet',
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
    const fd = openSync(temp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, cabinet)
    const directory = openSync(options.directory, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
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
    let entry: CabinetEntry | undefined
    try {
      await authorize(context)
      const parsed = validateRuntime('ExecRequest', input)
      if (!parsed.ok) throw new Problem('exec_schema', 'invalid_input')
      const request = parsed.value
      if (request.env.find((item) => item.value.kind === 'secret'))
        throw new Problem('exec_secret_env_unsupported', 'incompatible')
      if (!supported) throw new Problem('exec_platform_unsupported', 'incompatible')
      if (request.argv.length === 0 || request.argv.find((item) => item.includes('\0')))
        throw new Problem('exec_argv', 'invalid_input')
      for (const field of Object.keys(request.limits) as (keyof R.ResourceLimits)[])
        if (request.limits[field] === 0) throw new Problem(`exec_zero_${field}`, 'quota')
      if (request.limits.openFiles < 32) throw new Problem('exec_limit_openFiles', 'quota')
      const environment = { ...options.environment },
        named: string[] = []
      for (const variable of request.env) {
        if (
          variable.value.kind !== 'literal' ||
          named.includes(variable.name) ||
          !options.literalNames.includes(variable.name) ||
          !/^[A-Z_][A-Z0-9_]*$/u.test(variable.name) ||
          /^(?:LD_|DYLD_|NODE_|PATH$|HOME$|.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL))/u.test(variable.name) ||
          variable.value.value.includes('\0')
        )
          throw new Problem('exec_environment')
        named.push(variable.name)
        environment[variable.name] = variable.value.value
      }
      const id = createHash('sha256').update(`${context.bindingId}/${context.invocationId}`).digest('hex')
      const owner = ownerOf(context),
        digest = hash({ body: request, owner })
      const existing = entries.find((row) => row.id === id)
      if (existing) {
        if (existing.owner !== owner || existing.digest !== digest)
          throw new Problem('exec_request_identity', 'conflict')
        return existing.reply ?? reject('exec_unknown', 'unknown_effect', existing)
      }
      const stdin = request.stdinRef
        ? await bounded(signal(context), options.content.read(request.stdinRef, context))
        : Buffer.alloc(0)
      if (
        stdin.length > 1048576 ||
        (request.stdinRef &&
          (request.stdinRef.digest !== sha(stdin) || request.stdinRef.bytes !== stdin.length))
      )
        throw new Problem('exec_content', 'invalid_input')
      await authorize(context)
      const admission = await options.sandbox.withExecution(request, context, async (launch) => {
        await authorize(context)
        if (launch.signal.aborted) return reject('exec_cancelled', 'cancelled')
        const prior = entries.find((row) => row.id === id)
        if (prior) {
          if (prior.owner !== owner || prior.digest !== digest)
            return reject('exec_request_identity', 'conflict')
          return prior.reply ?? reject('exec_unknown', 'unknown_effect', prior)
        }
        entry = {
          id,
          owner,
          digest,
          ref: {
            authorityId: options.authorityId,
            executionId: id,
            requestIdentity: {
              aghRequestId: id,
              system: 'agh.exec',
              requestDigest: digest,
              idempotencyKey: null,
            },
          },
          reply: null,
          value: null,
          counters: null,
          pins: null,
        }
        entries.push(entry)
        flush()
        try {
          const availableTime = Date.parse(context.deadline) - Date.now()
          if (availableTime <= 0 || launch.signal.aborted) throw new Error('exec_cancelled')
          const callEndsFirst = request.limits.wallMs > availableTime
          const observed = await execute(
            launch.argv,
            launch.cwd,
            environment,
            stdin,
            { ...request.limits, wallMs: Math.min(availableTime, request.limits.wallMs) },
            AbortSignal.any([launch.signal, signal(context)]),
            launch,
          )
          entry.counters = observed.counters
          const output = await bounded(
              AbortSignal.timeout(2000),
              options.content.retain(observed.out, context),
            ),
            error = await bounded(AbortSignal.timeout(2000), options.content.retain(observed.err, context))
          if (
            output.ref.digest !== sha(observed.out) ||
            error.ref.digest !== sha(observed.err) ||
            output.ref.bytes !== observed.out.length ||
            error.ref.bytes !== observed.err.length
          )
            throw new Problem('exec_content')
          for (const stored of [output, error]) {
            if (
              !validateRuntime('RetentionRef', stored.retention).ok ||
              stored.retention.digest !== stored.ref.digest ||
              stored.retention.resourceId !== stored.ref.blobId ||
              stored.retention.authorityId !== stored.ref.authorityId ||
              stored.retention.pinId !== stored.ref.pinId ||
              stored.retention.kind !== 'blob'
            )
              throw new Problem('exec_content')
          }
          entry.pins = [output.retention, error.retention]
          const ordinary = observed.counters.reason === 'completed'
          entry.value = {
            executionRef: entry.ref,
            state: ordinary ? 'exited' : observed.counters.ownershipVerified ? 'terminated' : 'unknown',
            exitCode: observed.counters.code < 0 ? null : observed.counters.code,
            signal: observed.counters.signal ? `SIG${observed.counters.signal}` : null,
            stdoutRef: output.ref,
            stderrRef: error.ref,
            outputTruncated: observed.counters.reason === 'outputBytes',
            effectStatus: ordinary ? 'confirmed' : 'unknown',
          }
          if (!validateRuntime('ExecResult', entry.value).ok) throw new Problem('exec_content')
          entry.reply =
            callEndsFirst && observed.counters.reason === 'wallMs'
              ? reject('exec_unknown', 'unknown_effect', entry)
              : ordinary
                ? { ok: true, value: entry.value }
                : Object.keys(request.limits).includes(observed.counters.reason)
                  ? reject(`exec_limit_${observed.counters.reason}`, 'quota', entry)
                  : reject(
                      observed.counters.reason === 'residual'
                        ? 'exec_residual'
                        : observed.counters.reason === 'cleanup' || !observed.counters.ownershipVerified
                          ? 'exec_cleanup_unknown'
                          : 'exec_unknown',
                      'unknown_effect',
                      entry,
                    )
          flush()
          return entry.reply
        } catch (failure) {
          entry.reply = reject(
            failure instanceof Problem && failure.detail === 'exec_cleanup_unknown'
              ? 'exec_cleanup_unknown'
              : 'exec_unknown',
            'unknown_effect',
            entry,
          )
          flush()
          return entry.reply
        }
      })
      return admission.ok ? admission.value : admission
    } catch (problem) {
      return entry
        ? reject('exec_unknown', 'unknown_effect', entry)
        : problem instanceof Problem
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
    features: supported
      ? [
          'run',
          'reconcile',
          'cpuMs',
          'wallMs',
          'memoryBytes',
          'outputBytes',
          'processes',
          'openFiles',
          'owner-pipe',
          'cooperative-ownership',
          'lifeline',
        ]
      : [],
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
