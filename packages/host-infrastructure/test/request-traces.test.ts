import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, NullContractStore } from '@agnes/ai'
import { FakeAdapter, fakeModel, fakeRequest } from '@agnes/ai/testkit'
import type { RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { RequestTraceStore } from '../src/request-traces.js'
import { SystemPromptSettingsStore } from '../src/system-prompt-settings.js'

const homes: string[] = []
async function home() {
  const path = await mkdtemp(join(tmpdir(), 'agh-request-'))
  homes.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const request = (sessionKey = 'owned'): RequestBody => ({
  kind: 'inference',
  sessionKey,
  slot: 'primary',
  route: 'demo',
  model: 'demo',
  contractId: null,
  derivedHash: 'a'.repeat(64),
  system: 'synthetic persona',
  sections: [{ id: 'persona', source: 'test:persona', order: 1, text: 'synthetic persona' }],
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
})
describe('local request snapshots', () => {
  it('deduplicates immutable prompt/tools, retains final JSON and metadata, and isolates profiles and sessions after reopen', async () => {
    const root = await home()
    let now = 1000
    const store = new RequestTraceStore(root, 'local', undefined, () => now++)
    const first = await store.begin(request())
    await first.wire({
      system: 'synthetic persona',
      tools: [],
      messages: [{ role: 'user', content: 'transformed' }],
    })
    first.event({ type: 'usage', tokens: { input: 12, output: 3 }, response: { model: 'demo' } })
    first.event({ type: 'done' })
    await first.finish()
    const second = await store.begin(request())
    await second.finish()
    const reopened = new RequestTraceStore(root, 'local', undefined, () => now++)
    expect((await reopened.get('owned')).calls?.map((call) => call.id)).toEqual([first.id, second.id])
    expect((await reopened.get('other')).calls).toEqual([])
    const result = await reopened.get('owned', second.id)
    expect(result.snapshot).toMatchObject({
      capture: 'logical-request',
      wire: null,
      wireUnavailable: 'adapter-no-tap',
      tokens: { providerActual: null },
    })
    expect(result.snapshot?.attempts[0]).toMatchObject({
      status: 'unknown',
      wireUnavailable: 'adapter-no-tap',
    })
    expect(result.snapshot?.systemHash).toBe(result.previous?.systemHash)
    expect(result.snapshot?.toolsHash).toBe(result.previous?.toolsHash)
    expect(result.previous).toMatchObject({
      capture: 'final-provider-body',
      wire: { messages: [{ role: 'user', content: 'transformed' }] },
      response: { status: 'done', tokens: { input: 12, output: 3 } },
    })
    const metadata = await reopened.metadata('owned', first.id)
    expect(metadata?.request).toMatchObject({
      callId: first.id,
      promptHash: result.previous!.promptHash,
      hashBasis: 'redacted-json',
    })
    expect(metadata?.attempts[0]).toMatchObject({ parentCallId: first.id, status: 'completed' })
    expect(JSON.stringify(metadata)).not.toMatch(/synthetic persona|transformed|providerActualTokens/)
    expect(await reopened.metadata('other', first.id)).toBeNull()
    expect(await new RequestTraceStore(root, 'other').metadata('owned', first.id)).toBeNull()
    const [profile] = await readdir(join(root, 'model-requests'))
    const files = await readdir(join(root, 'model-requests', profile!))
    expect(files.filter((file) => file.startsWith(result.snapshot!.systemHash))).toHaveLength(1)
    expect((await reopened.get('other', first.id)).snapshot).toBeNull()
    expect((await new RequestTraceStore(root, 'other').get('owned', first.id)).snapshot).toBeNull()
    expect(await reopened.clear('other', first.id)).toBe(false)
    expect(await reopened.clear('owned', first.id)).toBe(true)
    expect((await reopened.get('owned', second.id)).snapshot?.system).toBe('synthetic persona')
    expect(await reopened.clear('owned', second.id)).toBe(true)
    expect(
      (await readdir(join(root, 'model-requests', profile!))).filter((file) => file.endsWith('.json')),
    ).toEqual([])
  })
  it('keeps unsupported adapter input separate from unavailable wire bodies and provider usage', async () => {
    const store = new RequestTraceStore(await home(), 'local')
    const adapter = new FakeAdapter({
      id: 'untapped',
      routes: [{ route: 'test', api: 'custom', baseUrl: 'https://invalid.test', credentialRef: 'fixture' }],
      models: { test: [fakeModel({ id: 'm', route: 'test' })] },
    })
    const provider = createProvider({
      adapters: [adapter],
      routes: { primary: { route: 'test', model: 'm' } },
      contract: new NullContractStore(),
      trace: store,
      secrets: () => 'fixture',
      clock: Date.now,
    })
    const input = fakeRequest({ route: 'test', model: 'm' })
    for await (const _event of provider.infer(input, {
      signal: new AbortController().signal,
      toolNames: [],
    })) {
      /* drain */
    }
    const call = (await store.get(input.sessionKey)).calls![0]!
    const snapshot = (await store.get(input.sessionKey, call.id)).snapshot!
    expect(snapshot).toMatchObject({
      capture: 'logical-request',
      wire: null,
      wireUnavailable: 'adapter-no-tap',
      tokens: { providerActual: null },
      response: { status: 'done' },
    })
    expect(snapshot.attempts[0]).toMatchObject({ status: 'unknown', providerActualTokens: null, wire: null })
  })
  it('removes credentials and secret-like text while preserving declared tool properties', async () => {
    const root = await home()
    const store = new RequestTraceStore(root, 'local')
    const aws = ['AKIA', '1234567890123456'].join('')
    const handle = await store.begin({
      ...request(),
      traceContext: { memoryRevision: 'revision-secret' },
      sections: [{ id: 'memory', order: 1, source: 'memory:fixture', text: 'password=hunter2' }],
      system: `Bearer synthetic-secret sk-testsecret123456789 ${aws} password=hunter2`,
    })
    await handle.wire({
      headers: { Authorization: 'synthetic-credential' },
      api_key: 'synthetic-key',
      parameters: { properties: { password: { type: 'string' } } },
      content: [{ type: 'image', data: 'private-base64' }],
      input: [{ type: 'input_image', image_url: 'data:image/png;base64,cHJpdmF0ZS1waXhlbHM=' }],
    })
    await handle.finish()
    const snapshot = (await store.get('owned', handle.id)).snapshot!
    const text = JSON.stringify(snapshot)
    for (const secret of [
      'synthetic-secret',
      'testsecret123456789',
      aws,
      'hunter2',
      'synthetic-credential',
      'synthetic-key',
      'private-base64',
      'cHJpdmF0ZS1waXhlbHM=',
    ])
      expect(text).not.toContain(secret)
    expect(snapshot).toMatchObject({
      memoryRevision: 'revision-secret',
      redacted: true,
      incomplete: true,
      hashBasis: 'redacted-json',
    })
    expect(snapshot.memoryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.sourceHashes).toHaveLength(1)
    expect(snapshot.wire).toMatchObject({ parameters: { properties: { password: { type: 'string' } } } })
    const [profile] = await readdir(join(root, 'model-requests'))
    for (const file of await readdir(join(root, 'model-requests', profile!)))
      expect(await readFile(join(root, 'model-requests', profile!, file), 'utf8')).not.toContain(
        'synthetic-credential',
      )
  })
  it('bounds calls, bytes and retention and refuses oversized capture without changing inference', async () => {
    const root = await home()
    let now = 1000
    const limits = { callBytes: 2048, totalBytes: 8192, calls: 1, ttlMs: 100 }
    const store = new RequestTraceStore(root, 'local', limits, () => now)
    const first = await store.begin({ ...request(), system: 'distinct old prompt' })
    await first.finish()
    const oldHash = (await store.get('owned', first.id)).snapshot!.systemHash
    now++
    const second = await store.begin(request())
    await first.finish()
    second.event({ type: 'usage', response: { text: 'x'.repeat(3000) } })
    await second.finish()
    expect(JSON.stringify((await store.get('owned', second.id)).snapshot)).not.toContain('x'.repeat(3000))
    expect((await store.get('owned', first.id)).snapshot).toBeNull()
    expect((await store.get('owned', second.id)).snapshot).not.toBeNull()
    const huge = await store.begin({ ...request(), system: 'x'.repeat(3000) })
    await huge.finish()
    expect((await store.get('owned', huge.id)).snapshot).toBeNull()
    const quota = new RequestTraceStore(root, 'quota', { ...limits, callBytes: 128 * 1024 }, () => now)
    const refused = await quota.begin(request())
    expect((await quota.get('owned', refused.id)).snapshot).not.toBeNull()
    await refused.wire({ instructions: 'x'.repeat(12 * 1024) })
    refused.event({ type: 'done' })
    await refused.finish()
    expect((await quota.get('owned', refused.id)).snapshot).toBeNull()
    const quotaDirectory = join(root, 'model-requests', createHash('sha256').update('quota').digest('hex'))
    const crashed = join(quotaDirectory, `${refused.id}.call.json.${refused.id}.tmp`)
    await writeFile(crashed, 'x'.repeat(limits.totalBytes))
    const blocked = await quota.begin(request())
    expect((await quota.get('owned', blocked.id)).snapshot).toBeNull()
    await rm(crashed)
    now += 101
    expect((await store.get('owned', second.id)).snapshot).toBeNull()
    const directory = createHash('sha256').update('local').digest('hex')
    const stop = store.start()
    try {
      await expect
        .poll(async () =>
          (await readdir(join(root, 'model-requests', directory!))).includes(`${second.id}.call.json`),
        )
        .toBe(false)
    } finally {
      stop()
    }
    const last = await store.begin(request())
    await last.finish()
    const profile = createHash('sha256').update('local').digest('hex')
    const path = join(root, 'model-requests', profile!)
    // Unreferenced recent bodies survive row eviction, including explicit late finish.
    await expect(stat(join(path, `${oldHash}.blob.json`))).resolves.toBeDefined()
    await utimes(join(path, `${oldHash}.blob.json`), new Date(1000), new Date(1000))
    const collect = store.start()
    try {
      await expect
        .poll(async () =>
          stat(join(path, `${oldHash}.blob.json`)).then(
            () => true,
            () => false,
          ),
        )
        .toBe(false)
    } finally {
      collect()
    }
    const bytes = (
      await Promise.all((await readdir(path)).map(async (file) => (await stat(join(path, file))).size))
    ).reduce((sum, size) => sum + size, 0)
    expect(bytes).toBeLessThanOrEqual(limits.totalBytes)
  })
  it('validates profile settings, requires full-override confirmation and resets defaults independently', async () => {
    const root = await home()
    const store = new SystemPromptSettingsStore(root, 'a')
    expect(await store.read()).toEqual({})
    await store.save({ personaPrefix: 'first' })
    expect(await store.read()).toEqual({ personaPrefix: 'first' })
    await expect(store.save({ personaPrefix: 'x'.repeat(8193) })).rejects.toThrow('CONFIG_INVALID_INPUT')
    await expect(store.save({ fullOverride: 'replacement' })).rejects.toThrow('CONFIG_INVALID_INPUT')
    expect(await store.read()).toEqual({ personaPrefix: 'first' })
    await expect(
      store.save({ fullOverride: 'replacement', personaPrefix: 'conflict' }, true),
    ).rejects.toThrow('CONFIG_INVALID_INPUT')
    const unicode = { fullOverride: '汉'.repeat(65536) }
    await store.save(unicode, true)
    expect(await store.read()).toEqual(unicode)
    await store.save({ fullOverride: 'replacement' }, true)
    expect(await new SystemPromptSettingsStore(root, 'b').read()).toEqual({})
    await store.save({})
    expect(await store.read()).toEqual({})
  })
})
