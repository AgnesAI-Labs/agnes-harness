import { createHash } from 'node:crypto'
import type { FsOps } from '@agnes/core'
import type { HookInvocationSnapshot } from '@agnes/extension-api'
import { AGH_DIR, type JsonValue } from '@agnes/protocol'
import { HostError } from './errors.js'

const HOOKS_PATH = `${AGH_DIR}/hooks.json`
const MAX_HOOKS_BYTES = 256 * 1024
const MAX_EVENT_LENGTH = 128
const MAX_MATCHER_LENGTH = 1024
const MAX_COMMAND_LENGTH = 65_536
const MAX_URL_LENGTH = 4096
const MAX_TIMEOUT_SECONDS = 86_400
const EMPTY_DIGEST = `sha256-${createHash('sha256').update(new Uint8Array()).digest('hex')}`

type HookFs = Readonly<Pick<FsOps, 'read' | 'stat'>>
type FileIdentity = Readonly<{ kind: 'file'; size: number; mtimeMs: number }>

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')

const failure = (reason: string): HostError =>
  new HostError('E_WORKSPACE_UNTRUSTED', 'workspace hook configuration is unavailable', {
    detail: { reason },
  })

const missing = (error: unknown): boolean => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function identity(stat: Awaited<ReturnType<HookFs['stat']>>): FileIdentity {
  if (stat.kind !== 'file') throw failure('hooks-not-regular')
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtimeMs))
    throw failure('hooks-stat-invalid')
  if (stat.size > MAX_HOOKS_BYTES) throw failure('hooks-too-large')
  return Object.freeze({ kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs })
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.kind === right.kind && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function parsedTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_SECONDS)
    throw failure('hooks-shape-invalid')
  return value
}

function parsedHook(value: unknown): Record<string, JsonValue> {
  if (!record(value)) throw failure('hooks-shape-invalid')
  const timeout = parsedTimeout(value.timeout)
  if (value.type === 'command' && bounded(value.command, MAX_COMMAND_LENGTH)) {
    const result: Record<string, JsonValue> = { type: 'command', command: value.command }
    if (timeout !== undefined) result.timeout = timeout
    return Object.freeze(result)
  }
  if (value.type !== 'http' || !bounded(value.url, MAX_URL_LENGTH)) throw failure('hooks-shape-invalid')
  try {
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw failure('hooks-shape-invalid')
  } catch (error) {
    if (error instanceof HostError) throw error
    throw failure('hooks-shape-invalid')
  }
  const result: Record<string, JsonValue> = { type: 'http', url: value.url }
  if (timeout !== undefined) result.timeout = timeout
  return Object.freeze(result)
}

function parseHooks(bytes: Uint8Array): readonly JsonValue[] {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw failure('hooks-json-invalid')
  }
  if (!record(value) || !record(value.hooks)) throw failure('hooks-shape-invalid')
  const groups: JsonValue[] = []
  for (const [event, entries] of Object.entries(value.hooks)) {
    if (!bounded(event, MAX_EVENT_LENGTH) || !Array.isArray(entries)) throw failure('hooks-shape-invalid')
    for (const entry of entries) {
      if (!record(entry) || (entry.matcher !== undefined && !bounded(entry.matcher, MAX_MATCHER_LENGTH)))
        throw failure('hooks-shape-invalid')
      if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) throw failure('hooks-shape-invalid')
      const hooks: JsonValue[] = entry.hooks.map(parsedHook)
      Object.freeze(hooks)
      const normalized: Record<string, JsonValue> = { event, hooks }
      if (entry.matcher !== undefined) normalized.matcher = entry.matcher as string
      groups.push(Object.freeze(normalized))
    }
  }
  return Object.freeze(groups)
}

function revision(read: () => string): string {
  const value = read()
  if (!bounded(value, 512)) throw failure('hook-policy-revision-invalid')
  return value
}

/**
 * Reads the one workspace hook file through its already-bound filesystem fence. Callers cannot
 * choose a path, root or policy revision, and parsed data never retains the filesystem capability.
 */
export class WorkspaceHookLoader {
  private cached: Readonly<{ digest: string; hooks: readonly JsonValue[] }> | undefined

  constructor(
    private readonly fs: HookFs,
    private readonly policyRevision: () => string,
  ) {}

  async snapshot(signal?: AbortSignal): Promise<HookInvocationSnapshot> {
    signal?.throwIfAborted()
    // The policy cell is sampled exactly once at invocation start. Later policy changes belong to
    // the next invocation and cannot make this file snapshot internally drift.
    const policyRevision = revision(this.policyRevision)
    let before: FileIdentity
    try {
      before = identity(await this.fs.stat(HOOKS_PATH))
    } catch (error) {
      if (!missing(error)) throw error
      signal?.throwIfAborted()
      return Object.freeze({
        workspaceDigest: EMPTY_DIGEST,
        policyRevision,
        hooks: Object.freeze([]),
      })
    }

    signal?.throwIfAborted()
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(await this.fs.read(HOOKS_PATH))
    } catch {
      // Missing after a successful stat is a read race, not an empty configuration.
      throw failure('hooks-read-race')
    }
    signal?.throwIfAborted()
    if (bytes.byteLength !== before.size || bytes.byteLength > MAX_HOOKS_BYTES)
      throw failure('hooks-read-race')

    let after: FileIdentity
    try {
      after = identity(await this.fs.stat(HOOKS_PATH))
    } catch {
      throw failure('hooks-read-race')
    }
    signal?.throwIfAborted()
    if (!sameIdentity(before, after) || after.size !== bytes.byteLength) throw failure('hooks-read-race')

    const digest = `sha256-${createHash('sha256').update(bytes).digest('hex')}`
    const hooks = this.cached?.digest === digest ? this.cached.hooks : parseHooks(bytes)
    if (this.cached?.digest !== digest) this.cached = Object.freeze({ digest, hooks })
    return Object.freeze({
      workspaceDigest: digest,
      policyRevision,
      hooks,
    })
  }
}
