import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { checkResolvedComposition, type ResolvedComposition } from '@agnes/host-common/profile/composition'
import { checkSavedProfile } from '@agnes/host-common/profile/saved-profile'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { defaultProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity-default'
import {
  DurableStateError,
  mkdirDurablySync,
  publishFileDurablySync,
  removeFileDurablySync,
} from '@agnes/package-manager'

import { SessionSandboxStore } from './sandbox-state.js'

export type CompositionBinding = Readonly<{
  sessionKey: string
  tree: ResolvedComposition
  profile: ResolvedProfile
  /** This session predates a composition container; retain its original deployment hash. */
  legacy?: true
}>
export type LiveCompositionSession = Readonly<{
  sessionKey: string
  generationId?: string
  compositionHash: string
  preset: string
  bundles: readonly string[]
  capabilities?: import('@agnes/protocol').SessionCapabilitySet | undefined
  toolGroups?: readonly CompositionToolGroup[]
  providers: Pick<
    ResolvedComposition['selection'],
    'loop' | 'modelAdapters' | 'compaction' | 'persistence' | 'sandbox'
  >
}>

export type CompositionToolGroup = Readonly<{
  packageId: string
  reason: 'official-default' | 'enabled-plugin' | 'bundle' | 'selected-loop'
  bundles: readonly string[]
  tools: readonly string[]
}>

/** Shares the runtime generation session lifetime: retained on close/hibernate, removed only on deletion. */
export class CompositionSessionStore {
  readonly root: string
  readonly #anchor: string
  constructor(profileDir: string) {
    this.root = join(profileDir, '.session-compositions')
    this.#anchor = dirname(profileDir)
  }
  private path(key: string): string {
    return join(this.root, createHash('sha256').update(key).digest('hex') + '.json')
  }
  /** A binding that exists but is not a complete record is a located corruption, never a missing one. */
  read(key: string): CompositionBinding | undefined {
    const file = this.path(key)
    let bytes: string
    try {
      bytes = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw invalidBinding(file, 'cannot be read', error)
    }
    let value: Record<string, unknown> | null
    try {
      value = JSON.parse(bytes) as Record<string, unknown> | null
    } catch (error) {
      throw invalidBinding(file, 'is not valid JSON', error)
    }
    if (!value || typeof value !== 'object' || value.sessionKey !== key)
      throw invalidBinding(file, 'does not describe this session')
    try {
      const tree = checkResolvedComposition(value.tree),
        profile = checkSavedProfile(value.profile)
      if (tree.profile !== profile.name) throw invalidBinding(file, 'does not describe this session')
      if (value.legacy !== undefined && value.legacy !== true)
        throw invalidBinding(file, 'does not describe this session')
    } catch (error) {
      if (error instanceof DurableStateError) throw error
      throw invalidBinding(file, 'is not a complete composition record', error)
    }
    return value as unknown as CompositionBinding
  }
  /** For lookups that must not fail on damage (ownership, deletion); opening a session uses `read`. */
  readIfValid(key: string): CompositionBinding | undefined {
    try {
      return this.read(key)
    } catch {
      return undefined
    }
  }
  /** A damaged intent cannot prove its session is elsewhere, so it counts as using the tree. */
  mayUseTree(key: string, treeHash: string): boolean {
    try {
      return this.read(key)?.tree.hash === treeHash
    } catch {
      return true
    }
  }
  /**
   * Publishes the intent record durably (see `publishFileDurablySync`), so the generation pin that
   * follows it can never survive power loss without it. The first writer wins.
   */
  pin(binding: CompositionBinding): CompositionBinding {
    mkdirDurablySync(this.root, this.#anchor)
    publishFileDurablySync(this.path(binding.sessionKey), JSON.stringify(binding))
    return this.read(binding.sessionKey)!
  }
  release(key: string): void {
    removeFileDurablySync(this.path(key))
    new SessionSandboxStore(dirname(this.root)).release(key)
  }
  /**
   * A binding is the intent record written before the generation pin and released after it, so a crash
   * on either side leaves a binding without a pin. Drops those (and the profile snapshot each carries)
   * once older than the grace in which another worker may still be opening the session.
   *
   * The pin is looked up by the binding's file name, which is the digest of its session key, never by
   * parsing the binding: a damaged binding whose pin exists is kept (resume then refuses it as
   * corrupt), and nothing is deleted unless the pin is positively absent.
   */
  sweepOrphans(
    pinState: (keyDigest: string) => 'present' | 'absent',
    options: { graceMs?: number; now?: number } = {},
  ): readonly string[] {
    const grace = options.graceMs ?? ORPHAN_GRACE_MS,
      now = options.now ?? Date.now(),
      removed: string[] = []
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return removed
      throw error
    }
    for (const name of names) {
      const path = join(this.root, name)
      let age: number
      try {
        age = now - statSync(path).mtimeMs
      } catch {
        continue
      }
      if (age < grace) continue
      const digest = /^([a-f0-9]{64})\.json$/.exec(name)?.[1]
      if (!digest) {
        // Interrupted publication temporaries.
        rmSync(path, { force: true })
        continue
      }
      let state: 'present' | 'absent' = 'present'
      try {
        state = pinState(digest)
      } catch {
        // An unreadable pin directory is not proof of an orphan.
      }
      if (state === 'present') continue
      removeFileDurablySync(path)
      removed.push(name)
    }
    return removed
  }
}

function invalidBinding(file: string, reason: string, cause?: unknown): DurableStateError {
  return Object.assign(
    new DurableStateError(
      'E_COMPOSITION_BINDING_INVALID',
      `session composition ${basename(file)} ${reason}; it is kept for inspection and the session cannot be resumed`,
      file,
    ),
    cause === undefined ? {} : { cause },
  )
}

const ORPHAN_GRACE_MS = 10 * 60_000

/** Safe status only. Private profile/config snapshots never enter the admin response. */
export async function createLiveCompositionWriter(profileDir: string) {
  await reapDeadLiveCompositions(profileDir)
  const identity = await defaultProcessIdentity(process.pid)
  // Status must not make an otherwise valid Host depend on an optional native identity backend.
  // Unknown identity is omitted from live inspection, rather than misreported as an active worker.
  if (identity.state !== 'alive')
    return { write(_sessions: readonly LiveCompositionSession[]) {}, close() {} }
  const root = join(profileDir, '.composition-live'),
    file = join(root, randomUUID() + '.json')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return {
    write(sessions: readonly LiveCompositionSession[]) {
      const temporary = file + '.tmp'
      try {
        writeFileSync(temporary, JSON.stringify({ pid: process.pid, startId: identity.startId, sessions }), {
          mode: 0o600,
          flush: true,
        })
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
    },
    close() {
      rmSync(file, { force: true })
    },
  }
}

/** Removes status files whose worker is gone. An unknown identity is never treated as dead. */
export async function reapDeadLiveCompositions(profileDir: string): Promise<void> {
  const root = join(profileDir, '.composition-live')
  const names = await readdir(root).catch(() => [] as string[])
  for (const name of names) {
    const path = join(root, name)
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
      // Writer temporaries from a crashed worker; a live writer renames its temporary within one call.
      if (/^[a-f0-9-]{36}\.json\.tmp$/.test(name)) {
        try {
          if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true })
        } catch {}
      }
      continue
    }
    let value: { pid?: unknown; startId?: unknown } | undefined
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // Writers rename a complete file into place, so unparseable content is never a live worker's.
      rmSync(path, { force: true })
      continue
    }
    if (typeof value?.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      rmSync(path, { force: true })
      continue
    }
    const identity = await defaultProcessIdentity(value.pid)
    if (identity.state === 'dead' || (identity.state === 'alive' && identity.startId !== value.startId))
      rmSync(path, { force: true })
  }
}

export async function readLiveCompositionSessions(
  profileDir: string,
): Promise<readonly LiveCompositionSession[]> {
  const root = join(profileDir, '.composition-live')
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  const sessions = new Map<string, LiveCompositionSession>()
  for (const name of names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    let value: { pid: number; startId: string; sessions: LiveCompositionSession[] }
    try {
      value = JSON.parse(await readFile(join(root, name), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Array.isArray(value.sessions)) continue
    const identity = await defaultProcessIdentity(value.pid)
    if (identity.state !== 'alive' || identity.startId !== value.startId) continue
    for (const session of value.sessions) sessions.set(session.sessionKey, session)
  }
  return [...sessions.values()]
}
