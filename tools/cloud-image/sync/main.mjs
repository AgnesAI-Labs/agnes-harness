import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { configuration, credentials } from './config.mjs'
import { coordinator } from './coordinator.mjs'
import { createLitestream } from './litestream.mjs'
import { atomicJson, fault, privateDirectory } from './private-files.mjs'
import { harnessRuntime } from './runtime.mjs'
import { createStore } from './s3-store.mjs'
import { localState } from './state.mjs'

const config = configuration(),
  lifetime = new AbortController()
await privateDirectory(config.run)
await atomicJson(join(config.run, 'health.json'), {
  backup_status: 'starting',
  last_sync_at: null,
  last_error: null,
  observed_at: new Date().toISOString(),
})
const runtime = harnessRuntime(config)
let manager,
  server,
  closing = false
async function shutdown() {
  if (closing) return
  closing = true
  try {
    await manager?.stop()
  } finally {
    lifetime.abort()
    await manager?.close()
    await runtime.cleanup()
    server?.close()
    await rm(config.socket, { force: true })
  }
}
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0))
})
process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(130))
})
try {
  // LLMSG omits the historical read grant on renewal. Only accept that after
  // this exact local epoch has completed recovery; a fresh restore still needs it.
  let restoreCompleted = Boolean(await localState(config))
  // The store reads credentials per request; no cloud credentials enter persisted status.
  const initial = await (async () => {
    const deadline = Date.now() + 30000
    while (true) {
      try {
        return await credentials(config, Date.now(), { restoreCompleted })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (Date.now() >= deadline) throw fault('SYNC_STS_WAIT_TIMEOUT')
        lifetime.signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  })()
  const binding = JSON.stringify([initial.bucket, initial.region, initial.endpoint])
  const read = async () => {
    const next = await credentials(config, Date.now(), { restoreCompleted })
    if (JSON.stringify([next.bucket, next.region, next.endpoint]) !== binding)
      throw fault('SYNC_STS_BINDING_CHANGED')
    return next
  }
  const store = createStore(initial, read, lifetime.signal)
  manager = coordinator(config, {
    store,
    replicator: createLitestream(config),
    runtime,
    readCredentials: read,
  })
  await manager.init({ waitMs: 0, signal: lifetime.signal })
  restoreCompleted = true
  await rm(config.socket, { force: true })
  server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/stop') {
      response.writeHead(404).end()
      return
    }
    if (
      request.headers['transfer-encoding'] ||
      (request.headers['content-length'] && request.headers['content-length'] !== '0')
    ) {
      response.writeHead(400).end()
      return
    }
    const result = await manager.stop()
    response
      .writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(result))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.socket, resolve)
  })
  const { chmod } = await import('node:fs/promises')
  await chmod(config.socket, 0o600)
} catch (error) {
  if (manager) await manager.fail(error)
  else
    await atomicJson(join(config.run, 'health.json'), {
      backup_status: 'failed',
      last_sync_at: null,
      last_error: error.code?.startsWith('SYNC_') ? error.code : 'SYNC_STARTUP_FAILED',
      observed_at: new Date().toISOString(),
    })
  process.stderr.write(`${error.code?.startsWith('SYNC_') ? error.code : 'SYNC_STARTUP_FAILED'}\n`)
  await manager?.close()
  await runtime.cleanup()
  process.exitCode = 1
}
