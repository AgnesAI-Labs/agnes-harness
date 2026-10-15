import type { PluginContextFacets, ServiceContext, ServiceDef } from '@agnes/extension-api'
import { type Json, MhsError, object, prepareArguments } from '@agnes/mhs-device'
import { type AdmissionSubject, type Authority, digest, type North } from '@agnes/mhs-hub'
import { MHS_EFFECT_SERVICES, MHS_QUERY_SERVICES, mhsServices } from './services.js'

const inputSchema = {
  type: 'object',
  properties: {
    device: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object' },
    values: { type: 'object' },
    params: { type: 'object' },
    until: { type: 'object' },
    timeout: { type: 'number' },
    note: { type: 'string' },
    watch: { type: 'string' },
    operationId: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

/** Managed composition supplies current activation; the Host supplies consumed native admission. */
export function createMhsNativeProfileAdapter(assertActive: () => Promise<void>) {
  const contexts = new WeakMap<object, AdmissionSubject>()
  const authority: Authority = {
    assertActive,
    async admit(subject, raw) {
      if (!raw || typeof raw !== 'object') throw new MhsError('approval-required')
      const expected = contexts.get(raw),
        context = raw as ServiceContext
      context.signal.throwIfAborted()
      await assertActive()
      if (!expected || digest(expected) !== digest(subject)) throw new MhsError('stale-admission')
    },
  }
  const definitions = (north: North): ServiceDef[] => {
    const services = mhsServices(north, async (raw) => {
      const context = raw as ServiceContext
      const admission = context.admission
      if (!admission || context.scope?.kind !== 'profile') throw new MhsError('approval-required')
      return { operationId: admission.operationId, context }
    })
    return [
      ...MHS_QUERY_SERVICES.map(
        (method): ServiceDef => ({
          name: `mhs.${method}`,
          scope: 'profile',
          kind: 'query',
          inputSchema,
          outputSchema: {},
          timeoutMs: 30000,
          maxResultBytes: 1048576,
          handler: async (input) => ((await services.query(method, input)) ?? null) as Json,
        }),
      ),
      ...MHS_EFFECT_SERVICES.map(
        (method): ServiceDef => ({
          name: `mhs.${method}`,
          scope: 'profile',
          kind: 'effect',
          inputSchema,
          outputSchema: {},
          timeoutMs: 30000,
          maxResultBytes: 1048576,
          ...(method === 'stop' ? { priority: 'urgent' as const } : {}),
          ...(method === 'lease' ? { controlLeaseMs: 30000 } : {}),
          effectPolicy: {
            isDestructive: !['stop', 'watch', 'unwatch'].includes(method),
            isOpenWorld: true,
            replay: 'never',
            requiresApproval: ['stop', 'watch', 'unwatch'].includes(method) ? 'never' : 'always',
            approvalScopes: [],
          },
          async prepare(raw) {
            await assertActive()
            const input = object(raw),
              views = await north.hub.list()
            const view =
              typeof input.device === 'string'
                ? views.find((row) => row.id === input.device)
                : views.filter((row) => row.available).length === 1
                  ? views.find((row) => row.available)
                  : undefined
            if (['stop', 'watch', 'unwatch'].includes(method))
              return { input: raw, presentation: { action: method } }
            if (!view) throw new MhsError('device-required')
            let subjectInput: Json
            if (method === 'call') {
              const tool = view.description.tools?.find((row) => row.name === input.tool)
              if (!tool) throw new MhsError('unknown-tool')
              subjectInput = {
                tool: tool.name,
                args: prepareArguments(tool.inputSchema, input.args ?? {}, []),
                requested: object(input.args ?? {}) as Json,
              }
            } else
              subjectInput =
                method === 'lease'
                  ? { durationMs: 30000 }
                  : (object(method === 'set' ? input.values : (input.params ?? {})) as Json)
            return {
              input: { ...input, device: view.id } as Json,
              resourceRevision: view.revision,
              presentation: {
                action: method === 'lease' ? 'manual' : method,
                device: view.id,
                revision: view.revision,
                input: subjectInput,
              },
            }
          },
          async handler(input, context) {
            const admission = context.admission
            if (!admission) throw new MhsError('approval-required')
            const presentation = object(admission.prepared.presentation)
            const sensitive = !['stop', 'watch', 'unwatch'].includes(method)
            if (sensitive && !admission.approval) throw new MhsError('approval-required')
            if (sensitive)
              contexts.set(context, {
                ...presentation,
                operationId: admission.operationId,
              } as unknown as AdmissionSubject)
            try {
              return ((await services.effect(method, input, context)) ?? null) as Json
            } finally {
              contexts.delete(context)
            }
          },
        }),
      ),
    ]
  }
  return {
    authority,
    definitions,
    register(ctx: Pick<PluginContextFacets, 'services'>, north: North) {
      for (const definition of definitions(north)) ctx.services.register(definition)
    },
  }
}
