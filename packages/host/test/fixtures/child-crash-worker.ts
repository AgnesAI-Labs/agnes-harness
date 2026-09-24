import { writeFileSync } from 'node:fs'
import { Kernel, presetDefaults } from '@agnes/core'
import { fakeProvider, fakeSeams, fencedFs, noTimers, testFsPolicy, textTurn } from '@agnes/core/testkit'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const dbFile = process.argv[2]
const readyFile = process.argv[3]
if (!dbFile || !readyFile) throw new Error('usage: child-crash-worker <db> <ready>')

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const provider = fakeProvider([textTurn('root'), textTurn('child')])
Object.assign(provider, {
  models: () => [
    {
      id: 'm1',
      name: 'm1',
      api: 'openai-completions',
      route: 'default',
      baseUrl: 'https://example.invalid/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 128,
      toolCallFormats: ['native'],
      thinkingReplay: 'native',
      contract_id: null,
    },
  ],
})
const storage = createSqliteStorage({ file: dbFile })
const k = Kernel.create({
  storage,
  seams: fakeSeams(),
  provider,
  contract: { contract_id: null, parser_version: '1' },
  preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 4 },
  fsOps: fencedFs(
    {
      read: async () => new Uint8Array(),
      write: async () => undefined,
      list: async () => [],
      stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
    },
    testFsPolicy('/w'),
  ),
  netFetch: async () => new Response(''),
  logger,
  timers: noTimers,
  clock: () => Date.now(),
})
const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const parent = await k.session('parent', {
  actor,
  resolvedProfileHash: 'h1',
  cwd: '/w',
  writerRunId: 'r1',
})
const live = await parent.d.children.createWithKind?.('spawn', {
  parent: parent.key,
  cwd: '/w',
  input: 'stay-alive',
})
const cancelled = await parent.d.children.createWithKind?.('spawn', {
  parent: parent.key,
  cwd: '/w',
  input: 'stop-me',
})
if (!live || !cancelled) throw new Error('createWithKind unavailable')
await cancelled.cancel?.()
const rec = await storage.lookupByKey(live.key)
writeFileSync(
  readyFile,
  JSON.stringify({
    liveKey: live.key,
    cancelledKey: cancelled.key,
    rootTaskId: rec?.rootTaskId ?? '',
  }),
)
setInterval(() => undefined, 1000)
