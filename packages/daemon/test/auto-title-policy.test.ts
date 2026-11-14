import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPreferencesStore } from '@agnes/daemon-foundation/storage/session-preferences'
import { expect, it } from 'vitest'
import { createWorkerRequests } from '../src/supervisor/assembly-worker-requests.js'

it('reads only the bound active session title policy and fails closed on missing authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-title-policy-'))
  const preferences = new SessionPreferencesStore()
  const active = new Set(['automatic', 'named', 'fork-name'])
  preferences.rename('named', 'My explicit name')
  preferences.rename('fork-name', 'Application fork name')
  const state = {
    o: { config: { dataDir: root }, profile: { name: 'p' } },
    ownerHome: root,
    conns: new Set(),
    workspaces: new Map(),
    sessionOwnership: { resolve: (key: string) => (active.has(key) ? { active: true } : undefined) },
    workspaceCatalog: {},
    resourceControlDirectory: root,
    resourceControl: { service: {} },
    notices: { emit: () => undefined },
    inflightConn: new Map(),
    pool: { businessWorker: () => undefined },
    registry: {},
    prompter: {},
    profilePorts: { managedSessions: {} },
    savedSkills: { installers: {} },
    preferences,
  }
  const dispatch = createWorkerRequests(state as never, { own: () => undefined } as never)
  const read = (sessionKey: string, params: unknown = {}) =>
    dispatch(
      sessionKey,
      {
        kind: 'request',
        sessionKey,
        requestId: 'title-policy',
        method: 'auto-title-eligible',
        params,
      } as never,
      new AbortController().signal,
      undefined as never,
    )
  try {
    await expect(read('automatic')).resolves.toBe(true)
    await expect(read('named')).resolves.toBe(false)
    await expect(read('fork-name')).resolves.toBe(false)
    await expect(read('missing')).resolves.toBe(false)
    // Model-accessible params cannot retarget the worker's bound session.
    await expect(read('named', { sessionKey: 'automatic' })).resolves.toBe(false)
    active.delete('automatic')
    await expect(read('automatic')).resolves.toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
