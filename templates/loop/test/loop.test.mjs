import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveLoop } from '@agnes/host/author-testkit'
import { loop } from '../dist/index.js'

test('scripted model, checkpoint resume and unsupported codec', async () => {
  const result = await driveLoop(loop, {
    inputs: [{ content: [{ type: 'text', text: 'hello' }] }],
    replies: [
      [
        { type: 'text_delta', delta: 'Hello!' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  assert.deepEqual(result.events, [
    {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'Hello!' }], stopReason: 'end_turn' },
    },
  ])
  assert.equal(result.remainingReplies, 0)
  const resumed = await driveLoop(loop, { checkpoint: result.checkpoint })
  assert.equal(resumed.requests.length, 0)
  await assert.rejects(driveLoop(loop, { checkpoint: { codecVersion: 999, state: {} } }), /unsupported/)
})
