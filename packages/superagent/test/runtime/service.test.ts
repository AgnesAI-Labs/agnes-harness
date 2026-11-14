// The managed service's hold of the process's hook state across generations: a generation that stops late leaves its
// successor's state alone, and the last stop leaves Superagent's sessions refused with their live notes, never unguarded.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManagedInit } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { SessionDelivery } from '../../src/runtime/delivery.js'
import { createHookStateHolder } from '../../src/runtime/hook-state.js'
import { closeGeneration, DATABASE_FILE, startService } from '../../src/runtime/index.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A generation's start: its grant over a fake client, and the shutdown it registers. */
function generation() {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'superagent-service-'))
  dirs.push(stateDirectory)
  const shutdowns: ((reason: 'disable' | 'upgrade' | 'exit') => Promise<unknown>)[] = []
  const init = {
    bundledApp: {
      stateDirectory,
      // The SDK client a grant carries, as the service checks it.
      client: {
        ...fakeClient().client,
        initialize: async () => {},
        close: async () => {},
        clientId: async () => 'superagent',
      },
      channels: { subscribe: () => () => {} },
      assertCurrent: () => {},
    },
    onShutdown: (handler: (typeof shutdowns)[number]) => shutdowns.push(handler),
    ready: () => {},
  } as unknown as ProfileManagedInit
  return { init, stateDirectory, shutdown: (reason: 'disable' | 'upgrade') => shutdowns[0]!(reason) }
}
const log = { warn: () => {} }
const settled = () => new Promise((resolve) => setImmediate(resolve))

describe('the service generations', () => {
  it("leave a newer generation's hook state to it, and leave Superagent's sessions refused after the last stop", async () => {
    const holder = createHookStateHolder()
    const first = generation()
    const second = generation()
    // The second generation's store knows the main session and its live note from an earlier run.
    const store = openStore(join(second.stateDirectory, DATABASE_FILE))
    new SessionRegistry(store).record({ kind: 'orchestrator' }, 'superagent:orchestrator')
    new SessionDelivery({ sessions: { handle: () => Promise.reject(new Error('unused')) }, store }).notify(
      'superagent:orchestrator',
      { content: 'Settings saved' },
    )
    store.close()

    await startService(first.init, holder, log)
    await settled()
    await startService(second.init, holder, log)
    await settled()
    const current = holder.get()
    // The first generation's stop finishes only now, after the second took over.
    await first.shutdown('upgrade')
    expect(holder.get()).toBe(current)

    await second.shutdown('disable')
    const left = holder.get()
    const call = (sessionId: string) => left.guardTool({ sessionId, toolName: 'read', input: {} })
    expect(left.isSuperagentSession('superagent:orchestrator')).toBe(true)
    expect(call('superagent:orchestrator')).toMatch(/not running/)
    expect(left.promptSections('superagent:orchestrator')).toEqual({
      stable: [],
      liveNote: { id: 'superagent-notices', content: 'Settings saved' },
    })
    expect(left.isSuperagentSession('01OWNER')).toBe(false)
    expect(call('01OWNER')).toBeUndefined()
  })
})

describe("a generation's close", () => {
  it('closes the store even when leaving the stopped hook state fails', () => {
    const store = { close: vi.fn() }
    const hooks = {
      clear: () => {
        throw new Error('the store could not be read')
      },
    }
    expect(() => closeGeneration(hooks, store)).toThrow('the store could not be read')
    expect(store.close).toHaveBeenCalledOnce()
  })
})
