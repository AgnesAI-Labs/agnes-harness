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
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as R from '@agnes/protocol/runtime'
import { canonicalJsonDigest as digest, validateRuntime } from '@agnes/protocol/runtime'

interface Launch {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  cwdFd: number
  rootFd: number
  cwdRoot: string
}
export interface ReferenceSandboxOptions {
  directory: string
  authorityId: string
  tenantId: string
  policy: R.FsPolicySnapshot
  roots: Readonly<Record<'workspace' | 'home' | 'data', string>>
  readPaths: readonly string[]
  networkPolicyRef: string
  mount(ref: R.MountRef, context: CallContext): Promise<string>
  identity: {
    resolve(input: R.IdentityResolveRequest, context: CallContext): Promise<Outcome<R.AuthenticatedIdentity>>
  }
  authorize(context: CallContext): boolean | Promise<boolean>
}
interface Document {
  key: string
  owner: string
  request: string
  status: R.SandboxState
  result: R.SandboxCreateResult | null
  uncertain: boolean
}
class Rejected {
  constructor(
    readonly reason: string,
    readonly code: R.RuntimeError['code'] = 'denied',
  ) {}
}
function denied(reason: string, code: R.RuntimeError['code'] = 'denied'): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode: reason,
      message: 'Sandbox request refused',
      diagnosticId: 'reference-sandbox',
      retryAdvice: { kind: 'never' },
    },
  }
}
const equal = (left: unknown, right: unknown) => digest(left as R.JsonValue) === digest(right as R.JsonValue)
async function race<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
  let listener!: () => void
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(new Rejected('sandbox_cancelled', 'cancelled'))
    signal.addEventListener('abort', listener, { once: true })
    if (signal.aborted) listener()
  })
  try {
    return await Promise.race([task, stopped])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}
