import type {
  CallContext,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { referenceAdmit, referenceCancel } from './supervisor-admission.js'
import type { RefPorts } from './supervisor-ports.js'
import { refuse, same, sessionOf, until } from './supervisor-wire.js'

export type ReferenceSupervisorDeployment = RefPorts

const methods = RuntimeServiceCatalog['agh.supervisor'].methods
const refs = RuntimeMethodSchemaRefs['agh.supervisor']
type Name = keyof typeof methods
const NAMES = Object.keys(methods) as Name[]

type Route = Readonly<{
  needs: readonly (keyof RefPorts)[]
  run(ports: RefPorts, value: unknown, context: CallContext): Promise<Outcome<unknown>>
}>

async function forward(
  ports: RefPorts,
  name: Name,
  value: unknown,
  context: CallContext,
): Promise<Outcome<unknown>> {
  const port = ports.sessionControl
  if (!port) return refuse('incompatible', 'supervisor_port_unavailable')
  const bound = (sessionId: string) => [null, sessionId].includes(sessionOf(context.scope))
  if (name === 'readSessionControl') {
    const sessionId = value as string
    if (!bound(sessionId)) return refuse('denied', 'supervisor_scope_session')
    const got = await until(port.readSessionControl({ sessionId }, context), context, ports.clock)
    return !got.ok
      ? got
      : got.value.sessionId === sessionId
        ? got
        : refuse('internal', 'supervisor_peer_mismatch')
  }
  const request = value as { sessionId: string; requestId: string }
  if (!bound(request.sessionId)) return refuse('denied', 'supervisor_scope_session')
  if (name === 'submitSessionControl') {
    const got = await until(
      port.submitSessionControl(request as W.SessionControlRequest, context),
      context,
      ports.clock,
    )
    return !got.ok
      ? got
      : got.value.sessionId === request.sessionId && got.value.requestId === request.requestId
        ? got
        : refuse('internal', 'supervisor_peer_mismatch')
  }
  const got = await until(port.sessionControlStatus(request, context), context, ports.clock)
  if (!got.ok) return got
  if (got.value === null) return refuse('invalid_input', 'not_found')
  return got.value.sessionId === request.sessionId && got.value.requestId === request.requestId
    ? got
    : refuse('internal', 'supervisor_peer_mismatch')
}

/** One `case` group per slice: session control first, then admission, then reads. */
function route(name: Name): Route | null {
  switch (name) {
    case 'readSessionControl':
    case 'submitSessionControl':
    case 'sessionControlStatus':
      return {
        needs: ['sessionControl'],
        run: (ports, value, context) => forward(ports, name, value, context),
      }
    case 'admit':
      return { needs: ['admission', 'releases', 'identity', 'limits'], run: referenceAdmit }
    case 'cancel':
      return { needs: ['admission', 'identity'], run: referenceCancel }
    default:
      return null
  }
}

export function createReferenceSupervisorFactory(
  descriptor: W.ProviderDescriptor,
  deployment: ReferenceSupervisorDeployment,
): ProviderFactory<ServiceProvider> {
  const valid =
    descriptor.contract === 'agh.supervisor' &&
    descriptor.major === 1 &&
    descriptor.scope === 'runtime' &&
    descriptor.recovery === 'R1' &&
    descriptor.operations.length === NAMES.length &&
    NAMES.every((name) => {
      const found = descriptor.operations.find((entry) => entry.method === name)
      return (
        found?.kind === methods[name].kind &&
        same(found.inputSchema, refs[name].input) &&
        same(found.outputSchema, refs[name].output)
      )
    })
  if (!valid) throw new TypeError('Invalid official Supervisor descriptor')
  const fixed = structuredClone(descriptor)
  return {
    descriptor: fixed,
    async create(config: W.DataRef, _deps: ScopedDependencies, factory: FactoryContext) {
      const body =
        config.kind === 'inline'
          ? boundedCanonicalJson(config.value, { maxBytes: 1024, maxDepth: 4, maxMembers: 4 })
          : null
      if (
        factory.scope.kind !== 'runtime' ||
        config.kind !== 'inline' ||
        !body?.ok ||
        !same(config.schema, fixed.configSchema) ||
        !same(body.value.json, {}) ||
        body.value.bytes !== config.bytes ||
        canonicalJsonDigest(body.value.json) !== config.digest
      )
        throw new TypeError('Invalid Supervisor factory input')
      const self: W.BindingRef = {
        contract: 'agh.supervisor',
        logicalName: fixed.logicalName,
        providerId: fixed.providerId,
        bindingId: factory.bindingId,
      }
      let phase: 'new' | 'ready' | 'draining' | 'closed' = 'new'
      let active = 0
      const idle: (() => void)[] = []
      const finish = () => {
        active -= 1
        if (active === 0) for (const wake of idle.splice(0)) wake()
      }
      const served = (name: Name) => {
        const found = route(name)
        return found?.needs.every((port) => deployment[port] !== undefined) === true
      }

      async function handle(
        kind: 'control' | 'query',
        request: W.ServiceOperation,
        context: CallContext,
      ): Promise<Outcome<W.DataRef>> {
        if (phase === 'closed') return refuse('cancelled', 'supervisor_disposed')
        if (phase === 'new') return refuse('incompatible', 'supervisor_not_ready')
        if (phase === 'draining' && kind === 'control') return refuse('cancelled', 'supervisor_draining')
        if (context.signal.aborted) return refuse('cancelled', 'cancelled')
        if (!same(request.target, self)) return refuse('denied', 'supervisor_binding_mismatch')
        const name = request.method as Name
        if (!NAMES.includes(name) || methods[name].kind !== kind)
          return refuse('incompatible', 'supervisor_method_unsupported')
        const found = route(name)
        if (!found) return refuse('incompatible', 'supervisor_method_unsupported')
        if (!found.needs.every((port) => deployment[port] !== undefined))
          return refuse('incompatible', 'supervisor_port_unavailable')
        const data = request.input
        const text =
          data.kind === 'inline'
            ? boundedCanonicalJson(data.value, { maxBytes: 65_536, maxDepth: 64, maxMembers: 10_000 })
            : null
        if (
          data.kind !== 'inline' ||
          !same(data.schema, refs[name].input) ||
          !text?.ok ||
          text.value.bytes !== data.bytes ||
          canonicalJsonDigest(text.value.json) !== data.digest ||
          !validateRuntime(methods[name].input as never, text.value.json).ok
        )
          return refuse('invalid_input', 'supervisor_input_invalid')
        active += 1
        try {
          const done = await found
            .run(deployment, structuredClone(text.value.json), context)
            .catch(() => refuse('internal', 'supervisor_provider_exception'))
          if (!done.ok) return done
          const out = boundedCanonicalJson(done.value, { maxBytes: 65_536, maxDepth: 64, maxMembers: 10_000 })
          if (!out.ok) return refuse('quota', 'inline_data_bytes')
          return {
            ok: true,
            value: {
              kind: 'inline',
              schema: refs[name].output,
              value: out.value.json,
              digest: canonicalJsonDigest(out.value.json),
              bytes: out.value.bytes,
            },
          }
        } finally {
          finish()
        }
      }

      const provider: ServiceProvider = {
        async ready() {
          if (phase === 'closed') return refuse('cancelled', 'supervisor_disposed')
          phase = phase === 'new' ? 'ready' : phase
          return { ok: true, value: undefined }
        },
        async health() {
          const missing = NAMES.filter((name) => !served(name))
          return {
            ok: true,
            value: {
              status:
                phase === 'ready' || phase === 'draining'
                  ? missing.length
                    ? 'degraded'
                    : 'ready'
                  : 'failed',
              diagnosticIds: missing.map((name) => `supervisor-unavailable:${name}`),
            },
          }
        },
        async drain(deadline) {
          if (phase !== 'closed') phase = 'draining'
          if (active > 0)
            await new Promise<void>((resolve) => {
              idle.push(resolve)
              setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()))
            })
          return {
            ok: true,
            value: {
              state: active === 0 ? 'drained' : 'blocked',
              activeInvocationIds: [],
              durableOwnerRefs: [],
              diagnosticIds: active === 0 ? [] : ['supervisor_inflight'],
            },
          }
        },
        async close() {
          phase = 'closed'
        },
        async query(request, context) {
          if (request.page !== undefined) return refuse('invalid_input', 'supervisor_input_invalid')
          const got = await handle('query', request, context)
          if (!got.ok) return got
          return {
            ok: true,
            value: {
              kind: 'value',
              output: got.value,
              snapshot:
                request.snapshot ??
                `rs-${got.value.kind === 'inline' ? got.value.digest.slice(0, 40) : 'blob'}`,
            },
          }
        },
        control: (request, context) => handle('control', request, context),
      }
      return provider
    },
  }
}
