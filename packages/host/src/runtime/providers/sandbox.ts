import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { createPlatform } from '../../adapters/platform.js'
import { callSignal, during } from '../platform/call-limit.js'

export const SANDBOX_CONTRACT = 'agh.sandbox'
export const DEFAULT_SANDBOX_PROVIDER_ID = 'agh.default/sandbox'
type Root = 'workspace' | 'home' | 'data'
export type SandboxLaunch = {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  cwdFd: number
  rootFd: number
  cwdRoot: string
}
export type SandboxOptions = {
  directory: string
  authorityId: string
  tenantId: string
  policy: W.FsPolicySnapshot
  roots: Readonly<Record<Root, string>>
  readPaths: readonly string[]
  networkPolicyRef: string
  mount(ref: W.MountRef, context: CallContext): Promise<string>
  identity: {
    resolve(input: W.IdentityResolveRequest, context: CallContext): Promise<Outcome<W.AuthenticatedIdentity>>
  }
  authorize(context: CallContext): boolean | Promise<boolean>
}
export type SandboxService = {
  binding: W.BindingRef
  providerDigest: string
  features: readonly string[]
  create(input: unknown, context: CallContext): Promise<Outcome<W.SandboxCreateResult>>
  inspect(input: unknown, context: CallContext): Promise<Outcome<W.SandboxInspectResult>>
  stop(input: unknown, context: CallContext): Promise<Outcome<W.SandboxStopResult>>
  withExecution<T>(
    input: W.ExecRequest,
    context: CallContext,
    run: (launch: SandboxLaunch) => Promise<T>,
  ): Promise<Outcome<T>>
  close(): Promise<void>
}
export function sandboxRefusal(code: W.RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Sandbox operation refused',
      diagnosticId: 'sandbox-provider',
      retryAdvice: { kind: 'never' },
    },
  }
}
const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as W.JsonValue) === canonicalJsonDigest(b as W.JsonValue)
export function createSandboxService(input: SandboxOptions): SandboxService {
  const options: SandboxOptions = {
    ...input,
    policy: structuredClone(input.policy),
    roots: { ...input.roots },
    readPaths: [...input.readPaths],
  }
  const binding: W.BindingRef = {
    bindingId: `${DEFAULT_SANDBOX_PROVIDER_ID}/binding`,
    contract: SANDBOX_CONTRACT,
    logicalName: 'sandbox',
    providerId: DEFAULT_SANDBOX_PROVIDER_ID,
  }
  const providerDigest = canonicalJsonDigest({
    contract: SANDBOX_CONTRACT,
    recipe: 'mandatory-hard-gates-before-effects-sqlite',
  })
  const supported = createPlatform().os === 'darwin'
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const file = join(options.directory, 'sandboxes.sqlite')
  if (!existsSync(file)) closeSync(createPrivateFileSync(file))
  const db = new DatabaseSync(file)
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sandboxes(id TEXT PRIMARY KEY, owner TEXT, fingerprint TEXT, value TEXT, state TEXT, uncertain INTEGER NOT NULL DEFAULT 0); UPDATE sandboxes SET state='lost', uncertain=1 WHERE state IN ('ready','creating','stopping')",
  )
  const lifetime = new AbortController()
  const scopes = new Map<string, { abort: AbortController; work: Set<Promise<unknown>> }>()
  const creates = new Set<Promise<unknown>>()
  const operations = new Set<Promise<unknown>>()
  function track<T>(pending: Promise<T>): Promise<T> {
    operations.add(pending)
    void pending.finally(() => operations.delete(pending))
    return pending
  }
  let closing: Promise<void> | undefined
  async function auth(context: CallContext) {
    if (lifetime.signal.aborted) throw new Error('sandbox_closed')
    if (context.signal.aborted || Date.parse(context.deadline) <= Date.now())
      throw new Error('sandbox_cancelled')
    const signal = callSignal(context, lifetime.signal, 'sandbox')
    const identity = await during(
      signal,
      'sandbox',
      options.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !identity.ok ||
      !validateRuntime('AuthenticatedIdentity', identity.value).ok ||
      identity.value.principalRef !== context.principalRef ||
      identity.value.tenantRef !== options.tenantId ||
      Date.parse(identity.value.expiresAt) <= Date.now() ||
      !same(context.scope, options.policy.scope) ||
      !(await during(signal, 'sandbox', Promise.resolve(options.authorize(context))))
    )
      throw new Error('sandbox_denied')
    if (lifetime.signal.aborted || context.signal.aborted) throw new Error('sandbox_cancelled')
  }
  async function checked(ref: W.SandboxRef, context: CallContext) {
    await auth(context)
    const row = db.prepare('SELECT * FROM sandboxes WHERE id=?').get(ref.sandboxId)
    if (
      !row?.value ||
      row.owner !== canonicalJsonDigest({ principal: context.principalRef, scope: context.scope }) ||
      !same((JSON.parse(String(row.value)) as W.SandboxCreateResult).sandboxRef, ref)
    )
      throw new Error('sandbox_owner')
    return { row, value: JSON.parse(String(row.value)) as W.SandboxCreateResult }
  }
  function refused(error: unknown): Outcome<never> {
    const detail =
      error instanceof Error && error.message.startsWith('sandbox_') ? error.message : 'sandbox_unavailable'
    return sandboxRefusal(
      detail === 'sandbox_cancelled'
        ? 'cancelled'
        : detail === 'sandbox_schema' || detail === 'sandbox_path'
          ? 'invalid_input'
          : 'denied',
      detail,
    )
  }
  async function create(raw: unknown, context: CallContext): Promise<Outcome<W.SandboxCreateResult>> {
    try {
      await auth(context)
      const parsed = validateRuntime('SandboxCreateRequest', raw)
      if (!parsed.ok) throw new Error('sandbox_schema')
      const body = parsed.value
      if (Object.values(body.resourceLimits).some((limit) => limit === 0))
        return sandboxRefusal('quota', 'sandbox_zero_limit')
      if (!supported || body.mode !== 'isolated-process')
        return sandboxRefusal('incompatible', 'sandbox_isolation_unsupported')
      return sandboxRefusal('incompatible', 'sandbox_limit_memoryBytes_unsupported')
    } catch (error) {
      return refused(error)
    }
  }
  const service: SandboxService = {
    binding,
    providerDigest,
    features: [],
    create(raw, context) {
      const pending = create(raw, context)
      creates.add(pending)
      void pending.finally(() => creates.delete(pending))
      return pending
    },
    async inspect(raw, context) {
      try {
        const p = validateRuntime('SandboxInspectRequest', raw)
        if (!p.ok) throw new Error('sandbox_schema')
        const { row } = await checked(p.value.sandboxRef, context)
        return { ok: true, value: { state: String(row.state) as W.SandboxState, usage: [] } }
      } catch (error) {
        return refused(error)
      }
    },
    async stop(raw, context) {
      try {
        const p = validateRuntime('SandboxStopRequest', raw)
        if (!p.ok) throw new Error('sandbox_schema')
        await checked(p.value.sandboxRef, context)
        const owned = scopes.get(p.value.sandboxRef.sandboxId)
        db.prepare("UPDATE sandboxes SET state='stopping' WHERE id=?").run(p.value.sandboxRef.sandboxId)
        owned?.abort.abort()
        const drained = await Promise.allSettled([...(owned?.work ?? [])])
        if (drained.some((item) => item.status === 'rejected'))
          db.prepare('UPDATE sandboxes SET uncertain=1 WHERE id=?').run(p.value.sandboxRef.sandboxId)
        db.prepare("UPDATE sandboxes SET state='stopped' WHERE id=?").run(p.value.sandboxRef.sandboxId)
        return {
          ok: true,
          value: {
            terminationReceipt: {
              authorityId: options.authorityId,
              receiptId: `stop:${p.value.sandboxRef.sandboxId}`,
              digest: canonicalJsonDigest(p.value.sandboxRef),
            },
            effectStatus:
              db.prepare('SELECT uncertain FROM sandboxes WHERE id=?').get(p.value.sandboxRef.sandboxId)
                ?.uncertain === 1 || drained.some((item) => item.status === 'rejected')
                ? 'unknown'
                : 'confirmed',
          },
        }
      } catch (error) {
        return refused(error)
      }
    },
    async withExecution(body, context, _run) {
      try {
        await auth(context)
        if (!validateRuntime('ExecRequest', body).ok) throw new Error('sandbox_schema')
        if (Object.values(body.limits).includes(0)) return sandboxRefusal('quota', 'sandbox_zero_limit')
        return sandboxRefusal('incompatible', 'sandbox_limit_memoryBytes_unsupported')
      } catch (error) {
        return refused(error)
      }
    },
    close() {
      closing ??= (async () => {
        lifetime.abort()
        for (const record of scopes.values()) record.abort.abort()
        await Promise.allSettled([
          ...operations,
          ...creates,
          ...[...scopes.values()].flatMap((record) => [...record.work]),
        ])
        db.close()
      })()
      return closing
    },
  }
  return {
    ...service,
    inspect: (raw, context) => track(service.inspect(raw, context)),
    stop: (raw, context) => track(service.stop(raw, context)),
    withExecution<T>(body: W.ExecRequest, context: CallContext, run: (launch: SandboxLaunch) => Promise<T>) {
      return track(service.withExecution(body, context, run))
    },
  }
}
