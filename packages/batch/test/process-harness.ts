import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function launch(entry: URL, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(entry), ...args], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const exit = once(child, 'exit')
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-16000)
  })
  const messages: Record<string, unknown>[] = []
  child.on('message', (message) => {
    if (message && typeof message === 'object') messages.push(message as Record<string, unknown>)
  })
  return { child, messages, exit, stderr: () => stderr }
}
export async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = once(child, 'exit')
  child.kill('SIGKILL')
  await exit
}
/** Snapshot descendants of live test-owned roots before killing those roots. */
export function descendants(children: readonly ChildProcess[]): number[] {
  const roots = children
    .filter((child) => child.exitCode === null && child.signalCode === null)
    .flatMap((child) => (child.pid === undefined ? [] : [child.pid]))
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
  const owned = new Set(roots)
  for (;;) {
    const found = rows.filter(
      ([pid, parent]) => pid !== undefined && parent !== undefined && owned.has(parent) && !owned.has(pid),
    )
    if (!found.length) break
    for (const [pid] of found) if (pid !== undefined) owned.add(pid)
  }
  return [...owned].filter((pid) => !roots.includes(pid))
}
export const daemonEntry = new URL('../../daemon/test/fixtures/source-loop-daemon.ts', import.meta.url)
export const driverEntry = new URL('./fixtures/managed-driver.ts', import.meta.url)
export async function daemonSocket(root: string) {
  return (JSON.parse(await readFile(join(root, 'home/daemon/owner.json'), 'utf8')) as { socketPath: string })
    .socketPath
}
