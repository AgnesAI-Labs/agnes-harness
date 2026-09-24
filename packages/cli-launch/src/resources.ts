import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files required by a local production launch.
 *
 * This is deliberately a path-only description. It does not inspect the current working
 * directory, read a profile, or start a service; those responsibilities belong to the CLI boot
 * layer and the daemon. Keeping resource discovery here makes a packaged launcher usable when its
 * caller has changed into an unrelated workspace.
 */
export type LaunchResources = {
  mode: 'source' | 'package' | 'sea'
  root: string
  daemonEntry: string
  workerEntry: string
  webRoot: string
  /** Node runtime shipped beside a SEA executable for detached daemon/worker children. */
  runtimeNode?: string
}

function isSea(): boolean {
  try {
    return process.getBuiltinModule('node:sea').isSea()
  } catch {
    return false
  }
}

function complete(root: string): boolean {
  return existsSync(join(root, 'daemon.mjs')) && existsSync(join(root, 'worker.mjs'))
}

const requiredWebAssets = [
  'index.html',
  'admin.html',
  'resources.html',
  'app.js',
  'admin.js',
  'resources.js',
  'style.css',
  // 侧栏品牌位与过程行头像用的位图：缺了它页面不会报错，只会静默地没有 logo 和头像
  // （CSS mask 取不到图），所以它属于"必备"而不是"可选"。
  'brand-mark.png',
] as const

function webRoot(root: string): string | undefined {
  const candidate = join(root, 'web')
  return requiredWebAssets.every((asset) => existsSync(join(candidate, asset))) ? candidate : undefined
}

function runtimeNode(root: string): string | undefined {
  for (const name of ['node', 'node.exe']) {
    const candidate = join(root, 'runtime', name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate immutable launch resources relative to this module or executable.
 *
 * `moduleUrl` is injectable for unit tests and otherwise remains the module's own URL. The source
 * fallback is intentionally only available to the repository development launcher; a production
 * output that is missing its sibling entries fails instead of silently reaching into a source tree.
 */
export function resolveLaunchResources(
  moduleUrl: string = import.meta.url,
  options: { allowSource?: boolean } = {},
): LaunchResources {
  const modulePath = fileURLToPath(moduleUrl)
  const here = dirname(modulePath)
  const sea = isSea()
  const candidates = sea
    ? [dirname(process.execPath)]
    : [here, join(here, 'local'), join(here, '..', 'local')]

  for (const candidate of candidates) {
    const root = resolve(candidate)
    const web = webRoot(root)
    if (complete(root) && web) {
      const runtime = sea ? runtimeNode(root) : undefined
      if (sea && !runtime)
        throw new Error('Agnes SEA runtime is unavailable; expected sibling runtime/node or runtime/node.exe')
      return {
        mode: sea ? 'sea' : 'package',
        root,
        daemonEntry: join(root, 'daemon.mjs'),
        workerEntry: join(root, 'worker.mjs'),
        webRoot: web,
        ...(runtime ? { runtimeNode: runtime } : {}),
      }
    }
  }

  if (sea && !runtimeNode(resolve(dirname(process.execPath))))
    throw new Error('Agnes SEA runtime is unavailable; expected sibling runtime/node or runtime/node.exe')

  // Web development serves the separately built frontend, but the backend must use the composed
  // distribution: source worker entries lack the builtin extension manifests injected by the build.
  const sourceWeb = webRoot(resolve(here, '..', '..', 'web', 'dist'))
  if (options.allowSource === true && !sea && sourceWeb) {
    const backendRoot = resolve(here, '..', 'dist', 'local')
    if (complete(backendRoot))
      return {
        mode: 'source',
        root: backendRoot,
        daemonEntry: join(backendRoot, 'daemon.mjs'),
        workerEntry: join(backendRoot, 'worker.mjs'),
        webRoot: sourceWeb,
      }
    throw new Error(
      'Agnes development backend is unavailable; run pnpm --filter @agnes/cli build:local first',
    )
  }

  throw new Error('Agnes local launch resources are unavailable; run the production build first')
}
