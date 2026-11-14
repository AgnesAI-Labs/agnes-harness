// What the real-daemon tests of the whole plugin share: the agent's scripted `gh`, a ticket seeded as the engine records
// one, the package operations, the panel services and the waits.
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { openStore } from '../../src/app/store.js'
import { type Candidate, Engine, type Policy } from '../../src/core/index.js'
import { SettingsSchema } from '../../src/policy.js'
import { ticketExecution } from '../../src/runtime/assignment.js'
import { SERVICE_ID } from '../../src/runtime/index.js'

export const PROFILE = 'local-dev'
export const PACKAGE = '@agnes/superagent'
export const ROW = 'ext:agnes.superagent/main'
/** The id the Host gives the plugin row's services. */
export const EXTENSION = `plugin/${createHash('sha256').update(ROW).digest('hex').slice(0, 16)}`
export const STEP_MS = 120_000
/** The state directory the platform gives the service by default (see the bundled-app grant). */
export const defaultStateDir = (aghHome: string) =>
  join(
    aghHome,
    'data',
    'bundled-apps',
    createHash('sha256').update(`${PROFILE}\0${PACKAGE}\0${SERVICE_ID}`).digest('hex').slice(0, 32),
  )
export const AGENT_LOGIN = 'agent-bot'
const FAKE_GH = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url))
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until<T>(
  label: string,
  probe: () => T | Promise<T>,
  ms = STEP_MS,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}
/** A message that makes the scripted model call `name` with `args` once. */
export const tool = (marker: string, name: string, args: unknown) =>
  `[[${marker} TOOL${JSON.stringify({ name, args })}ENDTOOL]]`

/**
 * The agent's real `gh`, outside the shims: a scripted fake that answers the account and repository checks for
 * `agent-bot` and `acme/app` and fails every other call. Returns its absolute path, which the GitHub Source names.
 */
export function writeAgentCli(root: string): string {
  const dir = join(root, 'agent-cli')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'script.json')
  writeFileSync(
    script,
    JSON.stringify({
      rules: [
        { args: ['api', 'user', '--jq', '.login'], stdout: `${AGENT_LOGIN}\n` },
        { args: ['api', 'user'], stdout: `{"login":"${AGENT_LOGIN}","id":42}\n` },
        { args: ['api', 'repos/acme/app'], stdout: '{"name":"acme/app","push":true}\n' },
      ],
    }),
  )
  const cli = join(dir, 'gh')
  writeFileSync(
    cli,
    `#!/bin/sh\nFAKE_GH_SCRIPT=${quote(script)} FAKE_GH_LOG=${quote(join(dir, 'gh.log'))} exec ${quote(process.execPath)} ${quote(FAKE_GH)} "$@"\n`,
  )
  chmodSync(cli, 0o755)
  return cli
}

/**
 * Writes the GitHub Source and execution settings and one accepted ticket with a pending assignment into Superagent's
 * database, as the engine records them after a request was assessed; returns the ticket id.
 */
export function seedTicket(database: string, stateDir: string, cli: string): string {
  const store = openStore(database)
  try {
    store.saveSettings(
      SettingsSchema.parse({
        sources: { github: { enabled: true, config: { repository: 'acme/app', cli } } },
        executor: {
          prepare: 'git init -q repo && echo prepared > repo/PREPARED',
          directory: join(stateDir, 'work'),
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
        execution: ticketExecution(ticket, outcome, store.settings(), stateDir),
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

/** One stored record of Superagent's database, read without holding it open. */
export function readRecord<T>(database: string, sql: string, ...params: string[]): T | undefined {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    return db.prepare(sql).get(...params) as T | undefined
  } finally {
    db.close()
  }
}
/** Every row a query of Superagent's database returns, read without holding it open. */
export function readAll(database: string, sql: string): unknown[] {
  if (!existsSync(database)) return []
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}
export interface StoredTicket {
  ended?: { outcome: string }
  execution?: { directory: string }
  assignments: { id: string; state: string; report?: { state: string; summary: string } }[]
}
export const ticketOf = (database: string, id: string): StoredTicket | undefined => {
  const row = readRecord<{ value: string }>(database, 'SELECT value FROM ticket WHERE id = ?', id)
  return row ? (JSON.parse(row.value) as StoredTicket) : undefined
}
export const kvOf = <T>(database: string, key: string): T | undefined => {
  const row = readRecord<{ value: string }>(database, 'SELECT value FROM kv WHERE key = ?', key)
  return row ? (JSON.parse(row.value) as T) : undefined
}

/** The package and panel calls of the owner's client. */
// biome-ignore lint/suspicious/noExplicitAny: the harness's client is the SDK client of the daemon package.
export function ownerCalls(client: () => any) {
  const command = async (step: string) => ({
    profile: PROFILE,
    clientId: await client().clientId(),
    commandId: `superagent-e2e-${step}-${randomUUID()}`,
  })
  const operation = async (receipt: { profile: string; operationId: string }) =>
    until(`package ${receipt.operationId}`, async () => {
      const result = await client().packages.operation.get(receipt)
      if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
        throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
      return result.state === 'completed' ? result : undefined
    })
  return {
    command,
    operation,
    disable: async () =>
      operation(await client().packages.disable({ ...(await command('disable')), id: PACKAGE })),
    enable: async () =>
      operation(await client().packages.enable({ ...(await command('enable')), id: PACKAGE })),
    /** Saves the plugin row's configuration (its machine settings). */
    async configure(value: Record<string, unknown>) {
      const snapshot = await client().packages.config.get({ profile: PROFILE, id: PACKAGE })
      const entry =
        snapshot.entries.find((item: { rowId: string }) => item.rowId === ROW) ?? snapshot.entries[0]
      const saved = await client().packages.config.save({
        ...(await command('configure')),
        id: PACKAGE,
        rowId: entry.rowId,
        value,
        expectedRevision: snapshot.revision,
      })
      if (!saved.ok) throw new Error(`configuration not saved: ${JSON.stringify(saved)}`)
      return saved
    },
    /** Calls a panel service of the plugin row, as the panel does. */
    async service(service: string, input: Record<string, unknown> = {}) {
      const result = await client().extensions.callScoped({ extension: EXTENSION, service, input })
      return result.output as Record<string, unknown>
    },
    exists: (id: string) =>
      client()
        .session.load(id, { history: 'none' })
        .then(
          () => true,
          () => false,
        ),
  }
}
