import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { InferenceEvent } from '@agnes/protocol'
import {
  fakeRequest,
  ScriptedProvider,
  recordModelFixture,
  replayModelFixture,
} from '@agnes/host/author-testkit'

const drain = async (stream: AsyncIterable<unknown>) => {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}
const input = () => ({ signal: new AbortController().signal, toolNames: [] })

it('records scripted exchanges with redacted text and deterministic identities, then replays keylessly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-fixture-'))
  const file = join(root, 'fixture.json')
  const options = { secrets: ['synthetic-private-value'] }
  const request = fakeRequest({
    sessionKey: 'random-live-id',
    system: 'synthetic-private-value',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Bearer synthetic-auth-value sk-synthetic12345' }] },
    ],
  })
  try {
    const recorder = await recordModelFixture(
      new ScriptedProvider({
        scripts: [
          [
            { type: 'text_delta', delta: 'synthetic-private-value' },
            { type: 'done', reason: 'stop' },
          ],
          [
            { type: 'text_delta', delta: 'second session' },
            { type: 'done', reason: 'stop' },
          ],
        ],
      }),
      file,
      options,
    )
    await drain(recorder.provider.infer(request, input()))
    await drain(recorder.provider.infer({ ...request, sessionKey: 'second-live-id' }, input()))
    await recorder.close()
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('synthetic-private-value')
    expect(text).not.toContain('synthetic-auth-value')
    expect(text).not.toContain('random-live-id')
    expect(text).not.toContain('sk-synthetic12345')
    expect(text).toContain('session-1')
    await expect(recordModelFixture(new ScriptedProvider({ scripts: [] }), file)).rejects.toThrow()
    const replay = await replayModelFixture(file, options)
    expect(() => replay.assertConsumed()).toThrow('not fully consumed')
    const events = await drain(replay.provider.infer({ ...request, sessionKey: 'another-live-id' }, input()))
    expect(events).toContainEqual({ type: 'text_delta', delta: '[REDACTED]' })
    expect(() => replay.assertConsumed()).toThrow('not fully consumed')
    expect(
      await drain(replay.provider.infer({ ...request, sessionKey: 'second-new-id' }, input())),
    ).toContainEqual({ type: 'text_delta', delta: 'second session' })
    replay.assertConsumed()
    const abandoned = await replayModelFixture(file, options)
    const stream = abandoned.provider.infer(request, input())[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()
    expect(() => abandoned.assertConsumed()).toThrow('not fully consumed')
    await expect(drain(abandoned.provider.infer(request, input()))).rejects.toThrow('abandoned')
    await expect(
      drain(replay.provider.infer({ ...request, sessionKey: 'another-live-id' }, input())),
    ).rejects.toThrow('exhausted')
    const mismatch = await replayModelFixture(file)
    await expect(drain(mismatch.provider.infer({ ...request, system: 'wrong' }, input()))).rejects.toThrow(
      'mismatch',
    )
    const cancelled = new AbortController()
    cancelled.abort(new Error('Stopped'))
    await expect(
      drain(mismatch.provider.infer(request, { signal: cancelled.signal, toolNames: [] })),
    ).rejects.toThrow('Stopped')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves failure prefixes, refuses abandoned recordings, and requires every bound session to consume its script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-fixture-'))
  const file = join(root, 'failure.json')
  const provider = new ScriptedProvider({ scripts: [] })
  try {
    const recorder = await recordModelFixture(
      {
        models: () => provider.models(),
        async *infer() {
          yield { type: 'text_delta', delta: 'partial' }
          throw new Error('synthetic failure')
        },
      },
      file,
    )
    await expect(drain(recorder.provider.infer(fakeRequest(), input()))).rejects.toThrow('synthetic failure')
    await recorder.close()
    const replay = await replayModelFixture(file)
    const seen: InferenceEvent[] = []
    await expect(
      (async () => {
        for await (const event of replay.provider.infer(fakeRequest(), input())) seen.push(event)
      })(),
    ).rejects.toThrow('synthetic failure')
    expect(seen).toEqual([{ type: 'text_delta', delta: 'partial' }])
    replay.assertConsumed()
    const abandoned = await recordModelFixture(provider, join(root, 'abandoned.json'))
    const stream = abandoned.provider.infer(fakeRequest(), input())[Symbol.asyncIterator]()
    await stream.next()
    await expect(abandoned.close()).rejects.toThrow('Drain')
    await stream.return?.()
    await abandoned.close()
    await expect(replayModelFixture(join(root, 'abandoned.json'))).rejects.toThrow('incomplete')
    const bad = JSON.parse(await readFile(file, 'utf8'))
    bad.exchanges[0].events = [{ type: 'unknown' }]
    await writeFile(join(root, 'bad.json'), JSON.stringify(bad))
    await expect(replayModelFixture(join(root, 'bad.json'))).rejects.toThrow('Invalid recorded event')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains replayed tool IDs across requests, including provider response IDs before tool calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-fixture-links-'))
  try {
    const first = fakeRequest()
    const call = {
      toolUseId: 'volatile-tool-id',
      ordinal: 0,
      name: 'lookup',
      args: { id: 'account-A', data: 'business-value' },
    }
    const second = fakeRequest({ messages: [{ role: 'assistant', content: [], toolCalls: [call] }] })
    const file = join(root, 'linked.json')
    const recorder = await recordModelFixture(
      new ScriptedProvider({
        scripts: [
          [
            {
              type: 'usage',
              tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              creditSource: 'estimated',
              response: { id: 'volatile-response-id', headers: { authorization: 'Bearer synthetic-secret' } },
            },
            { type: 'toolcall_end', via: 'native', call },
            { type: 'done', reason: 'toolUse' },
          ],
          [
            { type: 'text_delta', delta: 'finished' },
            { type: 'done', reason: 'stop' },
          ],
        ],
      }),
      file,
    )
    await drain(recorder.provider.infer(first, input()))
    await drain(recorder.provider.infer(second, input()))
    await recorder.close()
    const recorded = await readFile(file, 'utf8')
    expect(recorded).not.toContain('synthetic-secret')
    expect(recorded).not.toContain('volatile-tool-id')
    expect(recorded).not.toContain('volatile-response-id')
    expect(recorded).toContain('account-A')
    expect(recorded).toContain('business-value')
    const replay = await replayModelFixture(file)
    const events = []
    for await (const event of replay.provider.infer(first, input())) events.push(event)
    const replayed = events.find((event) => event.type === 'toolcall_end')
    if (!replayed || replayed.type !== 'toolcall_end') throw new Error('Missing replay tool call')
    const next = fakeRequest({ messages: [{ role: 'assistant', content: [], toolCalls: [replayed.call] }] })
    const drift = fakeRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ ...replayed.call, args: { id: 'account-B', data: 'business-value' } }],
        },
      ],
    })
    await expect(drain(replay.provider.infer(drift, input()))).rejects.toThrow('mismatch')
    expect(await drain(replay.provider.infer(next, input()))).toContainEqual({
      type: 'text_delta',
      delta: 'finished',
    })
    replay.assertConsumed()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
