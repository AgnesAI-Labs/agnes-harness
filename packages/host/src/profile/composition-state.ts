import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultProcessIdentity } from '../adapters/process-identity-default.js'
import { checkCompositionPatch, type ResolvedComposition } from './composition.js'
import type { ResolvedProfile } from './types.js'

export type CompositionBinding = Readonly<{
  sessionKey: string
  tree: ResolvedComposition
  profile: ResolvedProfile
}>
export type LiveCompositionSession = Readonly<{
  sessionKey: string
  generationId?: string
  compositionHash: string
  preset: string
  bundles: readonly string[]
  providers: Pick<
    ResolvedComposition['selection'],
    'loop' | 'modelAdapters' | 'compaction' | 'persistence' | 'sandbox'
  >
}>

/** Shares W7's session lifetime: retained on close/hibernate, removed only on deletion. */
export class CompositionSessionStore {
  readonly root: string
  constructor(profileDir: string) {
    this.root = join(profileDir, '.session-compositions')
  }
  private path(key: string): string {
    return join(this.root, createHash('sha256').update(key).digest('hex') + '.json')
  }
  read(key: string): CompositionBinding | undefined {
    let bytes: string
    try {
      bytes = readFileSync(this.path(key), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const value = JSON.parse(bytes) as CompositionBinding
    if (
      value.sessionKey !== key ||
      !value.tree ||
      !value.profile ||
      value.tree.profile !== value.profile.name ||
      !/^sha256-[a-f0-9]{64}$/.test(value.tree.hash)
    )
      throw new Error('E_COMPOSITION_BINDING_INVALID: session composition cannot be resumed')
    checkCompositionPatch(value.tree.selection)
    return value
  }
  pin(binding: CompositionBinding): CompositionBinding {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const path = this.path(binding.sessionKey),
      temporary = path + '.' + randomUUID()
    writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx', flush: true })
    try {
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      return this.read(binding.sessionKey)!
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  release(key: string): void {
    rmSync(this.path(key), { force: true })
  }
}

/** Safe status only. Private profile/config snapshots never enter the admin response. */
export async function createLiveCompositionWriter(profileDir: string) {
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
