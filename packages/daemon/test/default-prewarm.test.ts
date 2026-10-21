import type { PackageAdminService } from '@agnes/daemon-admin/packages/index'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { DaemonNotice } from '@agnes/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultPrewarmNotifier } from '../src/supervisor/default-prewarm.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it.each(['inventory', 'activation', 'trust', 'resources', 'rebuilt'] as const)(
  'rechecks default preparation after a profile %s event and preserves the notice',
  async (reason) => {
    const commands: string[] = []
    const notices: unknown[] = []
    const notifier = defaultPrewarmNotifier(
      {
        prewarmSharedWorker: async () => ({
          command: async (method: string) => {
            commands.push(method)
          },
        }),
      },
      'p',
      {
        emit: (kind, info) => {
          notices.push({ kind, info })
        },
      },
    )
    const event = { profile: 'p', reason, revision: 'changed' }
    notifier.changed(event)
    await vi.advanceTimersByTimeAsync(0)
    expect(commands).toEqual(['runtime.prewarm'])
    expect(notices).toEqual([{ kind: 'packages_changed', info: { detail: event } }])
    notifier.changed({ ...event, profile: 'other' })
    await vi.advanceTimersByTimeAsync(0)
    expect(commands).toEqual(['runtime.prewarm'])
  },
)

it('handles application adopt/clear hints without surfacing a failed speculative start', async () => {
  const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const pool = {
    prewarmSharedWorker: async () => {
      throw new Error('synthetic start failure')
    },
  }
  const notifier = defaultPrewarmNotifier(pool, 'p', { emit(_kind: DaemonNotice['kind']) {} })
  try {
    expect(notifier.applicationChanged()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(diagnostic).toHaveBeenCalledWith('Default composition prewarm request failed')
  } finally {
    diagnostic.mockRestore()
  }
})

it.each(['adopt', 'clear'] as const)(
  'schedules preparation after application %s succeeds',
  async (action) => {
    const commands: string[] = []
    const notifier = defaultPrewarmNotifier(
      {
        prewarmSharedWorker: async () => ({
          command: async (method: string) => {
            commands.push(method)
          },
        }),
      },
      'p',
      { emit() {} },
    )
    const handlers = new Map<string, Parameters<LocalEndpoint['register']>[1]>()
    const endpoint = {
      register: (method: string, handler: Parameters<LocalEndpoint['register']>[1]) => {
        handlers.set(method, handler)
      },
    } as unknown as LocalEndpoint
    let refuse = true
    const service = {
      call: async () => {
        if (refuse) throw new Error('synthetic admin refusal')
        return { status: 'active' }
      },
    } as unknown as PackageAdminService
    notifier.registerAdmin(endpoint, service, () => undefined)
    const call = () => handlers.get(`_agnes/v1/applications.${action}`)!({ profile: 'p' }, {} as never)
    await expect(call()).rejects.toThrow('admin refusal')
    expect(commands).toEqual([])
    refuse = false
    await expect(call()).resolves.toEqual({ status: 'active' })
    await vi.advanceTimersByTimeAsync(0)
    expect(commands).toEqual(['runtime.prewarm'])
  },
)
