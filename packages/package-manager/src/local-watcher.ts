import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import type { LocalPluginRoots } from './local-source.js'

/** Implemented by the generation owner; watcher never mutates Host registries. */
export interface LocalPluginReload {
  reloadPlugin(id: string): Promise<void>
}
export interface LocalPluginWatcher {
  refresh(): Promise<void>
  close(): Promise<void>
}

export function watchLocalPlugins(options: {
  roots: LocalPluginRoots
  scan(): Promise<readonly string[]>
  reload?: LocalPluginReload
  onError?(id: string | undefined, error?: unknown): void
  debounceMs?: number
}): LocalPluginWatcher {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()
  let failedScans = 0
  const watchers: FSWatcher[] = []
  const later = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      refresh().catch(() => {})
    }, ms)
    timer.unref()
  }
  // The returned run rejects when its scan fails; the serialized chain itself never does.
  const refresh = () => {
    const run = pending.then(async () => {
      if (closed) return
      const changed = await options.scan()
      failedScans = 0
      for (const id of changed) {
        if (!options.reload) continue // Pending generation-owner binding; inventory says restart-required.
        try {
          await options.reload.reloadPlugin(id)
        } catch (error) {
          options.onError?.(id, error)
        }
      }
    })
    pending = run.catch((error: unknown) => {
      options.onError?.(undefined, error)
      // A failed scan (e.g. a busy profile lock) must not drop the edit that triggered it.
      // ponytail: fixed 3 retries 1s apart; a longer outage still needs the next edit or Rescan.
      if (!closed && ++failedScans <= 3) later(1_000)
    })
    return run
  }
  const schedule = (_event: string, filename: string | Buffer | null) => {
    if (
      closed ||
      filename
        ?.toString()
        .split(/[\\/]/)
        .some((part) => ['node_modules', '.git'].includes(part))
    )
      return
    later(options.debounceMs ?? 100)
  }
  try {
    for (const root of Object.values(options.roots)) {
      mkdirSync(root, { recursive: true })
      const watcher = watch(root, { recursive: true, persistent: false }, schedule)
      watcher.on('error', () => options.onError?.(undefined))
      watchers.push(watcher)
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close()
    throw error
  }
  return {
    refresh,
    async close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      await pending
    },
  }
}
