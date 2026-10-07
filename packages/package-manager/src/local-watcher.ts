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
  onError?(id: string | undefined): void
  debounceMs?: number
}): LocalPluginWatcher {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()
  const watchers: FSWatcher[] = []
  const refresh = () => {
    pending = pending.then(async () => {
      if (closed) return
      try {
        const changed = await options.scan()
        for (const id of changed) {
          if (!options.reload) continue // Pending generation-owner binding; inventory says restart-required.
          try {
            await options.reload.reloadPlugin(id)
          } catch {
            options.onError?.(id)
          }
        }
      } catch {
        options.onError?.(undefined)
      }
    })
    return pending
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
    clearTimeout(timer)
    timer = setTimeout(() => {
      void refresh()
    }, options.debounceMs ?? 100)
    timer.unref()
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
