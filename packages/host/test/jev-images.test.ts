import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAdapter } from '@agnes/ai'
import { fakeModel } from '@agnes/ai/testkit'
import { seams as baseSeams } from '@agnes/base'
import { scanAll } from '@agnes/core'
import { actor, fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import { assertRuntimeRecord, type JsonValue } from '@agnes/jev-runtime'
import type { RequestBody } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../testkit/index.js'

it.each(['image-capable', 'captured-text-only'] as const)(
  'checks %s catalog behavior through real Host read/artifacts and the actual Pi boundary',
  async (capability) => {
    const capture = JSON.parse(
      await readFile(new URL('./fixtures/jev-real-media-text-only.json', import.meta.url), 'utf8'),
    )
    expect(capture).toMatchObject({
      requestedModel: 'deepseek-v4-flash',
      imageMime: 'image/png',
      preparedImage: true,
    })
    const root = await mkdtemp(join(tmpdir(), 'agnes-jev-image-'))
    const bytes = await readFile(new URL('../../../docs/assets/readme/banner.png', import.meta.url))
    await writeFile(join(root, 'picture.png'), bytes)
    const model = fakeModel({
      route: 'gw',
      id: capability === 'image-capable' ? 'm1' : capture.requestedModel,
      input: capability === 'image-capable' ? ['text', 'image'] : ['text'],
      baseUrl: 'https://image-wire.invalid/v1',
    })
    const adapter = new PiAdapter({
      manualRoutes: [{ route: 'gw', api: 'openai-completions', baseUrl: model.baseUrl, models: [model] }],
      maxRetries: 0,
    })
    adapter.bindCredential('gw', 'synthetic-test-key')
    let wire: Record<string, unknown> | undefined
    const wireEvents: unknown[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      wire = JSON.parse(
        options?.body === undefined && _url instanceof Request ? await _url.text() : String(options?.body),
      )
      // Stop after serialization. No URL is contacted and no actual inference is claimed.
      throw new Error('local wire capture complete')
    })
    const scripted = fakeProvider([
      ...(capability === 'captured-text-only' ? [toolTurn('read', { path: 'picture.png' })] : []),
      textTurn('Image evidence received.'),
    ])
    const provider = {
      models: () => [model],
      async *infer(body: RequestBody, options: Parameters<typeof scripted.infer>[1]) {
        if (body.messages.some((message) => message.content.some((block) => block.type === 'image')))
          for await (const event of adapter.stream('gw', body, {
            signal: options.signal,
            sessionKey: 'local-wire-test',
            toolNames: [],
            timeoutMs: { firstToken: 1000, total: 2000 },
          })) {
            wireEvents.push(event)
          }
        yield* scripted.infer(body, options)
      },
    }
    let decisions = 0
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
      provider,
      packages: { '@agnes/base': { seams: { artifacts: baseSeams.artifacts } } },
      disableSessionTitle: true,
      profileInputs: {
        user: {
          name: 'local-dev',
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [{ route: 'gw', api: 'openai-completions', baseUrl: model.baseUrl, models: [model] }],
          },
        },
      },
      jev: {
        decision: {
          backend: 'jev',
          endpoint: 'https://jev.invalid/v1',
          model: 'jev-test',
          transport: {
            async invoke({ questions }) {
              const inspect = decisions++ === 0
              const answers: Record<string, JsonValue> = {}
              for (const [name, value] of Object.entries(questions)) {
                const criteria = (value as { criteria?: Record<string, unknown> }).criteria
                if (!criteria) continue
                const selected =
                  name === 'purpose'
                    ? inspect
                      ? 'INSPECT'
                      : 'RESPOND'
                    : name.startsWith('operation_')
                      ? inspect
                        ? 'read'
                        : 'RESPOND'
                      : name === 'binding_read'
                        ? capability === 'image-capable'
                          ? Object.keys(criteria).find(
                              (key) =>
                                key !== 'LLM_PARAMETERS' &&
                                JSON.stringify(criteria[key]).includes('picture.png'),
                            )
                          : 'LLM_PARAMETERS'
                        : undefined
                if (selected && Object.hasOwn(criteria, selected))
                  answers[name] = {
                    type: 'choice',
                    choice: selected,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      Object.keys(criteria).map((key) => [key, key === selected ? 1 : 0]),
                    ),
                  }
              }
              return { output: { answers }, observedModel: 'jev-test' }
            },
          },
        },
      },
    })
    try {
      const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
      await session.enqueue('next-turn', {
        actor,
        content: [{ type: 'text', text: 'Read picture.png and describe its recorded evidence.' }],
      })
      const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(result, JSON.stringify(result)).toMatchObject({
        reason: capability === 'image-capable' ? 'completed' : 'error',
      })
      const rows = await scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
      const records = rows
        .filter((row) => row.type === 'runtime/record')
        .map((row) => {
          const record = (row.data as unknown as { record: unknown }).record
          assertRuntimeRecord(record)
          return record
        })
      const intended = records.find((record) => record.kind === 'action.intended')
      expect(intended?.kind === 'action.intended' ? intended.intent.arguments : undefined).toEqual(
        capability === 'image-capable'
          ? { path: await realpath(join(root, 'picture.png')) }
          : { path: 'picture.png' },
      )
      const settled = records.find((record) => record.kind === 'action.settled')
      expect(settled, JSON.stringify(settled)).toMatchObject({
        effect: 'none',
        outcome: {
          kind: 'success',
          content: [
            {
              kind: 'artifact',
              artifact: {
                mediaType: 'image/png',
                digest: createHash('sha256').update(bytes).digest('hex'),
                size: bytes.length,
              },
            },
          ],
        },
      })
      if (capability === 'captured-text-only') {
        expect(result.error).toEqual({
          code: 'E_RUNTIME_FAILED',
          message: '当前模型未声明支持工具返回的图片。请选择支持图像输入的模型后重试。',
        })
        expect(scripted.requests).toHaveLength(1)
        expect(fetch).not.toHaveBeenCalled()
        expect(records.findLast((record) => record.kind === 'run.stopped')).toMatchObject({
          reason: 'failed',
          detail: expect.stringContaining('LANGUAGE_IMAGE_MODEL_UNSUPPORTED'),
          unresolved: [],
        })
        expect(
          records.some(
            (record) =>
              record.kind === 'model.requested' &&
              record.call.codec === 'agnes-language-v1' &&
              (record.call.input as { request: RequestBody }).request.messages.some((message) =>
                message.content.some((block) => block.type === 'image'),
              ),
          ),
        ).toBe(false)
        // Native's existing adapter compatibility remains: a direct text-only Pi request is
        // downgraded to an explicit placeholder. Jev must have refused before reaching this seam.
        const previous = scripted.requests[0]
        if (!previous) throw new Error('Missing real Host parameter request')
        const nativeRequest: RequestBody = {
          ...previous,
          system: '',
          tools: [],
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }],
            },
          ],
        }
        for await (const event of adapter.stream('gw', nativeRequest, {
          signal: new AbortController().signal,
          sessionKey: 'native-compatibility-test',
          toolNames: [],
          timeoutMs: { firstToken: 1000, total: 2000 },
        }))
          wireEvents.push(event)
        expect(fetch).toHaveBeenCalledOnce()
        expect(JSON.stringify(wire)).toContain('image omitted: model does not support images')
        expect(JSON.stringify(wire)).not.toContain('data:image/png;base64,')
        await session.close()
        return
      }
      const requested = records.find(
        (record) => record.kind === 'model.requested' && record.call.purpose === 'answer',
      )
      if (requested?.kind !== 'model.requested') throw new Error('Missing answer request')
      const body = (requested.call.input as { request: RequestBody }).request
      expect(
        body.messages.flatMap((message) => message.content.filter((block) => block.type === 'image')),
      ).toEqual([{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }])
      expect(JSON.stringify(wire), JSON.stringify(wireEvents)).toContain(
        `data:image/png;base64,${bytes.toString('base64')}`,
      )
      expect(wire?.model).toBe('m1')
      expect(fetch).toHaveBeenCalledOnce()
      await session.close()
    } finally {
      fetch.mockRestore()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
