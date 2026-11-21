import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeHomeLocked, initializeLlmsgHomeLocked } from '../src/home-initialize.js'
import { inspectHome } from '../src/home-layout.js'

const initializer = new URL('../src/home-initialize.ts', import.meta.url).href
const locker = new URL('../src/configuration-lock.ts', import.meta.url).href
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const children: ChildProcess[] = []
let parent: string
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'agnes-home-process-'))
})
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }),
  )
  rmSync(parent, { recursive: true, force: true })
})

function childScript(script: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', tsx, '--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  children.push(child)
  return child
}

it('serializes two real startup processes and retains one home instance', async () => {
  const home = join(parent, 'home')
  const run = (profile: string) => {
    const child = childScript(
      `import { initializeHomeLocked } from ${JSON.stringify(initializer)};
      process.on('message', async () => {
        const result = await initializeHomeLocked(process.argv[1], process.argv[2]);
        process.send(result); process.disconnect();
      }); process.send('ready');`,
      [home, profile],
    )
    return { child, ready: once(child, 'message'), exited: once(child, 'exit') }
  }
  const starts = [run('local-dev'), run('other')]
  await Promise.all(starts.map((start) => start.ready))
  const results = await Promise.all(
    starts.map(async (start) => {
      const message = once(start.child, 'message')
      start.child.send('start')
      return (await message)[0] as { instanceId: string; state: string }
    }),
  )
  for (const start of starts) expect((await start.exited)[0]).toBe(0)
  expect(results[0]?.instanceId).toBe(results[1]?.instanceId)
  expect(results.map((result) => result.state)).toEqual(['current', 'current'])
  expect(inspectHome(home).instanceId).toBe(results[0]?.instanceId)
}, 30000)

