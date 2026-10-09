import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'

export interface ObservabilityConfig {
  enabled: boolean
  endpoint?: string
  tracesEndpoint?: string
  metricsEndpoint?: string
  logsEndpoint?: string
  headers?: Record<string, { secretRef: string }>
  redaction?: 'metadata' | 'content'
  batchSize?: number
  batchMs?: number
  queueSize?: number
  timeoutMs?: number
  shutdownPolicy?: 'flush' | 'discard'
}
export function observabilityHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AGH_HOME?.trim() || env.AGNES_HOME?.trim() || join(homedir(), AGH_DIR)
  if (!isAbsolute(home)) throw new Error('Observability home must be absolute')
  return home
}
export function validateObservability(config: ObservabilityConfig): ObservabilityConfig {
  const allowed = new Set([
    'enabled',
    'endpoint',
    'tracesEndpoint',
    'metricsEndpoint',
    'logsEndpoint',
    'headers',
    'redaction',
    'batchSize',
    'batchMs',
    'queueSize',
    'timeoutMs',
    'shutdownPolicy',
  ])
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !allowed.has(key)) ||
    typeof config.enabled !== 'boolean'
  )
    throw new Error('Invalid observability configuration')
  if (
    config.enabled &&
    !config.endpoint &&
    !(config.tracesEndpoint && config.metricsEndpoint && config.logsEndpoint)
  )
    throw new Error('Observability requires an OTLP endpoint')
  for (const endpoint of [
    config.endpoint,
    config.tracesEndpoint,
    config.metricsEndpoint,
    config.logsEndpoint,
  ]) {
    if (endpoint === undefined) continue
    try {
      if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new Error()
      const url = new URL(endpoint)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error()
    } catch {
      throw new Error('Invalid OTLP endpoint')
    }
  }
  for (const [value, min, max] of [
    [config.batchMs ?? 1000, 10, 30000],
    [config.timeoutMs ?? 3000, 10, 30000],
    [config.queueSize ?? 1024, 1, 16384],
    [config.batchSize ?? Math.min(256, config.queueSize ?? 1024), 1, config.queueSize ?? 1024],
  ]) {
    if (!Number.isInteger(value) || value! < min! || value! > max!)
      throw new Error('Invalid observability limits')
  }
  if (config.redaction !== undefined && !['metadata', 'content'].includes(config.redaction))
    throw new Error('Invalid observability redaction')
  if (config.shutdownPolicy !== undefined && !['flush', 'discard'].includes(config.shutdownPolicy))
    throw new Error('Invalid observability shutdown policy')
  if (config.headers !== undefined) {
    if (
      !config.headers ||
      typeof config.headers !== 'object' ||
      Array.isArray(config.headers) ||
      Object.keys(config.headers).length > 16
    )
      throw new Error('Invalid OTLP secret refs')
    for (const [key, value] of Object.entries(config.headers))
      if (
        !/^[a-zA-Z0-9-]{1,128}$/.test(key) ||
        ['content-type', 'host', 'content-length'].includes(key.toLowerCase()) ||
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).length !== 1 ||
        typeof value.secretRef !== 'string' ||
        !/^env:[A-Z_][A-Z0-9_]{0,123}$/.test(value.secretRef)
      )
        throw new Error('Invalid OTLP secret refs')
  }
  // Queue rows retain a snapshot even if the caller later mutates its settings object.
  return {
    ...config,
    ...(config.headers
      ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, ref]) => [key, { ...ref }])) }
      : {}),
  }
}
/** No plaintext header configuration or ambient OTLP_HEADERS is consumed. */
export function observabilityConfig(
  explicit: Partial<ObservabilityConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  let file: Partial<ObservabilityConfig> = {}
  try {
    const fd = openSync(
      join(observabilityHome(env), 'observability.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error()
      file = JSON.parse(readFileSync(fd, 'utf8')) as Partial<ObservabilityConfig>
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Invalid observability configuration')
  }
  if (!file || typeof file !== 'object' || Array.isArray(file))
    throw new Error('Invalid observability configuration')
  const config = validateObservability({ enabled: false, ...file, ...explicit })
  if (env.OTEL_SDK_DISABLED === 'true' || env.OTEL_SDK_DISABLED === '1') config.enabled = false
  return config
}
export function resolveHeaders(config: ObservabilityConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, ref] of Object.entries(config.headers ?? {})) {
    const value = process.env[ref.secretRef.slice(4)]
    if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('OTLP secret unavailable')
    headers[name] = value
  }
  return headers
}

/** Asynchronous live-resource read; never performs disk I/O on a session append callback. */
export async function readObservabilityConfig(
  home: string,
  explicit: Partial<ObservabilityConfig> = {},
): Promise<ObservabilityConfig> {
  let file: Partial<ObservabilityConfig> = {}
  try {
    const handle = await open(join(home, 'observability.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid observability configuration')
      file = JSON.parse(await handle.readFile('utf8')) as Partial<ObservabilityConfig>
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Invalid observability configuration')
  }
  if (!file || typeof file !== 'object' || Array.isArray(file))
    throw new Error('Invalid observability configuration')
  const config = validateObservability({ enabled: false, ...file, ...explicit })
  if (process.env.OTEL_SDK_DISABLED === 'true' || process.env.OTEL_SDK_DISABLED === '1')
    config.enabled = false
  return config
}
