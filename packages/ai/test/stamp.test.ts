import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InferenceEvent } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { sha256Hex } from '../src/hash.js'
import {
  buildStamp,
  createProvider,
  loadContractStore,
  NullContractStore,
  PiAdapter,
  renderPrefixedPrompt,
} from '../src/index.js'
import { FakeAdapter, fakeModel, fakeRequest } from '../testkit/index.js'
import { assertLoopbackOnly, installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

const ID = 'agnes-model-contract@0'
const store = loadContractStore({
  dir: fileURLToPath(new URL('../fixtures/contract/', import.meta.url)),
  contractIds: [ID],
})
function signedBomStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ai19-bom-'))
  cpSync(new URL('../fixtures/contract/', import.meta.url), dir, { recursive: true })
  const file = join(dir, ID, 'prefix.bin')
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(file)])
  writeFileSync(file, bytes)
  const manifestFile = join(dir, ID, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { sha256: { prefix: string } }
  manifest.sha256.prefix = sha256Hex(bytes)
  writeFileSync(manifestFile, JSON.stringify(manifest))
  return {
    store: loadContractStore({ dir, contractIds: [ID] }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
const run = { signal: new AbortController().signal, toolNames: [] }
async function collect(events: AsyncIterable<InferenceEvent>) {
  const result: InferenceEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

it('snapshots minimal-rl empty sections with the actual prefix bytes and one separator', () => {
  const req = fakeRequest({ contractId: ID, system: '' })
  expect(renderPrefixedPrompt(req, store)).toEqual(
    new Uint8Array(
      readFileSync(new URL('../fixtures/contract/snapshots/minimal-rl.prompt.bin', import.meta.url)),
    ),
  )
  expect(
    new TextDecoder().decode(renderPrefixedPrompt(fakeRequest({ system: 'é' }), new NullContractStore())),
  ).toBe('é')
})

it('uses an adapter report and honestly identifies absent evidence', async () => {
  const report = { sentHash: 'f'.repeat(64), transforms: [{ event: 'compat', ext: 'fake' }] }
  const adapter = new FakeAdapter({
    id: 'f',
    routes: [{ route: 'r', api: 'openai-completions', baseUrl: 'https://fake.invalid' }],
    models: { r: [fakeModel({ route: 'r', id: 'm' })] },
    reportSent: report,
  })
  const provider = createProvider({
    adapters: [adapter],
    routes: { primary: { route: 'r', model: 'm' } },
    contract: store,
    secrets: () => '',
    clock: () => 0,
  })
  const req = fakeRequest({ route: 'r', model: 'm' })
  expect((await collect(provider.infer(req, run)))[0]).toMatchObject({
    type: 'sent',
    stamp: { sent_hash: report.sentHash, transforms: report.transforms },
  })
  expect(buildStamp(req, store, '1', undefined)).toMatchObject({
    sent_hash: req.derivedHash,
    transforms: [{ event: 'sent_hash', ext: 'unreported' }],
  })
})

it.each([false, true])('hashes actual Pi HTTP bytes and preserves prefix (BOM=%s)', async (bom) => {
  const signed = signedBomStore()
  const store = bom
    ? signed.store
    : loadContractStore({
        dir: fileURLToPath(new URL('../fixtures/contract/', import.meta.url)),
        contractIds: [ID],
      })
  installLoopbackOnly()
  const bodies: Buffer[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    bodies.push(Buffer.concat(chunks))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing port')
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`
    const adapter = new PiAdapter({
      manualRoutes: [
        {
          route: 'r',
          api: 'openai-completions',
          baseUrl,
          credentialRef: 'test-marker',
          models: [
            fakeModel({
              route: 'r',
              id: 'm',
              baseUrl,
              contract_id: ID,
              thinkingReplay: 'drop',
              compat: { supportsDeveloperRole: false },
            }),
            fakeModel({ route: 'r', id: 'plain', baseUrl }),
          ],
        },
      ],
      maxRetries: 0,
    })
    const provider = createProvider({
      adapters: [adapter],
      routes: { primary: { route: 'r', model: 'm' } },
      contract: store,
      secrets: () => 'secret-marker-not-in-stamp',
      clock: () => 0,
    })
    const req = Object.freeze(
      fakeRequest({
        route: 'r',
        model: 'm',
        contractId: ID,
        system: 'Unicode é\n',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'private-thought-marker' },
              { type: 'text', text: 'history' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      }),
    )
    const events = await collect(provider.infer(req, run))
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
    expect(bodies).toHaveLength(1)
    const firstBody = bodies[0]
    if (!firstBody) throw new Error('missing body')
    expect(events[0]).toMatchObject({
      type: 'sent',
      stamp: {
        sent_hash: sha256Hex(firstBody),
        derived_hash: req.derivedHash,
        prompt_prefix_hash: store.prefixHash(ID),
        transforms: [
          { event: 'thinking_replay', ext: 'pi' },
          { event: 'compat', ext: 'pi' },
        ],
      },
    })
    const wire = JSON.parse(firstBody.toString()) as { messages: Array<{ content: string }> }
    expect(wire.messages[0]?.content).toBe(
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(renderPrefixedPrompt(req, store)),
    )
    expect(wire.messages[0]?.content.startsWith('\ufeff')).toBe(bom)
    expect(firstBody.toString()).not.toContain('private-thought-marker')
    expect(JSON.stringify(events[0])).not.toContain('secret-marker')
    expect(req.system).toBe('Unicode é\n')
    expect(await collect(provider.infer({ ...req, contractId: null }, run))).toEqual([
      expect.objectContaining({ type: 'error', code: 'CONTRACT_MISMATCH' }),
    ])
    expect(bodies).toHaveLength(1)
    const plain = fakeRequest({ route: 'r', model: 'plain', system: '\ufeffdefault system' })
    const defaultEvents = await collect(provider.infer(plain, run))
    const secondBody = bodies[1]
    if (!secondBody) throw new Error('missing default body')
    expect(defaultEvents[0]).toMatchObject({
      type: 'sent',
      stamp: { sent_hash: sha256Hex(secondBody), transforms: [], prompt_prefix_hash: null },
    })
    expect(
      (JSON.parse(secondBody.toString()) as { messages: Array<{ content: string }> }).messages[0]?.content,
    ).toBe('\ufeffdefault system')
    assertLoopbackOnly()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    restoreLoopbackOnly()
    signed.cleanup()
  }
})

it('rejects an unavailable named contract before stream and counts the same prefixed request', async () => {
  class Counting extends FakeAdapter {
    countedSystem: string | undefined
    override async count(_route: string, req: ReturnType<typeof fakeRequest>) {
      this.countedSystem = req.system
      return { source: 'provider' as const, tokens: 4, boundHash: req.derivedHash }
    }
  }
  const signed = signedBomStore()
  const store = signed.store
  const adapter = new Counting({
    id: 'f',
    routes: [{ route: 'r', api: 'openai-completions', baseUrl: 'https://fake.invalid' }],
    models: {
      r: [
        fakeModel({ route: 'r', id: 'm', contract_id: ID }),
        fakeModel({ route: 'r', id: 'missing', contract_id: 'absent' }),
      ],
    },
  })
  const p = createProvider({
    adapters: [
      adapter,
      new FakeAdapter({
        id: 'uncountable',
        routes: [{ route: 'z', api: 'openai-completions', baseUrl: 'https://fake.invalid' }],
        models: { z: [fakeModel({ route: 'z', id: 'm' })] },
      }),
    ],
    routes: { primary: { route: 'r', model: 'm' } },
    contract: store,
    secrets: () => '',
    clock: () => 0,
  })
  const req = fakeRequest({ route: 'r', model: 'm', contractId: ID, system: 'count me' })
  await p.count?.(req, run)
  expect(adapter.countedSystem).toBe(
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(renderPrefixedPrompt(req, store)),
  )
  await expect(p.count?.({ ...req, contractId: null }, run)).rejects.toMatchObject({
    code: 'CONTRACT_MISMATCH',
  })
  expect(await collect(p.infer({ ...req, model: 'missing', contractId: 'absent' }, run))).toEqual([
    expect.objectContaining({ type: 'error', code: 'CONTRACT_MISMATCH' }),
  ])
  await expect(p.count?.({ ...req, route: 'z' }, run)).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' })
  expect(await p.count?.({ ...req, route: 'z', contractId: null }, run)).toEqual({ source: 'unsupported' })
  expect(adapter.calls).toEqual([])
  expect(adapter.countedSystem?.startsWith('\ufeff')).toBe(true)
  signed.cleanup()
})

it.each(['empty', 'throw'] as const)(
  'emits an explicit unreported stamp before %s transport failure',
  async (mode) => {
    const adapter = new FakeAdapter({
      id: 'f',
      routes: [{ route: 'r', api: 'openai-completions', baseUrl: 'https://fake.invalid' }],
      models: { r: [fakeModel({ route: 'r', id: 'm' })] },
      script: () => {
        if (mode === 'throw') throw new Error('private-secret')
        return []
      },
    })
    const p = createProvider({
      adapters: [adapter],
      routes: { primary: { route: 'r', model: 'm' } },
      contract: store,
      secrets: () => '',
      clock: () => 0,
    })
    const events = await collect(p.infer(fakeRequest({ route: 'r', model: 'm' }), run))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'sent',
      stamp: { transforms: [{ event: 'sent_hash', ext: 'unreported' }] },
    })
    expect(events[1]).toMatchObject({ type: 'error', code: 'TRANSPORT' })
    expect(JSON.stringify(events)).not.toContain('private-secret')
  },
)
