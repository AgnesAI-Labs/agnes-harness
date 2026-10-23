import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertLoopbackOnly,
  type FakeSystemOne,
  type FakeSystemOneBehaviour,
  type FakeSystemOneScript,
  type FakeSystemOneSeen,
  fakeModel,
  installLoopbackOnly,
  restoreLoopbackOnly,
  startFakeSystemOne,
} from '@agnes/ai/testkit'
import { CORE_CHECKS, type Event, foldEvents, InvariantRegistry, scanAll } from '@agnes/core'
import { loopKind, type ModelAdapterEvent } from '@agnes/extension-api'
import { createCredentialStore, type HostSession, type SessionRecovery } from '@agnes/host'
import { createTestHost, type TestHost } from '@agnes/host/testkit'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { RouteDecl } from '@agnes/protocol'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { createJevLoopFactory, JEV_LOOP } from '../../src/index.js'
import { answersFor } from './fake-jev.js'

export type Row = Record<string, unknown>

export const JEV = Object.freeze({ route: 'jev', model: 'typesafe/jev-1.13-20260917' })
export const MAIN = Object.freeze({ route: 'main', model: 'main-1' })
/** A placeholder: the stand-in accepts any bearer key, and no ledger row may carry this one. */
export const JEV_KEY = 'TEST-KEY-0123456789'
export const JEV_CREDENTIAL = 'secret://jev/key'

const BASE_DIR = fileURLToPath(new URL('../../../base/', import.meta.url))
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']

const fakes: FakeSystemOne[] = []
const dirs: string[] = []

/**
 * Keeps every request of the describe block on the loopback interface: the deployment pool honours
 * the proxy variables, which would send even loopback traffic through a proxy set on the machine.
 * Each case's fake endpoints are closed and its scratch directories removed after it.
 */
export function useLoopback(): void {
  const savedEnv = new Map<string, string | undefined>()
  beforeAll(() => {
    installLoopbackOnly()
    for (const key of [...PROXY_VARIABLES, 'NO_PROXY', 'no_proxy']) savedEnv.set(key, process.env[key])
    for (const key of PROXY_VARIABLES) delete process.env[key]
    process.env.NO_PROXY = '127.0.0.1,localhost'
    delete process.env.no_proxy
  })
  afterAll(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restoreLoopbackOnly()
  })
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.close()))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    assertLoopbackOnly()
  })
}

/** A loopback stand-in for the Jev endpoint, closed after the case. */
export async function startJev(script: FakeSystemOneScript = {}): Promise<FakeSystemOne> {
  const fake = await startFakeSystemOne(script)
  fakes.push(fake)
  return fake
}

/**
 * Answers request `n` with `picks[min(n, last)]`: every choice head takes its pick, or its first
 * option, at `confidence`. The answers replace the endpoint's default ones.
 */
export function jevAnswers(
  picks: Array<Record<string, string>>,
  confidence = 0.9,
): (n: number, seen: FakeSystemOneSeen) => FakeSystemOneBehaviour {
  return (n, seen) => {
    const pick = picks[Math.min(n, picks.length - 1)] ?? {}
    const questions = (seen.body as { questions?: Record<string, unknown> } | null)?.questions ?? {}
    return { answers: answersFor(questions, { pick, confidence }) }
  }
}

/** A scratch data directory with the route's key in a file secret store, as an operator keeps it. */
export async function jevDataDir(): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'agnes-jev-host-'))
  dirs.push(scratch)
  const dataDir = join(scratch, 'home')
  await createCredentialStore({ root: dataDir }).putApiKey(JEV_CREDENTIAL, JEV_KEY)
  renameSync(join(dataDir, 'secrets'), join(dataDir, 'credentials'))
  return dataDir
}

const jevRoute = (baseUrl: string): RouteDecl => ({
  route: JEV.route,
  api: 'typesafe-systemone',
  baseUrl,
  credentialRef: JEV_CREDENTIAL,
  models: [
    fakeModel({
      id: JEV.model,
      route: JEV.route,
      api: 'typesafe-systemone',
      baseUrl,
      contextWindow: 64000,
      toolCallFormats: [],
      // The vendor prices input tokens only: 0.042 dollars per million.
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  ],
})

/** The scripted adapter accepts a successful reply only with exactly one usage event. */
const USAGE: ModelAdapterEvent = {
  type: 'usage',
  tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
  creditSource: 'estimated',
}
/** A conversation-model reply in plain text. */
export const textReply = (text: string): ModelAdapterEvent[] => [
  { type: 'text_delta', delta: text },
  USAGE,
  { type: 'done', reason: 'stop' },
]
/** A conversation-model reply that makes one tool call. */
export const callReply = (name: string, args: Record<string, string>): ModelAdapterEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 } },
  USAGE,
  { type: 'done', reason: 'toolUse' },
]