/** Independent array cabinet; mandatory hard gates are unavailable before effects. */
export function createReferenceSandbox(raw: ReferenceSandboxOptions) {
  const config = {
    ...raw,
    policy: structuredClone(raw.policy),
    roots: { ...raw.roots },
    readPaths: [...raw.readPaths],
  }
  const binding: R.BindingRef = {
    bindingId: 'agh.reference/sandbox/binding',
    providerId: 'agh.reference/sandbox',
    logicalName: 'sandbox',
    contract: 'agh.sandbox',
  }
  const providerDigest = digest({
    implementation: 'array-cabinet-hard-gate-admission',
    contract: binding.contract,
  })
  // guards-allow-platform: the reference advertises only its actually supported backend.
  const capable = process.platform === 'darwin'
  if (!existsSync(config.directory)) mkdirSync(config.directory, { mode: 0o700, recursive: true })
  chmodSync(config.directory, 0o700)
  const file = join(config.directory, 'sandbox-cabinet.json')
  const documents = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Document[]) : []
  const operations = new Set<Promise<unknown>>(),
    live = new Map<string, { stop: AbortController; operations: Set<Promise<unknown>> }>()
  const ending = new AbortController()
  let close: Promise<void> | undefined
  function persist() {
    if (!capable) return
    const temporary = `${file}.${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(documents), { mode: 0o600, flag: 'wx' })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    const dir = openSync(config.directory, 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  }
  for (const document of documents)
    if (!['stopped', 'lost'].includes(document.status)) {
      document.status = 'lost'
      document.uncertain = true
    }
  persist()
  function deadline(context: CallContext) {
    const remaining = Date.parse(context.deadline) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0 || context.signal.aborted)
      throw new Rejected('sandbox_cancelled', 'cancelled')
    return AbortSignal.any([context.signal, ending.signal, AbortSignal.timeout(Math.min(remaining, 60000))])
  }
  async function authorized(context: CallContext) {
    if (ending.signal.aborted) throw new Rejected('sandbox_closed')
    const signal = deadline(context)
    const answer = await race(
      signal,
      config.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !answer.ok ||
      !validateRuntime('AuthenticatedIdentity', answer.value).ok ||
      answer.value.principalRef !== context.principalRef ||
      answer.value.tenantRef !== config.tenantId ||
      Date.parse(answer.value.expiresAt) <= Date.now() ||
      !equal(context.scope, config.policy.scope) ||
      !(await race(signal, Promise.resolve(config.authorize(context))))
    )
      throw new Rejected('sandbox_denied')
    signal.throwIfAborted()
  }
  const holder = (context: CallContext) => digest({ principal: context.principalRef, scope: context.scope })
  async function document(ref: R.SandboxRef, context: CallContext) {
    await authorized(context)
    const found = documents.find((entry) => entry.key === ref.sandboxId)
    if (!found || found.owner !== holder(context) || !found.result || !equal(found.result.sandboxRef, ref))
      throw new Rejected('sandbox_owner')
    return found
  }
  function failure(problem: unknown) {
    return problem instanceof Rejected ? denied(problem.reason, problem.code) : denied('sandbox_unavailable')
  }
  function track<T>(promise: Promise<T>) {
    operations.add(promise)
    void promise.finally(() => operations.delete(promise))
    return promise
  }
  async function create(input: unknown, context: CallContext): Promise<Outcome<R.SandboxCreateResult>> {
    try {
      await authorized(context)
      const validated = validateRuntime('SandboxCreateRequest', input)
      if (!validated.ok) throw new Rejected('sandbox_schema', 'invalid_input')
      const request = validated.value
      if (Object.values(request.resourceLimits).includes(0)) return denied('sandbox_zero_limit', 'quota')
      if (!capable || request.mode !== 'isolated-process')
        return denied('sandbox_isolation_unsupported', 'incompatible')
      return denied('sandbox_limit_memoryBytes_unsupported', 'incompatible')
    } catch (problem) {
      return failure(problem)
    }
  }
  return {
    binding,
    providerDigest,
    features: [],
    create(input: unknown, context: CallContext) {
      return track(create(input, context))
    },
    inspect(input: unknown, context: CallContext): Promise<Outcome<R.SandboxInspectResult>> {
      return track(
        (async () => {
          try {
            const parsed = validateRuntime('SandboxInspectRequest', input)
            if (!parsed.ok) throw new Rejected('sandbox_schema', 'invalid_input')
            const entry = await document(parsed.value.sandboxRef, context)
            return { ok: true as const, value: { state: entry.status, usage: [] } }
          } catch (problem) {
            return failure(problem)
          }
        })(),
      )
    },
    stop(input: unknown, context: CallContext): Promise<Outcome<R.SandboxStopResult>> {
      return track(
        (async () => {
          try {
            const parsed = validateRuntime('SandboxStopRequest', input)
            if (!parsed.ok) throw new Rejected('sandbox_schema', 'invalid_input')
            const entry = await document(parsed.value.sandboxRef, context),
              owned = live.get(entry.key)
            if (entry.status !== 'stopped') {
              entry.status = 'stopping'
              persist()
              owned?.stop.abort()
              const drained = await Promise.allSettled([...(owned?.operations ?? [])])
              entry.uncertain ||= drained.some((result) => result.status === 'rejected')
              entry.status = 'stopped'
              persist()
            }
            return {
              ok: true as const,
              value: {
                terminationReceipt: {
                  authorityId: config.authorityId,
                  receiptId: `stop:${entry.key}`,
                  digest: digest(parsed.value.sandboxRef),
                },
                effectStatus: entry.uncertain ? ('unknown' as const) : ('confirmed' as const),
              },
            }
          } catch (problem) {
            return failure(problem)
          }
        })(),
      )
    },
    withExecution<T>(
      request: R.ExecRequest,
      context: CallContext,
      _execute: (launch: Launch) => Promise<T>,
    ): Promise<Outcome<T>> {
      return track(
        (async () => {
          try {
            await authorized(context)
            if (!validateRuntime('ExecRequest', request).ok)
              throw new Rejected('sandbox_schema', 'invalid_input')
            if (Object.values(request.limits).includes(0)) return denied('sandbox_zero_limit', 'quota')
            return denied('sandbox_limit_memoryBytes_unsupported', 'incompatible')
          } catch (problem) {
            return failure(problem)
          }
        })(),
      )
    },
    close() {
      close ??= (async () => {
        ending.abort()
        for (const owner of live.values()) owner.stop.abort()
        await Promise.allSettled([...operations])
      })()
      return close
    },
  }
}
