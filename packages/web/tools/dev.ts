import { type FSWatcher, realpathSync, watch as watchDirectory } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildResult } from 'esbuild'
import { webStyleInputs } from '../../../tools/web-style-source.mjs'
import { buildWeb } from './build.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(root, '..')
const copiedInputs = [
  join(root, 'public', 'index.html'),
  join(root, 'public', 'admin.html'),
  join(root, 'public', 'resources.html'),
  ...webStyleInputs(join(root, 'public', 'style.css')),
  join(root, 'public', 'brand-mark.png'),
  join(root, '..', 'web-ui', 'src', 'tokens.css'),
  join(root, '..', 'web-ui', 'src', 'conversation', 'messages.css'),
  join(root, '..', 'web-ui', 'src', 'conversation', 'tailwind.css'),
  join(root, '..', 'web-ui', 'src', 'conversation', 'markdown.css'),
]

function sourceDirectories(results: readonly BuildResult[]): Set<string> {
  const directories = new Set<string>()
  const inputs = [
    ...copiedInputs,
    ...results.flatMap((result) =>
      Object.keys(result.metafile?.inputs ?? {}).map((input) => resolve(root, input)),
    ),
  ]

  for (const input of inputs) {
    let sourcePath: string
    try {
      sourcePath = realpathSync(input)
    } catch {
      sourcePath = resolve(input)
    }
    if (!sourcePath.startsWith(`${packagesRoot}${sep}`)) continue
    if (sourcePath.split(sep).some((part) => part === 'node_modules' || part === 'dist')) continue

    let directory = dirname(sourcePath)
    while (directory.startsWith(`${packagesRoot}${sep}`)) {
      const relativePath = relative(packagesRoot, directory)
      const segments = relativePath.split(sep)
      const sourceRoot = segments.findIndex((part) => ['src', 'tools', 'public'].includes(part))
      if (sourceRoot < 0) break
      directories.add(directory)
      const boundary = resolve(packagesRoot, ...segments.slice(0, sourceRoot + 1))
      if (directory === boundary) break
      directory = dirname(directory)
    }
  }

  return directories
}

export async function startWebDevBuild(options: { onRebuilt?: () => void } = {}) {
  let onRebuilt = options.onRebuilt
  let closed = false
  let building = false
  let pending = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let buildPromise: Promise<void> | undefined
  const watchers = new Map<string, FSWatcher>()

  const updateWatchers = (results: readonly BuildResult[]): void => {
    const directories = sourceDirectories(results)
    for (const [directory, watcher] of watchers) {
      if (directories.has(directory)) continue
      watcher.close()
      watchers.delete(directory)
    }
    for (const directory of directories) {
      if (watchers.has(directory)) continue
      try {
        const watcher = watchDirectory(directory, (_event, fileName) => {
          const changed = fileName?.toString()
          if (changed === 'dist' || changed === 'node_modules') return
          scheduleBuild()
        })
        watcher.on('error', (error) => {
          console.error(`[web-dev] watcher failed for ${directory}`, error)
          watcher.close()
          watchers.delete(directory)
        })
        watchers.set(directory, watcher)
      } catch (error) {
        console.error(`[web-dev] could not watch ${directory}`, error)
      }
    }
  }

  const rebuild = async (): Promise<void> => {
    if (closed) return
    if (building) {
      pending = true
      return
    }
    building = true
    buildPromise = (async () => {
      do {
        pending = false
        try {
          const results = await buildWeb({ clean: false })
          updateWatchers(results)
          onRebuilt?.()
          console.log('[web-dev] frontend rebuilt')
        } catch (error) {
          console.error('[web-dev] frontend rebuild failed; keeping the current page', error)
        }
      } while (pending && !closed)
    })().finally(() => {
      building = false
      buildPromise = undefined
    })
    await buildPromise
  }

  function scheduleBuild(): void {
    if (closed) return
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void rebuild()
    }, 120)
  }

  const initialResults = await buildWeb()
  updateWatchers(initialResults)

  return {
    setOnRebuilt(callback: () => void): void {
      onRebuilt = callback
    },
    async close(): Promise<void> {
      closed = true
      if (debounce !== undefined) clearTimeout(debounce)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      await buildPromise
    },
  }
}
