import { toAcpPrompt, UI_PROJECTION_MAX_BYTES, type UITimeline } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { openTestHost } from './host.js'

it('saves a 100 MiB attachment and restores its exact bytes in a bounded Web history opening', async () => {
  const h = await openTestHost()
  const ep = h.endpoint()
  const draining = (async () => {
    for await (const _ of ep.notifications) {
      /* drain */
    }
  })()
  try {
    await ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
    })
    const created = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const sessionId = created.result.sessionId
    const content = [
      {
        type: 'file' as const,
        name: 'large.bin',
        mimeType: 'application/octet-stream',
        data: Buffer.alloc(100 * 1024 * 1024).toString('base64'),
      },
    ]
    const saved = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: toAcpPrompt(content) },
    })
    expect(saved).toMatchObject({ result: { stopReason: 'end_turn' } })
    const opening = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId, surface: 'web', maxBytes: UI_PROJECTION_MAX_BYTES },
    })) as { result: { timeline: UITimeline } }
    const user = opening.result.timeline.nodes.find((node) => node.kind === 'user')
    expect(user).toMatchObject({ kind: 'user', content })
  } finally {
    await ep.close()
    await draining
    await h.close()
  }
}, 60000)
