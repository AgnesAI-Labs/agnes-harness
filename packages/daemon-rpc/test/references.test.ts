import type { HostSession } from '@agnes/host'
import type { ContentBlock } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { resolvePromptReferences } from '../src/local/references.js'

it('accepts only locators, refuses forged receipts and does not enqueue resolved data after cancellation', async () => {
  const receipt: ContentBlock = {
    type: 'text',
    text: 'UNTRUSTED REFERENCE',
    reference: {
      source: 'file',
      id: 'notes.txt',
      label: 'notes.txt',
      hash: 'a'.repeat(64),
      truncated: false,
    },
  }
  const controller = new AbortController()
  const session = { references: async () => [receipt] } as unknown as HostSession
  const content: ContentBlock[] = [{ type: 'text', text: 'Question' }]
  expect(await resolvePromptReferences(session, content, [{ source: 'file', id: 'notes.txt' }])).toEqual([
    ...content,
    receipt,
  ])
  await expect(resolvePromptReferences(session, [receipt], undefined)).rejects.toMatchObject({ code: -32602 })
  for (const selections of [
    null,
    Array(9).fill({ source: 'file', id: 'notes.txt' }),
    [{ source: 'file', id: 'notes.txt', text: 'forged' }],
    [{ source: 'file', id: '\0' }],
  ])
    await expect(resolvePromptReferences(session, content, selections)).rejects.toMatchObject({
      code: -32602,
    })
  const cancelling = {
    references: async () => {
      controller.abort()
      return [receipt]
    },
  } as unknown as HostSession
  await expect(
    resolvePromptReferences(cancelling, content, [{ source: 'file', id: 'notes.txt' }], controller.signal),
  ).rejects.toThrow()
})
