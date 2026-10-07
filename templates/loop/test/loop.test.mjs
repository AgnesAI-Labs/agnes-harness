import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
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
  assert.deepEqual(result.events, [{ type: 'reply', data: { text: 'Hello!' } }])
  assert.equal(result.remainingReplies, 0)
  const resumed = await driveLoop(loop, { checkpoint: result.checkpoint })
  assert.equal(resumed.requests.length, 0)
  await assert.rejects(driveLoop(loop, { checkpoint: { codecVersion: 999, state: {} } }), /unsupported/)
})
