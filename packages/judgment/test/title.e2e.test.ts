import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { CALLER, judgmentDaemon, MODEL, PACKAGE, PROFILE } from './helpers/daemon.js'

async function titleModel() {
  const sockets = new Set<Socket>()
  const titles: Array<{ body: unknown; at: number }> = []
  let nextTitle = 'Synthetic garden planning'
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'main-1' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages?: Array<{ role: string; content: unknown }>
    }
    const isTitle = body.messages?.some(
      (m) =>
        ['system', 'developer'].includes(m.role) &&
        JSON.stringify(m.content).includes('First select the title language'),
    )
    const text = isTitle ? JSON.stringify({ language: 'en', title: nextTitle }) : 'Synthetic work complete.'
    if (isTitle) {
      titles.push({ body, at: Date.now() })
      await gate
    }
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = { id: 'synthetic-title', object: 'chat.completion.chunk', created: 0, model: 'main-1' }
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback model did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    titles,
    setTitle(value: string) {
      nextTitle = value
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    release() {
      release?.()
      gate = undefined
      release = undefined
    },
    async close() {
      release?.()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it('refreshes an installed automatic title in the background and preserves an explicit SDK name', async () => {
  const model = await titleModel()
  const fixture = await judgmentDaemon({ modelServerUrl: model.url }).catch(async (error) => {
    await model.close()
    throw error
  })
  const config = {
    judge: { route: 'jev-a', model: MODEL },
    uses: { title: { enabled: true, refreshAfterPrompts: 1 } },
  }
  try {
    await fixture.configure(config)
    const session = await fixture.session('title-live')
    const metadata = async (target = session) =>
      (await fixture.sdk.session.list()).items.find((row) => row.sessionId === target.id)
    await fixture.turn(session, 'Plan a synthetic garden layout.')
    await vi.waitFor(async () => expect((await metadata())?.title).toBe('Synthetic garden planning'), {
      timeout: 10_000,
    })
    const initialTitleCalls = model.titles.length
    fixture.respond({ delayMs: 4_000 }, 0.1)
    model.setTitle('Synthetic lunar navigation')
    const second = await fixture.turn(session, 'Switch tasks to synthetic lunar navigation.')
    expect(second.result.reason).toBe('completed')
    await vi.waitFor(() => expect(fixture.fake.seen.length).toBe(1), { timeout: 5_000 })
    const pendingJudge = fixture.fake.seen[0]
    if (!pendingJudge) throw new Error('background judgment did not start')
    expect(Date.now()).toBeLessThan(pendingJudge.at + 4_000)
    expect(model.titles).toHaveLength(initialTitleCalls)
    await fixture.turn(session, 'Include the newest-lunar-detail in this navigation task.')
    await vi.waitFor(async () => expect((await metadata())?.title).toBe('Synthetic lunar navigation'), {
      timeout: 12_000,
    })
    expect(JSON.stringify(model.titles.at(-1)?.body)).toContain('newest-lunar-detail')
    expect(fixture.fake.seen).toHaveLength(1)
    const usage = await session.projectUI()
    expect(
      usage.nodes.some(
        (node) => node.kind === 'cost' && node.caller === CALLER && node.label === 'judgment.title',
      ),
    ).toBe(true)
    expect(usage.nodes.some((node) => node.kind === 'cost' && node.purpose === 'title')).toBe(true)

    fixture.respond({}, 0.1)
    model.hold()
    model.setTitle('This automatic candidate must stay hidden')
    await fixture.turn(session, 'Change the synthetic task to underwater maps.')
    await vi.waitFor(() => expect(model.titles.length).toBe(initialTitleCalls + 2), { timeout: 8_000 })
    await fixture.sdk.session.rename(session.id, 'My explicit task name')
    model.release()
    await vi.waitFor(async () =>
      expect(await metadata()).toMatchObject({ title: 'My explicit task name', titleSource: 'user' }),
    )
    // A later genuine turn still cannot start another automatic-title request.
    const count = model.titles.length
    await fixture.turn(session, 'Now work on a synthetic weather simulation.')
    expect((await metadata())?.title).toBe('My explicit task name')
    expect(model.titles).toHaveLength(count)
    model.setTitle('Synthetic revocation baseline')
    const revoked = await fixture.session('title-revoked')
    await fixture.turn(revoked, 'Plan a synthetic lake survey.')
    await vi.waitFor(
      async () => expect((await metadata(revoked))?.title).toBe('Synthetic revocation baseline'),
      { timeout: 10_000 },
    )
    const beforeRevocation = model.titles.length
    model.hold()
    model.setTitle('Must not publish after package disable')
    await fixture.turn(revoked, 'Switch to a synthetic forest inventory.')
    await vi.waitFor(() => expect(model.titles.length).toBe(beforeRevocation + 1), { timeout: 8_000 })
    const common = { profile: PROFILE, clientId: await fixture.sdk.clientId(), id: PACKAGE }
    await fixture.operation(await fixture.sdk.packages.disable({ ...common, commandId: 'title-disable' }))
    model.release()
    await fixture.turn(revoked, 'Now plan a synthetic river inventory.')
    expect((await metadata(revoked))?.title).toBe('Synthetic revocation baseline')
    expect(model.titles).toHaveLength(beforeRevocation + 1)
  } finally {
    model.release()
    try {
      await fixture.close()
    } finally {
      await model.close()
    }
  }
}, 240_000)
