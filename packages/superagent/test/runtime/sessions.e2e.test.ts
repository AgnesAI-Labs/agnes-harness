// The shipped payload on a real daemon, with the state in the default directory the platform gives Superagent
// (`<data directory>/bundled-apps/<key>`) and the daemon started with the agent's HOME and shims there: Superagent opens
// its main session and a dispatched ticket's worker session with their role bundles, the worker's foreground command
// moves to the background after 5 seconds, and its orchestrator_report reaches the service through the tool's handle,
// is relayed to the main session and shows on the panel.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, it } from 'vitest'
import { SERVICE_ID } from '../../src/runtime/index.js'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import {
  ownerCalls,
  PACKAGE,
  PROFILE,
  seedTicket,
  ticketOf,
  tool,
  until,
  writeAgentCli,
} from './integration-fixtures.js'

afterAll(stopAllDaemons)

/** The state directory the platform gives the service by default (see the bundled-app grant). */
const defaultStateDir = (aghHome: string) =>
  join(
    aghHome,
    'data',
    'bundled-apps',
    createHash('sha256').update(`${PROFILE}\0${PACKAGE}\0${SERVICE_ID}`).digest('hex').slice(0, 32),
  )

it('opens the main and worker sessions on a real daemon, backgrounds a slow command and relays the worker report', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-sessions-')))
  let handle: DaemonHandle | undefined
  try {
    const aghHome = join(root, 'agh')
    const stateDir = defaultStateDir(aghHome)
    // The daemon starts as usual, with the operator's HOME and PATH; Superagent gives its sessions the agent's.
    const home = join(root, 'operator-home')
    mkdirSync(home)
    const cli = writeAgentCli(root)
    const daemon = await startDaemon({
      aghHome,
      home,
      path: process.env.PATH ?? '',
      plugins: ['./bundled-plugins/superagent'],
      onHandle: (started) => {
        handle = started
      },
    })
    const client = () => daemon.client
    const calls = ownerCalls(client)
    const exists = calls.exists

    // The enabled payload started with the grant: its database lies in the platform's directory for it.
    const database = join(stateDir, 'superagent.sqlite')
    await until('the Superagent database', () => existsSync(database))
    // Unconfigured, it opened no session.
    expect(await exists('superagent:orchestrator')).toBe(false)
    await calls.disable()
    const ticketId = seedTicket(database, stateDir, cli)
    await calls.enable()

    // Configured, it opens the main session with the router bundle and dispatches the ticket to its worker.
    const workerId = `superagent:worker:${ticketId}`
    await until('the worker session', () => exists(workerId)).catch((error: unknown) => {
      const lines = daemon
        .stderr()
        .split('\n')
        .filter((line) => /superagent|Superagent|error/i.test(line))
      const db = new DatabaseSync(database, { readOnly: true })
      const effects = db.prepare('SELECT kind, key, attempts, error FROM effect').all()
      const tickets = db.prepare('SELECT value FROM ticket').all()
      db.close()
      throw new Error(
        `${String(error)}\n${lines.slice(-30).join('\n')}\neffects: ${JSON.stringify(effects)}\ntickets: ${JSON.stringify(tickets)}`,
      )
    })
    const main = await client().session.load('superagent:orchestrator', { history: 'none' })
    expect((await main.tools()).capabilities).toMatchObject({
      preset: 'superagent-router',
      bundles: [`${PACKAGE}#router`],
    })
    const worker = await client().session.load(workerId, { history: 'none' })
    expect((await worker.tools()).capabilities).toMatchObject({
      preset: 'superagent-worker',
      bundles: [`${PACKAGE}#worker`],
    })
    const directory = join(stateDir, 'work')
    const ticketDir = readdirSync(directory).map((name) => join(directory, name))
    expect(ticketDir).toHaveLength(1)
    expect(readFileSync(join(ticketDir[0]!, 'repo', 'PREPARED'), 'utf8').trim()).toBe('prepared')
    // The worker's first turn reads its assignment, which Superagent delivered under its own command id.
    await until('the assignment turn', async () => {
      const ui = await worker.projectUI()
      return ui.nodes.some((node) => node.kind === 'user' && node.commandId?.startsWith('superagent:'))
    })
    await until('the worker idle', async () => (await worker.projectUI()).opState === null)
    // The platform marks it as Superagent's delivery for the reader; it is the owner's input as before otherwise.
    const assignment = (await worker.projectUI()).nodes.find(
      (node) => node.kind === 'user' && node.commandId?.startsWith('superagent:'),
    )
    expect(assignment).toMatchObject({
      origin: 'principal',
      deliveredBy: { kind: 'bundled-app', appId: '@agnes/superagent/superagent' },
    })
    expect(JSON.stringify(assignment?.kind === 'user' ? assignment.content : [])).toContain(ticketId)
    // The worker is named for its role and ticket, and the daemon groups it under its ticket directory's workspace.
    const workspace = (await client().workspace.list()).items.find((entry) => entry.path === ticketDir[0])
    expect(workspace?.workspaceId).toBeDefined()
    const grouped = await client().session.list({
      sidebar: { groupId: workspace?.workspaceId ?? '' },
      limit: 5,
    })
    expect(grouped.items.find((row) => row.sessionId === workerId)).toMatchObject({
      title: 'Worker · Fix the login page',
      cwd: ticketDir[0],
    })
    const answered = async (marker: string) =>
      until(`the tool result of ${marker}`, () =>
        daemon
          .modelRequests()
          .find((request) => request.lastRole === 'tool' && request.marker.includes(marker)),
      )

    // The worker preset's 5-second observation turns a slow foreground command into a background job.
    const sent = Date.now()
    await worker.followUp(tool('w-bg', 'shell', { command: 'sleep 20; echo slept' }))
    const backgrounded = await answered('w-bg')
    expect(Date.now() - sent).toBeLessThan(15_000)
    expect(backgrounded.toolResult ?? '').toMatch(/job/i)
    await until('the worker idle again', async () => (await worker.projectUI()).opState === null)

    // Superagent's skills are written into the AGH home's skill directory.
    expect(existsSync(join(aghHome, 'skills', 'dsh-superagent-github', 'SKILL.md'))).toBe(true)
    // The worker reports through orchestrator_report; the service records it for its ticket and relays it.
    await worker.followUp(
      tool('w-report', 'orchestrator_report', { state: 'ready', summary: 'E2E-REPORT done' }),
    )
    // The scripted model may call the tool once more after a job notice; the ticket's record is what counts.
    await answered('w-report')
    const ticket = await until('the reported ticket', () => {
      const value = ticketOf(database, ticketId)
      return value?.ended ? value : undefined
    })
    expect(ticket.assignments.at(-1)?.report).toMatchObject({ state: 'ready', summary: 'E2E-REPORT done' })
    expect(ticket.ended).toMatchObject({ outcome: 'completed' })
    const relay = await until('the relay in the main session', async () =>
      (await main.projectUI()).nodes.find(
        (node) =>
          node.kind === 'user' &&
          node.commandId?.startsWith('superagent:') &&
          node.content.some((block) => block.type === 'text' && block.text.includes('E2E-REPORT done')),
      ),
    )
    // Relayed as Superagent's delivery too, not shown as a person's message.
    expect(relay).toMatchObject({
      origin: 'principal',
      deliveredBy: { kind: 'bundled-app', appId: '@agnes/superagent/superagent' },
    })
    // The panel shows the ended ticket with the report.
    const detail = await calls.service('superagent.tickets.get', { id: ticketId })
    expect(detail).toMatchObject({ id: ticketId, ended: { outcome: 'completed' } })
    expect(JSON.stringify(detail)).toContain('E2E-REPORT done')
    // The ticket ended with that report: the worker's tools are refused from now on.
    await until('the worker idle after the report', async () => (await worker.projectUI()).opState === null)
    await worker.followUp(tool('w-after', 'shell', { command: 'echo after' }))
    const after = (await answered('w-after')).toolResult ?? ''
    expect(after, after).toContain('Ticket ended; new work needs a new authorized ticket')
  } finally {
    await handle?.stop()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 360_000)
