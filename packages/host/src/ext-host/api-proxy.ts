import {
  checkManifest,
  checkToolDef,
  type ExtensionAPI,
  type ExtensionContext,
  ExtensionError,
  type ExtensionManifest,
  extEventType,
  type SlotPayloadMap,
  type ToolDef,
} from '@agnes/extension-api'
import { inspectJsonData, validateAgainst, validateSlotPayload } from '@agnes/protocol'
import { ResourceEntry as ResourceSchema } from '@agnes/protocol/gen/hooks'
import { BUILTIN_HOOK_RANKS } from '../assemble/ext-rows.js'
import type { DisposerBag } from './disposers.js'
import type { Lease } from './lease.js'
import { mapResult } from './map-result.js'
import type { KernelPorts, RegMeta } from './ports.js'
import { projectionReader } from './projection-reader.js'
import { adaptProjection } from './projections.js'
import { capabilityToolContext } from './tool-context-capabilities.js'
import { invalidToolMessage } from './tool-def-message.js'

type Options = {
  manifest: ExtensionManifest
  /** Resolved package identity/version supplied by Host inventory, never by extension code. */
  packageIdentity: string
  packageVersion: string
  trust: ExtensionContext['trust']
  lease: Lease
  ports: KernelPorts
  bag: DisposerBag
  info: ExtensionContext['info']
  /** Assembly-time facts, one frozen object for every extension the host loads (spec 2026-09-15 §5.2). */
  platform: ExtensionContext['platform']
  log: ExtensionContext['log']
  signal: AbortSignal
  isRegistering(): boolean
}

