import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { runAgnesd } from '../src/supervisor/supervisor.js'

const state = vi.hoisted(() => ({
  close: undefined as (() => Promise<void>) | undefined,
  file: undefined as string | undefined,
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
      if (args[0].endsWith('daemon.jsonl')) state.file = args[0]
      return actual.createFileAudit(...args)
    },
  }
})

it('writes the record of a target that was put back to the daemon audit file, and nothing else', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'agnes-audit-revert-'))
  const root = join(temporary, 'home')
  createPrivateDirectorySync(root)
  let audit: ((record: unknown) => void) | undefined
  try {
    await runAgnesd(
      { profile: 'local-dev', home: root, workspace: root },
      {
        startProduction: async (options: { audit?: (record: unknown) => void }) => {
          audit = options.audit
          return {
            socketPath: join(root, 'daemon.sock'),
            owner: { pid: process.pid, generation: 1 },
            close: async () => {},
          } as never
        },
        publishDiscovery: async () => undefined as never,
        removeDiscovery: async () => {},
      },
    )
    audit?.({
      kind: 'plugin.tree.reverted',
      detail: { digest: 'd1', level: 'previous', packages: ['pkg-b'] },
    })
    audit?.({ kind: 'worker.log', message: 'not for this file' })
    const file = state.file
    if (!file) throw new Error('audit file was not created')
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual(['plugin.tree.reverted'])
    expect(JSON.parse(lines[0] ?? '{}').detail).toMatchObject({ level: 'previous', packages: ['pkg-b'] })
    await state.close?.()
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
