// The embedded AGH host behind run-agh.ts: one per run, in a home of its own. It boots the local
// host the way the loop bench does (packages/loop-jev/bench), but through `bootLocal` rather than
// `bootHeadless`: the headless form moves the data dir into a temp dir it makes during boot, and the
// refinement switch is a file in the data dir that the host reads once, when it assembles. A fresh
// home per run gives the same isolation and lets the switch be written before the host starts.
//
// Only `prepareHome` and `prepareMemory` are unit-tested; the rest boots a real host and is
// exercised by a real run.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type AghHost,
  type AghSession,
  type LaunchInput,
  type LedgerRow,
  type ReviewAnswer,
  TERMINAL_REVIEW_STATES,
} from './run-agh.js'
import { loadSkillSaveModules, skillSaveTransport } from './skill-save.js'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages')
const CLI = join(PACKAGES, 'cli')
const POLL_MS = 250

type SettingsSnapshot = { settings: { enabled: boolean; mode: string }; revision: string }
type SettingsStore = {
  read(): SettingsSnapshot
  save(settings: { enabled: boolean; mode: 'manual' | 'auto' }, expectedRevision: string): unknown
}
/** The parts of `@agnes/host` this file uses. */
export type HostModule = {
  initializeHomeLocked(home: string, profile: string): Promise<unknown>
  dataDir(home: string): string
  cacheDir(home: string): string
  RefinementSettingsStore: new (dataDir: string, profile: string) => SettingsStore
  /** The manual review request behind `session.refine`; the embedded host does not serve that RPC. */
  requestRefinement(session: never, focus?: string, saveTo?: 'workspace' | 'user'): Promise<{ runId: string }>
}

/**
 * Makes the run's home: a fresh AGH home, the profile file with the one route, and the refinement
 * switch saved the way the settings panel saves it (nothing at all for an "off" run). Returns the
 * data dir the host will use. Refuses a home that already exists, so no run reuses another's data.
 */
export async function prepareHome(
  input: Pick<LaunchInput, 'home' | 'profile' | 'profileDocument' | 'refinement'>,
  host: HostModule,
): Promise<string> {
  if (existsSync(input.home)) throw new Error(`the run home ${input.home} already exists`)
  await host.initializeHomeLocked(input.home, input.profile)
  const profileDir = join(input.home, 'profiles', input.profile)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  // JSON is valid YAML 1.2, so the profile file needs no YAML writer.
  writeFileSync(join(profileDir, 'profile.yaml'), `${JSON.stringify(input.profileDocument, null, 2)}\n`)
  const data = host.dataDir(input.home)
  const store = new host.RefinementSettingsStore(data, input.profile)
  if (input.refinement) store.save(input.refinement, store.read().revision)
  const now = store.read().settings
  if (now.enabled !== (input.refinement !== undefined))
    throw new Error(`the refinement switch in ${data} reads ${now.enabled ? 'on' : 'off'}`)
  return data
}

type Client = {
  workspace: { add(path: string): Promise<unknown> }
  createSession(options: { cwd: string; sessionKey: string }): Promise<SdkSession>
}
type SdkSession = {
  id: string
  setModel(input: { slot: 'primary'; route: string; model: string }): Promise<unknown>
  onPermissionRequest(handler: () => Promise<{ verdict: 'allowed-once' }>): () => void
  attach(options: { filter: { acpUpdates: boolean } }): Promise<unknown>
  prompt(text: string, options: { signal: AbortSignal; unattended: boolean }): Promise<{ reason: string }>
  detach(): Promise<unknown>
}
type OwnedSession = {
  close(): Promise<void>
  state: { refinementRuns: ReadonlyMap<string, { state: string }> }
}
type Booted = {
  client: Client
  host?: { profile: { dataDir: string }; kernel: { get(key: string): OwnedSession | undefined } }
  close(): Promise<void>
}

/** The parts of the file memory provider (`packages/memory-file`) this file uses. */
type MemoryInspection = { settings: { mode: string; userEnabled: boolean } }
export type MemoryModule = {
  openMemory(input: { home: string; workspaceRoot: string; sessionKey: string }): {
    /** Saves the settings and returns the inspection that follows. */
    configure(settings: object): Promise<MemoryInspection>
    inspect(): Promise<MemoryInspection>
    /** The memory page's own read and edit of a memory file (compare-and-swap on the hash read). */
    readFile(path: string): Promise<{ content: string; hash: string }>
    editFile(path: string, content: string, baseHash: string): Promise<unknown>
    /** What the agent is shown at the start of a turn; none while memory is off. */
    snapshot(turn: number): Promise<{ content: string } | undefined>
    close?(): Promise<void> | void
  }
}

