import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { bindAssets } from './assets.mjs'
import { credentialBinding, credentials } from './config.mjs'
import { atomicJson, fault, privateDirectory, privateJson } from './private-files.mjs'
import { localFilesystem } from './runtime.mjs'
import { ownHome, restoreState, synchronize } from './state.mjs'

export function coordinator(
  config,
  { store, replicator, runtime, readCredentials = () => credentials(config), tickMs = 5000 },
) {
  const statusFile = join(config.run, 'health.json')
  let status = { backup_status: 'starting', last_sync_at: null, last_error: null },
    stopping = false,
    stopped = false
  let credential,
    binding,
    queue = Promise.resolve(),
    timer,
    tickController,
    started = false,
    bootstrapBaseline = false
  const serialize = (fn) => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
  }
  async function report(patch) {
    status = { ...status, ...patch }
    await atomicJson(statusFile, { ...status, observed_at: new Date().toISOString() })
  }
  async function refresh() {
    const value = await readCredentials()
    if (binding && binding !== credentialBinding(value)) throw fault('SYNC_STS_BINDING_CHANGED')
    credential = value
    binding = credentialBinding(value)
    return value
  }
  async function tick() {
    if (stopping || stopped) return
    tickController = new AbortController()
    try {
      const next = await refresh()
      // The restored cut was confirmed before writers booted; later ticks must
      // still report degraded if ongoing writes prevent a newer confirmed cut.
      if (bootstrapBaseline) {
        const ready = await runtime.ready()
        await report({ backup_status: ready ? 'healthy' : 'starting', last_error: null })
        if (ready) bootstrapBaseline = false
        return
      }
      const time = await synchronize(config, store, replicator, next, tickController.signal)
      const ready = await runtime.ready()
      await report({ backup_status: ready ? 'healthy' : 'starting', last_sync_at: time, last_error: null })
    } catch (error) {
      if (!stopping)
        await report({
          backup_status: 'degraded',
          last_error: error.code?.startsWith('SYNC_') ? error.code : 'SYNC_BACKUP_FAILED',
        })
    } finally {
      tickController = undefined
    }
  }
  return {
    async init({ waitMs = 30000, signal } = {}) {
      await privateDirectory(config.run)
      await privateDirectory(config.home)
      await privateDirectory(config.workspace)
      await localFilesystem(config.home)
      await report({ backup_status: 'starting' })
      const deadline = Date.now() + waitMs
      while (true) {
        signal?.throwIfAborted()
        try {
          await refresh()
          break
        } catch (error) {
          if (error.code !== 'ENOENT' || Date.now() >= deadline)
            throw fault(error.code === 'ENOENT' ? 'SYNC_STS_WAIT_TIMEOUT' : error.code)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      // A provider mount must already exist. Never create a fake empty assets mount on recovery.
      await readdir(config.assets)
      await bindAssets(config)
      const local = await restoreState(config, store, replicator, credential, signal)
      stopped = local?.stopped === true
      if (!stopped && (config.initialized || local)) {
        await privateDirectory(join(config.home, 'data', 'tables'))
        await privateDirectory(join(config.home, 'data', 'artifacts'))
        // Freeze the restored baseline before starting any writer (including the
        // durable reporting queue). Only changing cuts are retried, never storage errors.
        for (let attempt = 0; ; attempt++) {
          try {
            const time = await synchronize(config, store, replicator, credential, signal)
            await report({ last_sync_at: time })
            bootstrapBaseline = true
            break
          } catch (error) {
            if (
              attempt === 4 ||
              !['SYNC_DATABASE_SET_CHANGED', 'SYNC_DATABASE_CHANGED_DURING_SNAPSHOT'].includes(error.code)
            )
              throw error
            signal?.throwIfAborted()
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
      }
      if (!stopped) {
        started = true
        await runtime.boot(signal)
        await ownHome(config)
      }
      await privateDirectory(join(config.home, 'data', 'tables'))
      await privateDirectory(join(config.home, 'data', 'artifacts'))
      if (stopped) await report({ backup_status: 'syncing', last_error: 'SYNC_AWAITING_STOP_RETRY' })
      else await serialize(tick)
      timer = setInterval(() => {
        if (!stopping && !stopped) void serialize(tick)
      }, tickMs)
      timer.unref?.()
    },
    async stop({ timeoutMs = 28000 } = {}) {
      stopping = true
      clearInterval(timer)
      tickController?.abort()
      const controller = new AbortController(),
        deadline = Date.now() + timeoutMs
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await serialize(async () => {
          try {
            controller.signal.throwIfAborted()
            await report({ backup_status: 'syncing', last_error: null })
            if (started && !stopped) {
              await runtime.stop(controller.signal)
              stopped = true
              await ownHome(config, true)
            }
            const next = await refresh()
            const time = await synchronize(config, store, replicator, next, controller.signal, {
              final: true,
            })
            if (Date.now() >= deadline) throw fault('SYNC_STOP_TIMEOUT')
            await report({ backup_status: 'healthy', last_sync_at: time, last_error: null })
            return { ok: true }
          } catch (error) {
            await report({
              backup_status: 'failed',
              last_error: error.code?.startsWith('SYNC_') ? error.code : 'SYNC_STOP_FAILED',
            })
            return { ok: false, error: status.last_error }
          }
        })
      } finally {
        clearTimeout(timeout)
      }
    },
    async fail(error) {
      await report({
        backup_status: 'failed',
        last_error: error.code?.startsWith('SYNC_') ? error.code : 'SYNC_STARTUP_FAILED',
      })
    },
    async close() {
      clearInterval(timer)
      tickController?.abort()
      await queue
      await replicator.close()
      store.close?.()
    },
    async health() {
      return privateJson(statusFile)
    },
  }
}
