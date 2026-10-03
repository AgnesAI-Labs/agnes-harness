import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { modelFixture } from './model-fixture.js'
import { referenceModelFixture } from './reference-model-fixture.js'

async function server(journal: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/model-http.mjs', import.meta.url)), journal],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'C' } },
  )
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup deadline')), 10000)
    child.once('message', (message) => {
      clearTimeout(timer)
      resolve((message as { port: number }).port)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('Fixture startup exited'))
    })
  })
  return { child, url: `http://127.0.0.1:${port}/v1` }
}
async function shutdown(child: ChildProcess) {
  if (child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  await exited
}
it.each(['openai-completions', 'anthropic-messages'] as const)(
  'runs actual %s wire with a restricted source and durable response',
  async (api) => {
    const directory = mkdtempSync(join(tmpdir(), 'model-wire-')),
      requests = join(directory, 'requests.jsonl')
    const remote = await server(requests)
    try {
      const fixture = await modelFixture(api, remote.url, join(directory, 'receipt.json'))
      const result = await fixture.action.execute(fixture.frame, fixture.call)
      expect(result.outcome).toBe('succeeded')
      expect(validateRuntime('EffectResult', result).ok).toBe(true)
      expect(result.result?.kind).toBe('inline')
      if (result.result?.kind !== 'inline') throw new Error('Missing model result')
      const model = validateRuntime('ModelOutput', result.result.value)
      expect(model.ok).toBe(true)
      if (!model.ok) throw new Error('Invalid output')
      expect(model.value.actualModel).toBe('fixture-model')
      expect(model.value.providerReceipt?.kind).toBe('inline')
      if (model.value.outputRef.kind !== 'inline') throw new Error('Missing inline text')
      expect(JSON.stringify(model.value.outputRef.value)).toContain('actual wire answer')
      expect(result.usage).toHaveLength(1)
      expect(result.usage[0]?.certainty).toBe('measured')
      expect(fixture.sends()).toBe(1)
      const hit = JSON.parse(readFileSync(requests, 'utf8').trim()) as {
        input: { model: string; max_tokens?: number; max_completion_tokens?: number }
        credentialMatched: boolean
      }
      expect(hit.credentialMatched).toBe(true)
      expect(hit.input.model).toBe('fixture-model')
      expect(api === 'openai-completions' ? hit.input.max_completion_tokens : hit.input.max_tokens).toBe(32)
      fixture.revoke()
      const recovered = await fixture.action.reconcile(fixture.frame, [], fixture.call)
      expect(recovered.kind).toBe('resolved')
      expect(readFileSync(join(directory, 'receipt.json'), 'utf8')).toContain('fixture-response')
      await fixture.provider.close('shutdown')
    } finally {
      await shutdown(remote.child)
      rmSync(directory, { recursive: true, force: true })
    }
  },
  20000,
)

for (const scenario of [
  'send-refused',
  'load-revoked',
  'copied-context',
  'receipt-failed',
  'context-mutated-at-send',
] as const) {
  it(`keeps actual wire and durable boundaries for ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-boundary-'))
    const requests = join(directory, 'requests.jsonl'),
      receipt = join(directory, 'receipt.json')
    const remote = await server(requests)
    try {
      const fixture = await modelFixture('openai-completions', remote.url, receipt)
      if (scenario === 'send-refused') fixture.reject()
      if (scenario === 'load-revoked') fixture.revokeDuringLoad()
      if (scenario === 'receipt-failed') fixture.failSave()
      if (scenario === 'context-mutated-at-send') fixture.mutateAtSend()
      const call =
        scenario === 'copied-context' ? { ...fixture.call, call: { ...fixture.context } } : fixture.call
      const result = await fixture.action.execute(fixture.frame, call)
      expect(validateRuntime('EffectResult', result).ok).toBe(true)
      if (scenario === 'receipt-failed') {
        expect(result.outcome).toBe('unknown_effect')
        expect(result.error?.detailCode).toBe('model_receipt_unconfirmed')
        expect(result.externalRequests).toHaveLength(1)
        expect(result.result).toBeDefined()
        expect(fixture.sends()).toBe(1)
      } else {
        expect(result.outcome).toBe('failed')
        expect(result.externalRequests).toHaveLength(0)
        expect(fixture.sends()).toBe(scenario === 'context-mutated-at-send' ? 1 : 0)
        expect(existsSync(requests)).toBe(false)
      }
    } finally {
      await shutdown(remote.child)
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20000)
}

for (const implementation of ['default', 'reference'] as const) {
  it.each([301, 302, 307, 308])(
    `${implementation} refuses physical redirects to an unadmitted endpoint (%s)`,
    async (status) => {
      let admitted = 0,
        unauthorized = 0,
        leakedCredential = false
      const remote = createServer((request, response) => {
        request.resume()
        if (request.url === '/v1/chat/completions') {
          admitted++
          response.writeHead(status, { location: '/unadmitted' })
          response.end()
        } else {
          unauthorized++
          leakedCredential ||= !!request.headers.authorization
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(
            'data: {"choices":[{"delta":{"content":"redirected"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
          )
        }
      })
      await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
      const address = remote.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const directory = mkdtempSync(join(tmpdir(), 'model-redirect-'))
      try {
        const endpoint = `http://127.0.0.1:${address.port}/v1`,
          receipt = join(directory, 'receipt.json')
        const fixture =
          implementation === 'default'
            ? await modelFixture('openai-completions', endpoint, receipt)
            : await referenceModelFixture(endpoint, receipt)
        const result = await fixture.action.execute(fixture.frame, fixture.call)
        expect(admitted).toBe(1)
        expect(unauthorized).toBe(0)
        expect(leakedCredential).toBe(false)
        expect(result.outcome).toBe('unknown_effect')
        expect(result.usage).toHaveLength(1)
        expect(result.usage[0]?.certainty).toBe('unknown')
        expect(existsSync(receipt)).toBe(true)
        expect(fixture.sends()).toBe(1)
        await fixture.provider.close('shutdown')
      } finally {
        await new Promise<void>((resolve) => remote.close(() => resolve()))
        rmSync(directory, { recursive: true, force: true })
      }
    },
    20000,
  )
}
