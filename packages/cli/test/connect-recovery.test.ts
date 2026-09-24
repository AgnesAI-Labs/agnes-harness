import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { type DaemonScope, readDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootConnect, bootLocalConnect } from '../src/boot/connect.js'
import type { Booted } from '../src/types.js'

vi.mock('@agnes/daemon', () => ({ readDaemonDiscovery: vi.fn(), resolveDaemonScope: vi.fn() }))
const windows = process.platform === 'win32' // guards-allow-platform: real replacement child processes and native pipe identity.
const children: ChildProcess[] = []
let booted: Booted | undefined
afterEach(async () => {
  await booted?.close()
  booted = undefined
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
  vi.resetAllMocks()
})

async function server(path: string) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const net = require('node:net');
    net.createServer(socket => {
      socket.on('error', () => {});
      let pending = '';
      socket.on('data', bytes => {
        pending += bytes;
        let end;
        while ((end = pending.indexOf('\\n')) >= 0) {
          const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          if (frame.id === undefined) continue;
          const result = frame.method === 'initialize'
            ? { protocolVersion: 1, agentCapabilities: {} }
            : { profile: { name: String(process.pid), resolvedProfileHash: null, presets: { default: 'p', allowed: ['p'] } }, families: [] };
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
        }
      });
    }).listen(process.argv[1], () => process.stdout.write('ready\\n'));
  `,
      path,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  children.push(child)
  if (!child.stdout) throw new Error('Missing fixture stdout')
  await once(child.stdout, 'data')
  const pid = child.pid
  const start = pid && windowsProcessStartTimeSync(pid)
  if (!pid || !start) throw new Error('Missing child identity')
  return { child, owner: { pid, processStartId: `win32:${pid}:${start}` } }
}

it.skipIf(!windows).each(['automatic', 'manual'])(
  '%s CLI recovers after the verified server is replaced by a different real PID',
  async (mode) => {
    const name = `cli-recovery-${randomUUID()}`
    const path = `\\\\.\\pipe\\${name}`
    const scope = { scopeID: 'selected', dataDir: '/backend-override' } as DaemonScope
    vi.mocked(resolveDaemonScope).mockResolvedValue(scope)
    const first = await server(path)
    const discovery = { socketPath: path, owner: first.owner } as NonNullable<
      Awaited<ReturnType<typeof readDaemonDiscovery>>
    >
    vi.mocked(readDaemonDiscovery).mockResolvedValue(discovery)
    const deps = { cwd: '/test', home: '/home', agnesVersion: '0.0.0-test', env: {}, log() {} }
    booted =
      mode === 'manual'
        ? await bootConnect(parseArgs(['--connect', `pipe:///${name}`]), deps)
        : await bootLocalConnect(parseArgs([]), deps, path, first.owner, scope)
    const recovered = vi.fn()
    booted.client.on('reconnected', recovered)
    const stopped = once(first.child, 'close')
    first.child.kill()
    await stopped
    vi.mocked(readDaemonDiscovery).mockResolvedValue(null)
    const second = await server(path)
    expect(second.owner.pid).not.toBe(first.owner.pid)
    vi.mocked(readDaemonDiscovery).mockResolvedValue({
      ...discovery,
      owner: { ...discovery.owner, ...second.owner },
    })
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce(), { timeout: 8000 })
    expect(await booted.client.call('_agnes/v1/apis.list', {})).toMatchObject({
      profile: { name: String(second.owner.pid) },
    })
    expect(readDaemonDiscovery).toHaveBeenLastCalledWith(scope)
  },
  15_000,
)
