import { describe, expect, it } from 'vitest'
import { notifyLiveSessionWorkers } from '../src/notify.js'

describe('notifyLiveSessionWorkers', () => {
  it('sends a resource.stale command (no payload) to every live activation link', async () => {
    const calls: Array<{ sessionKey: string; method: string; params: unknown }> = []
    const pool = {
      activationLinks: () => [
        {
          sessionKey: 's1',
          generation: 1,
          link: {
            command: async (method: string, params: unknown) => {
              calls.push({ sessionKey: 's1', method, params })
              return {}
            },
          },
        },
        {
          sessionKey: 's2',
          generation: 3,
          link: {
            command: async (method: string, params: unknown) => {
              calls.push({ sessionKey: 's2', method, params })
              return {}
            },
          },
        },
      ],
    }
    const failedSessionKeys = await notifyLiveSessionWorkers(pool)
    expect(calls).toMatchObject([
      { sessionKey: 's1', method: 'resource.stale', params: {} },
      { sessionKey: 's2', method: 'resource.stale', params: {} },
    ])
    expect(failedSessionKeys).toEqual([])
  })

  it('logs and continues past a worker whose notification fails, instead of aborting the rest, and reports it as failed', async () => {
    const notified: string[] = []
    const pool = {
      activationLinks: () => [
        {
          sessionKey: 'bad',
          generation: 1,
          link: { command: async () => Promise.reject(new Error('boom')) },
        },
        {
          sessionKey: 'good',
          generation: 1,
          link: {
            command: async (method: string) => {
              notified.push(method)
              return {}
            },
          },
        },
      ],
    }
    const warnings: unknown[] = []
    const failedSessionKeys = await notifyLiveSessionWorkers(pool, {
      warn: (message: string, detail?: unknown) => warnings.push({ message, detail }),
    })
    expect(notified).toEqual(['resource.stale'])
    expect(warnings).toHaveLength(1)
    expect(failedSessionKeys).toEqual(['bad'])
  })

  it('resolves with an empty failed-keys list when no session workers are currently live', async () => {
    await expect(notifyLiveSessionWorkers({ activationLinks: () => [] })).resolves.toEqual([])
  })
})
