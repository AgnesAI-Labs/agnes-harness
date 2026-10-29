import { type Context, type Fiber, FiberState, symbols } from '@agnes/cordis'
import {
  checkServiceDef,
  ExtensionError,
  type PluginProjectionDef,
  type PluginProjectionsPort,
  type PluginResourcesPort,
  type PluginServicesPort,
  type PluginSlotsPort,
  type ProjectionCapability,
  type ResourceEntry,
  SLOT_NAMES,
  type SlotFill,
  type SlotName,
  type SlotPayloadMap,
} from '@agnes/extension-api'
import type { RowOrigin, RowOriginLookup } from '@agnes/plugin-runtime/host'
import {
  inspectJsonData,
  type JsonValue,
  validateAgainst,
  validateProjectionCapability,
  validateSlotPayload,
} from '@agnes/protocol'
import { ResourceEntry as ResourceSchema } from '@agnes/protocol/gen/hooks'
import { installProfileRuntime } from '../profile/row-runtime.js'
import { compileExtensionSchema } from './json-schema.js'
import { mapResult } from './map-result.js'
import type { KernelPorts } from './ports.js'
import { adaptProjection } from './projections.js'
import { pluginRowSource } from './row-extension-host.js'
import { createRowServicePublication } from './row-service-publication.js'

export type RowServiceContribution = PluginServicesPort
export type RowResourceContribution = PluginResourcesPort
export type RowSlotContribution = PluginSlotsPort
export type RowProjectionDef<S extends JsonValue = JsonValue> = PluginProjectionDef<S> & ProjectionCapability
export type RowProjectionContribution = PluginProjectionsPort

type BoundRow = Readonly<{ fiber: Fiber; origin: Readonly<RowOrigin> }>

function assertBoundRow(fiber: Fiber, origin: Readonly<RowOrigin>, origins: RowOriginLookup): void {
  if (
    origins.lookup(fiber) !== origin ||
    fiber.uid === null ||
    fiber.state === FiberState.UNLOADING ||
    fiber.state === FiberState.DISPOSED
  )
    throw new ExtensionError('E_LEASE_EXPIRED', 'row is closed')
}

function nearestRow(fiber: Fiber, origins: RowOriginLookup): BoundRow | undefined {
  for (let current = fiber; current !== current.parent.fiber; current = current.parent.fiber) {
    const origin = origins.lookup(current)
    if (origin) return { fiber: current, origin }
  }
  return undefined
}

/**
 * Host-only bridge from verified row fibers to the existing service registry. The bound origin
 * object's identity is the mount token: the verifier removes it before a retired fiber can register
 * again, including when the row never called ctx.extension().
 */
