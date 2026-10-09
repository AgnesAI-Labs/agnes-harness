import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdminObservabilityParams, AdminObservabilityResult } from '@agnes/protocol/gen/app-server'
import { createPrivateFileSync, windowsWritePrivateFile } from '@agnes/system-node'
import { observabilityConfig, observabilityHome, validateObservability } from './config.js'
import { configureExporter, exporterHealth } from './runtime.js'
import { OtlpTransport } from './transport.js'

/** Invoke only behind a local-owner authority check. Destination changes are a backend operation. */
export async function administerObservability(
  input: AdminObservabilityParams,
  home = observabilityHome(),
): Promise<AdminObservabilityResult> {
  const settings = input.settings
    ? validateObservability(input.settings)
    : observabilityConfig({}, { ...process.env, AGH_HOME: home })
  if (input.settings && !input.test) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const stat = lstatSync(home)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid observability home')
    const file = join(home, 'observability.json')
    const bytes = Buffer.from(`${JSON.stringify(settings)}\n`)
    if (process.platform === 'win32')
      await windowsWritePrivateFile(file, bytes) // guards-allow-platform: private configuration replacement.
    else {
      const temporary = `${file}.${randomUUID()}.tmp`
      const fd = createPrivateFileSync(temporary)
      try {
        try {
          writeFileSync(fd, bytes)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    configureExporter(home, observabilityConfig({}, { ...process.env, AGH_HOME: home }))
  }
  let connection: 'ok' | 'failed' | undefined
  if (input.test) {
    validateObservability({ ...settings, enabled: true })
    // One synthetic record for each enabled signal. No ledger/content is read by a connection probe.
    const probe = new OtlpTransport({
      ...settings,
      enabled: true,
      batchSize: 1,
      queueSize: 3,
      shutdownPolicy: 'discard',
    })
    const deadline = setTimeout(() => void probe.dispose(), settings.timeoutMs ?? 3000)
    try {
      for (const signal of ['traces', 'logs', 'metrics'] as const) {
        if (signal === 'logs')
          probe.add(signal, { body: { stringValue: 'agh.exporter.connection-test' }, severityNumber: 9 })
        else if (signal === 'metrics')
          probe.add(signal, {
            name: 'agh.exporter.connection-test',
            unit: '1',
            gauge: {
              dataPoints: [
                { asDouble: 1, timeUnixNano: String(BigInt(Date.now()) * 1000000n), attributes: [] },
              ],
            },
          })
        else
          probe.add(signal, {
            name: 'agh.exporter.connection-test',
            traceId: randomUUID().replaceAll('-', ''),
            spanId: randomUUID().replaceAll('-', '').slice(0, 16),
            kind: 1,
            startTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
            endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
            attributes: [],
          })
      }
      await probe.flush()
      connection =
        probe.health().failures || probe.health().dropped || probe.health().queued ? 'failed' : 'ok'
    } finally {
      clearTimeout(deadline)
      await probe.dispose()
    }
  }
  return { settings, health: exporterHealth(home), ...(connection ? { connection } : {}) }
}

/** Content-free live status for diagnostic bundles. */
export function telemetrySnapshot(home = observabilityHome()) {
  try {
    const config = observabilityConfig({}, { ...process.env, AGH_HOME: home })
    return {
      enabled: config.enabled,
      includeContent: config.redaction === 'content',
      endpointHosts: [
        ...new Set(
          [config.endpoint, config.tracesEndpoint, config.metricsEndpoint, config.logsEndpoint].flatMap(
            (endpoint) => (endpoint ? [new URL(endpoint).host] : []),
          ),
        ),
      ],
    }
  } catch {
    return { enabled: false, includeContent: false, endpointHosts: [] }
  }
}
