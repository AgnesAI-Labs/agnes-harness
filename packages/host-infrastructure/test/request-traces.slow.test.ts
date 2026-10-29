import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { RequestTraceStore } from '../src/request-traces.js'

it('keeps warm capture responsive with a retained directory of large legacy calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-trace-history-'))
  try {
    const store = new RequestTraceStore(root, 'synthetic')
    const request = {
      kind: 'inference' as const,
      sessionKey: 'seed',
      slot: 'primary' as const,
      route: 'demo',
      model: 'demo',
      contractId: null,
      derivedHash: 'a'.repeat(64),
      system: 'synthetic',
      tools: [],
      messages: [],
    }
    const seed = await store.begin(request)
    await seed.finish()
    const dir = join(root, 'model-requests', createHash('sha256').update('synthetic').digest('hex'))
    const row = JSON.parse(await readFile(join(dir, `${seed.id}.call.json`), 'utf8'))
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'fixture '.repeat(24_000) }] }]
    for (let i = 0; i < 255; i++) {
      const id = randomUUID()
      await writeFile(
        join(dir, `${id}.call.json`),
        JSON.stringify({
          ...row,
          id,
          messages,
          sessionHash: createHash('sha256')
            .update(`session-${i % 8}`)
            .digest('hex'),
          attempts: row.attempts.map((attempt: object) => ({ ...attempt, parentCallId: id })),
        }),
      )
    }
    const reader = new RequestTraceStore(root, 'synthetic')
    const coldStart = performance.now()
    await reader.get('seed')
    const coldMs = performance.now() - coldStart
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      await reader.get('seed')
      samples.push(performance.now() - start)
    }
    const hotMs = samples.sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY
    const captureStart = performance.now()
    const handle = await reader.begin({ ...request, sessionKey: 'new-session' })
    await handle.wire({ system: 'synthetic', tools: [], messages: [] })
    await handle.finish()
    const captureMs = performance.now() - captureStart
    const fullStart = performance.now()
    const full = await reader.begin({ ...request, sessionKey: 'full-session' })
    const attempt = {
      attemptId: randomUUID(),
      index: 0,
      adapter: { id: 'synthetic', version: null, api: 'synthetic', endpoint: null },
    }
    await full.attempt?.({ ...attempt, status: 'not-sent' })
    await full.wire({ system: 'synthetic', tools: [], messages: [] }, attempt.attemptId)
    await full.attempt?.({ ...attempt, status: 'completed' })
    await full.finish()
    const fullCaptureMs = performance.now() - fullStart
    console.info(
      JSON.stringify({
        calls: 256,
        messageBytes: 192_000,
        coldMs,
        hotMedianMs: hotMs,
        captureMs,
        fullCaptureMs,
      }),
    )
    expect((await reader.get('new-session', handle.id)).snapshot?.wire).toEqual({
      system: 'synthetic',
      tools: [],
      messages: [],
    })
    // Large historical bodies must not be decoded repeatedly on the warm path.
    expect(hotMs).toBeLessThan(coldMs / 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
