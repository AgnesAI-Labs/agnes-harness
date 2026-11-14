// Adapted from dsh-superagent (MIT)
/**
 * Reading Feishu threads, messages and chat history through lark-cli (source `sources/feishu-read.ts`).
 * The Feishu Source keeps its lark-cli calls until it is rewired to the channels of the host; these cases are moved
 * from the prototype's tests and rewritten with that change.
 */
import { describe, it } from 'vitest'

describe('feishu-read', () => {
  it.todo(
    'resolves legacy source metadata and reads merged forwards without embedding automatic thread expansion',
  )
  it.todo('paginates source thread messages with opaque cursors and retains authors and edited timestamps')
  it.todo('skips and counts a topic message it cannot read, and reads the others')
  it.todo('rejects unrelated paths, missing sources, cross-chat results, and incomplete pagination')
  it.todo('reports absent parent/thread and deleted content explicitly')
  it.todo('reads only the source message link and rejects absent, deleted or cross-chat results')
  it.todo(
    'reads a topic page as messages a model reads: id, author, ISO time, text and the message each answers',
  )
  it.todo(
    'reads the chat around a message by time: five before it, the message and five after, then earlier pages',
  )
})