it.each([
  { inherited: false, publishing: false },
  { inherited: false, publishing: true },
  ...(process.platform === 'win32' ? [{ inherited: true, publishing: false }] : []),
])(
  'waits for a live initialization lock ($inherited ACL, publishing: $publishing) without replacing it',
  async ({ inherited, publishing }) => {
    const privateParent = join(parent, 'private')
    createPrivateDirectorySync(privateParent)
    const home = join(privateParent, 'home')
    const initial = await initializeHomeLocked(home)
    const lock = join(privateParent, '.home.initialize.sqlite')
    if (inherited) {
      execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        [lock, '/inheritance:e'],
        { windowsHide: true },
      )
      expect(hasPrivateDaclSync(lock)).toBe(false)
    }
    const inode = lstatSync(lock).ino
    const holder = childScript(
      `import { withConfigurationLock } from ${JSON.stringify(locker)};
    import { renameSync } from 'node:fs';
    await withConfigurationLock(process.argv[1], async () => {
      // Expose the first-start window: private directories exist but the marker is not published.
      if (process.argv[4] === 'true') renameSync(process.argv[2], process.argv[3]);
      // Keep the pending action reachable from live IPC, rather than awaiting an unresolvable promise.
      const released = new Promise((resolve) => process.once('message', resolve));
      process.send('held'); await released;
      if (process.argv[4] === 'true') renameSync(process.argv[3], process.argv[2]);
    });`,
      [lock, join(home, 'home-layout.json'), join(privateParent, 'pending-marker.json'), String(publishing)],
    )
    expect((await once(holder, 'message'))[0]).toBe('held')
    let completed = false
    const waiting = initializeHomeLocked(home).then(
      (result) => {
        completed = true
        return { result }
      },
      (error) => {
        completed = true
        return { error }
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    const exited = once(holder, 'exit')
    if (publishing) holder.send('publish')
    else holder.kill('SIGKILL')
    await exited
    expect(await waiting).toMatchObject({ result: { instanceId: initial.instanceId } })
    expect(lstatSync(lock).ino).toBe(inode)
  },
  15000,
)

it('the real CLI initializes a fresh home before reporting daemon status', async () => {
  const home = join(parent, 'cli-home')
  const cli = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', tsx, cli, 'daemon', 'status'], {
    env: { ...process.env, AGH_HOME: home },
    cwd: parent,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.push(child)
  let stderr = '',
    stdout = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  const [code] = await once(child, 'exit')
  expect(code, stderr).toBe(1) // The status command returns 1 when no daemon is running.
  expect(JSON.parse(stdout)).toMatchObject({ running: false })
  expect(inspectHome(home).state).toBe('current')
  expect(lstatSync(join(parent, '.cli-home.initialize.sqlite')).isFile()).toBe(true)
}, 60000)

describe.runIf(process.platform === 'linux')('LLMSG home bootstrap', () => {
  const fallback = 'fixture-environment-key'
  const preseeded = 'fixture-preseeded-key\n'
  const env = { AGH_CLOUD_KEY: fallback }
  function privateHome() {
    const home = join(parent, 'home')
    mkdirSync(home, { mode: 0o700 })
    return { home, key: join(home, 'cloud-key') }
  }

  it.each([false, true])(
    'initializes an empty or Key-only home (Key exists: %s) and restarts',
    async (preseed) => {
      const { home, key } = privateHome()
      if (preseed) {
        writeFileSync(key, preseeded, { mode: 0o644 })
        await expect(initializeHomeLocked(home)).rejects.toMatchObject({ code: 'E_HOME_VERSION' })
      }
      const originalInode = preseed ? lstatSync(key).ino : undefined
      const initialEnv = preseed ? {} : env
      const first = await initializeLlmsgHomeLocked(home, 'local-dev', initialEnv)
      if (!preseed) expect(readdirSync(home)).not.toContain('cloud-key')
      await initializeLlmsgHomeLocked(home, 'local-dev', initialEnv, 'persist-key')
      expect(readFileSync(key, 'utf8')).toBe(preseed ? preseeded : `${fallback}\n`)
      expect(lstatSync(key).mode & 0o777).toBe(0o600)
      if (preseed) expect(lstatSync(key).ino).toBe(originalInode)
      const replacement = join(home, 'rotation.tmp')
      writeFileSync(replacement, 'fixture-rotated-key\n', { mode: 0o600 })
      renameSync(replacement, key)
      const rotatedInode = lstatSync(key).ino
      await initializeLlmsgHomeLocked(home, 'local-dev', env)
      const restart = await initializeLlmsgHomeLocked(home, 'local-dev', env, 'persist-key')
      expect(restart.instanceId).toBe(first.instanceId)
      expect(readFileSync(key, 'utf8')).toBe('fixture-rotated-key\n')
      expect(lstatSync(key).ino).toBe(rotatedInode)
    },
  )

  it('uses the corrected environment Key after a failed install and refuses conflicting aliases', async () => {
    const { home, key } = privateHome()
    const retry = { AGH_API_KEY: 'fixture-retried-key' }
    await expect(initializeLlmsgHomeLocked(home, 'local-dev', env, 'persist-key')).rejects.toMatchObject({
      code: 'E_HOME_VERSION',
    })
    await expect(initializeLlmsgHomeLocked(home, 'local-dev', { ...env, ...retry })).rejects.toThrow(
      'Conflicting LLMSG cloud Key variables',
    )
    expect(readdirSync(home)).toEqual([])
    const first = await initializeLlmsgHomeLocked(home, 'local-dev', env)
    // The first plugin installation fails before the entrypoint can invoke the persistence step.
    expect(readdirSync(home)).not.toContain('cloud-key')
    const second = await initializeLlmsgHomeLocked(home, 'local-dev', retry)
    expect(second.instanceId).toBe(first.instanceId)
    await initializeLlmsgHomeLocked(home, 'local-dev', retry, 'persist-key')
    expect(readFileSync(key, 'utf8')).toBe('fixture-retried-key\n')
    await initializeLlmsgHomeLocked(home, 'local-dev', { ...env, ...retry }, 'persist-key')
    expect(readFileSync(key, 'utf8')).toBe('fixture-retried-key\n')
  })

  it('rechecks the home after the provider completes an in-progress atomic rotation', async () => {
    const { home, key } = privateHome()
    const replacement = join(home, 'rotation.tmp')
    writeFileSync(key, preseeded, { mode: 0o600 })
    writeFileSync(replacement, 'fixture-rotated-key\n', { mode: 0o600 })
    const bootstrap = initializeLlmsgHomeLocked(home, 'local-dev', {})
    await delay(20)
    expect(readFileSync(key, 'utf8')).toBe(preseeded)
    expect(readdirSync(home).sort()).toEqual(['cloud-key', 'rotation.tmp'])
    renameSync(replacement, key)
    await expect(bootstrap).resolves.toMatchObject({ state: 'current' })
    await initializeLlmsgHomeLocked(home, 'local-dev', env, 'persist-key')
    expect(readFileSync(key, 'utf8')).toBe('fixture-rotated-key\n')
  })

  it('refuses old layouts and preserves old data and the original Key', async () => {
    const { home, key } = privateHome()
    writeFileSync(key, preseeded, { mode: 0o600 })
    const legacy = join(home, 'sessions.db')
    writeFileSync(legacy, 'fixture-old-data')
    await expect(initializeLlmsgHomeLocked(home, 'local-dev', env)).rejects.toMatchObject({
      code: 'E_HOME_VERSION',
    })
    expect(readdirSync(home).sort()).toEqual(['cloud-key', 'sessions.db'])
    expect(readFileSync(legacy, 'utf8')).toBe('fixture-old-data')
    expect(readFileSync(key, 'utf8')).toBe(preseeded)
    const pending = join(home, '.llmsg-home-layout.pending')
    renameSync(legacy, pending)
    await expect(initializeLlmsgHomeLocked(home, 'local-dev', env)).rejects.toMatchObject({
      code: 'E_HOME_UNSAFE',
    })
    expect(readFileSync(pending, 'utf8')).toBe('fixture-old-data')
    expect(readFileSync(key, 'utf8')).toBe(preseeded)
  })

  it('refuses symbolic links, invalid existing Keys, and a missing fallback', async () => {
    const { home, key } = privateHome()
    const target = join(parent, 'private-target')
    const alias = join(parent, 'alias')
    writeFileSync(target, preseeded, { mode: 0o644 })
    symlinkSync(home, alias)
    await expect(initializeLlmsgHomeLocked(alias, 'local-dev', env)).rejects.toMatchObject({
      code: 'E_HOME_UNSAFE',
    })
    symlinkSync(target, key)
    await expect(initializeLlmsgHomeLocked(home, 'local-dev', env)).rejects.toMatchObject({
      code: 'E_LLMSG_KEY',
    })
    expect(lstatSync(key).isSymbolicLink()).toBe(true)
    expect(lstatSync(target).mode & 0o777).toBe(0o644)
    rmSync(key)
    for (const invalid of ['', ' \n']) {
      writeFileSync(key, invalid, { mode: 0o600 })
      await expect(initializeLlmsgHomeLocked(home, 'local-dev', env)).rejects.toMatchObject({
        code: 'E_LLMSG_KEY',
      })
      expect(readFileSync(key, 'utf8')).toBe(invalid)
    }
    rmSync(key)
    await expect(initializeLlmsgHomeLocked(home, 'local-dev', {})).rejects.toMatchObject({
      code: 'E_LLMSG_KEY',
    })
    expect(readdirSync(home)).toEqual([])
  })

  it.each([
    ['renameSync', false, true, 'fail'],
    ['renameSync', false, true, 'kill'],
    ['mkdirSync', false, true, 'kill'],
    ['linkSync', false, false, 'kill'],
    ['linkSync', true, false, 'kill'],
    ['linkSync', false, false, 'rotate'],
    ['openSync', true, true, 'rotate'],
  ] as const)(
    'recovers at %s (after: %s, preseed: %s, fault: %s)',
    async (method, after, preseed, fault) => {
      const { home, key } = privateHome()
      if (preseed) writeFileSync(key, preseeded, { mode: 0o600 })
      const child = childScript(
        'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; ' +
          'import { join } from "node:path"; import assert from "node:assert/strict"; ' +
          'const [home, method, after, fault, fallback] = process.argv.slice(1); ' +
          'const key = join(home, "cloud-key"), original = fs[method]; let injected = false; ' +
          'fs[method] = (...args) => { ' +
          '  if (injected || (method === "openSync" && args[0] !== key) || ' +
          '      (method === "renameSync" && args[1] !== join(home, "home-layout.json")) || ' +
          '      (method === "mkdirSync" && !String(args[0]).startsWith(home + "/")) || ' +
          '      (method === "linkSync" && args[1] !== key)) return original(...args); ' +
          '  injected = true; const result = after === "true" ? original(...args) : undefined; ' +
          '  if (fault === "kill") { process.kill(process.pid, "SIGKILL"); return; } ' +
          '  if (fault === "fail") throw Object.assign(new Error("fixture write failure"), { code: "EIO" }); ' +
          '  fs.writeFileSync(key + ".rotation", "fixture-concurrent-key\\n", { mode: 0o600 }); ' +
          '  fs.renameSync(key + ".rotation", key); return after === "true" ? result : original(...args); ' +
          '}; syncBuiltinESMExports(); ' +
          'const { initializeLlmsgHomeLocked } = await import(' +
          JSON.stringify(initializer) +
          '); ' +
          'const env = { AGH_CLOUD_KEY: fallback || undefined }; ' +
          'const init = async () => { await initializeLlmsgHomeLocked(home, "local-dev", env); ' +
          'await initializeLlmsgHomeLocked(home, "local-dev", env, "persist-key"); }; ' +
          'if (fault === "fail") await assert.rejects(init(), { code: "EIO" }); else await init(); ' +
          'assert.ok(injected); process.disconnect();',
        [home, method, String(after), fault, preseed ? '' : fallback],
      )
      expect(await once(child, 'exit')).toEqual(fault === 'kill' ? [null, 'SIGKILL'] : [0, null])
      if (preseed && fault !== 'rotate') expect(readFileSync(key, 'utf8')).toBe(preseeded)
      if (fault === 'rotate') expect(readFileSync(key, 'utf8')).toBe('fixture-concurrent-key\n')
      const published = inspectHome(home).instanceId
      const retryEnv = preseed ? {} : env
      await initializeLlmsgHomeLocked(home, 'local-dev', retryEnv)
      const retried = await initializeLlmsgHomeLocked(home, 'local-dev', retryEnv, 'persist-key')
      expect(retried.state).toBe('current')
      if (published) expect(retried.instanceId).toBe(published)
      expect(readFileSync(key, 'utf8')).toBe(
        fault === 'rotate' ? 'fixture-concurrent-key\n' : preseed ? preseeded : `${fallback}\n`,
      )
      expect(readdirSync(home)).not.toContain('.llmsg-home-layout.pending')
      expect(readdirSync(retried.paths.credentials)).not.toContain('.llmsg-cloud-key.pending')
    },
    30000,
  )
})
