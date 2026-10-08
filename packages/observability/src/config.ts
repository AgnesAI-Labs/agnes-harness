import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'

export interface ObservabilityConfig {
  enabled: boolean
  endpoint?: string
  tracesEndpoint?: string
  metricsEndpoint?: string
  headers?: Record<string, string>
  includeContent?: boolean
  batchMs?: number
  timeoutMs?: number
}
export function observabilityHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AGH_HOME?.trim() || env.AGNES_HOME?.trim() || join(homedir(), AGH_DIR)
  if (!isAbsolute(home)) throw new Error('Observability home must be absolute')
  return home
}
/** Explicit opt-in is independent of an endpoint. Invalid enabled configuration fails at load. */
export function observabilityConfig(
  explicit: Partial<ObservabilityConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  const path = join(observabilityHome(env), 'observability.json')
  let file: Partial<ObservabilityConfig> = {}
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid observability configuration')
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
  const boolean = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined) return fallback
    if (!['true', 'false', '1', '0'].includes(value)) throw new Error('Invalid observability switch')
    return value === 'true' || value === '1'
  }
  const headers: Record<string, string> = {}
  if (env.OTEL_EXPORTER_OTLP_HEADERS)
    for (const entry of env.OTEL_EXPORTER_OTLP_HEADERS.split(',')) {
      const index = entry.indexOf('=')
      if (index < 1) throw new Error('Invalid OTLP headers')
      headers[entry.slice(0, index).trim()] = decodeURIComponent(entry.slice(index + 1).trim())
    }
  const config: ObservabilityConfig = {
    ...file,
    enabled: boolean(env.AGH_OTEL_ENABLED, file.enabled ?? false),
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    ...(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? { tracesEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
      : {}),
    ...(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
      ? { metricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT }
      : {}),
    ...(env.OTEL_EXPORTER_OTLP_HEADERS ? { headers } : {}),
    ...(env.OTEL_EXPORTER_OTLP_TIMEOUT ? { timeoutMs: Number(env.OTEL_EXPORTER_OTLP_TIMEOUT) } : {}),
    includeContent: boolean(env.AGH_OTEL_INCLUDE_CONTENT, file.includeContent ?? false),
    ...explicit,
  }
  if (boolean(env.OTEL_SDK_DISABLED, false)) config.enabled = false
  if (typeof config.enabled !== 'boolean' || typeof config.includeContent !== 'boolean')
    throw new Error('Invalid observability switch')
  if (config.enabled) {
    if (!config.endpoint && !(config.tracesEndpoint && config.metricsEndpoint))
      throw new Error('Observability requires an OTLP endpoint')
    for (const endpoint of [config.endpoint, config.tracesEndpoint, config.metricsEndpoint].filter(Boolean)) {
      const url = new URL(endpoint!)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw new Error('Invalid OTLP endpoint')
    }
    for (const ms of [config.batchMs ?? 1000, config.timeoutMs ?? 3000])
      if (!Number.isInteger(ms) || ms < 10 || ms > 30_000) throw new Error('Invalid observability timeout')
    for (const [key, value] of Object.entries(config.headers ?? {}))
      if (!/^[a-zA-Z0-9-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))
        throw new Error('Invalid OTLP headers')
  }
  return config
}
