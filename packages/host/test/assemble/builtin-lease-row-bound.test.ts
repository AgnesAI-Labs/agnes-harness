import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { scratch } from './plugin-extension-fixture.js'

const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}

const callTool = (name: string, args: Record<string, string>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]
const say = (text: string): InferenceEvent[] => [{ type: 'text_delta', delta: text }]

describe('the writer lease setting does not reach builtin extension rows', () => {
  it('runs a builtin tool after the configured writer lease has elapsed since startup', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      packageDirs,
      limits: { 'lease.ttl_ms': 1000 },
      script: [callTool('ls', { path: realpathSync.native(dataDir) }), say('done')],
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const session = await host.createSession({ cwd: dataDir })
      // The kernel's writer lease still takes the configured value.
      const remaining = session.d.log.leaseRemainingMs()
      expect(remaining).toBeGreaterThan(0)
      expect(remaining).toBeLessThanOrEqual(1000)
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'list the directory' }],
      })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const results = JSON.stringify(
        (await session.scan({ type: 'tool/result', toSeq: session.lastSeq })).map((r) => r.data),
      )
      const all = JSON.stringify((await session.scan({ toSeq: session.lastSeq })).map((r) => r.data))
      await session.close()
      expect(results).toContain('"isError":false')
      expect(all).not.toContain('E_LEASE_EXPIRED')
    } finally {
      await host.close()
    }
  }, 15_000)

  it('leaves the writer lease at its default when the setting is absent', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({ dataDir, packageDirs, script: [say('done')] })
    try {
      const session = await host.createSession({ cwd: dataDir })
      expect(session.d.log.leaseRemainingMs()).toBeGreaterThan(1000)
      await session.close()
    } finally {
      await host.close()
    }
  })
})
