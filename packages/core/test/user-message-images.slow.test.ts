import type { ModelRecord } from '@agnes/protocol'
import { USER_IMAGE_SEND_BUDGET } from '@agnes/protocol-validation'
import { expect, it } from 'vitest'
import { fakeProvider } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const model: ModelRecord = {
  id: 'default',
  route: 'default',
  name: 'Image model',
  api: 'openai-completions',
  baseUrl: 'https://test.invalid',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}

// Images of 16 MiB each (the most one message may carry): queued one after another, the backlog
// passes the transport frame bound after a few of them, so this test has to build and validate well
// over 100 MiB of image data, which takes seconds on a hosted runner.
it('refuses image backlog overflow before replacing the durable inbox', { timeout: 60_000 }, async () => {
  const provider = fakeProvider([])
  provider.models = () => [model]
  const { session, log } = await openSession({ provider })
  const bytes = Buffer.alloc(USER_IMAGE_SEND_BUDGET.maxBytesPerImage)
  bytes.set([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
  ])
  bytes.set([0xff, 0xd9], bytes.length - 2)
  const content = [{ type: 'image' as const, mimeType: 'image/jpeg', data: bytes.toString('base64') }]
  let queued = 0
  let refusal: unknown
  while (refusal === undefined && queued < 20)
    await session.enqueue('next-turn', { content, actor }).then(
      () => queued++,
      (error: unknown) => {
        refusal = error
      },
    )
  expect(refusal).toMatchObject({
    code: 'E_ENVELOPE',
    message: expect.stringContaining('Queued inputs are too large'),
  })
  expect(queued).toBeGreaterThan(1)
  expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(queued)
  expect(await log.scan({ type: 'inbox', limit: 50 })).toHaveLength(queued)
})
