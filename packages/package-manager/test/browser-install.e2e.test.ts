import { type ChildProcess, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

// Copy the production ESM unchanged; only the reviewed payload and engine are synthetic.
async function fixture(packagedLock = true, key = process.platform + '-' + process.arch) {
  const root = await mkdtemp(join(tmpdir(), 'agh-browser-install-中文 #%-'))
  const plugin = join(root, 'plugin')
  const files = [
    { path: 'chromium', contents: 'fixture executable' },
    { path: 'runtime-helper', contents: 'fixture helper', executable: true },
  ]
  const info = {
    revision: 'fixture',
    executable: 'chromium',
    url: 'https://invalid.test/browser.zip',
    runtimeFiles: files.map(({ path, contents, executable }) => ({
      path,
      size: Buffer.byteLength(contents),
      executable,
    })),
  }
  const payload = Buffer.from('synthetic browser archive')
  const lock = join(root, 'cache', info.revision + '-' + key + '.lock')
  const children: ChildProcess[] = []
  await mkdir(join(plugin, 'src'), { recursive: true })
  await mkdir(join(plugin, 'dist/runtime/playwright'), { recursive: true })
  await mkdir(join(root, 'cache'))
  for (const name of ['cache.mjs', 'launcher.mjs', 'policy.mjs'])
    await copyFile(
      new URL('../bundled-plugins/browser/src/' + name, import.meta.url),
      join(plugin, 'src', name),
    )
  const require = createRequire(import.meta.url)
  const lockModule = packagedLock
    ? join(plugin, 'dist/runtime/owner-lock.mjs')
    : join(plugin, 'dist/runtime/playwright/node_modules/@agnes/system-node/owner-lock.mjs')
  await mkdir(join(lockModule, '..'), { recursive: true })
  if (!packagedLock)
    await writeFile(
      join(lockModule, '../package.json'),
      JSON.stringify({ name: '@agnes/system-node', exports: { './owner-lock': './owner-lock.mjs' } }),
    )
  await copyFile(require.resolve('@agnes/system-node/owner-lock'), lockModule)
  const engine = join(plugin, 'dist/runtime/playwright/node_modules/playwright-core')
  await mkdir(join(engine, 'lib'), { recursive: true })
  await writeFile(join(plugin, 'dist/runtime/playwright/package.json'), '{}')
  await writeFile(join(engine, 'package.json'), JSON.stringify({ version: '1.63.0', main: 'index.js' }))
  await writeFile(join(engine, 'index.js'), 'exports.chromium = {}')
  await writeFile(
    join(engine, 'lib/coreBundle.js'),
    `const { writeFile } = require('node:fs/promises')
      const { join } = require('node:path')
      exports.utils = { async extractZip(_, { dir }) {
        for (const file of ${JSON.stringify(files)})
          await writeFile(join(dir, file.path), file.contents, { mode: file.executable ? 0o755 : 0o644 })
      } }`,
  )
  await writeFile(join(root, 'payload'), payload)
  await writeFile(
    join(plugin, 'src/browser-artifacts.json'),
    JSON.stringify({
      [key]: { ...info, size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') },
    }),
  )
  await copyFile(new URL('./fixtures/browser-install-worker.mjs', import.meta.url), join(root, 'worker.mjs'))
  async function worker() {
    const child = fork(join(root, 'worker.mjs'), [], {
      execArgv: [],
      // pnpm's NODE_PATH must not supply dependencies absent from the relocated payload.
      env: { ...process.env, NODE_PATH: undefined },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.push(child)
    const messages: Record<string, unknown>[] = []
    let stderr = ''
    child.stderr!.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('message', (message) => messages.push(message as Record<string, unknown>))
    const wait = async (key: string, value: unknown = true) => {
      await expect
        .poll(() => messages.find((message) => message[key] === value), { timeout: 10_000, message: stderr })
        .toBeDefined()
      return messages.find((message) => message[key] === value)!
    }
    await wait('ready')
    return { child, wait }
  }
  return {
    root,
    cache: join(root, 'cache', info.revision + '-' + key),
    lock,
    worker,
    async downloads() {
      return (await readFile(join(root, 'downloads'), 'utf8')).trim().split('\n').length
    },
    async close() {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

it('refuses a platform with no reviewed archive before downloading', async () => {
  const f = await fixture(true, 'unavailable-host')
  try {
    const next = await f.worker()
    next.child.send('prepare')
    const result = await next.wait('state', 'failed')
    expect(result.errorCode).toBe('UNSUPPORTED_PLATFORM')
    expect(existsSync(join(f.root, 'downloads'))).toBe(false)
    expect(await readdir(join(f.root, 'cache'))).toEqual([])
  } finally {
    await f.close()
  }
})

it.each([
  'missing executable',
  'truncated executable',
  'missing runtime helper',
  'invalid marker',
  ...(process.platform === 'win32' ? [] : ['missing execute bit', 'non-executable runtime helper']),
])('refuses a cache with %s before downloading again', async (damage) => {
  const f = await fixture()
  try {
    const next = await f.worker()
    next.child.send('prepare')
    await next.wait('downloading')
    next.child.send('continue')
    await next.wait('state', 'ready')
    const executable = join(f.cache, 'chromium')
    const helper = join(f.cache, 'runtime-helper')
    const marker = join(f.cache, 'agnes-install.json')
    if (damage === 'missing executable') await rename(executable, executable + '.aside')
    else if (damage === 'truncated executable') await truncate(executable, 1)
    else if (damage === 'missing runtime helper') await rename(helper, helper + '.aside')
    else if (damage === 'invalid marker') await writeFile(marker, 'null')
    else await chmod(damage === 'missing execute bit' ? executable : helper, 0o644)
    await expect.poll(() => existsSync(f.lock)).toBe(false)

    const retry = await f.worker()
    retry.child.send('check')
    expect(await retry.wait('checked')).toMatchObject({ checkedState: 'failed', errorCode: 'CACHE_INVALID' })
    retry.child.send('launch')
    await retry.wait('launchError', 'CACHE_INVALID')
    retry.child.send('prepare')
    expect(await retry.wait('state', 'failed')).toMatchObject({ errorCode: 'CACHE_INVALID' })
    expect(await f.downloads()).toBe(1)
    expect(existsSync(f.cache)).toBe(true)
    expect(existsSync(f.lock)).toBe(false)

    await rename(f.cache, f.cache + '.quarantine')
    const recovered = await f.worker()
    recovered.child.send('prepare')
    await recovered.wait('downloading')
    recovered.child.send('continue')
    await recovered.wait('state', 'ready')
    expect(await f.downloads()).toBe(2)
  } finally {
    await f.close()
  }
})

it.skipIf(process.platform !== 'linux').each(['writable ancestor', 'cache symlink', 'writable runtime file'])(
  'refuses a Linux cache with %s',
  async (damage) => {
    const f = await fixture()
    try {
      const next = await f.worker()
      next.child.send('prepare')
      await next.wait('downloading')
      next.child.send('continue')
      await next.wait('state', 'ready')
      await expect.poll(() => existsSync(f.lock)).toBe(false)
      if (damage === 'writable ancestor') await chmod(f.root, 0o777)
      else if (damage === 'cache symlink') {
        await rename(f.cache, f.cache + '.aside')
        await symlink(f.cache + '.aside', f.cache)
      } else {
        const companion = join(f.cache, 'browser-helper')
        await writeFile(companion, 'fixture companion')
        await chmod(companion, 0o666)
      }

      const retry = await f.worker()
      retry.child.send('check')
      expect(await retry.wait('checked')).toMatchObject({ checkedState: 'failed', errorCode: 'CACHE_UNSAFE' })
      retry.child.send('launch')
      await retry.wait('launchError', 'CACHE_UNSAFE')
      retry.child.send('prepare')
      expect(await retry.wait('state', 'failed')).toMatchObject({ errorCode: 'CACHE_UNSAFE' })
      expect(await f.downloads()).toBe(1)
    } finally {
      await f.close()
    }
  },
)

it.each([true, false])(
  'recovers a dead owner without network access (packaged lock: %s)',
  async (packaged) => {
    const f = await fixture(packaged)
    try {
      const old = await f.worker()
      const exited = once(old.child, 'exit')
      old.child.kill('SIGKILL')
      await exited
      await writeFile(f.lock, JSON.stringify({ pid: old.child.pid, token: 'dead' }))
      const next = await f.worker()
      next.child.send('prepare')
      await next.wait('downloading')
      next.child.send('continue')
      await next.wait('state', 'ready')
      expect(await f.downloads()).toBe(1)
      await expect.poll(() => existsSync(f.lock)).toBe(false)
    } finally {
      await f.close()
    }
  },
)

it.each(['live', 'unknown-liveness', 'unreadable', 'legacy-directory'])(
  'refuses a %s owner and gives the exact recovery path',
  async (owner) => {
    const f = await fixture()
    try {
      if (owner === 'legacy-directory') await mkdir(f.lock)
      else
        await writeFile(
          f.lock,
          ['live', 'unknown-liveness'].includes(owner)
            ? JSON.stringify({ pid: process.pid, token: 'live' })
            : '{}',
        )
      const old = new Date(0)
      await utimes(f.lock, old, old)
      const next = await f.worker()
      if (owner === 'unknown-liveness') next.child.send('unknown-liveness')
      next.child.send('prepare')
      const result = await next.wait('state', 'failed')
      expect(result.error).toContain(f.lock)
      expect(result.error).toContain('no installer is running')
      if (['live', 'unknown-liveness'].includes(owner))
        expect(result.error).toContain(`process ${process.pid}`)
      expect(existsSync(f.lock)).toBe(true)
      expect(existsSync(join(f.root, 'downloads'))).toBe(false)
    } finally {
      await f.close()
    }
  },
)

it('installs once across two concurrent processes and lets the refused process retry', async () => {
  const f = await fixture()
  try {
    const [first, second] = await Promise.all([f.worker(), f.worker()])
    first.child.send('prepare')
    await first.wait('downloading')
    second.child.send('prepare')
    const busy = await second.wait('state', 'failed')
    expect(busy.error).toContain(`process ${first.child.pid}`)
    first.child.send('continue')
    await first.wait('state', 'ready')
    second.child.send('prepare')
    await second.wait('state', 'ready')
    expect(await f.downloads()).toBe(1)
  } finally {
    await f.close()
  }
})

it('waits for cancelled preparation to release its install lock before handing over to a replacement', async () => {
  const f = await fixture()
  const plugin = join(f.root, 'plugin')
  const source = new URL('../bundled-plugins/browser/', import.meta.url)
  const linuxCache = join(f.root, 'xdg-cache')
  const cache =
    process.platform === 'win32'
      ? join(f.root, 'Agnes', 'browser')
      : process.platform === 'linux'
        ? join(linuxCache, 'Agnes', 'browser')
        : join(f.root, 'Library', 'Caches', 'Agnes', 'browser')
  let release!: () => void, entered!: () => void, aborted!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const downloading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve
  })
  type Shutdown = () => Promise<{ state: string }>
  const shutdowns: Shutdown[] = []
  try {
    await copyFile(new URL('index.mjs', source), join(plugin, 'index.mjs'))
    for (const name of await readdir(new URL('src/', source)))
      if (name.endsWith('.mjs') || name === 'file-types.json')
        await copyFile(new URL(`src/${name}`, source), join(plugin, 'src', name))
    vi.stubEnv('LOCALAPPDATA', f.root)
    vi.stubEnv('HOME', f.root)
    vi.stubEnv('XDG_CACHE_HOME', linuxCache)
    const payload = await readFile(join(f.root, 'payload'))
    let interrupt = true
    vi.stubGlobal('fetch', async (_url: unknown, { signal }: { signal: AbortSignal }) => {
      const hold = interrupt
      interrupt = false
      return {
        ok: true,
        body: (async function* () {
          if (hold) {
            signal.addEventListener('abort', aborted, { once: true })
            try {
              entered()
              yield payload.subarray(0, 4)
              // Keep cleanup pending after cancellation, independently of filesystem speed.
              await pending
              yield payload.subarray(4)
            } finally {
              signal.removeEventListener('abort', aborted)
            }
          } else yield payload
        })(),
      }
    })
    // Load the relocated production ESM through Node, including paths containing # and %.
    const { main } = createRequire(import.meta.url)(join(plugin, 'index.mjs'))
    const activate = () => {
      let definition!: {
        start(init: {
          assertCurrent(): void
          ready(): void
          onShutdown(handler: Shutdown): void
        }): Promise<{ state: string }>
      }
      main.apply({
        profileRuntime: {
          register(value: typeof definition) {
            definition = value
            return {}
          },
          streams: { register() {} },
        },
        services: { register() {} },
        hooks: { register() {} },
        tools: { register() {} },
      })
      return definition.start({
        assertCurrent() {},
        ready() {},
        onShutdown(handler) {
          shutdowns.push(handler)
        },
      })
    }
    await activate()
    await downloading
    let settled = false
    const shutdown = shutdowns[0]
    if (!shutdown) throw new Error('Managed preparation did not register its shutdown handler')
    const closing = shutdown().then((result) => {
      settled = true
      return result
    })
    await cancelled
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect((await readdir(cache)).some((name) => name.endsWith('.lock'))).toBe(true)
    release()
    await expect(closing).resolves.toEqual({ state: 'settled' })
    expect(await readdir(cache)).toEqual([])
    const replacement = await activate()
    await expect.poll(() => replacement.state).toBe('ready')
    const installed = join(cache, 'fixture-' + process.platform + '-' + process.arch)
    expect(await readFile(join(installed, 'chromium'), 'utf8')).toBe('fixture executable')
    expect(JSON.parse(await readFile(join(installed, 'agnes-install.json'), 'utf8')).revision).toBe('fixture')
    expect((await readdir(cache)).some((name) => name.endsWith('.lock'))).toBe(false)
  } finally {
    release()
    try {
      await Promise.all(shutdowns.map((shutdown) => shutdown()))
      if (existsSync(cache))
        await expect
          .poll(async () =>
            (await readdir(cache)).filter((name) => name.endsWith('.lock') || name.includes('.tmp-')),
          )
          .toEqual([])
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      await f.close()
    }
  }
})

it('recovers after a process crashes mid-download and publishes only a complete install', async () => {
  const f = await fixture()
  try {
    const first = await f.worker()
    first.child.send('prepare')
    await first.wait('downloading')
    expect(existsSync(f.lock)).toBe(true)
    const exited = once(first.child, 'exit')
    first.child.kill('SIGKILL')
    await exited
    const next = await f.worker()
    next.child.send('prepare')
    await next.wait('downloading')
    next.child.send('continue')
    await next.wait('state', 'ready')
    expect(await f.downloads()).toBe(2)
    const cache = join(f.root, 'cache', 'fixture-' + process.platform + '-' + process.arch)
    expect(JSON.parse(await readFile(join(cache, 'agnes-install.json'), 'utf8')).revision).toBe('fixture')
    expect(await readFile(join(cache, 'chromium'), 'utf8')).toBe('fixture executable')
    await expect.poll(() => existsSync(f.lock)).toBe(false)
  } finally {
    await f.close()
  }
})

it('keeps a replacement owner lock when an installer finishes', async () => {
  const f = await fixture()
  try {
    const next = await f.worker()
    next.child.send('prepare')
    await next.wait('downloading')
    next.child.send('replace-lock')
    await next.wait('state', 'ready')
    expect(JSON.parse(await readFile(f.lock, 'utf8')).token).toBe('replacement')
  } finally {
    await f.close()
  }
})

it.each(['checksum', 'undersize', 'oversize', 'missing-installer'])(
  'rejects a payload with invalid %s, releases the lock and permits retry',
  async (damage) => {
    const f = await fixture()
    try {
      const file = join(f.root, 'payload')
      const original = await readFile(file)
      const installer = join(f.root, 'plugin/dist/runtime/owner-lock.mjs')
      const installerSource = await readFile(installer)
      const corrupt = Buffer.from(original)
      corrupt[0] = corrupt[0]! ^ 1
      if (damage === 'missing-installer') await rm(installer)
      else
        await writeFile(
          file,
          damage === 'checksum'
            ? corrupt
            : damage === 'undersize'
              ? original.subarray(0, -1)
              : Buffer.concat([original, Buffer.from('!')]),
        )
      const first = await f.worker()
      first.child.send('prepare')
      if (damage !== 'missing-installer') {
        await first.wait('downloading')
        first.child.send('continue')
      }
      const result = await first.wait('state', 'failed')
      if (damage === 'missing-installer') {
        expect(result.error).toContain('@agnes/system-node/owner-lock')
        expect(existsSync(join(f.root, 'downloads'))).toBe(false)
      } else {
        expect(result.errorCode).toBe('INTEGRITY')
        expect(result.error).toMatch(/reviewed (manifest|size)/)
      }
      await expect.poll(() => existsSync(f.lock)).toBe(false)
      expect(await readdir(join(f.root, 'cache'))).toEqual([])
      await writeFile(file, original)
      await writeFile(installer, installerSource)
      const next = await f.worker()
      next.child.send('prepare')
      await next.wait('downloading')
      next.child.send('continue')
      await next.wait('state', 'ready')
      expect(await f.downloads()).toBe(damage === 'missing-installer' ? 1 : 2)
    } finally {
      await f.close()
    }
  },
)
