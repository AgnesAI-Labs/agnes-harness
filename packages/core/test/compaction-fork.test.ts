import type { ModelRecord } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, readTool, testFsOps } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const signal = () => new AbortController().signal

const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  // Wide enough that only the explicit request below compacts, never the threshold.
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }

it('compacts a fork child over the tool results it inherited from its parent', async () => {
  const provider = fakeProvider([
    toolTurn('read', { path: 'a.txt' }),
    toolTurn('read', { path: 'b.txt' }),
    textTurn('parent done'),
    toolTurn('read', { path: 'c.txt' }),
    textTurn('child done'),
    textTurn('S'),
  ])
  Object.assign(provider, { models: () => [model()] })
  const storage = new MemoryStorage()
  const k = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  k.tools.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
  const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
  await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'read two files' }], actor })
  expect((await parent.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  const inheritedResult = parent
    .surface()
    .filter((node) => node.kind === 'tool_result')
    .at(-1)?.seq
  if (inheritedResult === undefined) throw new Error('parent wrote no tool result')

  const child = await k.session('child', {
    ...sessionOpts,
    writerRunId: 'r2',
    parent: { key: 'parent', boundarySeq: parent.lastSeq },
  })
  // The child's ledger state starts empty of calls; its surface carries the parent's prefix.
  expect(child.surface().some((node) => node.seq === inheritedResult)).toBe(true)
  await child.enqueue('next-turn', { content: [{ type: 'text', text: 'and one more' }], actor })
  expect((await child.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')

  child.compaction = new CompactionRunner({
    plan: async (payload) => {
      const nodes = payload.getSurface()
      const end = nodes.findIndex((node) => node.seq === inheritedResult)
      const first = nodes[0]
      const kept = nodes[end + 1]
      if (!first || !kept) throw new Error('the inherited prefix is not on the child surface')
      return {
        keepFromSeq: kept.seq,
        summarizeRange: [first.seq, inheritedResult],
        prompts: { system: 'S', history: 'summarize it' },
        maxTokens: 100,
        details: { readFiles: [], modifiedFiles: [] },
      }
    },
    onCompact: async () => undefined,
  })
  await child.requestCompaction({ actor, admissionId: 'fork-compaction' })
  expect((await child.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')

  const rows = await child.d.log.scan({ fromSeq: parent.lastSeq + 1, limit: 500 })
  expect(rows.filter((row) => row.type === 'x/core/compaction-failed').map((row) => row.data)).toEqual([])
  const replace = rows.find((row) => typeof row.surfaceOp === 'object')
  expect(replace?.surfaceOp).toMatchObject({ op: 'replace', end: inheritedResult })
  expect(child.surface()[0]?.kind).toBe('summary')
  expect(child.surface().some((node) => node.seq === inheritedResult)).toBe(false)
  await k.close()
})
