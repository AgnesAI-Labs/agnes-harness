import { createHash, randomBytes } from 'node:crypto'
import { arch, platform, release } from 'node:os' // guards-allow-platform: telemetry context identifies host OS and architecture.
import { isSea } from 'node:sea'
import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'

declare const AGNES_VERSION: string | undefined

export type Surface = 'cli' | 'web' | 'desktop' | 'channel' | 'sdk' | 'unknown'

export function channelSession(key: string): boolean {
  // Channel adapters use sessionKeyFor's dm/group scopes, including thread suffixes.
  return /^agnes:[^:]+:[^:]+:[^:]+:(?:dm|group):[^:]+/.test(key)
}

export function telemetrySurface(conn: ConnectionState, key: string): Surface {
  if (conn.credentialKind === 'channel' || channelSession(key)) return 'channel'
  if (conn.bundledApp) return 'desktop'
  if (conn.localListener === 'web' || conn.authKind === 'surface') return 'web'
  return conn.localListener === 'unix' ? 'cli' : 'sdk'
}

export function telemetryRuntime(distribution?: string) {
  const os = platform()
  const version = typeof AGNES_VERSION === 'string' ? AGNES_VERSION : 'dev'
  return {
    app_version: version,
    os: ['darwin', 'linux', 'win32'].includes(os) ? os : 'other',
    arch: arch(),
    os_release: release(),
    node_version: process.versions.node,
    distribution:
      isSea() || distribution === 'sea'
        ? 'sea'
        : distribution === 'desktop'
          ? 'desktop'
          : version === 'dev' || version === '0.0.0' || distribution === 'dev'
            ? 'dev'
            : 'npm',
  }
}

export function telemetryId(at: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let bits = (BigInt(at) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`)
  let id = ''
  for (let digit = 0; digit < 26; digit++) {
    id = alphabet[Number(bits & 31n)] + id
    bits >>= 5n
  }
  return id
}

export function telemetryHash(installId: string, value: string): string {
  return createHash('sha256').update(`${installId}:${value}`).digest('hex')
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function postTelemetry(
  endpoint: URL,
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  idempotencyKey?: string,
): Promise<boolean> {
  try {
    const target = new URL(endpoint)
    target.pathname = target.pathname.replace(/\/+$/, '') + path
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-AGH-Schema-Version': '1',
        ...(idempotencyKey ? { 'Content-Encoding': 'gzip', 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    if (idempotencyKey && response.status === 200) return record(await response.json()).ok === true
    await response.body?.cancel()
  } catch {
    // A collector failure never reaches a user request or the audit log.
  }
  return false
}
