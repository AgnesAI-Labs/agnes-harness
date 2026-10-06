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
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { admissionMethods } from '../supervisor/admission.js'
import type { MethodEntry, SupervisorDeployment } from '../supervisor/ports.js'
import { readMethods } from '../supervisor/reads.js'
import { sessionControlMethods } from '../supervisor/session-controls.js'
import { canonical, decodeInline, encodeInline, equal, fail } from '../supervisor/wire.js'

export type { SupervisorDeployment } from '../supervisor/ports.js'

const catalog = RuntimeServiceCatalog['agh.supervisor'].methods
const refs = RuntimeMethodSchemaRefs['agh.supervisor']
type MethodName = keyof typeof catalog
const NAMES = Object.keys(catalog) as readonly MethodName[]

/** One entry per implemented method. A method without an entry, or whose ports are absent, refuses by name. */
const TABLE: Readonly<Partial<Record<MethodName, MethodEntry>>> = Object.freeze({
  ...sessionControlMethods,
  ...admissionMethods,
  ...readMethods,
})

function checkedDescriptor(descriptor: W.ProviderDescriptor): W.ProviderDescriptor {
  const fixed = structuredClone(descriptor)
  const valid =
    validateRuntime('ProviderDescriptor', canonical(fixed)?.json).ok &&
    fixed.contract === 'agh.supervisor' &&
    fixed.major === 1 &&
    fixed.scope === 'runtime' &&
    fixed.recovery === 'R1' &&
    fixed.operations.length === NAMES.length &&
    NAMES.every((name) => {
      const operation = fixed.operations.find((entry) => entry.method === name)
      const schema = refs[name]
      return (
        operation !== undefined &&
        operation.kind === catalog[name].kind &&
        equal(operation.inputSchema, schema.input) &&
        equal(operation.outputSchema, schema.output)
      )
    })
  if (!valid) throw new TypeError('Invalid official Supervisor descriptor')
  return Object.freeze(fixed)
}

export function createDefaultSupervisorFactory(
  descriptor: W.ProviderDescriptor,
  deployment: SupervisorDeployment,
): ProviderFactory<ServiceProvider> {
  const fixed = checkedDescriptor(descriptor)
  return Object.freeze({
    descriptor: fixed,
    async create(config: W.DataRef, _dependencies: ScopedDependencies, factory: FactoryContext) {
      const body = config.kind === 'inline' ? canonical(config.value) : null
      if (
        factory.scope.kind !== 'runtime' ||
        factory.signal.aborted ||
        config.kind !== 'inline' ||
        !equal(config.schema, fixed.configSchema) ||
        !body ||
        body.bytes !== config.bytes ||
        canonicalJsonDigest(body.json) !== config.digest ||
        !equal(body.json, {})
      )
        throw new TypeError('Invalid Supervisor factory input')
      const binding: W.BindingRef = {
        contract: 'agh.supervisor',
        logicalName: fixed.logicalName,
        providerId: fixed.providerId,
        bindingId: factory.bindingId,
      }
      const inflight = new Set<Promise<unknown>>()
      let ready = false
      let draining = false
      let closed = false

      const served = (name: MethodName) => {
        const entry = TABLE[name]
        return entry?.needs.every((port) => deployment[port] !== undefined) === true
      }
      async function serve(
        kind: 'control' | 'query',
        request: W.ServiceOperation,
        context: CallContext,
      ): Promise<Outcome<{ output: W.DataRef; snapshot: string | null }>> {
        if (closed) return fail('cancelled', 'supervisor_disposed')
        if (!ready) return fail('incompatible', 'supervisor_not_ready')
        if (draining && kind === 'control') return fail('cancelled', 'supervisor_draining')
        if (context.signal.aborted) return fail('cancelled', 'cancelled')
        if (!equal(request.target, binding)) return fail('denied', 'supervisor_binding_mismatch')
        const name = request.method as MethodName
        if (!NAMES.includes(name) || catalog[name].kind !== kind)
          return fail('incompatible', 'supervisor_method_unsupported')
        const entry = TABLE[name]
        if (!entry) return fail('incompatible', 'supervisor_method_unsupported')
        if (!entry.needs.every((port) => deployment[port] !== undefined))
          return fail('incompatible', 'supervisor_port_unavailable')
        const input = decodeInline(request.input, refs[name].input)
        if (!input.ok) return input
        const typed = validateRuntime(catalog[name].input as never, input.value)
        if (!typed.ok) return fail('invalid_input', 'supervisor_input_invalid')
        const work = entry.run(deployment, structuredClone(input.value), context)
        inflight.add(work)
        try {
          const result = await work.catch(() => fail('internal', 'supervisor_provider_exception'))
          if (!result.ok) return result
          const output = encodeInline(refs[name].output, result.value)
          if (!output.ok) return output
          return { ok: true, value: { output: output.value, snapshot: null } }
        } finally {
          inflight.delete(work)
        }
      }
      const provider: ServiceProvider = {
        async ready(_context) {
          if (closed) return fail('cancelled', 'supervisor_disposed')
          if (typeof deployment.clock !== 'function')
            return fail('incompatible', 'supervisor_port_unavailable')
          ready = true
          return { ok: true, value: undefined }
        },
        async health(_context) {
          const missing = NAMES.filter((name) => !served(name))
          return {
            ok: true,
            value: {
              status: closed || !ready ? 'failed' : missing.length === 0 ? 'ready' : 'degraded',
              diagnosticIds: missing.map((name) => `supervisor-unavailable:${name}`),
            },
          }
        },
        async drain(deadline, _context) {
          draining = true
          const limit = Math.max(0, Date.parse(deadline) - Date.now())
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            Promise.allSettled([...inflight]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, limit)
            }),
          ])
          clearTimeout(timer)
          return {
            ok: true,
            value: {
              state: inflight.size === 0 ? 'drained' : 'blocked',
              activeInvocationIds: [],
              durableOwnerRefs: [],
              diagnosticIds: inflight.size === 0 ? [] : ['supervisor_inflight'],
            },
          }
        },
        async close(_reason) {
          closed = true
          ready = false
        },
        async query(request, context) {
          if (request.page !== undefined) return fail('invalid_input', 'supervisor_input_invalid')
          const reply = await serve('query', request, context)
          if (!reply.ok) return reply
          return {
            ok: true,
            value: {
              kind: 'value',
              output: reply.value.output,
              snapshot:
                request.snapshot ??
                `sv-${reply.value.output.kind === 'inline' ? reply.value.output.digest.slice(0, 40) : 'blob'}`,
            },
          }
        },
        async control(request, context) {
          const reply = await serve('control', request, context)
          return reply.ok ? { ok: true, value: reply.value.output } : reply
        },
      }
      return Object.freeze(provider)
    },
  })
}
