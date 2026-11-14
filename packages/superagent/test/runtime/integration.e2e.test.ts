// The whole plugin on a real daemon, from the shipped payload, with an explicit state directory and the daemon started
// with the agent's HOME and shims: a seeded request becomes a ticket whose worker session opens in its own directory;
// a disable through the package manager while the worker runs a turn and a job kills both within two seconds;
// enabling again reconciles and dispatches the interrupted assignment again; the worker's report ends the ticket, which
// the panel service shows.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { Paused } from '../../src/kv.js'
import { agentPaths } from '../../src/runtime/environment.js'
import { DATABASE_FILE } from '../../src/runtime/index.js'
import { TICKET_INSTRUCTIONS_FILE } from '../../src/runtime/instructions.js'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import {
  kvOf,
  ownerCalls,
  PACKAGE,
  PROFILE,
  readAll,
  seedTicket,
  sleep,
  ticketOf,
  tool,
  until,
  writeAgentCli,
} from './integration-fixtures.js'

afterAll(stopAllDaemons)

/** The Host's shutdown deadline for the service (the manifest's `shutdownTimeoutMs`). */
const SHUTDOWN_DEADLINE_MS = 5_000
/**
 * From asking for the disable to every Superagent session confirmed quiet. The stop starts as soon as the disable
 * reaches the worker; were it left to the next generation's publication it would start only about 5 s later.
 */
const DISABLE_TO_QUIET_MS = 2_000

