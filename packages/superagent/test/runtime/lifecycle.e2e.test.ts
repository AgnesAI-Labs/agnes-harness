import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { KV } from '../../src/kv.js'
import type { SessionAdapter } from '../../src/runtime/contracts.js'
import { verifyEnvironment } from '../../src/runtime/environment.js'
import { createHookStateCell } from '../../src/runtime/hook-state.js'
import { DATABASE_FILE, type SdkClient } from '../../src/runtime/index.js'
import { createLifecycle, sdkSessionControl, sessionsOnly } from '../../src/runtime/lifecycle.js'
import { startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { startGitHttpRemote } from '../fixtures/git-http-remote.js'
import { AGENT_CREDENTIAL } from '../fixtures/homes.js'
import { prepareAgentEnvironment } from './agent-environment.js'
import { fakeApp, ORCHESTRATOR, runningTicket, workerKey } from './lifecycle-fakes.js'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterAll(stopAllDaemons)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(label: string, probe: () => Promise<T> | T, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}
const tool = (marker: string, args: Record<string, unknown>) =>
  `[[${marker} TOOL${JSON.stringify({ name: 'shell', args })}ENDTOOL]]`

/**
 * The smallest session adapter over the real SDK client: the running state, the inbox with its command ids and the
 * running jobs come from the daemon, cancelling and dropping go to it. Opening and creating Sessions is not needed here.
 */
function sdkAdapter(client: () => SdkClient): SessionAdapter {
  const open = (id: string) => client().session.open(id)
  return {
    ensureOrchestrator: () => Promise.reject(new Error('not used')),
    ensureWorker: () => Promise.reject(new Error('not used')),
    async cancel(id) {
      await (await open(id)).cancel()
    },
    async state(id) {
      const session = await open(id)
      const ui = await session.projectUI()
      const { jobs } = await session.jobsRead()
      return {
        running: ui.opState != null,
        pending: (ui.pendingInputs ?? []).map((item) => ({
          itemId: item.itemId,
          ...(item.commandId ? { commandId: item.commandId } : {}),
        })),
        jobs: jobs.filter((job) => job.status === 'running').length,
      }
    },
    async dropPending(id, itemIds) {
      const session = await open(id)
      for (const itemId of itemIds) await session.removeQueued(itemId)
    },
  }
}

it.skipIf(process.platform === 'win32')(
  'disable mid-turn stops the push, the job and the queue; enable reconciles by real state and resumes a queued input once after a restart',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-lifecycle-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const remote = await startGitHttpRemote({ users: { [AGENT_CREDENTIAL.user]: AGENT_CREDENTIAL.password } })
    cleanups.push(() => remote.close())
    const env = await prepareAgentEnvironment(root, remote.url)
    const daemon = await startDaemon({
      aghHome: join(root, 'agh'),
      home: env.agentHome,
      path: env.path,
      plugins: [],
      onHandle: (handle) => cleanups.push(() => handle.stop()),
    })
    const client = () => daemon.client as unknown as SdkClient
    const ticketDir = join(root, 'exec', 'T-1')
    mkdirSync(ticketDir, { recursive: true })
    // The ticket's repository, cloned with the agent's credential (this also registers the ticket directory).
    expect(
      await daemon.shell(
        `git clone -q ${remote.url} repo && cd repo && git checkout -q -b work && echo y > y.txt && git add y.txt && git commit -q -m y && echo cloned`,
        ticketDir,
      ),
    ).toContain('cloned')
    const worker = await client().session.new({
      cwd: ticketDir,
      sessionKey: workerKey('T-1'),
      permission: 'full-access',
    })
    const orchestrator = await client().session.new({
      cwd: ticketDir,
      sessionKey: ORCHESTRATOR,
      permission: 'full-access',
    })
    const ids = [worker.id, orchestrator.id]

    const store = openStore(join(root, 'state', DATABASE_FILE))
    cleanups.push(() => store.close())
    store.tickets.save(
      runningTicket('T-1', {}, { execution: { name: 'T-1', directory: ticketDir, assignment: 'do it' } }),
    )
    const sessions = sdkAdapter(client)
    const build = (log: string[]) => {
      const app = fakeApp(log, () => ids)
      const hooks = createHookStateCell()
      const lifecycle = createLifecycle({
        store,
        sessions,
        control: sdkSessionControl(client()),
        hooks,
        hookState: sessionsOnly,
        environment: async () => ({ home: env.agentHome, shimsDir: env.shims, config: env.config }),
        createApp: () => app,
        writeEnvironment: (home, shims, cfg) => env.write(home, shims, cfg),
        verifyEnvironment: (home, shims, cfg) =>
          verifyEnvironment(home, shims, cfg, { HOME: env.agentHome, PATH: env.path }),
      })
      return { app, hooks, lifecycle }
    }

    // On: the environment is written and checked in the daemon's environment, and both sessions are registered.
    const firstLog: string[] = []
    const first = build(firstLog)
    await first.lifecycle.start()
    await first.lifecycle.settled()
    expect(first.lifecycle.status()).toEqual({ state: 'running' })
    expect(first.hooks.get().isSuperagentSession(worker.id)).toBe(true)

    // The worker leaves a background job that pushes later, then starts a turn that pushes when its command ends,
    // and a delivery arrives while it is busy.
    await worker.followUp(
      tool('JOB', {
        command: 'sleep 12; cd repo && git push origin work:refs/heads/agent/T-1-job 2>&1',
        background: true,
      }),
    )
    await until(
      'the agent job',
      async () => (await sessions.state(worker.id)).jobs === 1 && !(await sessions.state(worker.id)).running,
    )
    await worker.followUp(
      tool('TURN', { command: 'sleep 10; cd repo && git push origin work:refs/heads/agent/T-1 2>&1' }),
      {
        commandId: 'superagent:m-turn',
      },
    )
    await until('the turn running its command', () =>
      daemon
        .modelRequests()
        .some((request) => request.marker.startsWith('TURN') && request.lastRole === 'user'),
    )
    await sleep(1_000)
    await worker.steer('[[QUEUED a person wrote while the worker was busy]]', {
      commandId: 'superagent:m-queued',
    })
    const busy = await sessions.state(worker.id)
    expect(busy.running).toBe(true)
    expect(busy.pending.map((item) => item.commandId)).toEqual(['superagent:m-queued'])
    // The background job, and the turn's foreground command, which the daemon lists as a running job too.
    expect(busy.jobs).toBeGreaterThanOrEqual(1)
    first.app.poll()
    expect(first.app.polls).toBe(1)

    // Off, mid-turn.
    await first.lifecycle.stop('disable')
    // Past both deadlines (the turn's command and the job push at 10 s and 12 s): no push reached the remote.
    await sleep(14_000)
    const refs = await remote.refs()
    expect(refs, 'the cancelled turn did not push').not.toContain('refs/heads/agent/T-1')
    expect(refs, 'the killed job did not push').not.toContain('refs/heads/agent/T-1-job')
    expect(remote.authLog().some((line) => /POST \S*git-receive-pack/.test(line))).toBe(false)
    expect(await sessions.state(worker.id), 'no turn, nothing waiting, no job').toEqual({
      running: false,
      pending: [],
      jobs: 0,
    })
    // Nothing polled, sent or ran again, and the hooks no longer treat the session as Superagent's.
    first.app.poll()
    expect(first.app.polls).toBe(1)
    expect(daemon.modelRequests().some((request) => request.marker.startsWith('QUEUED'))).toBe(false)
    expect(first.hooks.get().isSuperagentSession(worker.id)).toBe(false)
    expect(store.get(KV.runtime.paused)).toMatchObject({
      reason: 'disable',
      assignments: [{ ticketId: 'T-1', assignmentId: 'a-T-1' }],
    })
    // The first start found the worker idle with its assignment running, and re-dispatched it once.
    expect(firstLog).toEqual(['app.start', 'interrupted T-1 a-T-1', 'app.stop disable'])

    // The same push from a session that was never stopped reaches the remote: the check above is not vacuous.
    expect(
      await daemon.shell(
        'cd repo && git push origin work:refs/heads/agent/control 2>&1; echo exit=$?',
        ticketDir,
      ),
    ).toContain('exit=0')
    expect(await remote.refs()).toContain('refs/heads/agent/control')

    // Busy main session, an input queued behind it, then a daemon restart: the turn ends, the input stays queued.
    await orchestrator.followUp(tool('ORCH', { command: 'sleep 20' }))
    await until('the main session turn', async () => (await sessions.state(orchestrator.id)).running)
    await orchestrator.followUp('[[RESUMED queued before the restart]]', { commandId: 'superagent:m-resume' })
    await daemon.restart()
    const restarted = await sessions.state(orchestrator.id)
    expect(restarted.running).toBe(false)
    expect(restarted.pending.map((item) => item.commandId)).toEqual(['superagent:m-resume'])

    // On again: the worker (idle, aborted mid-work) is re-dispatched once; the main session's queued input runs once.
    const secondLog: string[] = []
    const second = build(secondLog)
    await second.lifecycle.start()
    await second.lifecycle.settled()
    expect(second.lifecycle.status()).toEqual({ state: 'running' })
    expect(secondLog).toEqual(['app.start', 'interrupted T-1 a-T-1'])
    await until('the resumed input', () =>
      daemon.modelRequests().some((request) => request.marker.startsWith('RESUMED')),
    )
    await until('the main session to settle', async () => {
      const state = await sessions.state(orchestrator.id)
      return !state.running && state.pending.length === 0
    })
    expect(
      daemon
        .modelRequests()
        .filter((request) => request.marker.startsWith('RESUMED') && request.lastRole === 'user'),
    ).toHaveLength(1)
    expect(store.get(KV.runtime.paused), 'the reconcile ends the pause').toBeUndefined()

    await second.lifecycle.stop('shutdown')

    // A ticket that ends keeps its workspace and session: a person's later reply resumes it in the same session and
    // directory.
    store.tickets.save({
      ...store.tickets.get('T-1')!,
      ended: { at: new Date().toISOString(), by: 'human', outcome: 'stopped' },
    })
    const listed = async () => (await client().workspace.list()).items.map((item) => realpathSync(item.path))
    await second.lifecycle.ticketEnded('T-1')
    expect(await listed(), 'the ended ticket keeps its workspace').toContain(ticketDir)
    const resumed = await client().session.open(worker.id)
    await resumed.followUp(tool('RESUME', { command: 'pwd' }), { commandId: 'superagent:m-reply' })
    const answered = await until('the resumed worker turn', () =>
      daemon
        .modelRequests()
        .find((request) => request.marker.startsWith('RESUME') && request.lastRole === 'tool'),
    )
    expect(answered.toolResult, 'the same session works in the same directory').toContain(ticketDir)
    await until('the resumed turn to end', async () => !(await sessions.state(worker.id)).running)

    // Once retention archived its conversation (here: ended more than 14 days ago, no thread left), it is retired.
    store.tickets.save({
      ...store.tickets.get('T-1')!,
      ended: { at: new Date(Date.now() - 15 * 24 * 3600_000).toISOString(), by: 'human', outcome: 'stopped' },
    })
    await second.lifecycle.ticketEnded('T-1')
    expect(await listed(), 'the retired ticket loses its workspace').not.toContain(ticketDir)
    await daemon.stop()
  },
  240_000,
)