/** The conversation model: the built-in scripted adapter, answering from `replies` in order. */
const mainRoute = (replies: ModelAdapterEvent[][]): RouteDecl => ({
  route: MAIN.route,
  api: 'scripted',
  baseUrl: 'https://scripted.invalid',
  compat: { replies, repeatLast: true },
  models: [
    fakeModel({
      id: MAIN.model,
      route: MAIN.route,
      api: 'scripted',
      baseUrl: 'https://scripted.invalid',
      contextWindow: 200_000,
    }),
  ],
})

/** An in-process plugin row that registers `value` under `kind`. */
const providerRow = (id: string, exportName: string, kind: unknown, value: unknown) => ({
  declaration: {
    id,
    export: exportName,
    apiRange: '^5.0.0',
    default: true,
    inject: ['providers'],
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport({
    inject: ['providers'],
    apply(ctx: { providers: { register(kind: unknown, value: unknown): void } }) {
      ctx.providers.register(kind, value)
    },
  }),
})

type Seams = NonNullable<Parameters<typeof createTestHost>[0]['seams']>
type Approval = NonNullable<Parameters<typeof createTestHost>[0]['approval']>

export type JevLoopBoot = {
  dataDir: string
  /** The Jev endpoint; `null` leaves the Jev route out of the profile. */
  fake: FakeSystemOne | null
  /** The conversation model's replies, in order; the last one repeats. */
  main: ModelAdapterEvent[][]
  /** The loop's plugin configuration. */
  config?: object
  approval?: (req: unknown) => Promise<unknown>
  /** Seams beyond billing, for example a verifier and a repair policy for the stop gate. */
  seams?: Seams
}

export type JevKit = TestHost & {
  billed: Row[]
  recovered: SessionRecovery[]
  open(key: string): Promise<HostSession>
}

/**
 * One process: a real host whose profile declares the Jev route first and the conversation route
 * second, with `agnes.jev` installed. Sessions run in `dataDir`.
 */
export async function bootJevLoop(o: JevLoopBoot): Promise<JevKit> {
  const billed: Row[] = []
  const routes = [...(o.fake ? [jevRoute(o.fake.url)] : []), mainRoute(o.main)]
  const t = await createTestHost({
    dataDir: o.dataDir,
    disableSessionTitle: true,
    // The built-in file tools are bundled extensions the host reads from the base package's directory.
    packageDirs: { '@agnes/base': BASE_DIR },
    limits: { 'cost.credits_per_usd': 100 },
    ...(o.approval ? { approval: o.approval as Approval } : {}),
    seams: {
      ...(o.seams ?? {}),
      billing: {
        record: async (row) => {
          billed.push(row as unknown as Row)
        },
      },
    } as Seams,
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', routes },
        adapters: { secrets: { kind: 'file', path: join(o.dataDir, 'credentials') } },
      },
    },
    packages: {
      '@agnes/code': {
        plugins: [providerRow('ext:agnes.jev/loop', 'jevTestLoop', loopKind, createJevLoopFactory(o.config))],
      },
    },
  })
  const recovered: SessionRecovery[] = []
  const open = (key: string): Promise<HostSession> =>
    t.host.createSession({
      key,
      cwd: o.dataDir,
      loop: JEV_LOOP,
      onRecovered: (recovery) => {
        recovered.push(recovery)
      },
    })
  return { ...t, billed, recovered, open }
}

/**
 * What a killed process leaves behind: the ledger is sealed first, so nothing the dying host does
 * while it tears down reaches it, then the host is closed to release its resources.
 */
export async function crash(kit: JevKit, session: HostSession): Promise<void> {
  await session.d.log.close()
  await kit.host.close()
}

export const rowsOf = async (session: HostSession): Promise<Event[]> =>
  scanAll((query) => session.scan(query), { fromSeq: 1, toSeq: session.lastSeq })
export const data = (row: Event | undefined): Row => (row?.data ?? {}) as Row
export const ofType = (rows: Event[], type: string) => rows.filter((row) => row.type === type)
export const costs = (rows: Event[]) => ofType(rows, 'cost/ledger')
export const sideCosts = (rows: Event[]) => costs(rows).filter((row) => data(row).purpose === 'side-call')
export const violations = (rows: Event[]) => {
  const checks = new InvariantRegistry()
  checks.register('@agnes/core', CORE_CHECKS)
  return checks.run(rows, foldEvents([]))
}

/** Queues `text` as the next turn and runs until a turn ends. */
export const runTurn = async (session: HostSession, text: string, signal = new AbortController().signal) => {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  return session.run({ until: 'turn-end', signal })
}
/** Runs whatever the session has queued or parked until a turn ends. */
export const continueTurn = (session: HostSession, signal = new AbortController().signal) =>
  session.run({ until: 'turn-end', signal })
