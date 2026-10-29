import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const say = (): InferenceEvent[] => [
  { type: 'text_delta', delta: 'Noted.' },
  { type: 'done', reason: 'stop' },
]

it('reads built-in projections from where the previous turn left them, however long the ledger is', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-projection-reads-')))
  dirs.push(dataDir)
  vi.stubEnv('AGH_HOME', dataDir)
  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1' })],
    scripts: [say, say, say],
    onExhausted: 'error',
  })
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    disableSessionTitle: true,
    provider,
  })
  try {
    const session = await host.createSession({ cwd: dataDir })
    for (let n = 0; n < 600; n++)
      await session.appendExtensionEvent(
        'x/fixture/projection-reads/note',
        { n },
        { source: 'fixture/projection-reads', trust: 'trusted' },
      )
    const scan = session.scan.bind(session)
    let rows = 0
    session.scan = async (query) => {
      const page = await scan(query)
      rows += page.length
      return page
    }
    const turn = async () => {
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Note this.' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      rows = 0
      const ledger = session.lastSeq
      expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'completed',
      })
      return { rows, ledger }
    }
    const first = await turn()
    const second = await turn()
    const third = await turn()
    // The first turn folds the whole ledger for each built-in projection it reads. Later turns read
    // only what was written since their previous read, a small part of the ledger.
    expect(first.rows).toBeGreaterThan(first.ledger)
    for (const later of [second, third]) expect(later.rows).toBeLessThan(later.ledger / 4)
    // The time context still sees the turn that ended before each later turn.
    const requests = provider.calls.map((request) => JSON.stringify(request))
    expect(requests[0]).toContain('unavailable (first turn)')
    for (const request of requests.slice(1)) expect(request).toMatch(/preceding turn ended: \d+ seconds/)
  } finally {
    await host.close()
  }
})
