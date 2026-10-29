import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, Provider, UITimeline } from '@agnes/protocol'
import { createClient, PreviewMerger, UIProjectionSync } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'

const CHUNK = 512
const CHUNKS = 600

/** Paces a scripted stream the way a real model does, so projection requests interleave with it. */
function pacedProvider(): Provider {
  const answer = Array.from(
    { length: CHUNKS },
    (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(CHUNK - 4)}`,
  )
  const inner = new ScriptedProvider({
    scripts: [
      [
        ...answer.map((delta): InferenceEvent => ({ type: 'text_delta', delta })),
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  return {
    models: () => inner.models(),
    async *infer(req, opts) {
      for await (const event of inner.infer(req, opts)) {
        // Far faster than a real model (a 512-character chunk every few hundred milliseconds or more),
        // yet slow enough that the 50 ms patch debounce is not the only thing being measured.
        if (event.type === 'text_delta') await new Promise((resolve) => setTimeout(resolve, 10))
        yield event
      }
    },
  }
}

async function streamLongAnswer(
  /** Open the projection only after this many characters of the answer were already streamed. */
  joinAfterChars = 0,
) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-projection-long-stream-'))
  const { host } = await createTestHost({
    dataDir: dir,
    provider: pacedProvider(),
    disableSessionTitle: true,
  })
  const opened = vi.spyOn(host, 'createSession')
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let sync: UIProjectionSync | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const core = await opened.mock.results[0]?.value
    if (!core) throw new Error('missing Core session')
    const view = vi.spyOn(core.d.ui, 'view')
    const journalPatch = vi.spyOn(core.d.ui, 'journalPatch')
    const openings = vi.spyOn(session, 'projectUIOpening')
    const timelines: UITimeline[] = []
    const merger = new PreviewMerger()
    let streamedMax = 0
    sync = new UIProjectionSync(
      session,
      {
        timeline: (value) => timelines.push(merger.apply(value)),
        preview: (p) => {
          merger.add(p)
          streamedMax = Math.max(streamedMax, merger.text(p.effectId)?.text.length ?? 0)
        },
        error: () => undefined,
      },
      { isolate: 'share', opening: { maxNodes: 500, maxBytes: 1_048_576 } },
    )
    if (joinAfterChars > 0) {
      const prompted = session.prompt('write a long answer')
      await vi.waitFor(
        () => {
          const [running] = core.previewSnapshot()
          if ((running?.text.length ?? 0) < joinAfterChars) throw new Error('stream not far enough yet')
        },
        { timeout: 30_000, interval: 5 },
      )
      await sync.start()
      view.mockClear()
      await prompted
    } else {
      await sync.start()
      view.mockClear()
      await session.prompt('write a long answer')
    }
    // The turn's closing cost row comes after the answer; once it is on screen the stream is over.
    const last = await vi.waitFor(
      () => {
        const timeline = timelines.at(-1)
        if (!timeline?.nodes.some((node) => node.kind === 'cost')) throw new Error('turn not over yet')
        return timeline
      },
      { timeout: 30_000, interval: 20 },
    )
    const answer = last.nodes.find((node) => node.kind === 'assistant') as unknown as
      | { text: string }
      | undefined
    return {
      text: answer?.text ?? '',
      streamedMax,
      views: view.mock.calls.length,
      misses: journalPatch.mock.results.filter((result) => result.value === null).length,
      openings: openings.mock.calls.length,
    }
  } finally {
    await sync?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

it('streams 300 KB without growing the Core patch journal: no full view, no reopen', async () => {
  const result = await streamLongAnswer()
  expect(result.text.length).toBe(CHUNK * CHUNKS)
  expect(result.text.startsWith('0000')).toBe(true)
  expect(result.text.endsWith('x')).toBe(true)
  // The whole answer reached the viewer as previews before the committed message replaced it.
  expect(result.streamedMax).toBe(CHUNK * CHUNKS)
  expect(result).toMatchObject({ views: 0, misses: 0, openings: 1 })
}, 60_000)

it('joining a stream midway catches up from the snapshot: no full view, no reopen', async () => {
  const result = await streamLongAnswer(300 * CHUNK)
  expect(result.text.length).toBe(CHUNK * CHUNKS)
  expect(result.streamedMax).toBe(CHUNK * CHUNKS)
  expect(result).toMatchObject({ views: 0, misses: 0, openings: 1 })
}, 60_000)
