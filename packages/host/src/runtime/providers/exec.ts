import { createHash } from 'node:crypto'
import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { createPlatform } from '../../adapters/platform.js'
import { callSignal, during } from '../platform/call-limit.js'
import { type ExecutionMetrics, runOwnedExecution } from '../platform/resource-owners.js'
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
  const providerDigest = canonicalJsonDigest({ contract: EXEC_CONTRACT, recipe: 'native-pipe-owner-sqlite' })
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
    let ref: W.ExecutionRef | undefined
    try {
      await auth(context)
      const parsed = validateRuntime('ExecRequest', raw)
      if (!parsed.ok) return refusal('invalid_input', 'exec_schema')
      const body = parsed.value
      if (body.env.some((item) => item.value.kind === 'secret'))
        return refusal('incompatible', 'exec_secret_env_unsupported')
      if (!supported)
        return refusal(
          'incompatible',
          createPlatform().os === 'win32' ? 'exec_limit_openFiles_unsupported' : 'exec_platform_unsupported',
        )
      if (!body.argv.length || body.argv.some((value) => value.includes('\0')))
        return refusal('invalid_input', 'exec_argv')
      for (const [name, limit] of Object.entries(body.limits))
        if (limit === 0) return refusal('quota', `exec_zero_${name}`)
      if (body.limits.openFiles < 32) return refusal('quota', 'exec_limit_openFiles')
      const env = { ...options.environment },
        names = new Set<string>()
      for (const item of body.env) {
        if (
          item.value.kind !== 'literal' ||
          names.has(item.name) ||
          !options.literalNames.includes(item.name) ||
          !/^[A-Z_][A-Z0-9_]*$/u.test(item.name) ||
          /^(?:LD_|DYLD_|NODE_|PATH$|HOME$|.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL))/u.test(item.name) ||
          item.value.value.includes('\0')
        )
          return refusal('denied', 'exec_environment')
        names.add(item.name)
        env[item.name] = item.value.value
      }
      const owner = canonicalJsonDigest({ principal: context.principalRef, scope: context.scope })
      const fingerprint = canonicalJsonDigest({ body, owner })
      const id = createHash('sha256').update(`${context.bindingId}/${context.invocationId}`).digest('hex')
      ref = {
        authorityId: options.authorityId,
        executionId: id,
        requestIdentity: {
          system: EXEC_CONTRACT,
          aghRequestId: id,
          idempotencyKey: null,
          requestDigest: fingerprint,
        },
      }
      const prior = db.prepare('SELECT * FROM executions WHERE id=?').get(id)
      if (prior) {
        if (prior.owner !== owner || prior.fingerprint !== fingerprint)
          return refusal('conflict', 'exec_request_identity')
        return prior.outcome
          ? (JSON.parse(String(prior.outcome)) as Outcome<W.ExecResult>)
          : refusal('unknown_effect', 'exec_unknown', ref)
      }
      const stdin = body.stdinRef
        ? await during(
            callSignal(context, lifetime.signal, 'exec'),
            'exec',
            options.content.read(body.stdinRef, context),
          )
        : new Uint8Array()
      if (
        stdin.length > 1024 * 1024 ||
        (body.stdinRef &&
          (stdin.length !== body.stdinRef.bytes ||
            createHash('sha256').update(stdin).digest('hex') !== body.stdinRef.digest))
      )
        return refusal('invalid_input', 'exec_content')
      await auth(context)
      const executionRef = ref
      const launched = await options.sandbox.withExecution(body, context, async (launch) => {
        await auth(context)
        if (launch.signal.aborted) return refusal('cancelled', 'exec_cancelled')
        const concurrent = db.prepare('SELECT * FROM executions WHERE id=?').get(id)
        if (concurrent) {
          if (concurrent.owner !== owner || concurrent.fingerprint !== fingerprint)
            return refusal('conflict', 'exec_request_identity')
          return concurrent.outcome
            ? (JSON.parse(String(concurrent.outcome)) as Outcome<W.ExecResult>)
            : refusal('unknown_effect', 'exec_unknown', executionRef)
        }
        db.prepare('INSERT INTO executions VALUES(?,?,?,?,NULL,NULL)').run(
          id,
          owner,
          fingerprint,
          JSON.stringify(executionRef),
        )
        const signal = AbortSignal.any([
          launch.signal,
          lifetime.signal,
          AbortSignal.timeout(Math.max(1, Date.parse(context.deadline) - Date.now())),
        ])
        try {
          const remainingDeadline = Date.parse(context.deadline) - Date.now()
          if (remainingDeadline <= 0 || signal.aborted) throw new Error('exec_cancelled')
          const deadlineBound = remainingDeadline < body.limits.wallMs
          const result = await runOwnedExecution({
            ...launch,
            env,
            stdin,
            limits: { ...body.limits, wallMs: Math.min(body.limits.wallMs, remainingDeadline) },
            signal,
          })
          const metrics = result.metrics
          // Completion facts are kept separately from external-effect certainty.
          const normal = metrics.reason === 'completed'
          const retained = await during(
            AbortSignal.timeout(2000),
            'exec',
            Promise.all([
              options.content.retain(result.stdout, context),
              options.content.retain(result.stderr, context),
            ]),
          )
          for (const [index, bytes] of [result.stdout, result.stderr].entries()) {
            const data = retained[index]
            if (
              !data ||
              data.ref.bytes !== bytes.length ||
              data.ref.digest !== createHash('sha256').update(bytes).digest('hex')
            )
              throw new Error('exec_content')
            if (
              !validateRuntime('RetentionRef', data.retention).ok ||
              data.retention.authorityId !== data.ref.authorityId ||
              data.retention.pinId !== data.ref.pinId ||
              data.retention.kind !== 'blob' ||
              data.retention.resourceId !== data.ref.blobId ||
              data.retention.digest !== data.ref.digest
            )
              throw new Error('exec_content')
          }
          const value: W.ExecResult = {
            executionRef,
            state: normal ? 'exited' : metrics.ownershipVerified ? 'terminated' : 'unknown',
            exitCode: metrics.code < 0 ? null : metrics.code,
            signal: metrics.signal ? `SIG${metrics.signal}` : null,
            stdoutRef: retained[0]?.ref ?? null,
            stderrRef: retained[1]?.ref ?? null,
            outputTruncated: metrics.reason === 'outputBytes',
            effectStatus: normal ? 'confirmed' : 'unknown',
          }
          if (!validateRuntime('ExecResult', value).ok) throw new Error('exec_content')
          const outcome: Outcome<W.ExecResult> =
            deadlineBound && metrics.reason === 'wallMs'
              ? refusal('unknown_effect', 'exec_unknown', executionRef, metrics)
              : normal
                ? { ok: true, value }
                : ['cpuMs', 'wallMs', 'memoryBytes', 'outputBytes', 'processes', 'openFiles'].includes(
                      metrics.reason,
                    )
                  ? refusal('quota', `exec_limit_${metrics.reason}`, executionRef, metrics)
                  : refusal(
                      'unknown_effect',
                      metrics.reason === 'residual'
                        ? 'exec_residual'
                        : metrics.reason === 'cleanup' || !metrics.ownershipVerified
                          ? 'exec_cleanup_unknown'
                          : 'exec_unknown',
                      executionRef,
                      metrics,
                    )
          db.prepare('UPDATE executions SET outcome=?, evidence=? WHERE id=?').run(
            JSON.stringify(outcome),
            JSON.stringify({ metrics, value, references: retained.map((item) => item.retention) }),
            id,
          )
          return outcome
        } catch (failure) {
          const outcome = refusal(
            'unknown_effect',
            failure instanceof Error && failure.message === 'exec_cleanup_unknown'
              ? 'exec_cleanup_unknown'
              : 'exec_unknown',
            executionRef,
          )
          db.prepare('UPDATE executions SET outcome=? WHERE id=?').run(JSON.stringify(outcome), id)
          return outcome
        }
      })
      return launched.ok ? launched.value : launched
    } catch (problem) {
      if (ref && db.prepare('SELECT id FROM executions WHERE id=?').get(ref.executionId))
        return refusal('unknown_effect', 'exec_unknown', ref)
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
    run(raw, context) {
      const key = `${context.bindingId}/${context.invocationId}`
      // Journal identity decides duplicate outcomes; concurrent inputs cannot bypass it.
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
