import { closeSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ActionContext,
  ActionProviderFactory,
  CallContext,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as R from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

export function rejection(code: R.RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Reference request refused',
      diagnosticId: 'reference-billing-trace',
      retryAdvice: { kind: 'never' },
    },
  }
}
export const serial = (schema: R.SchemaRef, data: unknown): R.DataRef => {
  const checked = boundedCanonicalJson(data, { maxDepth: 32, maxMembers: 10000, maxBytes: 65536 })
  if (!checked.ok) throw new TypeError('reference data too large')
  const value = checked.value.json
  return {
    schema,
    kind: 'inline',
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(jcs(value)),
    value,
  }
}
export function unserial<T>(
  reference: R.DataRef,
  schema: R.SchemaRef,
  type: Parameters<typeof validateRuntime>[0],
): T {
  if (
    !validateRuntime('DataRef', reference).ok ||
    reference.kind !== 'inline' ||
    reference.digest !== canonicalJsonDigest(reference.value) ||
    jcs(reference.schema) !== jcs(schema) ||
    reference.bytes !== Buffer.byteLength(jcs(reference.value)) ||
    reference.bytes > 65536
  )
    throw new TypeError('input_schema')
  const checked = validateRuntime(type, reference.value)
  if (!checked.ok) throw new TypeError('input_schema')
  return checked.value as T
}
/** Independent document authority: one atomic document, not the Host relational outboxes. */
export function cabinet<T>(file: string, initial: T) {
  if (!existsSync(dirname(file))) createPrivateDirectorySync(dirname(file))
  if (!existsSync(file)) closeSync(createPrivateFileSync(file))
  const sql = new DatabaseSync(file)
  sql.exec(
    'PRAGMA synchronous=FULL;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS cabinet(slot INTEGER PRIMARY KEY,value TEXT NOT NULL)',
  )
  sql.prepare('INSERT OR IGNORE INTO cabinet VALUES(1,?)').run(jcs(initial))
  const load = () =>
    JSON.parse(String(sql.prepare('SELECT value FROM cabinet WHERE slot=1').get()?.value)) as T
  return {
    view: load,
    change<U>(fn: (state: T) => U): U {
      sql.exec('BEGIN IMMEDIATE')
      try {
        const state = load(),
          result = fn(state)
        sql.prepare('UPDATE cabinet SET value=? WHERE slot=1').run(jcs(state))
        sql.exec('COMMIT')
        return result
      } catch (error) {
        sql.exec('ROLLBACK')
        throw error
      }
    },
    close: () => sql.close(),
  }
}
export async function until<T>(task: Promise<T>, call: CallContext): Promise<T> {
  if (call.signal.aborted) throw new Error('cancelled')
  let listener: () => void = () => {}
  const cancel = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error('cancelled'))
    call.signal.addEventListener('abort', listener, { once: true })
  })
  try {
    const value = await Promise.race([task, cancel])
    if (call.signal.aborted) throw new Error('cancelled')
    return value
  } finally {
    call.signal.removeEventListener('abort', listener)
  }
}
export type RemotePort = {
  target: R.NetworkTarget
  retain(bytes: Uint8Array, call: CallContext): Promise<R.BytesRef>
}
export async function deliver(
  remote: RemotePort,
  document: unknown,
  action: ActionContext,
): Promise<Outcome<R.NetworkRequestResult>> {
  const source = await until(remote.retain(Buffer.from(jcs(document)), action.call), action.call)
  const networkRefs = RuntimeMethodSchemaRefs['agh.network'].request
  const command: R.NetworkRequest = {
    method: 'POST',
    target: remote.target,
    bodyRef: source,
    maxBytes: 65536,
    redirect: { maxHops: 0, mode: 'deny' },
    headers: serial(RuntimeSchemaRefs.ControlledHttpHeaders, { 'content-type': 'application/json' }),
  }
  const response = await until(
    action.effects.invoke(
      { operation: 'agh.network.request', input: serial(networkRefs.input, command) },
      action.call,
    ),
    action.call,
  )
  if (!response.ok) return response
  try {
    return {
      ok: true,
      value: unserial<R.NetworkRequestResult>(response.value, networkRefs.output, 'NetworkRequestResult'),
    }
  } catch {
    return rejection('unknown_effect', 'effect_unknown')
  }
}
type Engine = {
  record?(request: R.ServiceOperation, call: CallContext): Promise<Outcome<R.DataRef>>
  act(frame: R.ActionFrame, context: ActionContext, probe: boolean): Promise<Outcome<R.DataRef>>
  owners(): string[]
  finish(): void
}
export function referenceFactory(
  contract: 'agh.trace' | 'agh.billing',
  packageDigest: string,
  schema: R.SchemaRef,
  create: () => Engine,
): ProviderFactory<ServiceProvider> {
  const api = RuntimeMethodSchemaRefs[contract]
  const operationNames = contract === 'agh.billing' ? ['post', 'refund', 'reconcile'] : ['record', 'export']
  const descriptor: R.ProviderDescriptor = {
    major: 1,
    packageVersion: '0.0.0',
    contract,
    providerId: `agh.reference/${contract.substring(4)}`,
    packageDigest,
    logicalName: 'reference',
    configSchema: schema,
    scope: contract === 'agh.trace' ? 'runtime' : 'workspace',
    features: [],
    requires: [],
    capabilities: [],
    stateCodecs: [],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    activationMode: 'eager',
    operations: operationNames.map((method) => {
      const refs = api[method as keyof typeof api]
      return {
        method,
        inputSchema: refs.input,
        outputSchema: refs.output,
        kind: method === 'record' ? 'observe' : 'action',
        retrySafety: method === 'record' ? 'idempotent' : 'reconcile-first',
        requiredCapabilities: [],
      }
    }),
  }
  return {
    descriptor,
    async create(configuration, _dependencies, identity) {
      if (
        configuration.kind !== 'inline' ||
        jcs(configuration.schema) !== jcs(schema) ||
        jcs(configuration.value) !== '{}' ||
        configuration.digest !== canonicalJsonDigest(configuration.value) ||
        configuration.bytes !== 2
      )
        throw new TypeError('invalid configuration')
      const engine = create(),
        abort = new AbortController(),
        tasks = new Set<Promise<unknown>>()
      const record = engine.record
      const invocations = new Set<string>()
      let phase: 'open' | 'drain' | 'closed' = 'open'
      const inspect = (call: CallContext): Outcome<void> => {
        if (phase !== 'open') return rejection('denied', 'blocked')
        if (identity.signal.aborted || call.signal.aborted) return rejection('cancelled', 'cancelled')
        if (
          call.bindingId !== identity.bindingId ||
          !Object.entries(identity.scope).every(
            ([key, datum]) =>
              key === 'kind' || (call.scope as unknown as Record<string, unknown>)[key] === datum,
          )
        )
          return rejection('denied', 'permission_absent')
        return Date.parse(call.deadline) > Date.now()
          ? { ok: true, value: undefined }
          : rejection('timeout', 'deadline')
      }
      async function run(call: CallContext, work: (call: CallContext) => Promise<Outcome<R.DataRef>>) {
        const check = inspect(call)
        if (!check.ok) return check
        if (invocations.has(call.invocationId)) return rejection('conflict', 'invocation_busy')
        const deadline = new AbortController(),
          timer = setTimeout(
            () => deadline.abort(),
            Math.min(2147483647, Date.parse(call.deadline) - Date.now()),
          )
        const task = work({
          ...call,
          signal: AbortSignal.any([call.signal, identity.signal, abort.signal, deadline.signal]),
        })
        tasks.add(task)
        invocations.add(call.invocationId)
        try {
          return await task
        } catch (error) {
          return rejection(
            error instanceof TypeError ? 'invalid_input' : 'internal',
            error instanceof TypeError ? 'input_schema' : 'storage_failure',
          )
        } finally {
          tasks.delete(task)
          invocations.delete(call.invocationId)
          clearTimeout(timer)
        }
      }
      const lifecycle = {
        ready: async (call: CallContext) => inspect(call),
        async health(call: CallContext): Promise<Outcome<R.Health>> {
          const check = inspect(call)
          return check.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : check
        },
        async drain(): Promise<Outcome<R.DrainResult>> {
          phase = 'drain'
          return {
            ok: true,
            value: {
              state: tasks.size || engine.owners().length ? 'blocked' : 'drained',
              activeInvocationIds: Array.from(invocations),
              durableOwnerRefs: engine.owners().map((id) => ({ id, kind: 'reconciliation' })),
              diagnosticIds: [],
            },
          }
        },
        async close() {
          if (phase === 'closed') return
          phase = 'closed'
          abort.abort()
          await Promise.allSettled([...tasks])
          engine.finish()
        },
      }
      const render = (r: Outcome<R.DataRef>): R.EffectResult =>
        r.ok
          ? { outcome: 'succeeded', result: r.value, usage: [], references: [], externalRequests: [] }
          : {
              outcome:
                r.error.code === 'unknown_effect'
                  ? 'unknown_effect'
                  : r.error.code === 'cancelled'
                    ? 'cancelled'
                    : 'failed',
              error: r.error,
              usage: [],
              references: [],
              externalRequests: [],
            }
      const actions: Record<string, ActionProviderFactory> = {}
      for (const method of operationNames.filter((n) => n !== 'record')) {
        actions[method] = {
          kind: 'leaf',
          stateCodec: null,
          recovery: 'R2',
          async create(owner) {
            let dead = false
            const halt = new AbortController(),
              active = new Map<string, Promise<unknown>>()
            const execute = async (frame: R.ActionFrame, context: ActionContext, probe: boolean) => {
              if (dead || owner.signal.aborted) return render(rejection('denied', 'blocked'))
              const { signal: _signal, ...wire } = context.call
              if (
                !validateRuntime('ActionFrame', frame).ok ||
                frame.method !== method ||
                frame.actionId !== owner.actionId ||
                frame.runId !== owner.runId ||
                frame.bindingId !== identity.bindingId ||
                owner.bindingId !== identity.bindingId ||
                frame.invocationId !== context.call.invocationId ||
                jcs(frame.context) !== jcs(wire) ||
                frame.input.kind !== 'inline' ||
                frame.input.digest !== frame.inputDigest ||
                jcs(context.call.scope) !== jcs(owner.scope)
              )
                return render(rejection('invalid_input', 'input_schema'))
              const pending = run(
                {
                  ...context.call,
                  signal: AbortSignal.any([context.call.signal, owner.signal, halt.signal]),
                },
                (call) => engine.act(frame, { ...context, call }, probe),
              )
              active.set(context.call.invocationId, pending)
              try {
                return render(await pending)
              } finally {
                active.delete(context.call.invocationId)
              }
            }
            return {
              ...lifecycle,
              ready: async (call: CallContext) =>
                dead ? rejection('denied', 'blocked') : lifecycle.ready(call),
              health: async (call: CallContext) =>
                dead ? rejection('denied', 'blocked') : lifecycle.health(call),
              async drain(): Promise<Outcome<R.DrainResult>> {
                dead = true
                return {
                  ok: true,
                  value: {
                    state: active.size === 0 ? 'drained' : 'blocked',
                    activeInvocationIds: Array.from(active.keys()),
                    durableOwnerRefs: [],
                    diagnosticIds: [],
                  },
                }
              },
              kind: 'leaf',
              effectSemantics: 'receipt-query',
              executionUnit: 'single-effect',
              close: async () => {
                dead = true
                halt.abort()
                await Promise.allSettled([...active.values()])
              },
              execute: (f, c) => execute(f, c, false),
              reconcile: async (f, _e, c) => {
                const result = await execute(f, c, true)
                if (result.outcome === 'succeeded' && result.result)
                  return { kind: 'resolved', evidence: result.result, result }
                return {
                  kind: 'unknown',
                  reason: 'Reconciliation remains unconfirmed',
                  evidence: serial(RuntimeSchemaRefs.StandardToolOutput, {
                    content: [],
                    structured: { outcome: result.outcome, detailCode: result.error?.detailCode ?? null },
                  }),
                }
              },
            }
          },
        }
      }
      return {
        ...lifecycle,
        actions,
        ...(record
          ? {
              async observe(request: R.ServiceOperation, call: CallContext) {
                if (
                  request.method !== 'record' ||
                  request.target.providerId !== descriptor.providerId ||
                  request.target.bindingId !== identity.bindingId ||
                  request.target.contract !== contract ||
                  request.target.logicalName !== descriptor.logicalName
                )
                  return rejection('denied', 'permission_absent')
                return run(call, (c) => record(request, c))
              },
            }
          : {}),
      }
    },
  }
}
