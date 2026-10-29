import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { HostSession } from '@agnes/host'
import type { ContentBlock } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { resolvePromptReferences } from '../src/local/references.js'
import { registerWorkspaceFiles } from '../src/local/workspace-files.js'

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

it('cancels only the matching session reference request', async () => {
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'tester' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  const signals = new Map<string, AbortSignal>()
  const replies = new Map<string, (value: unknown) => void>()
  const listings: Array<{ operation: string; path: string; browse: boolean }> = []
  const session = (id: string) =>
    ({
      references: (_operation: string, _query: unknown, signal: AbortSignal) => {
        signals.set(id, signal)
        return new Promise((resolve) => replies.set(id, resolve))
      },
      workspaceFiles: (operation: string, path: string, browse: boolean) => {
        listings.push({ operation, path, browse })
        return Promise.resolve({
          path,
          observedAt: new Date().toISOString(),
          revision: 'test',
          gitStatus: 'unavailable',
          truncated: false,
          entries: [],
        })
      },
    }) as unknown as HostSession
  const sessions = new Map([
    ['one', session('one')],
    ['two', session('two')],
  ])
  registerWorkspaceFiles(
    ep,
    {
      registry: {
        require: (id) => {
          const found = sessions.get(id)
          if (!found) throw new Error('Unknown test session')
          return { session: found }
        },
      },
    },
    () => {},
  )
  const request = (id: number, method: string, params: unknown) => ({
    jsonrpc: '2.0' as const,
    id,
    method,
    params,
  })
  const one = ep.handle(
    request(1, '_agnes/v1/session.references.searchCancelable', {
      sessionId: 'one',
      query: 'x',
      requestId: 'same',
    }),
  )
  const two = ep.handle(
    request(2, '_agnes/v1/session.references.searchCancelable', {
      sessionId: 'two',
      query: 'x',
      requestId: 'same',
    }),
  )
  await vi.waitFor(() => expect(signals.size).toBe(2))
  await ep.handle(request(3, '_agnes/v1/session.references.cancel', { sessionId: 'one', requestId: 'same' }))
  expect(signals.get('one')?.aborted).toBe(true)
  expect(signals.get('two')?.aborted).toBe(false)
  replies.get('one')?.({ items: [], truncated: false })
  replies.get('two')?.({ items: [], truncated: false })
  await Promise.all([one, two])
  await ep.handle(request(4, '_agnes/v1/session.workspace.browse', { sessionId: 'one', path: 'src' }))
  await ep.handle(request(5, '_agnes/v1/session.workspace.list', { sessionId: 'one', path: 'src' }))
  expect(listings).toEqual([
    { operation: 'list', path: 'src', browse: true },
    { operation: 'list', path: 'src', browse: false },
  ])
})
