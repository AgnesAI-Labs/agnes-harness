import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { kill, message, run } from './fixtures/child-process.js'

// Cold restart of converted request media. Real: the default media service, the AI default adapter, the
// request builder and the source reader, a local HTTP peer, new processes. Stand-ins: the State (a file
// that keeps child receipts and parent frames), the model composite that runs the vision child, the model
// service's `prepare`, and the Loop's planning after a miss. Prepared requests live only in one process.

type Api = 'openai-completions' | 'anthropic-messages'
const here = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const IMAGE = (api: Api) => (api === 'anthropic-messages' ? '"type":"image"' : 'image_url')

async function harness(api: Api, serverMode: 'ok' | 'drop', scenario: 'convert' | 'native') {
  const directory = mkdtempSync(join(tmpdir(), 'model-media-restart-'))
  const journal = join(directory, 'wire.jsonl')
  const world = join(directory, 'world')
  mkdirSync(world)
  writeFileSync(journal, '')
  const children: ChildProcess[] = []
  const server = run(children, [here('model-media-http.mjs'), journal, serverMode])
  const listening = await message(server, (v) => typeof v.port === 'number')
  const endpoint = `http://127.0.0.1:${listening.port}${api === 'anthropic-messages' ? '' : '/v1'}`
  const worker = async (mode: 'first' | 'resume' | 'main' | 'replan') => {
    const child = run(children, [
      '--import',
      'tsx',
      here('model-media-restart-worker.ts'),
      api,
      endpoint,
      world,
      mode,
      scenario,
      serverMode === 'drop' ? 'fast' : 'normal',
    ])
    const ready = await message(child, (v) => v.phase === 'ready')
    return { child, pid: ready.pid as number }
  }
  const wire = () =>
    readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { input: { model: string } })
  const ask = async (w: Awaited<ReturnType<typeof worker>>, ...phases: string[]) => {
    const reply = message(w.child, (v) => phases.includes(String(v.phase)))
    w.child.send({ op: 'go' })
    return reply
  }
  const done = async () => {
    await Promise.all(children.map(kill))
    rmSync(directory, { recursive: true, force: true })
  }
  return { worker, wire, ask, done, world }
}

it.each(['openai-completions', 'anthropic-messages'] as const)(
  'a restart after the confirmed conversion neither repeats it nor sends the main request from the lost handle (%s)',
  async (api) => {
    const h = await harness(api, 'ok', 'convert')
    try {
      const first = await h.worker('first')
      const durable = await h.ask(first, 'durable')
      expect(h.wire()).toHaveLength(1)
      expect(h.wire()[0]?.input.model).toBe('vision-model')
      expect(JSON.stringify(h.wire()[0]?.input)).toContain(IMAGE(api))
      await kill(first.child)

      // The media service resumes from the saved parent and the published child receipt: no second vision call.
      const digests: unknown[] = []
      for (let round = 0; round < 2; round += 1) {
        const resumed = await h.worker('resume')
        const media = await h.ask(resumed, 'media')
        expect(resumed.pid).not.toBe(first.pid)
        expect(media, JSON.stringify(media)).toMatchObject({ children: 0, verified: true })
        expect(media.usageIds).toEqual(durable.usageIds)
        expect(h.wire()).toHaveLength(1)
        digests.push(media.mediaDigest)
        await kill(resumed.child)
      }
      expect(digests[0]).toBe(digests[1])

      // The prepared main request was an object of the dead process: the registry here is empty, the miss is
      // named, and nothing is prepared again or sent.
      const main = await h.worker('main')
      expect(await h.ask(main, 'lost', 'loaded')).toMatchObject({
        phase: 'lost',
        detail: 'model_prepared_lost',
        registryHit: false,
      })
      expect(h.wire()).toHaveLength(1)
    } finally {
      await h.done()
    }
  },
  120_000,
)

// PENDING DECISION: whether planning again after a registry miss should reuse a conversion that was
// already confirmed. This row pins what the current media service does: a new parent action converts
// again and the second vision call is paid and recorded as its own usage. Change this row with the decision.
it('pins the current behaviour of planning again after the miss: a new parent action converts again (pending decision)', async () => {
  const h = await harness('openai-completions', 'ok', 'convert')
  try {
    const first = await h.worker('first')
    const durable = await h.ask(first, 'durable')
    await kill(first.child)
    const replan = await h.worker('replan')
    const sent = await h.ask(replan, 'sent', 'refused')
    expect(sent.phase).toBe('sent')
    const lines = h.wire()
    expect(lines.map((line) => line.input.model)).toEqual(['vision-model', 'vision-model', 'text-model'])
    const body = JSON.stringify(lines[2]?.input)
    expect(body).toContain('[untrusted auxiliary vision analysis]')
    expect(body).toContain('actual wire answer')
    expect(body).not.toMatch(/image_url|"type":"image"/)
    // The conversion's usage stays on its own child: the main call reports only its own.
    expect(sent.usageIds).toHaveLength(1)
    expect(durable.usageIds).toHaveLength(1)
    expect(sent.conversionUsageIds).toHaveLength(1)
  } finally {
    await h.done()
  }
}, 120_000)

it('never creates a second conversion when the vision call was sent but its answer never arrived', async () => {
  const h = await harness('openai-completions', 'drop', 'convert')
  try {
    const first = await h.worker('first')
    const outcome = await h.ask(first, 'durable')
    expect(outcome.outcome).toBe('unknown_effect')
    expect(h.wire()).toHaveLength(1)
    await kill(first.child)
    const resumed = await h.worker('resume')
    const media = await h.ask(resumed, 'media')
    expect(media).toMatchObject({ children: 0, failed: 'unknown_effect/media_conversion_unknown' })
    expect(h.wire()).toHaveLength(1) // no second vision call, and the main request is never built from it
  } finally {
    await h.done()
  }
}, 120_000)

it('sends native media without any conversion and keeps the image on the main request', async () => {
  const h = await harness('openai-completions', 'ok', 'native')
  try {
    const main = await h.worker('main')
    await h.ask(main, 'sent')
    const lines = h.wire()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.input.model).toBe('text-model')
    expect(JSON.stringify(lines[0]?.input)).toContain('image_url')
  } finally {
    await h.done()
  }
}, 120_000)

it('does not resume the conversion after access to the source was withdrawn, and keeps the confirmed fact', async () => {
  const h = await harness('openai-completions', 'ok', 'convert')
  try {
    const first = await h.worker('first')
    await h.ask(first, 'durable')
    await kill(first.child)
    writeFileSync(join(h.world, 'revoked'), '')
    const resumed = await h.worker('resume')
    const media = await h.ask(resumed, 'media')
    expect(media).toMatchObject({ children: 0, failed: 'denied/media_source_denied' })
    expect(h.wire()).toHaveLength(1) // only the confirmed vision call; nothing new is sent
    expect(JSON.parse(readFileSync(join(h.world, 'state.json'), 'utf8')).receipts).toHaveProperty(
      'vision-child-media-parent:vision-receipt-media-parent',
    )
  } finally {
    await h.done()
  }
}, 120_000)
