import type { EmbeddingEncodeRequest } from '@agnes/protocol/runtime'
import { createEmbeddingConsumer, type EmbeddingFixtureOptions } from '../embedding-fixture.js'

// Test-only executable fixture for actual process recovery.
const options = JSON.parse(process.argv[2] ?? '') as EmbeddingFixtureOptions
const consumer = await createEmbeddingConsumer(options)
process.send?.({ ready: true, pid: process.pid, descriptor: consumer.descriptor })
process.on(
  'message',
  async (message: { id: number; method: string; input: EmbeddingEncodeRequest; mode?: string }) => {
    try {
      let result: unknown
      if (message.method === 'encode') result = await consumer.encode(message.input, message.mode)
      else if (message.method === 'reconcile')
        result = await consumer.encode(message.input, undefined, {}, true)
      else if (message.method === 'cancel') consumer.cancel()
      else if (message.method === 'stop') await consumer.stop()
      else throw Error('Unknown embedding fixture operation')
      process.send?.({ id: message.id, result })
    } catch (error) {
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : 'Embedding fixture error',
      })
    }
  },
)
