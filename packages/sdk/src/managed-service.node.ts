import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, lstatSync, openSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import { createPrivateFileSync, hasPrivateDaclSync } from '@agnes/system-node'
import { createOwnedStore } from './owned-store.node.js'

export type ManagedServiceInitialization = {
  instanceId: string
  incarnation: string
  scopeId: string
  apiVersion: string
  listeners: Record<string, { host: '127.0.0.1'; port: number }>
  storePath: string
  namespace: string
}
export function readManagedServiceInitialization(
  value = process.env.AGNES_MANAGED_INIT,
): ManagedServiceInitialization {
  try {
    if (!value || value.length > 65536) throw new Error()
    const init: unknown = JSON.parse(value)
    if (!init || typeof init !== 'object' || Array.isArray(init)) throw new Error()
    const d = init as Record<string, unknown>
    for (const key of ['instanceId', 'incarnation', 'scopeId', 'apiVersion', 'storePath', 'namespace'])
      if (typeof d[key] !== 'string' || !d[key] || String(d[key]).length > 4096) throw new Error()
    if (
      !isAbsolute(String(d.storePath)) ||
      !d.listeners ||
      typeof d.listeners !== 'object' ||
      Array.isArray(d.listeners)
    )
      throw new Error()
    const listeners: Record<string, { host: '127.0.0.1'; port: number }> = {}
    for (const [name, endpoint] of Object.entries(d.listeners)) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
        !endpoint ||
        typeof endpoint !== 'object' ||
        endpoint.host !== '127.0.0.1' ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535
      )
        throw new Error()
      listeners[name] = { host: '127.0.0.1', port: endpoint.port }
    }
    return {
      instanceId: String(d.instanceId),
      incarnation: String(d.incarnation),
      scopeId: String(d.scopeId),
      apiVersion: String(d.apiVersion),
      storePath: String(d.storePath),
      namespace: String(d.namespace),
      listeners,
    }
  } catch {
    throw new Error('invalid managed service initialization')
  }
}
export type ManagedShutdown = (
  reason: 'disable' | 'upgrade' | 'exit',
  signal: AbortSignal,
) => Promise<{ state: 'settled' | 'unknown'; detail?: JsonValue }>
/** Start the private management endpoint; application listeners and storage validation precede ready(). */
export async function createManagedServiceRuntime(options: {
  initialization?: ManagedServiceInitialization
  port?: number
  healthPath?: string
}) {
  const init = readManagedServiceInitialization(
    JSON.stringify(options.initialization ?? readManagedServiceInitialization()),
  )
  const windows = process.platform === 'win32' // guards-allow-platform: protect the managed SDK's own private store file.
  try {
    closeSync(windows ? createPrivateFileSync(init.storePath) : openSync(init.storePath, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = lstatSync(init.storePath)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (windows
      ? !hasPrivateDaclSync(init.storePath)
      : (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new Error('unsafe managed store')
  const database = new DatabaseSync(init.storePath)
  const store = createOwnedStore(database, init.namespace)
  const lifetime = new AbortController()
  let handler: ManagedShutdown | undefined
  let ready = false
  let stopped = false
  let shutdown: Promise<{ incarnation: string; state: 'settled' | 'unknown' }> | undefined
  const proof = createHash('sha256').update(init.incarnation).digest()
  const permitted = (req: IncomingMessage) =>
    typeof req.headers['x-agnes-incarnation'] === 'string' &&
    timingSafeEqual(createHash('sha256').update(req.headers['x-agnes-incarnation']).digest(), proof)
  const server = createServer((req, res) => {
    void route(req, res).catch(() => reply(res, 503, { error: 'unavailable' }))
  })
  const port = options.port ?? Number(process.env.PORT)
  const healthPath = options.healthPath ?? process.env.AGNES_MANAGED_HEALTH_PATH ?? '/health'
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/[A-Za-z0-9/_-]*$/.test(healthPath)) {
    database.close()
    throw new Error('invalid managed endpoint')
  }
  function reply(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return
    res
      .writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' })
      .end(JSON.stringify(body))
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!permitted(req)) {
      req.resume()
      reply(res, 403, { error: 'refused' })
      return
    }
    if (req.method === 'GET' && req.url === healthPath) {
      reply(res, ready && !stopped ? 200 : 503, {
        incarnation: init.incarnation,
        apiVersion: init.apiVersion,
        listeners: Object.keys(init.listeners),
        storageReady: ready,
        shutdownReady: !!handler,
      })
      return
    }
    if (req.method !== 'POST' || req.url !== '/_agnes/managed/shutdown') {
      req.resume()
      reply(res, 404, {})
      return
    }
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.length
      if (bytes > 4096) {
        req.resume()
        reply(res, 413, {})
        return
      }
      chunks.push(data)
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (
      !input ||
      typeof input !== 'object' ||
      !('reason' in input) ||
      !['disable', 'upgrade', 'exit'].includes(String(input.reason))
    ) {
      reply(res, 400, {})
      return
    }
    ready = false
    shutdown ??= (async () => {
      const timeout = AbortSignal.timeout(5000)
      lifetime.abort(input.reason)
      let state: 'settled' | 'unknown' = 'unknown'
      try {
        const result = await Promise.race([
          handler?.(input.reason as 'disable' | 'upgrade' | 'exit', timeout),
          new Promise<undefined>((resolve) =>
            timeout.addEventListener('abort', () => resolve(undefined), { once: true }),
          ),
        ])
        if (
          result?.state === 'settled' &&
          (result.detail === undefined || inspectJsonData(result.detail, 4096).ok)
        )
          state = 'settled'
      } catch {
        /* Preserve unknown; killing the process is not an external settlement receipt. */
      }
      return { incarnation: init.incarnation, state }
    })()
    reply(res, 200, await shutdown)
  }
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  }).catch((error: unknown) => {
    database.close()
    throw error
  })
  return {
    instanceId: init.instanceId,
    incarnation: init.incarnation,
    scopeId: init.scopeId,
    listeners: Object.freeze(init.listeners),
    store,
    signal: lifetime.signal,
    onShutdown(fn: ManagedShutdown) {
      if (handler || ready || stopped) throw new Error('managed shutdown already registered')
      handler = fn
    },
    async ready(info: { apiVersion: string; listeners: readonly string[] }) {
      if (
        stopped ||
        shutdown ||
        !handler ||
        info.apiVersion !== init.apiVersion ||
        JSON.stringify([...info.listeners].sort()) !== JSON.stringify(Object.keys(init.listeners).sort())
      )
        throw new Error('managed readiness mismatch')
      ready = true
    },
    async close() {
      if (stopped) return
      stopped = true
      ready = false
      lifetime.abort('closed')
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      database.close()
    },
  }
}
