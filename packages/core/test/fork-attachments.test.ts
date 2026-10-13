import type { ContentBlock, ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { UserAttachmentPort } from '../src/step/attachment-admission.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const CLOCK = 1_757_203_200_000
const SHA = 'a'.repeat(64)
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

const reference: ContentBlock = {
  type: 'file',
  mimeType: 'application/zip',
  name: 'a.zip',
  attachment: { sha256: SHA, bytes: 1000 },
} as ContentBlock

/** The host's rule: an upload receipt for this session, or a reference the session already holds. */
function port(receipts: ReadonlySet<string> = new Set()): UserAttachmentPort {
  return {
    storeByReference: true,
    isUserAttachment: async () => true,
    read: async () => new Uint8Array(),
    store: async () => {
      throw new Error('nothing inline is stored here')
    },
    authorize: async ({ sessionKey, referenced }) =>
      referenced || receipts.has(sessionKey) ? 'ok' : 'unauthorized',
  }
}

function kernel(storage: MemoryStorage, attachments: UserAttachmentPort) {
  const provider = fakeProvider([])
  Object.assign(provider, { models: () => [model()] })
  return Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => CLOCK,
    attachments,
  })
}

const text = (t: string) => ({
  actor,
  origin: 'principal' as const,
  trust: 'trusted' as const,
  type: 'user/message' as const,
  data: { content: [{ type: 'text' as const, text: t }] },
})

/** A parent whose seq 10 is a user message holding a file reference; its history runs to seq 13. */
async function parentWithReference(k: Kernel) {
  const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'p' })
  while (parent.lastSeq < 9) await parent.append([text(`before ${parent.lastSeq}`)])
  await parent.append([{ ...text('with a file'), data: { content: [reference] } }])
  expect(parent.lastSeq).toBe(10)
  while (parent.lastSeq < 13) await parent.append([text(`after ${parent.lastSeq}`)])
  return parent
}

const send = (session: Awaited<ReturnType<Kernel['session']>>) =>
  session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'again' }, reference] })

describe('a forked session and the attachments of its ancestry', () => {
  it('may send a reference its parent already held before the fork point', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const k = kernel(storage, port())
    await parentWithReference(k)
    const child = await k.session('child-12', {
      ...sessionOpts,
      writerRunId: 'c12',
      parent: { key: 'parent', boundarySeq: 12 },
    })
    expect(child.attachmentIndex.referenced(SHA)).toBe(true)
    await expect(send(child)).resolves.toBeGreaterThan(12)
    await k.close()

    // Opened again later, cold, the child still finds the reference in its ancestry.
    const again = kernel(storage, port())
    const reopened = await again.session('child-12', { ...sessionOpts, writerRunId: 'c12b' })
    expect(reopened.d.log.parent).toEqual({ key: 'parent', boundarySeq: 12 })
    await expect(send(reopened)).resolves.toBeGreaterThan(12)
    await again.close()
  })

  it('may not send a reference its parent only held after the fork point, without an upload of its own', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const k = kernel(storage, port())
    await parentWithReference(k)
    const child = await k.session('child-8', {
      ...sessionOpts,
      writerRunId: 'c8',
      parent: { key: 'parent', boundarySeq: 8 },
    })
    expect(child.attachmentIndex.referenced(SHA)).toBe(false)
    const before = child.lastSeq
    await expect(send(child)).rejects.toMatchObject({
      code: 'E_ENVELOPE',
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
    expect(child.lastSeq).toBe(before)
    await k.close()

    // With an upload receipt of its own the same reference is accepted.
    const uploaded = kernel(storage, port(new Set(['child-8'])))
    const reopened = await uploaded.session('child-8', { ...sessionOpts, writerRunId: 'c8b' })
    await expect(send(reopened)).resolves.toBeGreaterThan(8)
    await uploaded.close()
  })
})
