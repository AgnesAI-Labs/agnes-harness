import type { Dict } from '@agnes/cosmokit'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Context } from './context.js'
import { Fiber, FiberState, resolveConfig } from './fiber.js'
import {
  abortMountingFiber,
  activateMountingFiber,
  announceMountingFiber,
  asAwaitableFiber,
  attachMountingFiber,
  type AwaitableFiber,
  commitMountingFiber,
} from './mounting.js'
import { registerPreparedRuntime, unregisterPreparedRuntime } from './prepared-state.js'
import { type Plugin, type RegistryService } from './registry.js'
import { DisposableList, symbols } from './utils.js'

export const preparedPluginBrand: unique symbol = Symbol('agnes.prepared-plugin')

export interface PreparedPluginInvocation {
  readonly [preparedPluginBrand]: true
}

interface PreparedRecord {
  readonly callback: globalThis.Function
  readonly Config?: StandardSchemaV1
  readonly inject: Readonly<Dict>
  readonly name?: string
}

interface RuntimeOwner {
  claims: number
  readonly runtime: Plugin.Runtime
}

const records = new WeakMap<PreparedPluginInvocation, PreparedRecord>()
const owners = new WeakMap<RegistryService, Map<PreparedPluginInvocation, RuntimeOwner>>()

function resolvePlugin(plugin: Plugin): globalThis.Function {
  if (typeof plugin === 'function') return plugin
  if (plugin && typeof plugin === 'object') {
    const apply = plugin.apply
    if (typeof apply === 'function') return apply
  }
  throw new Error(
    `invalid plugin, expect function or object with an "apply" method, received ${typeof plugin}`,
  )
}

function recordOf(prepared: PreparedPluginInvocation): PreparedRecord {
  const record = records.get(prepared)
  if (!record) throw new TypeError('invalid PreparedPluginInvocation')
  return record
}

function registryOf(context: Context): RegistryService {
  const registry = context.registry as RegistryService & { [symbols.original]?: RegistryService }
  return registry[symbols.original] ?? registry
}

function acquireRuntime(
  context: Context,
  prepared: PreparedPluginInvocation,
): {
  record: PreparedRecord
  runtime: Plugin.Runtime
  release(): void
} {
  const record = recordOf(prepared)
  const registry = registryOf(context)
  let map = owners.get(registry)
  if (!map) {
    map = new Map()
    owners.set(registry, map)
  }
  let owner = map.get(prepared)
  if (!owner) {
    owner = {
      claims: 0,
      runtime: {
        name: record.name,
        callback: record.callback,
        fibers: new DisposableList(),
      },
    }
    map.set(prepared, owner)
    registerPreparedRuntime(registry, owner.runtime)
  }
  owner.claims++
  let released = false
  return {
    record,
    runtime: owner.runtime,
    release() {
      if (released) return
      released = true
      owner.claims--
      if (owner.claims || owner.runtime.fibers.length) return
      if (map?.get(prepared) !== owner) return
      map.delete(prepared)
      unregisterPreparedRuntime(registry, owner.runtime)
      if (!map.size) owners.delete(registry)
    },
  }
}

function createPreparedFiber(
  context: Context,
  prepared: PreparedPluginInvocation,
  normalizedConfig: unknown,
  deferredPublication: boolean,
  beforePublish?: (fiber: Fiber) => void,
): Fiber {
  context.fiber.assertActive()
  const owner = acquireRuntime(context, prepared)
  try {
    return new Fiber(context, normalizedConfig, { ...owner.record.inject }, owner.runtime, () => [], {
      beforePublish,
      deferredPublication,
      releaseRuntime: owner.release,
    })
  } catch (error) {
    owner.release()
    throw error
  }
}

export function preparePluginInvocation(
  plugin: Plugin<unknown>,
  inject: Readonly<Record<string, unknown>>,
): PreparedPluginInvocation {
  const callback = resolvePlugin(plugin)
  let name = plugin.name
  if (name === 'apply') name = undefined
  const handle = Object.freeze({ [preparedPluginBrand]: true as const })
  records.set(handle, {
    callback,
    Config: plugin.Config,
    inject: Object.freeze({ ...inject }),
    name,
  })
  return handle
}

export function normalizePreparedConfig(prepared: PreparedPluginInvocation, rawConfig: unknown): unknown {
  const record = recordOf(prepared)
  return resolveConfig({ Config: record.Config } as Plugin.Runtime, rawConfig)
}

export function pluginPrepared(
  context: Context,
  prepared: PreparedPluginInvocation,
  normalizedConfig: unknown,
): Fiber & PromiseLike<Fiber> {
  const fiber = createPreparedFiber(context, prepared, normalizedConfig, false)
  return asAwaitableFiber(fiber)
}

export type PreparedPluginBeforePublish = (fiber: Fiber) => void

export interface PreparedPluginPublication {
  plugin(
    context: Context,
    prepared: PreparedPluginInvocation,
    normalizedConfig: unknown,
    beforePublish?: PreparedPluginBeforePublish,
  ): Fiber
  publish(): readonly AwaitableFiber[]
  rollback(): Promise<void>
}

function assertPublicationFibers(fibers: readonly Fiber[]): void {
  for (const fiber of fibers) {
    if (fiber.uid === null) throw new Error('cannot publish a disposed prepared fiber')
    const parent = fiber.parent.fiber
    if (parent.uid === null || parent.state === FiberState.UNLOADING) {
      throw new Error('cannot publish a prepared fiber with an inactive parent')
    }
  }
}

export function beginPreparedPluginPublication(): PreparedPluginPublication {
  const fibers: Fiber[] = []
  let published = false
  let closed = false
  let failedCleanup: Promise<void> | undefined
  return {
    plugin(context, prepared, normalizedConfig, beforePublish) {
      if (closed) throw new Error('prepared publication is closed')
      const fiber = createPreparedFiber(context, prepared, normalizedConfig, true, beforePublish)
      fibers.push(fiber)
      return fiber
    },
    publish() {
      if (closed) throw new Error('prepared publication is closed')
      try {
        assertPublicationFibers(fibers)
        for (const fiber of fibers) commitMountingFiber(fiber)
        const result = fibers.map(attachMountingFiber)
        for (const fiber of fibers) {
          announceMountingFiber(fiber)
          assertPublicationFibers(fibers)
        }
        assertPublicationFibers(fibers)
        for (const fiber of fibers) activateMountingFiber(fiber)
        published = true
        closed = true
        return result
      } catch (error) {
        closed = true
        failedCleanup = Promise.allSettled([...fibers].reverse().map(abortMountingFiber)).then(() => {})
        throw error
      }
    },
    async rollback() {
      if (failedCleanup) return failedCleanup
      if (closed && !published) return
      closed = true
      await Promise.allSettled([...fibers].reverse().map(abortMountingFiber))
    },
  }
}
