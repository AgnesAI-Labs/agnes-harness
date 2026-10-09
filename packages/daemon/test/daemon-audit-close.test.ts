import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { runAgnesd } from '../src/supervisor/supervisor.js'

const state = vi.hoisted(() => ({
  events: [] as string[],
  close: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('../src/supervisor/lifecycle.js', async (original) => ({
  ...(await original<typeof import('../src/supervisor/lifecycle.js')>()),
  installSignals: (close: () => Promise<void>) => {
    state.close = close
    return () => {}
  },
}))
vi.mock('../src/supervisor/stop-request.js', async (original) => ({
  ...(await original<typeof import('../src/supervisor/stop-request.js')>()),
  watchWindowsStopRequest: () => () => {},
}))
vi.mock('@agnes/host', async (original) => {
  const actual = await original<typeof import('@agnes/host')>()
  return {
    ...actual,
    createFileAudit: (...args: Parameters<typeof actual.createFileAudit>) => {
      const sink = actual.createFileAudit(...args)
      return {
        ...sink,
        close: async () => {
          if (args[0].endsWith('daemon.jsonl')) state.events.push('flush')
          await sink.close?.()
        },
      }
    },
  }
})

async function closeDaemon() {
  const close = state.close
  if (!close) throw new Error('shutdown callback missing')
  await close()
}

it.each(['normal', 'startup', 'discovery'])('flushes the real audit sink on %s exit', async (mode) => {
  state.events = []
  state.close = undefined
  const temporary = mkdtempSync(join(tmpdir(), 'agnes-audit-close-'))
  const root = join(temporary, 'home')
  createPrivateDirectorySync(root)
  const failure = new Error('injected startup/discovery failure')
  try {
    const starting = runAgnesd(
      { profile: 'local-dev', home: root, workspace: root },
      {
        startProduction: async () => {
          if (mode === 'startup') throw failure
          return {
            socketPath: join(root, 'daemon.sock'),
            owner: { pid: process.pid, generation: 1 },
            close: async () => {
              state.events.push('close')
            },
          } as never
        },
        publishDiscovery: async () => {
          if (mode === 'discovery') throw failure
          return undefined as never // runAgnesd does not consume the publication result.
        },
        removeDiscovery: async () => {},
      },
    )
    if (mode === 'normal') {
      await starting
      await closeDaemon()
      await closeDaemon()
    } else await expect(starting).rejects.toBe(failure)
    expect(state.events).toEqual(mode === 'startup' ? ['flush'] : ['close', 'flush'])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
