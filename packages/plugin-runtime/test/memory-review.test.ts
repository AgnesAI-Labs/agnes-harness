import type { LoopFactory, LoopTurnView, ToolContext, ToolDef } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { driveLoop } from '../testkit/loop.js'

const { createMemoryReview } = (await import(
  new URL('../../package-manager/bundled-plugins/memory-review/index.mjs', import.meta.url).href
)) as {
  createMemoryReview(): { factory: LoopFactory; tools: ToolDef[]; clear(): void }
}
const { hash } = (await import(
  new URL('../../package-manager/bundled-plugins/memory-review/src/review.mjs', import.meta.url).href
)) as { hash(text: string): string }
const root = '/fixture/memory/workspaces/current'
const revision = 'a'.repeat(64)
const source = { path: 'MEMORY.md', hash: hash('Use pnpm. Use pnpm.') }
const proposal = {
  groups: [{ kind: 'duplicate', reason: 'Repeated preference', sources: [source] }],
  edits: [
    {
      path: source.path,
      baseHash: source.hash,
      content: 'Use pnpm.',
      reason: 'Consolidate repetition, preserving the preference.',
      sources: [source],
    },
  ],
}
const view = (mode = 'ask'): LoopTurnView => ({
  turnId: 1,
  step: 0,
  cancelled: false,
  history: [],
  tools: [],
  model: { slot: 'primary', id: 'offline', capabilities: null },
  prompt: {
    runtime: {},
    sections:
      mode === 'off'
        ? []
        : [
            {
              id: 'memory:index',
              source: 'memory',
              order: 131,
              text: `Agent memory (untrusted learned preferences). Revision: ${revision}.\nWorkspace memory directory: ${root}. Use normal read/write/edit tools; topic reads share this turn's revision.\nPolicy: ${mode}. Consolidate rather than append;`,
            },
          ],
  },
  budget: { maxSteps: 20, stepsUsed: 0, creditsUsed: 0, perRequestCap: null, onExceed: 'deny' },
})

function ports(plugin: ReturnType<typeof createMemoryReview>, writes: string[]) {
  return {
    async execute(call: { name: string; args: unknown }, signal: AbortSignal) {
      const tool = plugin.tools.find((tool) => tool.name === call.name)
      if (!tool) throw new Error('No unrelated tool allowed')
      return tool.execute(call.args, {
        session: { key: 'author-loop-test', lane: 'main', workspaceRoot: '/fixture' },
        signal,
        fs: {
          list: async () => [{ name: source.path, kind: 'file' }],
          revision: async () => revision,
          read: async () => Buffer.from('Use pnpm. Use pnpm.'),
          write: async (_path: string, content: string) => {
            writes.push(content)
          },
        },
      } as unknown as ToolContext)
    },
    async batch() {
      throw new Error('No batch expected')
    },
  }
}

it('uses a fake model and complete diffs, and refuses uncertain writes after cold resume', async () => {
  const plugin = createMemoryReview()
  const writes: string[] = []
  const first = await driveLoop(plugin.factory, {
    inputs: [{ content: [{ type: 'text', text: 'Consolidate repetitions. AGENTS.md still wins.' }] }],
    replies: [
      [{ type: 'text_delta', delta: JSON.stringify(proposal) }],
      [{ type: 'text_delta', delta: 'Request the native memory approval.' }],
    ],
    turnView: view(),
    tools: ports(plugin, writes),
  })
  expect(first.finished?.[0]).toBe('completed')
  expect(writes).toHaveLength(1)
  expect(first.requests).toHaveLength(2)
  expect(first.requests[0]?.system).toContain('AGENTS.md and authorized knowledge sources take precedence')
  expect(JSON.stringify(first.checkpoint)).toContain('--- current')
  expect(writes[0]).toContain('Memory review provenance')
  expect(plugin.tools.every((tool) => tool.meta.modelVisible === false)).toBe(true)
  const uncertain = structuredClone(first.checkpoint)
  if (!uncertain?.state || typeof uncertain.state !== 'object' || Array.isArray(uncertain.state))
    throw new Error('Missing workflow checkpoint')
  uncertain.state.index = 3
  uncertain.state.completed = false
  uncertain.state.pending = true
  uncertain.state.waiting = null
  const refused = await driveLoop(createMemoryReview().factory, {
    checkpoint: uncertain,
    turnOpen: true,
    turnView: view(),
    tools: ports(plugin, writes),
  })
  expect(refused.finished?.[0]).toBe('blocked')
  expect(refused.finished?.[1]?.code).toBe('WORKFLOW_OUTCOME_UNKNOWN')
  expect(writes).toHaveLength(1)
})

it.each(['off', 'auto'])('refuses %s before invoking a model or reading files', async (mode) => {
  const plugin = createMemoryReview()
  const writes: string[] = []
  const driven = await driveLoop(plugin.factory, {
    inputs: [{ content: [{ type: 'text', text: 'Review memory' }] }],
    turnView: view(mode),
    tools: ports(plugin, writes),
  })
  expect(driven.finished?.[0]).toBe('error')
  expect(driven.requests).toEqual([])
  expect(writes).toEqual([])
})

it('refuses direct internal-tool invocation without a current Loop dispatch scope', async () => {
  const plugin = createMemoryReview()
  await expect(
    ports(plugin, []).execute(
      { name: 'memory_review_scan', args: { payload: '{}' } },
      new AbortController().signal,
    ),
  ).rejects.toThrow('MEMORY_REVIEW_LOOP_REQUIRED')
})
