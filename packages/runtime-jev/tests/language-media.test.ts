import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ArtifactRef, LanguageInput, RuntimeRecord } from '@agnes/jev-runtime'
import type { ModelRecord, RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createLanguageBackend, type LanguageHost } from '../src/language.js'

const bytes = readFileSync(new URL('../../../docs/assets/readme/banner.png', import.meta.url))
const artifact: ArtifactRef = {
  id: 'immutable-image',
  digest: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
  mediaType: 'image/png',
}
const imageModel: ModelRecord = {
  id: 'image',
  name: 'image',
  api: 'openai-completions',
  route: 'test',
  baseUrl: 'https://image.invalid',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
function input(ref = artifact, copies = 1): LanguageInput {
  // User-provided refs and directive additions are deliberately present beside the settled result.
  const records = [
    {
      version: 1,
      id: 'user',
      turn: 't',
      kind: 'input.admitted',
      input: { id: 'u', source: 'user', content: [{ kind: 'artifact', artifact: ref }] },
    },
    {
      version: 1,
      id: 'intent',
      turn: 't',
      kind: 'action.intended',
      decision: 'd',
      intent: {
        id: 'i',
        tool: 'read',
        toolRevision: '1',
        arguments: { path: 'picture.png' },
        effectClass: 'read_only',
        environmentEpoch: 'e',
      },
    },
    {
      version: 1,
      id: 'result',
      turn: 't',
      kind: 'action.settled',
      intentId: 'i',
      effect: 'none',
      observations: [],
      outcome: {
        kind: 'success',
        content: Array.from({ length: copies }, () => ({ kind: 'artifact', artifact: ref })),
        directive: {
          conclude: false,
          additions: [{ id: 'extra', source: 'tool', content: [{ kind: 'artifact', artifact: ref }] }],
        },
      },
    },
    {
      version: 1,
      id: 'extra',
      turn: 't',
      kind: 'input.admitted',
      input: { id: 'extra', source: 'tool', content: [{ kind: 'artifact', artifact: ref }] },
    },
  ] as unknown as RuntimeRecord[]
  return { purpose: 'answer', state: {}, tools: [], history: [], records, inputCursor: 'result' }
}
function host(overrides: Partial<LanguageHost> = {}): LanguageHost {
  return {
    provider: {
      models: () => [imageModel],
      async *infer() {
        yield { type: 'text_delta', delta: 'ok' }
        yield { type: 'done', reason: 'stop' }
      },
    },
    selection: () => ({ slot: 'primary', route: 'test', model: 'image', contractId: null }),
    sessionKey: 's',
    system: '',
    maxFormatRetries: 0,
    maxResponseBytes: 1024,
    hashRequest: (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    artifacts: { read: async () => bytes },
    ...overrides,
  }
}

describe('Jev settled tool image transport', () => {
  it('materializes real repository bytes only in settled tool evidence and persists the exact provider body', async () => {
    let sent: RequestBody | undefined
    const base = host()
    const backend = createLanguageBackend({
      ...base,
      provider: {
        models: () => [imageModel],
        async *infer(body, options) {
          sent = body
          yield* base.provider.infer(body, options)
        },
      },
    })
    const call = await backend.prepare(input(), new AbortController().signal)
    const body = (call.input as { request: RequestBody }).request
    const images = body.messages.flatMap((message) =>
      message.content.filter((block) => block.type === 'image'),
    )
    expect(images).toEqual([{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }])
    expect(JSON.stringify(body.messages)).toContain('unread_attachment')
    expect(body.system).not.toContain('immutable-image')
    expect(call.codec).toBe('agnes-language-v1')
    await backend.invoke(call, new AbortController().signal)
    expect(sent).toEqual(body)
    expect((call.input as { mediaRefs: unknown[] }).mediaRefs).toHaveLength(1)
  })

  it.each([
    ['missing', 'LANGUAGE_IMAGE_UNAVAILABLE'],
    ['digest', 'LANGUAGE_IMAGE_INTEGRITY'],
    ['size', 'LANGUAGE_IMAGE_INTEGRITY'],
    ['limit', 'LANGUAGE_IMAGE_LIMIT'],
    ['aggregate', 'LANGUAGE_IMAGE_LIMIT'],
    ['type', 'LANGUAGE_IMAGE_TYPE'],
  ] as const)('rejects %s evidence before calling the provider', async (kind, code) => {
    let calls = 0
    let reads = 0
    const ref = {
      ...artifact,
      ...(kind === 'digest' ? { digest: '0'.repeat(64) } : {}),
      ...(kind === 'size' ? { size: artifact.size + 1 } : {}),
      ...(kind === 'type' ? { mediaType: 'image/svg+xml' } : {}),
    }
    const backend = createLanguageBackend(
      host({
        maxImageRequestBytes: kind === 'limit' ? 1 : artifact.size + 1,
        artifacts: {
          read: async () => {
            reads++
            if (kind === 'missing') throw new Error('private path')
            return bytes
          },
        },
        provider: {
          models: () => [imageModel],
          async *infer() {
            calls++
            yield { type: 'done', reason: 'stop' }
          },
        },
      }),
    )
    await expect(
      backend.prepare(input(ref, kind === 'aggregate' ? 2 : 1), new AbortController().signal),
    ).rejects.toMatchObject({ code })
    expect(calls).toBe(0)
    if (['limit', 'aggregate', 'type'].includes(kind)) expect(reads).toBe(0)
  })

  it.each(['text-only', 'missing', 'ambiguous'] as const)(
    'refuses %s exact model capability before artifact I/O or inference',
    async (kind) => {
      let reads = 0
      let calls = 0
      const models =
        kind === 'text-only'
          ? [{ ...imageModel, input: ['text'] as ModelRecord['input'] }]
          : kind === 'missing'
            ? [{ ...imageModel, route: 'another-route' }]
            : [imageModel, imageModel]
      const backend = createLanguageBackend(
        host({
          artifacts: {
            read: async () => {
              reads++
              return bytes
            },
          },
          provider: {
            models: () => models,
            async *infer() {
              calls++
              yield { type: 'done', reason: 'stop' }
            },
          },
        }),
      )
      await expect(backend.prepare(input(), new AbortController().signal)).rejects.toMatchObject({
        code: 'LANGUAGE_IMAGE_MODEL_UNSUPPORTED',
      })
      expect(reads).toBe(0)
      expect(calls).toBe(0)
    },
  )

  it('captures a changing selection getter once before artifact I/O and rechecks only the bound model at invoke', async () => {
    let selected = 0
    let catalog = [imageModel]
    let calls = 0
    const backend = createLanguageBackend({
      ...host(),
      selection(_purpose) {
        selected++
        return {
          slot: 'primary',
          route: 'test',
          model: selected === 1 ? 'image' : 'other',
          contractId: null,
        }
      },
      provider: {
        models: () => catalog,
        async *infer() {
          calls++
          yield { type: 'done', reason: 'stop' }
        },
      },
    })
    const call = await backend.prepare(input(), new AbortController().signal)
    expect(selected).toBe(1)
    expect((call.input as { request: RequestBody }).request.model).toBe('image')
    catalog = [{ ...imageModel, input: ['text'] }]
    await expect(backend.invoke(call, new AbortController().signal)).rejects.toMatchObject({
      code: 'LANGUAGE_IMAGE_MODEL_UNSUPPORTED',
    })
    expect(selected).toBe(1)
    expect(calls).toBe(0)
  })

  it('checks cancellation after artifact I/O before creating a prepared request', async () => {
    const controller = new AbortController()
    const backend = createLanguageBackend(
      host({
        artifacts: {
          read: async () => {
            controller.abort()
            return bytes
          },
        },
      }),
    )
    await expect(backend.prepare(input(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
