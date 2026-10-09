import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
        ],
      }),
      file,
      options,
    )
    await drain(recorder.provider.infer(request, input()))
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
    replay.assertConsumed()
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
    const seen = []
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
