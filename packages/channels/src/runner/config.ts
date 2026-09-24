import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ChannelManifest } from '@agnes/protocol'
import { windowsReadPrivateTextSync } from '@agnes/system-node'
import { parse as parseYaml } from 'yaml'
import { ChannelError } from '../errors.js'

export type Connect =
  | { kind: 'unix'; path: string }
  | { kind: 'ws'; url: string; sourceAuthSecretRef?: string }

export type RunnerConfig = {
  channel: string
  connect: Connect
  localDaemon?: { home?: string; profile?: string; dataDir?: string }
  tenant: string
  agent: string
  credentialsFile: string
  allowFrom: string[]
  requireMention: boolean
  ackReaction: 'all' | 'direct' | 'group-all' | 'group-mentions' | 'off'
  workspace: string
  outbound: { costLine: boolean }
  directory: { sync: string | false }
  healthz: { enabled: boolean; port: number }
}

export function validateLocalDaemonTarget(config: Pick<RunnerConfig, 'connect' | 'localDaemon'>): void {
  if (
    config.localDaemon !== undefined &&
    (config.connect.kind !== 'unix' || !config.connect.path.startsWith('\\\\.\\pipe\\'))
  )
    invalid('localDaemon requires a Windows local pipe connection', 'localDaemon')
}

function parseLocalDaemon(input: unknown): RunnerConfig['localDaemon'] {
  if (input === undefined) return undefined
  if (!isRecord(input)) invalid('localDaemon must be a mapping', 'localDaemon')
  const result: NonNullable<RunnerConfig['localDaemon']> = {}
  for (const key of Object.keys(input)) {
    if (key !== 'home' && key !== 'profile' && key !== 'dataDir')
      invalid(`unknown localDaemon field ${key}`, 'localDaemon')
    const value = nonEmptyString(input[key], `localDaemon.${key}`)
    if (!value.trim() || value.includes('\0')) invalid(`invalid localDaemon.${key}`, `localDaemon.${key}`)
    result[key] = value
  }
  return result
}

function invalid(message: string, key?: string): never {
  throw new ChannelError('E_CONFIG_INVALID', message, key === undefined ? undefined : { key })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapping(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) invalid(`${key} must be a mapping`, key)
  return value
}

function nonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${key} must be a non-empty string`, key)
  return value
}

function optionalBoolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') invalid(`${key} must be a boolean`, key)
  return value
}

export function parseConnect(value: unknown): Connect {
  const connect = nonEmptyString(value, 'connect')
  if (connect.startsWith('unix:')) {
    const path = connect.slice('unix:'.length)
    if (path.length === 0) invalid('connect unix path must not be empty', 'connect')
    return { kind: 'unix', path }
  }
  if (connect.startsWith('ws://') || connect.startsWith('wss://')) {
    try {
      const url = new URL(connect)
      if (!url.hostname) invalid('connect websocket URL must have a host', 'connect')
    } catch {
      invalid('connect must be a valid ws:// or wss:// URL', 'connect')
    }
    return { kind: 'ws', url: connect }
  }
  return invalid('connect must be unix:<path> or ws[s]://<host>', 'connect')
}

function parseAllowFrom(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    invalid('allowFrom must be an array of non-empty strings', 'allowFrom')
  }
  return [...value] as string[]
}

const ACK_REACTIONS = new Set<RunnerConfig['ackReaction']>([
  'all',
  'direct',
  'group-all',
  'group-mentions',
  'off',
])

function parseAckReaction(value: unknown): RunnerConfig['ackReaction'] {
  if (value === undefined) return 'group-mentions'
  if (typeof value !== 'string' || !ACK_REACTIONS.has(value as RunnerConfig['ackReaction'])) {
    invalid('ackReaction is not a supported policy', 'ackReaction')
  }
  return value as RunnerConfig['ackReaction']
}

export async function loadConfig(path: string): Promise<RunnerConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ChannelError('E_CONFIG_INVALID', `cannot read ${path}: ${errorMessage(error)}`, { path })
  }

  let input: unknown
  try {
    input = parseYaml(text)
  } catch (error) {
    throw new ChannelError('E_CONFIG_INVALID', `${path} is not valid YAML: ${errorMessage(error)}`, {
      path,
    })
  }
  if (!isRecord(input)) invalid(`${path} must contain a mapping`)

  for (const key of ['channel', 'connect', 'tenant', 'agent', 'credentialsFile'] as const) {
    if (input[key] === undefined) invalid(`missing ${key}`, key)
  }

  const outbound = mapping(input.outbound, 'outbound')
  const directory = mapping(input.directory, 'directory')
  const healthz = mapping(input.healthz, 'healthz')
  const sync = directory.sync
  if (sync !== undefined && sync !== false && (typeof sync !== 'string' || sync.length === 0)) {
    invalid('directory.sync must be false or a non-empty schedule string', 'directory.sync')
  }
  const port = healthz.port ?? 9877
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
    invalid('healthz.port must be an integer from 0 through 65535', 'healthz.port')
  }

  const connect = parseConnect(input.connect)
  const localDaemon = parseLocalDaemon(input.localDaemon)
  validateLocalDaemonTarget({ connect, ...(localDaemon === undefined ? {} : { localDaemon }) })
  return {
    channel: nonEmptyString(input.channel, 'channel'),
    connect,
    ...(localDaemon === undefined ? {} : { localDaemon }),
    tenant: nonEmptyString(input.tenant, 'tenant'),
    agent: nonEmptyString(input.agent, 'agent'),
    credentialsFile: nonEmptyString(input.credentialsFile, 'credentialsFile'),
    allowFrom: parseAllowFrom(input.allowFrom),
    requireMention: optionalBoolean(input.requireMention, true, 'requireMention'),
    ackReaction: parseAckReaction(input.ackReaction),
    workspace: input.workspace === undefined ? process.cwd() : nonEmptyString(input.workspace, 'workspace'),
    outbound: {
      costLine: optionalBoolean(outbound.costLine, true, 'outbound.costLine'),
    },
    directory: {
      sync: sync === undefined ? 'every 15m' : sync,
    },
    healthz: {
      enabled: optionalBoolean(healthz.enabled, true, 'healthz.enabled'),
      port,
    },
  }
}

function unreadable(path: string, message: string): ChannelError {
  return new ChannelError('E_SECRETS_UNREADABLE', `${path}: ${message}`, { path })
}

function parseSecretJson(path: string, text: string): Record<string, string> {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    throw unreadable(path, 'invalid JSON')
  }
  if (!isRecord(input)) throw unreadable(path, 'JSON secrets must be an object')
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') throw unreadable(path, `secret ${key} must be a string`)
    output[key] = value
  }
  return output
}

function parseSecretEnv(path: string, text: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [offset, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw unreadable(path, `line ${offset + 1} must be KEY=VALUE`)
    const key = line.slice(0, separator).trim()
    if (key.length === 0) throw unreadable(path, `line ${offset + 1} has an empty key`)
    if (Object.hasOwn(output, key)) throw unreadable(path, `duplicate secret ${key}`)
    output[key] = line.slice(separator + 1).trim()
  }
  return output
}

const windowsSecrets = process.platform === 'win32' // guards-allow-platform: Channels private credential file reader.

export async function loadSecrets(path: string, manifest: ChannelManifest): Promise<Record<string, string>> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  let text: string
  try {
    if (windowsSecrets) {
      text = windowsReadPrivateTextSync(resolve(path), 1024 * 1024)
    } else {
      // Check and read through the same descriptor so a path swap cannot bypass the mode gate.
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
      const metadata = await file.stat()
      if (!metadata.isFile()) throw unreadable(path, 'not a regular file')
      if ((metadata.mode & 0o077) !== 0) {
        throw unreadable(
          path,
          `mode ${(metadata.mode & 0o777).toString(8)} grants group or other access; chmod 600`,
        )
      }
      text = await file.readFile('utf8')
    }
  } catch (error) {
    if (error instanceof ChannelError) throw error
    throw unreadable(path, `cannot open or read: ${errorMessage(error)}`)
  } finally {
    await file?.close().catch(() => undefined)
  }
  const trimmed = text.trim()
  const secrets = trimmed.startsWith('{') ? parseSecretJson(path, trimmed) : parseSecretEnv(path, text)
  const missing = manifest.credentials.required.filter(
    (key) => !Object.hasOwn(secrets, key) || secrets[key]?.length === 0,
  )
  if (missing.length > 0) throw unreadable(path, `missing required ${missing.join(',')}`)
  return secrets
}

export function redact(secrets: Record<string, string>, text: string): string {
  const values = [...new Set(Object.values(secrets).filter((value) => value.length >= 4))].sort(
    (left, right) => right.length - left.length,
  )
  let output = text
  for (const value of values) output = output.split(value).join('***')
  return output
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
