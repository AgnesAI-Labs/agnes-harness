// A stop of a few dozen real sessions on a real daemon: 36 Superagent sessions each run a turn with a long foreground
// command, and the lifecycle's stop, through the real session adapter and the owner's SDK client, cancels every turn
// and confirms every session quiet within the 4-second stop budget, below the Host's 5-second shutdown deadline.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { KV } from '../../src/kv.js'
import { createHookStateCell } from '../../src/runtime/hook-state.js'
import { DATABASE_FILE, type SdkClient } from '../../src/runtime/index.js'
import { createLifecycle, sdkSessionControl, sessionsOnly } from '../../src/runtime/lifecycle.js'
import { type SessionClient, SessionRegistry, Sessions } from '../../src/runtime/sessions.js'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { tool, until } from './integration-fixtures.js'
import { fakeApp } from './lifecycle-fakes.js'

afterAll(stopAllDaemons)

const SESSIONS = 36
/** The lifecycle's stop budget, below the Host's shutdown deadline. */
const STOP_BUDGET_MS = 4_000

it.skipIf(process.platform === 'win32')(
  `stops ${SESSIONS} running sessions within the stop budget`,
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-stop-')))
    let handle: DaemonHandle | undefined
    const store = openStore(join(root, DATABASE_FILE))
    try {
      const home = join(root, 'home')
      const work = join(root, 'work')
      mkdirSync(home)
      mkdirSync(work)
      const daemon = await startDaemon({
        aghHome: join(root, 'agh'),
        home,
        path: process.env.PATH ?? '',
        plugins: [],
        onHandle: (started) => {
          handle = started
        },
      })
      const client = daemon.client as unknown as SdkClient
      await client.workspace.add(work)
      const registry = new SessionRegistry(store)
      // The sessions, each with a turn whose command runs far longer than the test.
      const ids: string[] = []
      for (let n = 0; n < SESSIONS; n++) {
        const session = await client.session.new({
          cwd: work,
          sessionKey: `superagent:worker:T-${n}`,
          permission: 'full-access',
        })
        registry.record({ kind: 'worker', ticketId: `T-${n}` }, session.id)
        ids.push(session.id)
      }
      await Promise.all(
        ids.map(async (id) =>
          (await client.session.load(id, { history: 'none' })).followUp(
            tool(`stop-${id}`, 'shell', { command: 'sleep 50' }),
          ),
        ),
      )
      const sessions = new Sessions({
        client: client as unknown as SessionClient,
        registry,
        orchestratorDir: () => work,
        prepareCommand: () => '',
        environment: () => ({}),
        lifetime: new AbortController().signal,
      })
      await until('every turn running its command', async () =>
        (await Promise.all(ids.map((id) => sessions.state(id)))).every((state) => state.running),
      )
      const log: string[] = []
      const lifecycle = createLifecycle({
        store,
        sessions,
        control: sdkSessionControl(client),
        hooks: createHookStateCell(),
        hookState: sessionsOnly,
        environment: async () => ({
          stateDir: root,
          account: { login: 'agent-bot', email: 'a@x', blocked: [] },
        }),
        writeEnvironment: async () => {},
        verifyEnvironment: async () => {},
        archive: () => ({ archived: 0 }),
        createApp: () => fakeApp(log, () => registry.ids()),
        log: { warn: (text) => log.push(`warn ${text}`) },
      })
      await lifecycle.start()
      await lifecycle.settled()
      expect(lifecycle.status()).toEqual({ state: 'running' })

      const began = Date.now()
      await lifecycle.stop('disable')
      const took = Date.now() - began
      const stop = store.get(KV.runtime.paused)?.stop
      console.info(`stopping ${SESSIONS} sessions took ${took} ms; stop record ${JSON.stringify(stop)}`)
      expect(took).toBeLessThan(STOP_BUDGET_MS + 500)
      expect(stop).toMatchObject({ sessions: SESSIONS, unstopped: [] })
      expect(log.filter((line) => line.startsWith('warn'))).toEqual([])
      const states = await Promise.all(ids.map((id) => sessions.state(id)))
      expect(states.filter((state) => state.running || state.jobs > 0)).toEqual([])
    } finally {
      store.close()
      await handle?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  360_000,
)
