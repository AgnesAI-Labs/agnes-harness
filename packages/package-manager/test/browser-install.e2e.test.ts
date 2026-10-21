import { type ChildProcess, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Copy the production ESM unchanged; only the reviewed payload and engine are synthetic.
async function fixture(packagedLock = true) {
  const root = await mkdtemp(join(tmpdir(), 'agh-browser-install-'))
  const plugin = join(root, 'plugin')
  const key = process.platform + '-' + process.arch
  const info = { revision: 'fixture', executable: 'chromium', url: 'https://invalid.test/browser.zip' }
  const payload = Buffer.from('synthetic browser archive')
  const lock = join(root, 'cache', info.revision + '-' + key + '.lock')
  const children: ChildProcess[] = []
  await mkdir(join(plugin, 'src'), { recursive: true })
  await mkdir(join(plugin, 'dist/runtime/playwright'), { recursive: true })
  await mkdir(join(root, 'cache'))
  for (const name of ['launcher.mjs', 'policy.mjs'])
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
    `exports.utils = { extractZip: async (_, { dir }) => require('node:fs/promises').writeFile(require('node:path').join(dir, 'chromium'), 'fixture executable') }`,
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
      } else expect(result.error).toMatch(/reviewed (manifest|size)/)
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
