import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { createPlatform } from '../../adapters/platform.js'
import { callSignal, during } from '../platform/call-limit.js'
import type { ExecutionMetrics } from '../platform/resource-owners.js'
import type { SandboxService } from './sandbox.js'

export const EXEC_CONTRACT = 'agh.exec'
export const DEFAULT_EXEC_PROVIDER_ID = 'agh.default/exec'
export type ExecOptions = {
  directory: string
  authorityId: string
  tenantId: string
  scope: W.ScopeRef
  sandbox: Pick<SandboxService, 'withExecution'>
  identity: {
    resolve(input: W.IdentityResolveRequest, context: CallContext): Promise<Outcome<W.AuthenticatedIdentity>>
  }
  authorize(context: CallContext): boolean | Promise<boolean>
  environment: Readonly<Record<string, string>>
  literalNames: readonly string[]
  content: {
    read(ref: W.BytesRef, context: CallContext): Promise<Uint8Array>
    retain(bytes: Uint8Array, context: CallContext): Promise<{ ref: W.BytesRef; retention: W.RetentionRef }>
  }
}
export type ExecService = {
  binding: W.BindingRef
  providerDigest: string
  features: readonly string[]
  run(input: unknown, context: CallContext): Promise<Outcome<W.ExecResult>>
  reconcile(input: unknown, context: CallContext): Promise<Outcome<W.ReconcileResult>>
  close(): Promise<void>
}
function box(value: W.JsonValue): W.DataRef {
  const digest = canonicalJsonDigest(value)
  return {
    kind: 'inline',
    value,
    digest,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    schema: RuntimeMethodSchemaRefs['agh.exec'].reconcile.input,
  }
}
function refusal(
  code: W.RuntimeError['code'],
  detailCode: string,
  ref?: W.ExecutionRef,
  metrics?: ExecutionMetrics,
): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Execution refused or interrupted',
      diagnosticId: 'exec-provider',
      retryAdvice: ref
        ? { kind: 'reconcile', ownerRef: { kind: 'reconciliation', id: ref.executionId } }
        : { kind: 'never' },
      ...(ref
        ? {
            safeDetail: {
              executionRef: ref,
              ...(metrics
                ? { metrics }
                : {
                    ownership: {
                      verified: false,
                      remaining: null,
                      reason: 'No verified terminal ownership record',
                    },
                  }),
            } as W.JsonValue,
          }
        : {}),
    },
  }
}
const equal = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as W.JsonValue) === canonicalJsonDigest(b as W.JsonValue)

