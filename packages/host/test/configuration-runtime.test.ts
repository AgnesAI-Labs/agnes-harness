import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
import { expect, it } from 'vitest'
import { createConfigurationService } from '../src/configuration.js'
import { createTestHost, runOnce } from '../testkit/index.js'

it('assembles and streams an external custom model without inventing an unloaded parser contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-custom-runtime-'))
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/model/info') {
      expect(req.method).toBe('GET')
      expect(req.headers.authorization).toBe('Bearer custom-test')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              model_name: 'external-manual-model',
              model_info: {
                input_cost_per_token: 3e-7,
                output_cost_per_token: 1.2e-6,
                cache_read_input_token_cost: 6e-9,
                cache_creation_input_token_cost: 0,
              },
            },
          ],
        }),
      )
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    expect(req.url).toBe('/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer custom-test')
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
      return
    }
    const chunk = { id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: request.model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: 'custom model works' }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined
  try {
    const service = createConfigurationService({ home: join(root, 'home'), profile: 'local-dev' })
    await service.save({
      providerId: 'custom-openai',
      model: 'external-manual-model',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'custom-test',
      custom: {
        api: 'openai-completions',
        contextWindow: 32768,
        maxTokens: 1024,
        input: ['text'],
        reasoning: false,
        toolCalls: true,
        maxTokensField: 'max_tokens',
      },
    })
    const input = await service.profileInput()
    expect(input.provider?.routes?.[0]?.models?.[0]).toMatchObject({
      contract_id: null,
      toolCallFormats: ['native'],
      // HTTP fixture metadata cannot attest an HTTPS price source; inference remains usable.
      pricePolicy: { perMillion: { inputUncached: null, output: null } },
    })
    host = await createTestHost({
      dataDir: join(root, 'runtime'),
      disableSessionTitle: true,
      profileInputs: { user: { ...input, name: 'custom-test' } },
    })
    expect(
      (await runOnce(host.host, { cwd: join(root, 'runtime'), prompt: 'Synthetic custom runtime test' }))
        .finalText,
    ).toBe('custom model works')
  } finally {
    await host?.host.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

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
