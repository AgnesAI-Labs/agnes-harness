// A server the test answers by hand: a request waits until the test replies to it, and the test
// can push notifications at any moment in between.
import { localAuth } from '../../src/auth.js'
import { type Client, createClient } from '../../src/client.js'
import { memoryJournal } from '../../src/journal.js'
import { fakeEndpoint } from './fake-endpoint.js'

export type ScriptedServer = {
  /** Pushes one server-to-client notification. */
  notify(method: string, params: unknown): void
  /** Answers the oldest unanswered request for `method`. */
  reply(method: string, result: unknown): void
  /** Fails the oldest unanswered request for `method` with a JSON-RPC error. */
  fail(method: string, error: { code: number; message: string; data?: Record<string, unknown> }): void
  /** The params of every request received for `method`, in order. */
  received(method: string): unknown[]
}

export async function clientWithScriptedServer(
  ready: Record<string, (params: unknown) => unknown> = {},
  timeouts?: { request?: number; initialize?: number },
): Promise<{ client: Client; server: ScriptedServer }> {
  const waiting = new Map<string, Array<{ resolve(v: unknown): void; reject(e: unknown): void }>>()
  const seen = new Map<string, unknown[]>()
  const held =
    (method: string) =>
    (params: unknown): Promise<unknown> => {
      seen.set(method, [...(seen.get(method) ?? []), params])
      return new Promise((resolve, reject) => {
        waiting.set(method, [...(waiting.get(method) ?? []), { resolve, reject }])
      })
    }
  const fake = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    ...ready,
    'session/load': held('session/load'),
    '_agnes/v1/session.storedOpening': held('_agnes/v1/session.storedOpening'),
    '_agnes/v1/session.verifyHistory': held('_agnes/v1/session.verifyHistory'),
    '_agnes/v1/session.exportRaw': held('_agnes/v1/session.exportRaw'),
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: fake.endpoint },
    journal: memoryJournal(),
    authProviders: { local: () => localAuth() },
    ...(timeouts ? { timeouts } : {}),
  })
  const next = (method: string) => {
    const pending = waiting.get(method)?.shift()
    if (!pending) throw new Error(`no pending ${method} request`)
    return pending
  }
  const server: ScriptedServer = {
    notify: (method, params) => fake.push({ jsonrpc: '2.0', method, params } as never),
    reply: (method, result) => next(method).resolve(result),
    fail: (method, error) => next(method).reject(error),
    received: (method) => seen.get(method) ?? [],
  }
  return { client, server }
}
