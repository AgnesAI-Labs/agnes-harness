import { InferenceEvent as InferenceEventSchema } from '@agnes/protocol/gen/model'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { MediaAdapter, pollUntilDone, type VideoClient, type WireEvent } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'

const videoModel = fakeModel({
  id: 'vid-1',
  route: 'agnes-media-video',
  cost: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 },
})

async function collect(it: AsyncIterable<WireEvent>) {
  const out: WireEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const opts = () => ({
  signal: new AbortController().signal,
  toolNames: [],
  sessionKey: 'k',
  timeoutMs: { firstToken: 1000, total: 60_000 },
})
const imgModel = fakeModel({
  id: 'img-1',
  route: 'agnes-media-image',
  cost: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0 },
})

describe('media schema', () => {
  it('InferenceEvent accepts media variants', () => {
    expect(
      Value.Check(InferenceEventSchema, {
        type: 'media',
        kind: 'image',
        data: 'AAAA',
        mimeType: 'image/png',
      }),
    ).toBe(true)
    expect(
      Value.Check(InferenceEventSchema, { type: 'media', kind: 'video_job', jobId: 'j1', status: 'running' }),
    ).toBe(true)
    expect(
      Value.Check(InferenceEventSchema, { type: 'media', kind: 'video_job', jobId: 'j1', status: 'bogus' }),
    ).toBe(false)
  })
})

describe('MediaAdapter image', () => {
  it('yields one media event per image, estimated credits, then done', async () => {
    const a = new MediaAdapter({
      imageRoute: { baseUrl: 'https://media.invalid', models: [imgModel] },
      imagesImpl: async () => ({
        images: [
          { data: 'AAA', mimeType: 'image/png' },
          { data: 'BBB', mimeType: 'image/png' },
        ],
      }),
    })
    const events = await collect(
      a.stream(
        'agnes-media-image',
        fakeRequest({
          slot: 'image',
          route: 'agnes-media-image',
          model: 'img-1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'a cat' }] }],
        }),
        opts(),
      ),
    )
    expect(events.map((e) => e.type)).toEqual(['media', 'media', 'usage', 'done'])
    expect(events[2]).toMatchObject({
      type: 'usage',
      credits: 10,
      creditSource: 'estimated',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  // `ImagesModels.generateImages()` never rejects: a provider failure comes back as a normal
  // `AssistantImages` value carrying `stopReason: 'error'`, not as a thrown/rejected promise. This
  // pins the behaviour that makes that distinction matter — `piImages` (and any `imagesImpl`) must
  // treat that return value as a failure and throw, so `stream()`'s try/catch turns it into the
  // adapter's terminal `error` WireEvent instead of a `done` reporting zero images. The plan's own
  // sample had no test covering this path; it is a real gap this closes.
  it('reports a provider stopReason:"error" result as a terminal error, not a silent empty done', async () => {
    const a = new MediaAdapter({
      imageRoute: { baseUrl: 'https://media.invalid', models: [imgModel] },
      imagesImpl: async () => {
        throw new Error('provider generation failed')
      },
    })
    const events = await collect(
      a.stream(
        'agnes-media-image',
        fakeRequest({
          slot: 'image',
          route: 'agnes-media-image',
          model: 'img-1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'a cat' }] }],
        }),
        opts(),
      ),
    )
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        code: 'TRANSPORT',
        message: 'provider generation failed',
        retryable: true,
      },
    ])
  })
})

describe('pollUntilDone', () => {
  const client = (
    seq: Array<{ status: 'running' | 'succeeded' | 'failed' }>,
  ): VideoClient & { cancelled: string[]; polls: number } => {
    let i = 0
    const c: VideoClient & { cancelled: string[]; polls: number } = {
      cancelled: [],
      polls: 0,
      submit: async () => ({ jobId: 'j1' }),
      cancel: async (id) => {
        c.cancelled.push(id)
      },
      poll: async () => {
        c.polls++
        return seq[Math.min(i++, seq.length - 1)] ?? { status: 'running' }
      },
    }
    return c
  }
  it('backs off 2s → 4s → 8s and resolves on success', async () => {
    const delays: number[] = []
    let now = 0
    const c = client([{ status: 'running' }, { status: 'running' }, { status: 'succeeded' }])
    const r = await pollUntilDone(c, 'j1', {
      sleep: async (ms) => {
        delays.push(ms)
        now += ms
      },
      clock: () => now,
      timeoutMs: 900_000,
      signal: new AbortController().signal,
    })
    expect(r.status).toBe('succeeded')
    expect(delays).toEqual([2000, 4000])
  })
  it('expires on total timeout and cancels on abort', async () => {
    let now = 0
    const c = client([{ status: 'running' }])
    const r = await pollUntilDone(c, 'j1', {
      sleep: async (ms) => {
        now += ms
      },
      clock: () => now,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    })
    expect(r.status).toBe('expired')
    const ac = new AbortController()
    ac.abort()
    const c2 = client([{ status: 'running' }])
    const r2 = await pollUntilDone(c2, 'j1', {
      sleep: async () => {},
      clock: () => 0,
      timeoutMs: 10_000,
      signal: ac.signal,
    })
    expect(r2.status).toBe('cancelled')
    expect(c2.cancelled).toEqual(['j1'])
  })
})

describe('MediaAdapter video', () => {
  // Regression pin: onTick's status log used to push a `succeeded` tick with no `url`, and the
  // block after pollUntilDone then yielded a *second* `succeeded` event carrying the real `url` -
  // a caller that treats the first terminal status it sees as final (a reasonable thing to do,
  // since `succeeded` is a real terminal VideoStatus) would act on the url-less one and never see
  // the real one. Exactly one `succeeded` event, carrying `url`, is correct.
  it('submits, ticks running once, then yields exactly one succeeded event carrying the url', async () => {
    let polls = 0
    const client: VideoClient = {
      submit: async () => ({ jobId: 'job-1' }),
      poll: async () => {
        polls++
        if (polls === 1) return { status: 'running' }
        return { status: 'succeeded', url: 'https://media.invalid/job-1.mp4' }
      },
      cancel: async () => {},
    }
    const a = new MediaAdapter({
      imageRoute: { baseUrl: 'https://media.invalid', models: [] },
      videoRoute: { baseUrl: 'https://media.invalid', models: [videoModel] },
      videoClient: client,
      sleep: async () => {},
      clock: () => 0,
    })
    const events = await collect(
      a.stream(
        'agnes-media-video',
        fakeRequest({
          slot: 'video',
          route: 'agnes-media-video',
          model: 'vid-1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'a cat running' }] }],
        }),
        opts(),
      ),
    )
    const jobEvents = events.filter((e) => e.type === 'media' && e.kind === 'video_job')
    expect(jobEvents).toEqual([
      { type: 'media', kind: 'video_job', jobId: 'job-1', status: 'submitted' },
      { type: 'media', kind: 'video_job', jobId: 'job-1', status: 'running' },
      {
        type: 'media',
        kind: 'video_job',
        jobId: 'job-1',
        status: 'succeeded',
        url: 'https://media.invalid/job-1.mp4',
      },
    ])
    expect(events.map((e) => e.type)).toEqual(['media', 'media', 'media', 'usage', 'done'])
  })
})
