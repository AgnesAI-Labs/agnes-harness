import { createHash } from 'node:crypto'
import type { HookInvocationSnapshot } from '@agnes/extension-api'
import type { HostFs } from '../../../src/seam-init.js'

const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_EVENT_LENGTH = 128
const MAX_MATCHER_LENGTH = 1024
const MAX_COMMAND_LENGTH = 65_536
const MAX_URL_LENGTH = 4096
const MAX_TIMEOUT_SECONDS = 86_400

export type CcCommandHook = { type: 'command'; command: string; timeout?: number }
export type CcHttpHook = { type: 'http'; url: string; timeout?: number }
export type CcHook = CcCommandHook | CcHttpHook
export type CcHookGroup = { event: string; matcher?: string; hooks: CcHook[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

function timeout(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_SECONDS)
    return null
  return value
}

function hook(value: unknown): CcHook | undefined {
  if (!isRecord(value)) return undefined
  const hookTimeout = timeout(value.timeout)
  if (hookTimeout === null) return undefined
  const withTimeout = hookTimeout === undefined ? {} : { timeout: hookTimeout }

  if (value.type === 'command' && boundedString(value.command, MAX_COMMAND_LENGTH)) {
    return { type: 'command', command: value.command, ...withTimeout }
  }
  if (value.type !== 'http' || !boundedString(value.url, MAX_URL_LENGTH)) return undefined

  try {
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '')
      return undefined
  } catch {
    return undefined
  }
  return { type: 'http', url: value.url, ...withTimeout }
}

function group(event: string, value: unknown): CcHookGroup | undefined {
  if (!boundedString(event, MAX_EVENT_LENGTH) || !isRecord(value)) return undefined
  if (value.matcher !== undefined && !boundedString(value.matcher, MAX_MATCHER_LENGTH)) return undefined
  if (!Array.isArray(value.hooks) || value.hooks.length === 0) return undefined
  const hooks = value.hooks.map(hook)
  if (hooks.some((item) => item === undefined)) return undefined
  return {
    event,
    ...(value.matcher === undefined ? {} : { matcher: value.matcher }),
    hooks: hooks as CcHook[],
  }
}

/** Re-validates the Host-owned pure-data snapshot at each runner boundary. */
export function hookGroupsFromSnapshot(snapshot: HookInvocationSnapshot | undefined): CcHookGroup[] {
  if (snapshot === undefined) return []
  if (
    typeof snapshot.workspaceDigest !== 'string' ||
    snapshot.workspaceDigest.length === 0 ||
    typeof snapshot.policyRevision !== 'string' ||
    snapshot.policyRevision.length === 0 ||
    !Array.isArray(snapshot.hooks)
  )
    throw new Error('invalid workspace hook snapshot')
  const groups: CcHookGroup[] = []
  for (const value of snapshot.hooks) {
    if (!isRecord(value) || typeof value.event !== 'string')
      throw new Error('invalid workspace hook snapshot')
    const parsed = group(value.event, value)
    if (!parsed) throw new Error('invalid workspace hook snapshot')
    groups.push(parsed)
  }
  return groups
}

/**
 * Reads Claude Code hook files in caller-supplied precedence order.
 *
 * The caller owns warning policy because this leaf deliberately has no logger dependency. A file
 * that is absent, too large, unreadable or malformed contributes no groups; malformed groups do
 * not suppress valid siblings from the same file.
 */
export type CcHooksSnapshot = { configDigest: string; groups: CcHookGroup[] }

/** Parses and fingerprints one copied read, so permission never describes a different version. */
export async function readHooksSnapshot(fs: HostFs, path: string): Promise<CcHooksSnapshot | undefined> {
  let bytes: Uint8Array
  try {
    const stat = await fs.stat(path)
    if (stat.kind !== 'file' || stat.size > MAX_CONFIG_BYTES) return undefined
    bytes = Uint8Array.from(await fs.read(path))
    if (bytes.byteLength > MAX_CONFIG_BYTES) return undefined
  } catch {
    return undefined
  }
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  if (!isRecord(document) || !isRecord(document.hooks)) return undefined
  const groups: CcHookGroup[] = []
  for (const [event, values] of Object.entries(document.hooks)) {
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const parsed = group(event, value)
      if (parsed) groups.push(parsed)
    }
  }
  return { configDigest: `sha256-${createHash('sha256').update(bytes).digest('hex')}`, groups }
}

export async function readHooksConfig(fs: HostFs, paths: string[]): Promise<CcHookGroup[]> {
  const out: CcHookGroup[] = []
  for (const path of paths) {
    const snapshot = await readHooksSnapshot(fs, path)
    if (snapshot) out.push(...snapshot.groups)
  }
  return out
}
