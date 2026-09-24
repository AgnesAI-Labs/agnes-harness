import { describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { memoryJournal } from '../src/journal.js'
import type { PermissionRequest } from '../src/permission.js'
import { fakeEndpoint, flush, type Handler } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }
const init: Handler = fakeEndpoint({}).initialize

const permissionRequest = (): PermissionRequest => ({
  sessionId: 's1',
  toolCall: { toolCallId: 'tool-1', status: 'pending', title: 'Read a file' },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
})

describe('session.load permission registration', () => {
  it('answers a permission request that arrives before the load response', async () => {
    const request = permissionRequest()
    let loadResolved = false
    const f = fakeEndpoint({
      initialize: init,
      'session/load': (_params, { push }) => {
        push({ jsonrpc: '2.0', id: 'during-load', method: 'session/request_permission', params: request })
        return {}
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    try {
      const seen: PermissionRequest[] = []
      const session = await c.session.load('s1', {
        onPermissionRequest: async (incoming) => {
          expect(loadResolved).toBe(false)
          seen.push(incoming)
          return { optionId: 'allow' }
        },
      })
      loadResolved = true
      await flush()

      expect(session.id).toBe('s1')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ sessionId: 's1', toolCall: { toolCallId: 'tool-1' } })
      expect(f.calls.find((call) => call.method === '<response:during-load>')).toMatchObject({
        params: { result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
      })
    } finally {
      await c.close()
    }
  })

  it('removes the load-time handler when load fails', async () => {
    const request = permissionRequest()
    const f = fakeEndpoint({
      initialize: init,
      'session/load': () => {
        throw new Error('load failed')
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    try {
      await expect(
        c.session.load('s1', {
          onPermissionRequest: async () => ({ optionId: 'allow' }),
        }),
      ).rejects.toThrow('load failed')

      f.push({
        jsonrpc: '2.0',
        id: 'after-failed-load',
        method: 'session/request_permission',
        params: request,
      })
      await flush()

      // The fallback chooses the offered reject option once the failed load has disposed
      // the caller's handler. If the handler leaked, this would select `allow` instead.
      expect(f.calls.find((call) => call.method === '<response:after-failed-load>')).toMatchObject({
        params: { result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
      })
    } finally {
      await c.close()
    }
  })
})
