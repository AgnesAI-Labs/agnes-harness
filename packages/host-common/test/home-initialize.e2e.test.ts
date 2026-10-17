import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { initializeHomeLocked } from '../src/home-initialize.js'
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