/** The official file memory provider, from its source like the CLI boot code below. */
export const loadMemoryModule = async (): Promise<MemoryModule> =>
  (await import(pathToFileURL(join(PACKAGES, 'memory-file', 'src', 'index.ts')).href)) as MemoryModule

/**
 * Saves the run's memory settings for every workspace in the run's home, the way the memory
 * settings panel saves them, before the host starts: the same for on and off runs.
 */
export async function prepareMemory(
  input: Pick<LaunchInput, 'home' | 'workspaces' | 'memory'>,
  memory: MemoryModule,
): Promise<void> {
  for (const workspaceRoot of input.workspaces) {
    const session = memory.openMemory({ home: input.home, workspaceRoot, sessionKey: 'rsi-eval-setup' })
    try {
      const { settings } = await session.configure(input.memory)
      if (settings.mode !== input.memory.mode || settings.userEnabled !== input.memory.userEnabled)
        throw new Error(`the memory settings of ${workspaceRoot} did not save`)
    } finally {
      await session.close?.()
    }
  }
}

/** The workspace memory index a person edits on the memory page. */
const MEMORY_INDEX = 'MEMORY.md'

/**
 * Adds one paragraph to a workspace's memory the way a person saves it on the memory page (the
 * provider's own edit of the index, which the agent reads from the next turn), after what the index
 * already holds. Used for the oracle arm: the task's lesson, written before the second session.
 */
export async function seedWorkspaceMemory(
  input: { home: string; workspace: string; text: string },
  memory: MemoryModule,
): Promise<void> {
  const session = memory.openMemory({
    home: input.home,
    workspaceRoot: input.workspace,
    sessionKey: 'rsi-eval-seed',
  })
  try {
    const current = await session.readFile(MEMORY_INDEX)
    const kept = current.content.trimEnd()
    await session.editFile(
      MEMORY_INDEX,
      `${kept === '' ? '' : `${kept}\n\n`}${input.text.trim()}\n`,
      current.hash,
    )
  } finally {
    await session.close?.()
  }
}

const refusal = (error: unknown): string | undefined => {
  const data = (error as { data?: { code?: unknown; reason?: unknown } } | null)?.data
  return data?.code === 'SEMANTIC_REJECTED' && typeof data.reason === 'string' ? data.reason : undefined
}

