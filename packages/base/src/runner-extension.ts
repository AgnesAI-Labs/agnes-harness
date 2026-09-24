import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import type { ExtensionAPI, HookEvent, HookHandler } from '@agnes/extension-api'
import * as extensionApi from '@agnes/extension-api'
import * as protocol from '@agnes/protocol'
import * as typebox from '@sinclair/typebox'
import { createJiti } from 'jiti/static'
import { runnerLease } from './runner-context.js'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (file: string): string =>
  `sha256-${createHash('sha256').update(readFileSync(file)).digest('hex')}`
const unavailable = (): never => {
  throw new extensionApi.ExtensionError('E_CAPABILITY_UNDECLARED', 'registration unavailable in this runner')
}

/** Runs only inside the confined release process, never in Host. */
export async function loadRunnerExtension(
  data: Record<string, unknown>,
  capability: (method: string, input: unknown) => Promise<unknown>,
  withdraw: (id: string) => boolean,
): Promise<{
  handlers: Map<string, HookHandler<HookEvent>>
  registrations: Map<string, HookEvent>
  dispose: () => Promise<void>
}> {
  if (
    typeof data.entry !== 'string' ||
    typeof data.manifestFile !== 'string' ||
    typeof data.packageDirectory !== 'string' ||
    !record(data.context) ||
    !record(data.context.lease) ||
    !record(data.context.info) ||
    !record(data.context.platform)
  )
    throw new Error('invalid extension bootstrap')
  const root = realpathSync(data.packageDirectory)
  for (const path of [data.entry, data.manifestFile]) {
    const rel = relative(root, realpathSync(path))
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error('entry outside package')
  }
  if (
    digest(data.entry) !== data.entryDigest ||
    digest(data.manifestFile) !== process.env.AGNES_MANIFEST_DIGEST
  )
    throw new Error('extension bytes changed')
  const checked = extensionApi.checkManifest(JSON.parse(readFileSync(data.manifestFile, 'utf8')))
  if (
    !checked.ok ||
    checked.value.id !== data.context.extId ||
    !checked.value.runtime?.supports.includes('isolated')
  )
    throw new Error('extension manifest mismatch')
  const manifest = checked.value
  const shutdown = new AbortController()
  const handlers = new Map<string, HookHandler<HookEvent>>()
  const registrations = new Map<string, HookEvent>()
  let sequence = 0
  let registering = true
  const reject = unavailable
  const api: ExtensionAPI = Object.freeze({
    registerHook<E extends HookEvent>(event: E, handler: extensionApi.HookHandler<E>) {
      if (
        !registering ||
        !manifest.capabilities.hooks?.includes(event) ||
        typeof handler !== 'function' ||
        sequence >= 1024
      )
        throw new extensionApi.ExtensionError('E_CAPABILITY_UNDECLARED', 'invalid hook proposal')
      const id = `h-${++sequence}`
      registrations.set(id, event)
      handlers.set(id, (payload, context) => handler(payload as extensionApi.HookPayloadMap[E], context))
      let removed = false
      return () => {
        if (removed) return
        removed = true
        // Before publication remove the proposal; afterward retain old turn callbacks.
        if (registering || !withdraw(id)) {
          handlers.delete(id)
          registrations.delete(id)
        }
      }
    },
    registerTool: reject,
    registerResource: reject,
    registerSlot: reject,
    registerService: reject,
    registerProjection: reject,
    events: Object.freeze({
      append: (name: string, value: protocol.JsonValue) =>
        capability('events.append', { name, data: value }) as Promise<extensionApi.Seq>,
    }),
    ctx: Object.freeze({
      extId: manifest.id,
      version: manifest.version,
      trust: data.context.trust as 'trusted',
      lease: runnerLease(data.context.lease),
      info: Object.freeze(data.context.info) as ExtensionAPI['ctx']['info'],
      // Plain data already validated as a record above; frozen so the factory cannot write it.
      platform: Object.freeze(data.context.platform) as ExtensionAPI['ctx']['platform'],
      log: Object.freeze({ debug() {}, info() {}, warn() {}, error() {} }),
      signal: shutdown.signal,
    }),
  })
  const jiti = createJiti(`${dirname(data.entry)}/package.json`, {
    moduleCache: false,
    fsCache: false,
    tryNative: false,
    forceTranspile: true,
    interopDefault: true,
    debug: false,
    tsconfigPaths: false,
    virtualModules: {
      '@agnes/extension-api': extensionApi,
      '@agnes/protocol': protocol,
      '@sinclair/typebox': typebox,
    },
  })
  const imported: unknown = await jiti.import(data.entry)
  if (!record(imported) || typeof imported.default !== 'function')
    throw new Error('invalid extension factory')
  const returned: unknown = imported.default(api)
  const then =
    returned && (typeof returned === 'object' || typeof returned === 'function')
      ? (returned as { then?: unknown }).then
      : undefined
  const settle = (value: unknown): unknown => {
    registering = false
    return value
  }
  // Match Host's synchronous registration boundary; await alone would admit a queued microtask.
  const disposer =
    typeof then === 'function'
      ? await new Promise<unknown>((resolve, reject) =>
          Reflect.apply(then, returned, [resolve, reject]),
        ).then(settle)
      : settle(returned)
  if (disposer !== undefined && typeof disposer !== 'function') throw new Error('invalid disposer')
  return {
    handlers,
    registrations,
    dispose: async () => {
      shutdown.abort()
      if (typeof disposer === 'function') await disposer()
    },
  }
}