/** A separate service; legacy Exec adapters and their Windows launch paths remain intact. */
export function createExecService(input: ExecOptions): ExecService {
  const options = {
    ...input,
    scope: structuredClone(input.scope),
    environment: { ...input.environment },
    literalNames: [...input.literalNames],
  }
  const binding: W.BindingRef = {
    bindingId: `${DEFAULT_EXEC_PROVIDER_ID}/binding`,
    contract: EXEC_CONTRACT,
    logicalName: 'exec',
    providerId: DEFAULT_EXEC_PROVIDER_ID,
  }
  const providerDigest = canonicalJsonDigest({
    contract: EXEC_CONTRACT,
    recipe: 'mandatory-hard-gates-before-launch-sqlite',
  })
  const supported = createPlatform().os === 'darwin'
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const file = join(options.directory, 'executions.sqlite')
  if (!existsSync(file)) closeSync(createPrivateFileSync(file))
  const db = new DatabaseSync(file)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, owner TEXT, fingerprint TEXT, ref TEXT, outcome TEXT, evidence TEXT)',
  )
  const lifetime = new AbortController(),
    active = new Map<string, Promise<Outcome<W.ExecResult>>>()
  const queries = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  async function auth(context: CallContext) {
    if (lifetime.signal.aborted) throw new Error('exec_closed')
    const deadline = Date.parse(context.deadline)
    if (context.signal.aborted || !Number.isFinite(deadline) || deadline <= Date.now())
      throw new Error('exec_cancelled')
    const signal = callSignal(context, lifetime.signal, 'exec')
    const result = await during(
      signal,
      'exec',
      options.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !result.ok ||
      !validateRuntime('AuthenticatedIdentity', result.value).ok ||
      result.value.principalRef !== context.principalRef ||
      result.value.tenantRef !== options.tenantId ||
      Date.parse(result.value.expiresAt) <= Date.now() ||
      !equal(context.scope, options.scope) ||
      !(await during(signal, 'exec', Promise.resolve(options.authorize(context))))
    )
      throw new Error('exec_denied')
    if (context.signal.aborted || lifetime.signal.aborted) throw new Error('exec_cancelled')
  }
  async function perform(raw: unknown, context: CallContext): Promise<Outcome<W.ExecResult>> {
    try {
      await auth(context)
      const parsed = validateRuntime('ExecRequest', raw)
      if (!parsed.ok) return refusal('invalid_input', 'exec_schema')
      const body = parsed.value
      if (body.env.some((item) => item.value.kind === 'secret'))
        return refusal('incompatible', 'exec_secret_env_unsupported')
      if (!body.argv.length || body.argv.some((value) => value.includes('\0')))
        return refusal('invalid_input', 'exec_argv')
      for (const [name, limit] of Object.entries(body.limits))
        if (limit === 0) return refusal('quota', `exec_zero_${name}`)
      if (!supported)
        return refusal(
          'incompatible',
          createPlatform().os === 'win32' ? 'exec_limit_openFiles_unsupported' : 'exec_platform_unsupported',
        )
      // No hard tree memory/process gate: refuse before content reads, journaling or launch.
      return refusal('incompatible', 'exec_limit_memoryBytes_unsupported')
    } catch (problem) {
      const detail =
        problem instanceof Error && problem.message.startsWith('exec_') ? problem.message : 'exec_unavailable'
      return refusal(detail === 'exec_cancelled' ? 'cancelled' : 'denied', detail)
    }
  }
  async function reconcile(raw: unknown, context: CallContext): Promise<Outcome<W.ReconcileResult>> {
    try {
      await auth(context)
      const parsed = validateRuntime('ExecReconcileRequest', raw)
      if (!parsed.ok) return refusal('invalid_input', 'exec_schema')
      const row = db.prepare('SELECT * FROM executions WHERE id=?').get(parsed.value.executionRef.executionId)
      if (
        !row ||
        row.owner !== canonicalJsonDigest({ principal: context.principalRef, scope: context.scope }) ||
        !equal(JSON.parse(String(row.ref)), parsed.value.executionRef)
      )
        return refusal('denied', 'exec_owner')
      const evidence = row.evidence
        ? (JSON.parse(String(row.evidence)) as {
            metrics: ExecutionMetrics
            value: W.ExecResult
            references?: W.RetentionRef[]
          })
        : null
      if (!evidence || evidence.value.effectStatus === 'unknown' || !evidence.references)
        return {
          ok: true,
          value: {
            kind: 'unknown',
            evidence: box({ executionRef: parsed.value.executionRef }),
            reason: 'External effects are unresolved; execution must not be replayed',
          },
        }
      return {
        ok: true,
        value: {
          kind: 'resolved',
          evidence: box({ executionRef: parsed.value.executionRef }),
          result: {
            outcome: evidence.value.exitCode === 0 ? 'succeeded' : 'failed',
            result: {
              ...box(evidence.value as W.JsonValue),
              schema: RuntimeMethodSchemaRefs['agh.exec'].run.output,
            },
            ...(evidence.value.exitCode === 0
              ? {}
              : {
                  error: {
                    code: 'internal' as const,
                    detailCode: 'exec_exit',
                    message: 'Command exited unsuccessfully',
                    diagnosticId: 'exec-provider',
                    retryAdvice: { kind: 'never' as const },
                  },
                }),
            externalRequests: [],
            usage: [],
            references: evidence.references,
          },
        },
      }
    } catch {
      return refusal('denied', lifetime.signal.aborted ? 'exec_closed' : 'exec_denied')
    }
  }
  return {
    binding,
    providerDigest,
    features: [],
    run(raw, context) {
      const key = `${context.bindingId}/${context.invocationId}`
      // Track every admission attempt so close drains current authentication work.
      const pending = perform(raw, context)
      active.set(key, pending)
      queries.add(pending)
      void pending.finally(() => {
        if (active.get(key) === pending) active.delete(key)
        queries.delete(pending)
      })
      return pending
    },
    reconcile(raw, context) {
      const pending = reconcile(raw, context)
      queries.add(pending)
      void pending.finally(() => queries.delete(pending))
      return pending
    },
    close() {
      closing ??= (async () => {
        lifetime.abort()
        await Promise.allSettled([...queries])
        db.close()
      })()
      return closing
    },
  }
}
