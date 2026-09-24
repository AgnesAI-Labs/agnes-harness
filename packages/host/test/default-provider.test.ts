import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLoopbackOnly, fakeModel, installLoopbackOnly, restoreLoopbackOnly } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import { createTestHost, runOnce } from '../testkit/index.js'

it('omitted provider uses production assembly, credentials, wire, tools and default pricing', async () => {
  installLoopbackOnly()
  const dirs: string[] = []
  const requests: Array<{
    model: string
    messages: unknown[]
    tools: Array<{ function: { name: string } }>
  }> = []
  let authorized = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number]
    requests.push(body)
    if (req.headers.authorization === 'Bearer synthetic-default-provider') authorized++
    const tool = requests.length % 2 === 1
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'read-probe',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"probe.txt"}' },
            },
          ],
        }
      : {
          content: JSON.stringify(body.messages).includes('actual-workspace-result')
            ? 'verified actual read'
            : 'missing tool result',
        }
    const event = {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing loopback port')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    for (const creditsPerUsd of [undefined, 7]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'agnes-real-provider-'))
      dirs.push(dataDir)
      writeFileSync(join(dataDir, 'probe.txt'), 'actual-workspace-result')
      const secrets = join(dataDir, 'credentials')
      createPrivateDirectorySync(secrets)
      createPrivateDirectorySync(join(secrets, 'test'))
      const credential = createPrivateFileSync(join(secrets, 'test', 'wire'))
      try {
        writeFileSync(credential, 'synthetic-default-provider')
      } finally {
        closeSync(credential)
      }
      const model = fakeModel({
        id: 'fixture',
        route: 'wire',
        api: 'openai-completions',
        baseUrl,
        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
      })
      const t = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
        packages: { '@agnes/code': { operations: codeOperations } },
        // Neither provider nor script is present: this must traverse buildProvider and PiAdapter.
        profileInputs: {
          user: {
            name: 'real-provider',
            provider: {
              package: '@agnes/ai',
              adapters: ['@agnes/ai'],
              routes: [
                {
                  route: 'wire',
                  api: 'openai-completions',
                  baseUrl,
                  credentialRef: 'secret://test/wire',
                  models: [model],
                },
              ],
            },
            adapters: { secrets: { kind: 'file', path: secrets } },
            ...(creditsPerUsd === undefined ? {} : { limits: { 'cost.credits_per_usd': creditsPerUsd } }),
          },
        },
      })
      try {
        const result = await runOnce(t.host, {
          cwd: dataDir,
          prompt: 'Read probe.txt and confirm its contents.',
        })
        expect(result.reason).toBe('completed')
        expect(result.toolCalls).toEqual(['read'])
        expect(result.finalText).toBe('verified actual read')
        const rows = result.events.filter((e) => e.type === 'cost/ledger')
        expect(rows).toHaveLength(2)
        for (const row of rows)
          expect(row.data).toMatchObject({ credits: 2 * (creditsPerUsd ?? 1), creditSource: 'estimated' })
      } finally {
        await t.host.close()
      }
    }
    expect(requests).toHaveLength(4)
    expect(authorized).toBe(4)
    for (const request of requests) {
      expect(request.model).toBe('fixture')
      expect(request.tools.map((tool) => tool.function.name)).toContain('read')
    }
    assertLoopbackOnly()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    restoreLoopbackOnly()
  }
})
