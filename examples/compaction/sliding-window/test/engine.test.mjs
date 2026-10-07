import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slidingWindow } from '../dist/index.js'

test('retains the last N turns, pinned context and tool pairs without using a model', async () => {
  const engine = slidingWindow(1).create()
  const nodes = [1, 2, 3].flatMap((turn) =>
    ['user', 'assistant'].map((kind, i) => ({
      seq: turn * 2 + i,
      kind,
      turn,
      pinned: false,
      tokensEstimate: 40,
      data: { content: [{ type: 'text', text: 'history' }] },
    })),
  )
  const input = {
    conversation: nodes,
    system: 'Keep this system context.',
    budget: { contextTokens: 240, contextWindow: 200, reserveTokens: 40, keepRecentTokens: 80 },
    beforeCompact: {},
  }
  const ports = {
    signal: new AbortController().signal,
    model: {
      summarize() {
        throw new Error('must not call model')
      },
    },
  }
  assert.equal(engine.shouldCompact(input.budget), true)
  assert.deepEqual((await engine.compact(input, ports)).range, [2, 5])
  nodes[2].pinned = true
  assert.deepEqual((await engine.compact(input, ports)).range, [2, 3])
  nodes[2].pinned = false
  nodes[4].kind = 'tool_result'
  assert.deepEqual((await engine.compact(input, ports)).range, [2, 4])
  nodes[0].pinned = true
  assert.equal(await engine.compact(input, ports), null)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(engine.compact(input, { ...ports, signal: cancelled.signal }), { name: 'AbortError' })
  assert.equal(input.system, 'Keep this system context.')
})
