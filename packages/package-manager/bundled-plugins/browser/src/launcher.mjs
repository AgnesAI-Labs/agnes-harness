import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { failure } from './policy.mjs'

const VERSION = '1.63.0'
const packaged = new URL('../dist/runtime/playwright/package.json', import.meta.url)
const require = createRequire(existsSync(packaged) ? packaged : new URL('../package.json', import.meta.url))
const packagedLock = new URL('../dist/runtime/owner-lock.mjs', import.meta.url)
let engine
function load() {
  if (!engine) {
    const root = dirname(require.resolve('playwright-core/package.json'))
    const metadata = require(join(root, 'package.json'))
    if (metadata.version !== VERSION) throw failure('VERSION_MISMATCH', 'Browser engine version mismatch.')
    const chromium = require(join(root, 'index.js')).chromium
    const bundle = require(join(root, 'lib/coreBundle.js'))
    engine = { chromium, extractZip: bundle.utils.extractZip }
  }
  return engine
}
function owned(parent, target) {
  const part = relative(resolve(parent), resolve(target))
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part))
    throw failure('CACHE_PATH', 'Browser cache path escaped its owner.')
  return target
}
async function artifact(cacheRoot) {
  const key = platform() + '-' + arch()
  const values = JSON.parse(await readFile(new URL('./browser-artifacts.json', import.meta.url), 'utf8'))
  const value = values[key]
  if (!value || !/^[a-f0-9]{64}$/.test(value.sha256))
    throw failure('UNSUPPORTED_PLATFORM', 'This platform has no reviewed browser runtime.')
  const base =
    cacheRoot ??
    (platform() === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Agnes', 'browser')
      : join(homedir(), 'Library', 'Caches', 'Agnes', 'browser'))
  const cache = owned(base, join(base, value.revision + '-' + key))
  return {
    ...value,
    relativeExecutable: value.executable,
    base,
    cache,
    executable: owned(cache, join(cache, value.executable)),
  }
}
async function installed(info) {
  try {
    const marker = JSON.parse(await readFile(join(info.cache, 'agnes-install.json'), 'utf8'))
    return marker.sha256 === info.sha256 && (await stat(info.executable)).isFile()
  } catch {
    return false
  }
}

/** Fixed payloads are downloaded in process: no global Node or SEA-as-Node child is required. */
export function createLauncher({ cacheRoot, fetchArchive = fetch } = {}) {
  let installing, controller, retryFor
  const launcher = {
    async check(runtime) {
      if (!runtime.enabled) return
      try {
        runtime.state = (await installed(await artifact(cacheRoot))) ? 'ready' : 'stopped'
      } catch (error) {
        runtime.state = 'failed'
        runtime.error = String(error.message).slice(0, 500)
      }
    },
    prepare(runtime) {
      if (installing) {
        if (controller?.signal.aborted) retryFor = runtime
        return
      }
      const epoch = runtime.epoch
      controller = new AbortController()
      const signal = controller.signal
      runtime.state = 'preparing'
      runtime.error = undefined
      runtime.notify()
      installing = (async () => {
        const info = await artifact(cacheRoot)
        if (!(await installed(info))) {
          // Missing installer dependencies fail this managed service, not plugin/worker admission.
          const {
            acquireOwnerFileLock,
            pidExists,
            readLockOwner,
            releaseOwnerFileLock,
            takeOverOwnerFileLock,
          } = await import(
            existsSync(packagedLock)
              ? packagedLock.href
              : pathToFileURL(require.resolve('@agnes/system-node/owner-lock')).href
          )
          await mkdir(info.base, { recursive: true })
          const lock = owned(info.base, info.cache + '.lock')
          const owner = { pid: process.pid, token: randomUUID() }
          while (!acquireOwnerFileLock(lock, owner)) {
            const held = readLockOwner(lock)
            if (held && !pidExists(held.pid)) {
              takeOverOwnerFileLock(lock, held.token)
              continue
            }
            throw failure(
              'INSTALL_BUSY',
              held
                ? `Browser install lock ${lock} is held by process ${held.pid} (live or unknown). Retry after installation finishes; remove this lock manually only after confirming no installer is running.`
                : `Browser install lock ${lock} has no readable owner (possibly an old directory lock). Confirm no installer is running, then remove this lock manually and retry.`,
            )
          }
          let staging
          try {
            if (!(await installed(info))) {
              staging = owned(info.base, await mkdtemp(info.cache + '.tmp-'))
              const zip = owned(staging, join(staging, 'browser.zip'))
              const download = await fetchArchive(info.url, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
              })
              if (!download.ok || !download.body)
                throw failure('DOWNLOAD_FAILED', 'Browser download failed: ' + download.status)
              const output = await open(zip, 'wx')
              const hash = createHash('sha256')
              let bytes = 0
              try {
                for await (const chunk of download.body) {
                  signal.throwIfAborted()
                  bytes += chunk.length
                  if (bytes > info.size)
                    throw failure('INTEGRITY', 'Browser archive exceeded its reviewed size.')
                  hash.update(chunk)
                  await output.write(chunk)
                }
              } finally {
                await output.close()
              }
              if (bytes !== info.size || hash.digest('hex') !== info.sha256)
                throw failure('INTEGRITY', 'Browser archive checksum did not match the reviewed manifest.')
              signal.throwIfAborted()
              const unpacked = owned(staging, join(staging, 'unpacked'))
              await mkdir(unpacked)
              await load().extractZip(zip, { dir: unpacked })
              signal.throwIfAborted()
              const executable = owned(unpacked, join(unpacked, info.relativeExecutable))
              owned(await realpath(unpacked), await realpath(executable))
              await chmod(executable, 0o755)
              await writeFile(
                join(unpacked, 'agnes-install.json'),
                JSON.stringify({ sha256: info.sha256, revision: info.revision }),
              )
              // An existing cache is not overwritten or deleted underneath another profile.
              if (existsSync(info.cache))
                throw failure(
                  'CACHE_INVALID',
                  'The existing browser cache is incomplete; inspect it before repair.',
                )
              await rename(unpacked, info.cache)
            }
          } finally {
            try {
              if (staging) await rm(owned(info.base, staging), { recursive: true, force: true })
            } finally {
              releaseOwnerFileLock(lock, owner.token)
            }
          }
        }
        runtime.guard(epoch)
        runtime.state = 'ready'
        runtime.error = undefined
        runtime.notify()
      })()
        .catch((error) => {
          if (runtime.enabled && epoch === runtime.epoch) {
            runtime.state = 'failed'
            runtime.error =
              error.code === 'INSTALL_BUSY' ? error.message : String(error.message).slice(0, 500)
            runtime.notify()
          }
        })
        .finally(() => {
          installing = undefined
          const next = retryFor
          retryFor = undefined
          if (next?.enabled && !next.closed) launcher.prepare(next)
        })
    },
    async launch() {
      const info = await artifact(cacheRoot)
      if (!(await installed(info)))
        throw failure(
          'PREPARING',
          'The browser plugin is preparing its runtime. Wait for the browser panel to become ready.',
        )
      const env = {}
      for (const name of [
        'SystemRoot',
        'WINDIR',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'LOCALAPPDATA',
        'HOME',
        'TMPDIR',
        'PATH',
        'LANG',
      ])
        if (process.env[name]) env[name] = process.env[name]
      return load().chromium.launch({
        executablePath: info.executable,
        headless: true,
        chromiumSandbox: true,
        env,
        timeout: 30_000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
    },
    cancel() {
      retryFor = undefined
      controller?.abort()
    },
  }
  return launcher
}