export function createRowServiceHost(
  describePackage: (
    packageId: string,
    snapshotId: string,
    exportName?: string,
  ) =>
    | Readonly<{
        version?: string
        integrity?: string
        declaredCapabilities?: import('@agnes/protocol').PluginCapabilities
      }>
    | undefined,
  profileRuntime?: Parameters<typeof installProfileRuntime>[2],
) {
  let ports: KernelPorts | undefined
  const pending = new Set<() => void>()
  const projectionNames = new WeakMap<RowOrigin, Set<string>>()
  const servicePublication = createRowServicePublication()

  return Object.freeze({
    installRoot(root: Context, origins: RowOriginLookup): void {
      const registerService = servicePublication.install(root)
      if (profileRuntime) installProfileRuntime(root, origins, profileRuntime)
      const contribution: RowServiceContribution = {
        register(this: { ctx: Context }, def) {
          const found = nearestRow(this.ctx.fiber, origins)
          if (!found) throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'service requires a verified row')
          if (!checkServiceDef(def).ok)
            throw new ExtensionError('E_SERVICE_DEF', 'invalid service definition')
          compileExtensionSchema(def.inputSchema, 'E_SERVICE_DEF')
          compileExtensionSchema(def.outputSchema, 'E_SERVICE_DEF')
          const { fiber, origin } = found
          const alive = () => {
            assertBoundRow(fiber, origin, origins)
          }
          alive()
          const owner = pluginRowSource(origin.rowId)
          const description = describePackage(origin.packageId, origin.snapshotId, origin.exportName)
          const version = description?.version ?? '0.0.0'
          return fiber.effect(() => {
            const ac = new AbortController()
            const release = registerService(`${owner}/${def.name}`, () => {
              alive()
              if (!ports) throw new Error('row services are not active')
              return ports.services.registerRow(def, {
                owner,
                ...(origin.rowRevision ? { activationRevision: origin.rowRevision } : {}),
                packageId: origin.packageId,
                integrity: description?.integrity ?? origin.snapshotId,
                ...(description?.declaredCapabilities
                  ? { declaredCapabilities: description.declaredCapabilities }
                  : {}),
                version,
                signal: ac.signal,
                assertAlive: alive,
                assertRunning: alive,
                consume() {},
              })
            })
            return () => {
              ac.abort()
              release()
            }
          }, `ctx.services.register(${def.name})`)
        },
      }
      Object.defineProperty(contribution, symbols.tracker, { value: { property: 'ctx' } })
      root.provide('services', contribution)

      const resources: RowResourceContribution = {
        register(this: { ctx: Context }, entry) {
          const found = nearestRow(this.ctx.fiber, origins)
          if (!found) throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'resource requires a verified row')
          const data = inspectJsonData(entry, Number.MAX_SAFE_INTEGER)
          if (!data.ok || !validateAgainst(ResourceSchema, data.value).ok)
            throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'invalid resource')
          const resource = data.value as ResourceEntry
          const { fiber, origin } = found
          const alive = () => {
            assertBoundRow(fiber, origin, origins)
          }
          alive()
          return fiber.effect(() => {
            let release: (() => void) | undefined
            const publish = () => {
              alive()
              if (!ports) return
              release = ports.resources.register(resource, {
                source: pluginRowSource(origin.rowId),
                trust: origin.trustTier === 'builtin' ? 'builtin' : 'trusted',
              })
            }
            if (ports) publish()
            else pending.add(publish)
            return () => {
              pending.delete(publish)
              release?.()
            }
          }, `ctx.resources.register(${resource.kind})`)
        },
      }
      Object.defineProperty(resources, symbols.tracker, { value: { property: 'ctx' } })
      root.provide('resources', resources)

      const slots: RowSlotContribution = {
        register<S extends SlotName>(this: { ctx: Context }, slot: S, fill: NoInfer<SlotFill<S>>) {
          const found = nearestRow(this.ctx.fiber, origins)
          if (!found) throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'slot requires a verified row')
          if (!SLOT_NAMES.includes(slot) || typeof fill !== 'function')
            throw new ExtensionError('E_SLOT_PAYLOAD', 'invalid slot fill')
          const { fiber, origin } = found
          const owner = pluginRowSource(origin.rowId)
          const alive = () => {
            assertBoundRow(fiber, origin, origins)
          }
          alive()
          return fiber.effect(() => {
            let release: (() => void) | undefined
            const publish = () => {
              alive()
              if (!ports) return
              release = ports.slots.register(
                slot,
                (context) => {
                  alive()
                  const projections = {
                    async readOwn<T extends JsonValue = JsonValue>(name: string) {
                      alive()
                      if (!projectionNames.get(origin)?.has(name))
                        throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'projection not owned by row')
                      try {
                        const result = await ports?.projections.read(
                          `${owner}/${name}`,
                          { source: owner, trust: origin.trustTier === 'builtin' ? 'builtin' : 'trusted' },
                          alive,
                        )
                        alive()
                        if (!result || 'error' in result.unit) throw new Error('projection unavailable')
                        const data = inspectJsonData(result.unit.view ?? result.unit.state, 262144)
                        if (!data.ok) throw new Error('projection unavailable')
                        return {
                          status: 'available' as const,
                          name,
                          asOfSeq: result.asOfSeq,
                          stateVersion: result.unit.stateVersion,
                          value: data.value as T,
                        }
                      } catch {
                        return {
                          status: 'unavailable' as const,
                          name,
                          error: {
                            code: 'E_PROJECTION_STATE' as const,
                            safeMessage: 'projection unavailable',
                          },
                        }
                      }
                    },
                  }
                  return mapResult(fill(Object.freeze({ ...context, projections })), (value) => {
                    alive()
                    if (value === null) return null
                    const data = inspectJsonData(value)
                    if (!data.ok || !validateSlotPayload(slot, data.value).ok)
                      throw new ExtensionError('E_SLOT_PAYLOAD', 'invalid slot payload')
                    return data.value as SlotPayloadMap[S]
                  })
                },
                {
                  source: owner,
                  trust: origin.trustTier === 'builtin' ? 'builtin' : 'trusted',
                },
              )
            }
            if (ports) publish()
            else pending.add(publish)
            return () => {
              pending.delete(publish)
              release?.()
            }
          }, `ctx.slots.register(${slot})`)
        },
      }
      Object.defineProperty(slots, symbols.tracker, { value: { property: 'ctx' } })
      root.provide('slots', slots)

      const projections: RowProjectionContribution = {
        register(this: { ctx: Context }, def) {
          const found = nearestRow(this.ctx.fiber, origins)
          if (!found)
            throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'projection requires a verified row')
          const capability = {
            name: def.name,
            inputEventTypes: def.inputEventTypes,
            maxStateBytes: def.maxStateBytes,
          } as ProjectionCapability
          if (!validateProjectionCapability(capability).ok)
            throw new ExtensionError('E_PROJECTION_DEF', 'invalid projection capability')
          const { fiber, origin } = found
          const alive = () => {
            assertBoundRow(fiber, origin, origins)
          }
          alive()
          const owner = pluginRowSource(origin.rowId)
          const projection = adaptProjection(owner, def, capability)
          return fiber.effect(() => {
            let release: (() => void) | undefined
            let names = projectionNames.get(origin)
            if (!names) {
              names = new Set()
              projectionNames.set(origin, names)
            }
            if (names.has(def.name))
              throw new ExtensionError('E_REGISTRY_DUPLICATE', 'projection already registered by row')
            names.add(def.name)
            const publish = () => {
              alive()
              if (!ports) return
              release = ports.projections.register(
                {
                  ...projection,
                  init: () => {
                    alive()
                    return projection.init()
                  },
                  apply(state: JsonValue, event: Parameters<typeof projection.apply>[1]) {
                    alive()
                    return projection.apply(state, event)
                  },
                  ...(projection.view
                    ? {
                        view(state: JsonValue) {
                          alive()
                          return projection.view?.(state)
                        },
                      }
                    : {}),
                },
                { owner },
              )
            }
            try {
              if (ports) publish()
              else pending.add(publish)
            } catch (error) {
              names.delete(def.name)
              throw error
            }
            return () => {
              pending.delete(publish)
              release?.()
              names.delete(def.name)
            }
          }, `ctx.projections.register(${def.name})`)
        },
      }
      Object.defineProperty(projections, symbols.tracker, { value: { property: 'ctx' } })
      root.provide('projections', projections)
    },
    activate(next: KernelPorts): void {
      if (ports) throw new Error('row services already active')
      ports = next
      servicePublication.activate()
      for (const publish of [...pending]) {
        pending.delete(publish)
        publish()
      }
    },
    publishRoot(root: Context): void {
      servicePublication.select(root)
    },
  })
}