/** Capability checks are synchronous; only the authorized underlying action returns a promise. */
export function buildExtensionAPI(input: Options): ExtensionAPI {
  const checked = checkManifest(input.manifest)
  if (!checked.ok || !['builtin', 'trusted'].includes(input.trust))
    throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'invalid extension configuration')
  const m = checked.value
  const caps = m.capabilities
  const { lease, ports, bag, signal, isRegistering } = input
  const meta: RegMeta = Object.freeze({
    source: m.id,
    trust: input.trust,
    // Only a registration this proxy itself has attested as builtin gets a fixed dispatch rank; a
    // plugin can never reach this field (third-party-transform-directive-hooks design §3 point 3).
    ...(input.trust === 'builtin' && BUILTIN_HOOK_RANKS.has(`ext:${m.id}`)
      ? { hookRank: BUILTIN_HOOK_RANKS.get(`ext:${m.id}`) as number }
      : {}),
  })
  const toolMeta: RegMeta = Object.freeze({
    source: m.id,
    trust: input.trust,
    packageIdentity: input.packageIdentity,
    packageVersion: input.packageVersion,
    ...(input.trust === 'builtin' && input.packageIdentity === '@agnes/base' && m.id === 'agnes/computer-use'
      ? { executionDomain: 'host-computer-use' as const }
      : {}),
  })
  const log = Object.freeze({
    debug: input.log.debug.bind(input.log),
    info: input.log.info.bind(input.log),
    warn: input.log.warn.bind(input.log),
    error: input.log.error.bind(input.log),
  })
  const refuse: (message: string) => never = (message) => {
    throw new ExtensionError('E_CAPABILITY_UNDECLARED', message, { extId: m.id })
  }
  const alive = () => {
    lease.assertAlive('execute')
    if (signal.aborted) throw new ExtensionError('E_LEASE_EXPIRED', 'extension is closed', { extId: m.id })
  }
  const registering = () => {
    alive()
    if (!isRegistering()) refuse('registration outside factory')
  }
  const projections = projectionReader(
    ports.projections,
    meta,
    lease,
    alive,
    caps.projections?.map((p) => p.name) ?? [],
  )
  const ctx: ExtensionContext = Object.freeze({
    extId: m.id,
    version: m.version,
    trust: input.trust,
    get lease() {
      return lease.view()
    },
    info: Object.freeze({ ...input.info }),
    platform: input.platform,
    log,
    signal,
  })
  return Object.freeze({
    ctx,
    registerService(def) {
      registering()
      return bag.add(ports.services.register(def, { manifest: m, lease, signal }))
    },
    registerProjection(def) {
      registering()
      const cap = caps.projections?.find((item) => item.name === def?.name)
      if (!cap || !lease.allows('projection', cap.name)) return refuse('projection not declared')
      return bag.add(ports.projections.register(adaptProjection(m.id, def, cap), { owner: m.id }))
    },
    registerTool(def: ToolDef) {
      registering()
      if (!caps.tools) refuse('tools not declared')
      try {
        def = {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          meta: structuredClone(def.meta),
          ...(def.policyVersion === undefined ? {} : { policyVersion: def.policyVersion }),
          ...(def.classify === undefined ? {} : { classify: def.classify }),
          execute: def.execute,
        }
      } catch {
        throw new ExtensionError('E_TOOLDEF_META', 'invalid tool definition', { extId: m.id })
      }
      const checked = checkToolDef(def, { prefix: caps.tools.prefix })
      if (!checked.ok)
        throw new ExtensionError('E_TOOLDEF_META', invalidToolMessage(def.name, checked.problems), {
          extId: m.id,
        })
      if (caps.tools.names && !caps.tools.names.includes(def.name)) refuse('tool name not declared')
      if (!lease.allows('toolPrefix', def.name)) refuse('tool outside lease scope')
      const name = def.name
      const execute = def.execute.bind(def)
      const wrapped: ToolDef = {
        ...def,
        execute: async (args, tctx) => {
          alive()
          if (!lease.allows('toolPrefix', name)) refuse('tool outside lease scope')
          lease.consume()
          return execute(args, capabilityToolContext(m, { ...tctx, projections }))
        },
      }
      return bag.add(ports.tools.add(wrapped, toolMeta))
    },
    registerHook(event, handler) {
      registering()
      if (!caps.hooks?.includes(event) || typeof handler !== 'function') refuse('hook not declared')
      return bag.add(
        ports.hooks.on(
          event,
          (payload, hctx) => {
            if (event !== 'shutdown') alive()
            return handler(
              payload,
              Object.freeze({
                ...hctx,
                projections,
                lease: lease.view(),
                log,
                signal: event === 'shutdown' ? hctx.signal : AbortSignal.any([hctx.signal, signal]),
              }),
            )
          },
          meta,
        ),
      )
    },
    registerSlot(slot, fill) {
      registering()
      if (!caps.slots?.includes(slot) || typeof fill !== 'function') refuse('slot not declared')
      if (!lease.allows('slot', slot)) refuse('slot outside lease scope')
      return bag.add(
        ports.slots.register(
          slot,
          (sctx) => {
            alive()
            if (!lease.allows('slot', slot)) refuse('slot outside lease scope')
            return mapResult(fill(Object.freeze({ ...sctx, projections })), (value) => {
              if (value === null) return null
              const data = inspectJsonData(value)
              if (!data.ok || !validateSlotPayload(slot, data.value).ok)
                throw new ExtensionError('E_SLOT_PAYLOAD', 'invalid slot payload', { extId: m.id })
              return data.value as SlotPayloadMap[typeof slot]
            })
          },
          meta,
        ),
      )
    },
    registerResource(entry) {
      registering()
      const data = inspectJsonData(entry, Number.MAX_SAFE_INTEGER)
      if (!data.ok || !validateAgainst(ResourceSchema, data.value).ok) refuse('invalid resource')
      const resource = data.value as typeof entry
      if (!caps.resources?.includes(resource.kind)) refuse('resource kind not declared')
      return bag.add(ports.resources.register(resource, meta))
    },
    events: Object.freeze({
      append(name, value) {
        alive()
        if (!caps.events || !lease.allows('event', name)) refuse('events not granted')
        const type = extEventType(m.id, name)
        const data = inspectJsonData(value)
        if (!data.ok)
          throw new ExtensionError('E_EVENT_NAMESPACE', 'invalid event JSON payload', { extId: m.id })
        return ports.extEvents.append(type, data.value, meta)
      },
    }),
  } satisfies ExtensionAPI)
}
