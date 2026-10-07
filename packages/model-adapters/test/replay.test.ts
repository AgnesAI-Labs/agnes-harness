import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ModelAdapterConfig,
  ModelAdapterInstance,
  ModelAdapterStreamOptions,
} from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { readModelResponses, recordModelResponses, replayAdapter, scriptedAdapter } from '../src/index.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function file(name: string) {
  const dir = await mkdtemp(join(tmpdir(), 'agh-replay-'))
  dirs.push(dir)
  return join(dir, name)
}
const request: RequestBody = {
  kind: 'inference',
  sessionKey: 'session-1',
  slot: 'primary',
  route: 'demo',
  model: 'demo',
  contractId: null,
  derivedHash: 'a'.repeat(64),
  system: 'Teach.',
  messages: [],
  tools: [],
}
const options = (sessionKey = 'session-1'): ModelAdapterStreamOptions => ({
  sessionKey,
  signal: new AbortController().signal,
  toolNames: [],
  timeoutMs: { firstToken: 1000, total: 1000 },
})
const config = (path: string, match = 'strict'): ModelAdapterConfig => ({
  routes: [
    {
      route: 'demo',
      api: 'replay',
      baseUrl: 'http://127.0.0.1/v1',
      models: [],
      compat: { file: path, match },
    },
  ],
})
async function collect(adapter: ModelAdapterInstance, body = request, opts = options()) {
  const events = []
  for await (const event of adapter.stream('demo', body, opts)) events.push(event)
  return events
}
it('records private responses and replays with independent session cursors, mismatch and exhaustion refusal', async () => {
  const path = await file('responses.jsonl')
  const events = [
    { type: 'text_delta', delta: 'Hello' },
    {
      type: 'usage',
      tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated',
    },
    { type: 'done', reason: 'stop' },
  ] as const
  const source: ModelAdapterInstance = {
    id: 'demo',
    routes: () => [],
    models: () => [],
    async *stream() {
      yield* events
    },
  }
  const recorder = await recordModelResponses(source, path)
  expect(await collect(recorder)).toEqual(events)
  await recorder.dispose?.()
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readModelResponses(path)).toHaveLength(1)
  expect(await readFile(path, 'utf8')).not.toContain('credential')
  const replay = await replayAdapter.create(config(path))
  expect(await collect(replay, { ...request, system: 'Changed' })).toEqual([
    expect.objectContaining({ type: 'error', code: 'CONTRACT_MISMATCH', retryable: false }),
  ])
  expect(await collect(replay)).toEqual(events)
  expect(await collect(replay)).toEqual([
    expect.objectContaining({ type: 'error', code: 'NO_MODEL', retryable: false }),
  ])
  expect(await collect(replay, { ...request, sessionKey: 'session-2' }, options('session-2'))).toEqual(events)
  const sequence = await replayAdapter.create(config(path, 'sequence'))
  expect(await collect(sequence, { ...request, system: 'Compare another strategy' })).toEqual(events)
})
it('scripted files work outside testkit and validate terminal events and cancellation', async () => {
  const path = await file('lesson.json')
  const replies = [
    [
      { type: 'text_delta', delta: 'Lesson' },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ],
  ]
  await writeFile(path, JSON.stringify({ schemaVersion: 1, replies }))
  const inlineConfig = {
    routes: [{ ...config(path).routes[0]!, compat: { replies, repeatLast: true } }],
  }
  const inline = await scriptedAdapter.create(inlineConfig)
  expect(await collect(inline)).toEqual(replies[0])
  expect(await collect(inline)).toEqual(replies[0])
  await expect(
    scriptedAdapter.create({ routes: [{ ...inlineConfig.routes[0]!, compat: { file: path, replies } }] }),
  ).rejects.toThrow('either')
  await expect(
    scriptedAdapter.create({
      routes: [{ ...inlineConfig.routes[0]!, compat: { replies, repeatLast: 'yes' } }],
    }),
  ).rejects.toThrow('boolean')
  const scripted = await scriptedAdapter.create(config(path))
  expect(await collect(scripted)).toEqual(replies[0])
  expect(await collect(scripted)).toEqual([
    expect.objectContaining({ type: 'error', code: 'NO_MODEL', retryable: false }),
  ])
  const ac = new AbortController()
  ac.abort()
  await expect(collect(scripted, request, { ...options(), signal: ac.signal })).rejects.toThrow()
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, replies: [[{ type: 'text_delta', delta: 'Incomplete' }]] }),
  )
  await expect(scriptedAdapter.create(config(path))).rejects.toThrow('terminal')
})
it('refuses interrupted recordings and never overwrites a response file', async () => {
  const path = await file('partial.jsonl')
  const source: ModelAdapterInstance = {
    id: 'demo',
    routes: () => [],
    models: () => [],
    async *stream() {
      yield { type: 'text_delta', delta: 'Partial' }
      throw new Error('disconnected')
    },
  }
  const recorder = await recordModelResponses(source, path)
  await expect(collect(recorder)).rejects.toThrow('disconnected')
  await recorder.dispose?.()
  await expect(readModelResponses(path)).rejects.toThrow('incomplete')
  await expect(recordModelResponses(source, path)).rejects.toThrow()
})