/** Reads every row of one session's ledger, every lane, from the run's own sessions.db. */
export function readLedger(dataDir: string, sessionKey: string): LedgerRow[] {
  const db = new DatabaseSync(join(dataDir, 'sessions.db'), { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT seq, ts, type, CAST(lane AS TEXT) AS lane, origin, data FROM events
         WHERE session_key = ? ORDER BY seq ASC`,
      )
      .all(sessionKey) as {
      seq: number
      ts: string
      type: string
      lane: unknown
      origin: unknown
      data: unknown
    }[]
    return rows.map((row) => ({
      seq: Number(row.seq),
      ts: String(row.ts),
      type: String(row.type),
      lane: typeof row.lane === 'string' && row.lane !== '' ? row.lane : null,
      origin: typeof row.origin === 'string' ? row.origin : null,
      data: typeof row.data === 'string' ? (JSON.parse(row.data) as unknown) : null,
    }))
  } finally {
    db.close()
  }
}

export async function launchHost(input: LaunchInput): Promise<AghHost> {
  const host = (await import('@agnes/host')) as unknown as HostModule
  const data = await prepareHome(input, host)
  await prepareMemory(input, await loadMemoryModule())
  const { bootLocal } = (await import(pathToFileURL(join(CLI, 'src', 'boot', 'local.ts')).href)) as {
    bootLocal(args: unknown, deps: object): Promise<Booted>
  }
  const { parseArgs } = (await import(pathToFileURL(join(CLI, 'src', 'args.ts')).href)) as {
    parseArgs(argv: string[]): unknown
  }
  // Saved skills reach the workspace through the daemon's installer over a resource-control store of this
  // run; only a run with refinement on gets the way to do it (see skill-save.ts).
  const live = new Map<string, string>()
  const refinementSave = input.refinement
    ? skillSaveTransport(input.refinement, {
        home: input.home,
        dataDir: data,
        profile: input.profile,
        workspaceOf: (key) => live.get(key),
        enabled: () => new host.RefinementSettingsStore(data, input.profile).read().settings.enabled,
        modules: await loadSkillSaveModules(),
      })
    : undefined
  const agnesVersion = (JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as { version: string })
    .version
  // The host reads user-wide instruction files from AGH_HOME; the run's home holds none.
  const savedHome = process.env.AGH_HOME
  process.env.AGH_HOME = input.home
  const restore = () => {
    if (savedHome === undefined) delete process.env.AGH_HOME
    else process.env.AGH_HOME = savedHome
  }
  let booted: Booted
  try {
    booted = await bootLocal(
      parseArgs(['--profile', input.profile, '--cwd', input.workspace, '--standalone']),
      {
        env: input.env,
        home: input.home,
        cwd: input.workspace,
        agnesVersion,
        log: () => {},
        ...(refinementSave ? { refinementSave } : {}),
      },
    )
  } catch (error) {
    restore()
    throw error
  }
  const embedded = booted.host
  if (!embedded || embedded.profile.dataDir !== data) {
    await booted.close()
    restore()
    throw new Error(`the run host does not use the run's data dir ${data}`)
  }
  for (const workspace of input.workspaces) await booted.client.workspace.add(workspace)
  const ids = new Map<string, string>()

  const openSession = async (sessionKey: string, workspace: string): Promise<AghSession> => {
    if (!input.workspaces.includes(workspace))
      throw new Error(`${workspace} is not one of the run's workspaces`)
    const session = await booted.client.createSession({ cwd: workspace, sessionKey })
    ids.set(sessionKey, session.id)
    live.set(sessionKey, workspace)
    live.set(session.id, workspace)
    await session.setModel({ slot: 'primary', route: input.model.route, model: input.model.model })
    // Nobody attends an eval run: every approval is given, as the Prime runs execute without asking.
    const offPermission = session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
    await session.attach({ filter: { acpUpdates: false } })
    return {
      key: sessionKey,
      prompt: async (text, signal) => (await session.prompt(text, { signal, unattended: true })).reason,
      review: async (saveTo): Promise<ReviewAnswer> => {
        try {
          const owned = embedded.kernel.get(session.id)
          if (!owned) return { refused: 'unavailable' }
          return await (saveTo
            ? host.requestRefinement(owned as never, undefined, saveTo)
            : host.requestRefinement(owned as never))
        } catch (error) {
          const reason = refusal(error)
          if (reason === undefined) throw error
          return { refused: reason }
        }
      },
      settled: async (runId, ms) => {
        const until = Date.now() + ms
        for (;;) {
          const state = embedded.kernel.get(session.id)?.state.refinementRuns.get(runId)?.state
          if (state !== undefined && TERMINAL_REVIEW_STATES.has(state)) return state
          if (Date.now() >= until) return undefined
          await new Promise((wake) => setTimeout(wake, POLL_MS))
        }
      },
      close: async () => {
        offPermission()
        try {
          await embedded.kernel.get(session.id)?.close()
        } finally {
          live.delete(sessionKey)
          live.delete(session.id)
          await session.detach().catch(() => undefined)
        }
      },
    }
  }

  return {
    openSession,
    seedMemory: async (workspace, text) => {
      if (!input.workspaces.includes(workspace))
        throw new Error(`${workspace} is not one of the run's workspaces`)
      await seedWorkspaceMemory({ home: input.home, workspace, text }, await loadMemoryModule())
    },
    close: async () => {
      try {
        await booted.close()
      } finally {
        restore()
        // The home's cache (transpiled plugin sources) is large and says nothing about the run.
        rmSync(host.cacheDir(input.home), { recursive: true, force: true })
      }
    },
    ledger: (sessionKey) => {
      const id = ids.get(sessionKey)
      if (id === undefined) throw new Error(`no session was opened as ${sessionKey}`)
      const rows = readLedger(data, id)
      if (rows.length === 0) throw new Error(`the ledger holds no rows for session ${id}`)
      return rows
    },
  }
}
