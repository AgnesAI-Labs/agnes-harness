import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
import { expect, it } from 'vitest'
import { createConfigurationService } from '../src/configuration.js'
import { createTestHost, runOnce } from '../testkit/index.js'

it('binds real model calls to account credentials and preserves a running Host after default changes', async () => {
  const entry = getApiKeyProvider('deepseek')
  if (!entry) throw new Error('provider unavailable')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('model unavailable')
  const calls: string[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: model }] }))
      return
    }
    for await (const _chunk of req) {
      /* drain the real model request */
    }
    const account =
      req.headers.authorization === 'Bearer work-key'
        ? 'work'
        : req.headers.authorization === 'Bearer personal-key'
          ? 'personal'
          : 'invalid'
    calls.push(account)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: { content: account }, finish_reason: null }],
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const root = await mkdtemp(join(tmpdir(), 'agnes-account-runtime-'))
  const hosts: Awaited<ReturnType<typeof createTestHost>>[] = []
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    // Let the service create its private home; mkdtemp is only the test cleanup container.
    const service = createConfigurationService({ home: join(root, 'home'), profile: 'local-dev' })
    await service.save({
      accountId: 'work',
      providerId: 'deepseek',
      baseUrl,
      apiKey: 'work-key',
      model,
      expectedRevision: 0,
    })
    await service.save({
      accountId: 'personal',
      providerId: 'deepseek',
      baseUrl,
      apiKey: 'personal-key',
      model,
      expectedRevision: 1,
    })
    const old = await createTestHost({
      dataDir: join(root, 'old'),
      disableSessionTitle: true,
      profileInputs: { user: { ...(await service.profileInput()), name: 'multi-test' } },
    })
    hosts.push(old)
    await service.account({ accountId: 'personal', action: 'default', expectedRevision: 2 })
    const next = await createTestHost({
      dataDir: join(root, 'new'),
      disableSessionTitle: true,
      profileInputs: { user: { ...(await service.profileInput()), name: 'multi-test' } },
    })
    hosts.push(next)
    expect((await runOnce(old.host, { cwd: join(root, 'old'), prompt: 'Identify account' })).finalText).toBe(
      'work',
    )
    expect((await runOnce(next.host, { cwd: join(root, 'new'), prompt: 'Identify account' })).finalText).toBe(
      'personal',
    )
    expect(calls).toEqual(['work', 'personal'])
  } finally {
    for (const host of hosts) await host.host.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
