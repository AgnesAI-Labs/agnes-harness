// The shipped payload on a real daemon: Superagent opens its main session and a dispatched ticket's worker session with
// their role bundles, the worker's foreground command moves to the background after 5 seconds, and its
// orchestrator_report reaches the service through the tool's handle and is relayed to the main session.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, it } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { type Candidate, Engine, type Policy } from '../../src/core/index.js'
import { SettingsSchema } from '../../src/policy.js'
import { ticketExecution } from '../../src/runtime/assignment.js'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { makeHomes } from '../fixtures/homes.js'

afterAll(stopAllDaemons)

const PROFILE = 'local-dev'
const PACKAGE = '@agnes/superagent'
const STEP_MS = 120_000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(label: string, probe: () => T | Promise<T>, ms = STEP_MS): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}
const tool = (marker: string, name: string, args: unknown) =>
  `[[${marker} TOOL${JSON.stringify({ name, args })}ENDTOOL]]`

/** Writes one accepted ticket with a pending assignment into Superagent's database, as the engine records it. */
function seed(database: string, root: string, gh: string) {
  const store = openStore(database)
  try {
    store.saveSettings(
      SettingsSchema.parse({
        sources: { github: { enabled: true, config: { repository: 'acme/app', cli: gh } } },
        executor: {
          prepare: 'git init -q repo && echo prepared > repo/PREPARED',
          directory: join(root, 'work'),
        },
      }),
    )
    const requests: Candidate[] = []
    const policy: Policy = {
      version: 'seed',
      paused: false,
      evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
      revalidate: () => true,
      admitsInferred: () => false,
    }
    const engine = new Engine({
      repo: store,
      scope: { scope: () => ({ listened: true, observed: false }) },
      policy: () => policy,
      assessor: { request: (candidate) => requests.push(candidate) },
      executor: { start: () => {}, deliver: () => {}, stop: () => {} },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      prepareTicket: (ticket, outcome) => ({
        ...ticket,
        execution: ticketExecution(ticket, outcome, store.settings(), root),
      }),
    })
    engine.receive({
      id: 'trigger-1',
      source: 'chat',
      threads: [{ source: 'chat', id: 'e2e' }],
      actor: { source: 'chat', id: 'alice' },
      human: true,
      at: new Date().toISOString(),
      text: 'Please fix the login page.',
      channel: { source: 'chat', thread: 'e2e', address: { message: 'trigger-1' } },
      meta: {},
    })
    engine.evaluateDue()
    const candidate = requests.at(-1)!
    return engine.decide(candidate.triggers[0]!.id, {
      kind: 'accept',
      title: 'Fix the login page',
      scope: 'login page',
      reason: 'requested',
      acknowledgement: 'On it.',
      name: 'fix-login',
      evalId: candidate.evalId,
    }).ticketId!
  } finally {
    store.close()
  }
}

it.skipIf(process.platform === 'win32')(
  'opens the main and worker sessions on a real daemon, backgrounds a slow command and relays the worker report',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-sessions-')))
    let handle: DaemonHandle | undefined
    try {
      const homes = makeHomes(root)
      homes.writeGhScript({
        rules: [
          { args: ['api', 'user'], stdout: '{"login":"agent-bot","id":42}\n' },
          { args: ['api', 'repos/acme/app'], stdout: '{"name":"acme/app","push":true}\n' },
        ],
      })
      const aghHome = join(root, 'agh')
      const daemon = await startDaemon({
        aghHome,
        home: homes.agentHome,
        path: `${homes.shimsDir}:${process.env.PATH ?? ''}`,
        plugins: ['./bundled-plugins/superagent'],
        onHandle: (started) => {
          handle = started
        },
      })
      const client = () => daemon.client
      const exists = (id: string) =>
        client()
          .session.load(id, { history: 'none' })
          .then(
            () => true,
            () => false,
          )
      const command = async (step: string) => ({
        profile: PROFILE,
        clientId: await client().clientId(),
        commandId: `superagent-e2e-${step}-${Date.now()}`,
      })
      const operation = async (receipt: { profile: string; operationId: string }) =>
        until(`package ${receipt.operationId}`, async () => {
          const result = await client().packages.operation.get(receipt)
          if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
            throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
          return result.state === 'completed' ? result : undefined
        })

      // The enabled payload started with the grant: its database lies in the platform's directory for it.
      const { dataDir } = JSON.parse(readFileSync(join(aghHome, 'daemon', 'discovery.json'), 'utf8')) as {
        dataDir: string
      }
      const apps = join(dataDir, 'bundled-apps')
      const stateDir = await until('the Superagent database', () => {
        const found = existsSync(apps)
          ? readdirSync(apps).filter((name) => existsSync(join(apps, name, 'superagent.sqlite')))
          : []
        return found.length === 1 ? join(apps, found[0]!) : undefined
      })
      // Unconfigured, it opened no session.
      expect(await exists('superagent:orchestrator')).toBe(false)
      await operation(await client().packages.disable({ ...(await command('disable')), id: PACKAGE }))
      const ticketId = seed(join(stateDir, 'superagent.sqlite'), stateDir, join(homes.shimsDir, 'gh'))
      await operation(await client().packages.enable({ ...(await command('enable')), id: PACKAGE }))

      // Configured, it opens the main session with the router bundle and dispatches the ticket to its worker.
      const workerId = `superagent:worker:${ticketId}`
      await until('the worker session', () => exists(workerId)).catch((error: unknown) => {
        const lines = daemon
          .stderr()
          .split('\n')
          .filter((line) => /superagent|Superagent|error/i.test(line))
        const db = new DatabaseSync(join(stateDir, 'superagent.sqlite'), { readOnly: true })
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
        const db = new DatabaseSync(join(stateDir, 'superagent.sqlite'), { readOnly: true })
        try {
          const row = db.prepare('SELECT value FROM ticket WHERE id = ?').get(ticketId) as { value: string }
          const value = JSON.parse(row.value) as {
            ended?: { outcome: string }
            assignments: { report?: { state: string; summary: string } }[]
          }
          return value.ended ? value : undefined
        } finally {
          db.close()
        }
      })
      expect(ticket.assignments.at(-1)?.report).toMatchObject({ state: 'ready', summary: 'E2E-REPORT done' })
      expect(ticket.ended).toMatchObject({ outcome: 'completed' })
      await until('the relay in the main session', async () =>
        (await main.projectUI()).nodes.some(
          (node) =>
            node.kind === 'user' &&
            node.commandId?.startsWith('superagent:') &&
            node.content.some((block) => block.type === 'text' && block.text.includes('E2E-REPORT done')),
        ),
      )
      // The ticket ended with that report: the worker's tools are refused from now on.
      await until('the worker idle after the report', async () => (await worker.projectUI()).opState === null)
      await worker.followUp(tool('w-after', 'shell', { command: 'echo after' }))
      const after = (await answered('w-after')).toolResult ?? ''
      expect(after, after).toContain('Ticket ended; new work needs a new authorized ticket')
    } finally {
      await handle?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  360_000,
)
