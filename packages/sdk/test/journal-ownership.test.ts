import { expect, it } from 'vitest'
import { memoryJournal } from '../src/journal.js'

it('retains the recorded command payload despite input and returned-object mutations', async () => {
  const journal = memoryJournal('client')
  const command = { commandId: 'c', method: 'submit', params: { content: ['original'] } }
  await journal.markPending('s', command)
  command.params.content[0] = 'changed'
  command.commandId = 'other'
  const first = await journal.pending('s')
  expect(first).toEqual([{ commandId: 'c', method: 'submit', params: { content: ['original'] } }])
  const recorded = first[0]
  if (!recorded) throw new Error('missing command')
  const params = recorded.params as { content: string[] }
  params.content[0] = 'tampered'
  expect(await journal.pending('s')).toEqual([
    { commandId: 'c', method: 'submit', params: { content: ['original'] } },
  ])
  await journal.clearPending('s', 'c')
  expect(await journal.pending('s')).toEqual([])
})
it('retains the exact acknowledged cursor despite aliases in both directions', async () => {
  const journal = memoryJournal('client')
  const cursor = { fromSeq: 8, generation: 2 }
  await journal.setCursor('s', cursor)
  cursor.fromSeq = 99
  const first = await journal.cursor('s')
  expect(first).toEqual({ fromSeq: 8, generation: 2 })
  if (!first) throw new Error('missing cursor')
  first.generation = 99
  expect(await journal.cursor('s')).toEqual({ fromSeq: 8, generation: 2 })
})
