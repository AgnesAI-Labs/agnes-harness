import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { createClient } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { MemorySessionPrincipalOwnership } from '../src/storage/session-ownership.js'
import { testWorkspaceCatalog } from './host.js'

it('returns identical usage through SDK full/patch/opening/history and a reopened SQLite host', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-usage-rpc-'))
  const first = await createTestHost({
    dataDir,
    script: [
      [
        { type: 'text_delta', delta: 'usage evidence' },
        {
          type: 'usage',
          tokens: { input: 120, output: 50, cacheRead: 600, cacheWrite: 0, reasoning: 20 },
          credits: 0.125,
          creditSource: 'estimated',
          billing: { usdMicros: 125, source: 'estimated', subscription: false },
          timing: { ttftMs: 90, durationMs: 1200 },
        },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  const ownership = new MemorySessionPrincipalOwnership()
  const workspaces = await testWorkspaceCatalog(dataDir)
  const connect = (host: typeof first.host) =>
    createClient({
      transport: {
        kind: 'inproc',
        endpoint: createLocalEndpoint(host, { pollMs: 5, sessionOwnership: ownership, workspaces }),
      },
    })
  const client = connect(first.host)
  try {
    const session = await client.session.new({ cwd: dataDir })
    const before = await session.projectUI()
    await session.prompt([{ type: 'text', text: 'hello' }])
    const web = await session.projectUI(undefined, { surface: 'web' })
    const cli = await session.projectUI(undefined, { surface: 'tui' })
    expect(web.usage).toEqual(cli.usage)
    expect(web.usage).toMatchObject({
      totals: { input: 120, output: 50, cacheRead: 600, reasoning: 20 },
      credits: { amount: 0.125, complete: true, source: 'estimated' },
      reasoningComplete: true,
      billingComplete: true,
      context: { source: 'estimated' },
      cost: { usdMicros: 125 },
    })
    const cost = web.nodes.find((node) => node.kind === 'cost')
    expect(cost).toMatchObject({
      timing: { ttftMs: 90, durationMs: 1200 },
      tokens: { input: 120, output: 50 },
      billing: { usdMicros: 125 },
    })
    const update = await session.projectUIPatch(before.upto)
    expect(update.kind === 'patch' ? update.patch.usage : update.timeline.usage).toEqual(web.usage)
    const opening = await session.projectUIOpening({ maxNodes: 1, surface: 'web' })
    expect(opening.timeline.usage).toEqual(web.usage)
    const history = [...opening.timeline.nodes]
    let cursor = opening.history.hasEarlier ? opening.history.cursor : undefined
    let pages = 0
    while (cursor) {
      const page = await session.projectUIHistory(cursor, { limit: 1 })
      history.push(...page.nodes)
      cursor = page.hasEarlier ? page.cursor : undefined
      pages++
    }
    expect(pages).toBeGreaterThan(0)
    expect(history.map((node) => node.id).sort()).toEqual(web.nodes.map((node) => node.id).sort())
    expect(history.find((node) => node.id === cost?.id)).toEqual(cost)
    await client.close()
    await first.host.close()
    const reopened = await createTestHost({ dataDir, script: [] })
    const otherClient = connect(reopened.host)
    try {
      const loaded = await otherClient.session.load(session.id, { cwd: dataDir })
      const restored = await loaded.projectUI()
      expect(restored.usage).toEqual(web.usage)
      expect(restored.nodes.find((node) => node.id === cost?.id)).toEqual(cost)
    } finally {
      await otherClient.close()
      await reopened.host.close()
    }
  } finally {
    await client.close()
    await first.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
