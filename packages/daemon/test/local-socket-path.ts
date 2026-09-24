import { createHash } from 'node:crypto'
import { windowsProcessStartTimeSync } from '@agnes/system-node'

const windows = process.platform === 'win32' // guards-allow-platform: test-only local transport fixture.

/** Stable for reconnects; each test's unique temporary path isolates its pipe. */
export function localSocketPath(path: string): string {
  return windows ? `\\\\.\\pipe\\agnes-test-${createHash('sha256').update(path).digest('hex')}` : path
}

/** Only for listeners owned by this test process; external daemons need trusted discovery. */
export function localSdkTransport(path: string) {
  if (!path.startsWith('\\\\.\\pipe\\')) return { kind: 'unix' as const, path }
  const start = windowsProcessStartTimeSync(process.pid)
  if (!start) throw new Error('Test listener identity unavailable')
  return {
    kind: 'unix' as const,
    path,
    serverIdentity: { pid: process.pid, processStartId: `win32:${process.pid}:${start}` },
  }
}