it.skipIf(process.platform === 'win32')(
  'runs a ticket end to end, stops its worker on a disable and resumes it on enable',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-int-')))
    let handle: DaemonHandle | undefined
    try {
      const stateDir = join(root, 'state')
      const { home, shimsDir } = agentPaths(stateDir)
      mkdirSync(home, { recursive: true })
      const cli = writeAgentCli(root)
      const aghHome = join(root, 'agh')
      // The daemon runs as the deployment guide starts it: the agent's HOME, its shims first on PATH.
      const daemon = await startDaemon({
        aghHome,
        home,
        path: `${shimsDir}:${process.env.PATH ?? ''}`,
        plugins: ['./bundled-plugins/superagent'],
        onHandle: (started) => {
          handle = started
        },
      })
      const client = () => daemon.client
      const calls = ownerCalls(client)
      /** Superagent's GitHub skill as the platform lists it. */
      const listedSkill = async () => {
        const listed = (await client().call('_agnes/v1/resources.list', {
          profile: PROFILE,
          kind: 'skill',
        })) as {
          items: { name?: string; desired?: string; trust?: string; actual?: string }[]
        }
        return listed.items.find((item) => item.name === 'dsh-superagent-github')
      }
      const database = join(stateDir, DATABASE_FILE)
      const diagnose = async (error: unknown): Promise<never> => {
        const lines = daemon
          .stderr()
          .split('\n')
          .filter((line) => /superagent|Superagent|error/i.test(line))
        const status = await calls.service('superagent.status').catch((failure: unknown) => String(failure))
        const state = await calls
          .service('superagent.state')
          .then((answer) => JSON.stringify(answer.setup))
          .catch((failure: unknown) => String(failure))
        const facts = [
          `database in the state directory: ${existsSync(database)}`,
          `status: ${JSON.stringify(status)}`,
          `setup: ${state}`,
          `pause: ${JSON.stringify(kvOf(database, 'runtime-paused'))}`,
          `effects: ${JSON.stringify(readAll(database, 'SELECT kind, key, attempts, error FROM effect'))}`,
          `tickets: ${JSON.stringify(readAll(database, 'SELECT value FROM ticket'))}`,
          `worker health: ${JSON.stringify(await calls.service('superagent.overview').then((answer) => answer.health ?? answer, String))}`,
        ]
        throw new Error(`${String(error)}\n${facts.join('\n')}\n${lines.slice(-40).join('\n')}`, {
          cause: error,
        })
      }

      // Set the state directory, write the settings and a ticket there, and turn Superagent on.
      await calls.disable()
      await calls.configure({ stateDir })
      const ticketId = seedTicket(database, stateDir, cli)
      await calls.enable()
      const workerId = `superagent:worker:${ticketId}`
      await until('the worker session', () => calls.exists(workerId)).catch(diagnose)
      expect(existsSync(join(stateDir, 'home', '.gitconfig')), 'the agent environment is written').toBe(true)
      const main = await client().session.load('superagent:orchestrator', { history: 'none' })
      expect((await main.tools()).capabilities).toMatchObject({ preset: 'superagent-router' })
      const worker = await client().session.load(workerId, { history: 'none' })
      expect((await worker.tools()).capabilities).toMatchObject({
        preset: 'superagent-worker',
        bundles: [`${PACKAGE}#worker`],
      })

      // The ticket directory: prepared under the execution root, with the repository in repo/ and the instructions.
      const directory = ticketOf(database, ticketId)?.execution?.directory ?? ''
      expect(directory.startsWith(join(stateDir, 'work'))).toBe(true)
      expect(readFileSync(join(directory, 'repo', 'PREPARED'), 'utf8').trim()).toBe('prepared')
      expect(readFileSync(join(directory, TICKET_INSTRUCTIONS_FILE), 'utf8')).toContain(
        `# Ticket ${ticketId}`,
      )
      const userTurns = async () =>
        (await worker.projectUI()).nodes.filter(
          (node) => node.kind === 'user' && node.commandId?.startsWith('superagent:'),
        ).length
      await until('the assignment turn', async () => (await userTurns()) > 0)
      await until('the worker idle', async () => (await worker.projectUI()).opState === null)
      const answered = async (marker: string) =>
        until(`the tool result of ${marker}`, () =>
          daemon
            .modelRequests()
            .find((request) => request.lastRole === 'tool' && request.marker.includes(marker)),
        )
      // The worker runs in the ticket directory, as the agent.
      await worker.followUp(tool('w-where', 'shell', { command: 'pwd; echo "HOME=$HOME"; command -v gh' }))
      const where = (await answered('w-where')).toolResult ?? ''
      expect(where).toContain(directory)
      expect(where).toContain(`HOME=${home}`)
      expect(where).toContain(join(shimsDir, 'gh'))
      await until('the worker idle again', async () => (await worker.projectUI()).opState === null)

      // A background job, then a turn running a command, both of which would leave a mark if they went on: the stop
      // has to kill them, well before either ends by itself, rather than wait for them.
      const jobMark = join(root, 'job-ran')
      const turnMark = join(root, 'turn-ran')
      await worker.followUp(tool('w-job', 'shell', { command: `sleep 12; touch ${jobMark}` }))
      expect((await answered('w-job')).toolResult ?? '').toMatch(/job/i)
      await until('the worker idle after the job', async () => (await worker.projectUI()).opState === null)
      await worker.followUp(tool('w-turn', 'shell', { command: `sleep 9; touch ${turnMark}` }))
      await until('the worker turn running', async () => (await worker.projectUI()).opState != null)

      // Disable through the package manager while the worker runs.
      const began = Date.now()
      await calls.disable()
      const disableMs = Date.now() - began
      const paused = kvOf<Paused>(database, 'runtime-paused')
      const offset = (at: string | number | undefined) =>
        at === undefined ? 'none' : `+${Number(new Date(at)) - began} ms`
      const mark = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : undefined)
      console.info(
        [
          `disable took ${disableMs} ms; stop record ${JSON.stringify(paused?.stop)}`,
          `pause recorded ${offset(paused?.at)}; turn mark ${offset(mark(turnMark))}; job mark ${offset(mark(jobMark))}`,
        ].join('\n'),
      )
      // Every session was cancelled and its jobs killed from within the Host's shutdown, with the SDK client still
      // usable there: the stop read each session quiet again, within the bound, long before either command would
      // have ended by itself.
      expect(paused).toMatchObject({ assignments: [{ ticketId }] })
      expect(paused?.stop?.unstopped, 'every session confirmed quiet').toEqual([])
      expect(paused?.stop?.sessions).toBeGreaterThanOrEqual(2)
      expect(paused?.stop?.ms ?? Number.POSITIVE_INFINITY).toBeLessThan(SHUTDOWN_DEADLINE_MS)
      expect(Number(new Date(paused?.at ?? Number.NaN)) - began, 'disable to quiet').toBeLessThanOrEqual(
        DISABLE_TO_QUIET_MS,
      )
      const after = await client().session.load(workerId, { history: 'none' })
      expect((await after.projectUI()).opState).toBeNull()
      // Both commands were killed, not left to end.
      const jobs = (await after.jobsRead()).jobs
      const jobOf = (path: string) => jobs.find((job) => job.command.includes(path))
      console.info(
        `jobs after the disable: ${JSON.stringify(jobs.map(({ command, status, code }) => ({ command, status, code })))}`,
      )
      expect(jobs.filter((job) => job.status === 'running' && job.owner === 'agent')).toEqual([])
      expect(jobOf(jobMark)?.status, 'the background job was killed').toBe('killed')
      expect(jobOf(turnMark)?.status, "the turn's command was killed").toBe('killed')
      await sleep(8_000)
      console.info(`after the wait: turn mark ${offset(mark(turnMark))}; job mark ${offset(mark(jobMark))}`)
      expect(existsSync(jobMark), 'the killed job did not finish').toBe(false)
      expect(existsSync(turnMark), 'the cancelled turn did not finish').toBe(false)
      expect(ticketOf(database, ticketId)?.ended, 'a stopped ticket stays open').toBeUndefined()

      // Enabled again: the reconcile reads the worker by its real state and ends the pause. Its assignment waited for
      // input when the disable came (its turns had ended), so nothing is dispatched again; the ticket stays open and the
      // worker runs under the guard again.
      const before = await userTurns()
      await calls.enable()
      await until('the pause ended', () => kvOf<Paused>(database, 'runtime-paused') === undefined).catch(
        diagnose,
      )
      expect(await userTurns(), 'a waiting assignment is not dispatched again').toBe(before)
      expect(ticketOf(database, ticketId)?.assignments.at(-1)?.state).toBe('running')
      await worker.followUp(tool('w-back', 'shell', { command: 'echo back-again' }))
      expect((await answered('w-back')).toolResult ?? '').toContain('back-again')
      await until('the worker idle after the resume', async () => (await worker.projectUI()).opState === null)
      // The skills Superagent wrote into the AGH home when it started are readable by its sessions, once the platform
      // lists them ready (a read during a skills reload finds none).
      await until('the skill listed ready', async () => (await listedSkill())?.actual === 'ready')
      await worker.followUp(tool('w-skill', 'skill_read', { name: 'dsh-superagent-github' }))
      const skillText = (await answered('w-skill')).toolResult ?? ''
      console.info(`skill_read dsh-superagent-github: ${skillText.slice(0, 160).replace(/\s+/g, ' ')}`)
      expect(skillText).not.toContain('NOT_FOUND')
      expect(skillText).toContain('gh')
      await until('the worker idle after the skill', async () => (await worker.projectUI()).opState === null)

      // The worker reports; the ticket ends with that report, which the panel shows.
      await worker.followUp(
        tool('w-report', 'orchestrator_report', { state: 'ready', summary: 'E2E-REPORT done' }),
      )
      await answered('w-report')
      const ended = await until('the reported ticket', () => {
        const ticket = ticketOf(database, ticketId)
        return ticket?.ended ? ticket : undefined
      })
      expect(ended.ended).toMatchObject({ outcome: 'completed' })
      const detail = await calls.service('superagent.tickets.get', { id: ticketId })
      expect(detail).not.toHaveProperty('failure')
      expect(detail).toMatchObject({ id: ticketId, ended: { outcome: 'completed' } })
      expect(JSON.stringify(detail)).toContain('E2E-REPORT done')
      await until('the worker idle after the report', async () => (await worker.projectUI()).opState === null)
      await worker.followUp(tool('w-after', 'shell', { command: 'echo after' }))
      expect((await answered('w-after')).toolResult ?? '').toContain(
        'Ticket ended; new work needs a new authorized ticket',
      )

      // A disable with nothing running, for comparison: how long until the Host calls the service's shutdown.
      const idleBegan = Date.now()
      await calls.disable()
      const idlePause = kvOf<Paused>(database, 'runtime-paused')
      console.info(
        `idle disable took ${Date.now() - idleBegan} ms; pause recorded +${Number(new Date(idlePause?.at ?? 0)) - idleBegan} ms; stop record ${JSON.stringify(idlePause?.stop)}`,
      )
      expect(idlePause?.stop?.unstopped).toEqual([])

      // The skills Superagent wrote into the AGH home: what the platform makes of them.
      expect(existsSync(join(aghHome, 'skills', 'dsh-superagent-github', 'SKILL.md'))).toBe(true)
      const skill = await listedSkill()
      console.info(`dsh-superagent-github as the platform lists it: ${JSON.stringify(skill)}`)
      expect(skill).toMatchObject({ desired: 'enabled', trust: 'trusted', actual: 'ready' })
    } finally {
      await handle?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  480_000,
)
