import { createHash } from 'node:crypto'
import { request } from 'undici'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseDriverLock } from './driver-lock.js'

export type ComputerUseDownloadResponse = Readonly<{
  statusCode: number
  contentLength?: number
  location?: string
  body: AsyncIterable<Uint8Array>
}>

export type ComputerUseDownloadTransport = (
  url: string,
  signal: AbortSignal,
) => Promise<ComputerUseDownloadResponse>

function selectedArtifact(lock: ComputerUseDriverLock, platform: 'win32' | 'darwin' | 'linux') {
  const runtimeArchitecture = createPlatform().snapshot().arch
  const architecture = runtimeArchitecture === 'x64' ? 'x86_64' : runtimeArchitecture
  return lock.artifacts.find(
    (artifact) => artifact.platform === platform && artifact.architectures.includes(architecture as never),
  )
}

async function trustedHttpsGet(url: string, signal: AbortSignal): Promise<ComputerUseDownloadResponse> {
  const response = await request(url, {
    method: 'GET',
    signal,
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'agnes-computer-use-installer/1',
    },
  })
  const rawLength = response.headers['content-length']
  const rawLocation = response.headers.location
  const contentLength =
    typeof rawLength === 'string' && /^[0-9]+$/.test(rawLength) ? Number(rawLength) : undefined
  return {
    statusCode: response.statusCode,
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(typeof rawLocation === 'string' ? { location: rawLocation } : {}),
    body: response.body,
  }
}

function trustedReleaseRedirect(value: string | undefined): string {
  if (typeof value !== 'string') throw new Error('Computer Use download redirect lacks a location')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Computer Use download redirect location is invalid')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'release-assets.githubusercontent.com' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith('/github-production-release-asset/') ||
    !url.search
  )
    throw new Error('Computer Use download redirect is outside GitHub release assets')
  return url.href
}

async function discardRedirectBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  let total = 0
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Computer Use download returned invalid bytes')
    total += chunk.byteLength
    if (total > 64 * 1024) throw new Error('Computer Use download redirect body is oversized')
  }
}

/** Downloads the exact lock URL through at most one trusted release-asset redirect, then verifies it. */
export async function downloadLockedWindowsComputerUseDriver(
  lock: ComputerUseDriverLock,
  options: Readonly<{
    signal?: AbortSignal
    transport?: ComputerUseDownloadTransport
  }> = {},
): Promise<Uint8Array> {
  return downloadLockedComputerUseDriver(lock, 'win32', options)
}

/** Platform-scoped locked asset download. Signature verification remains a separate mandatory gate. */
export async function downloadLockedComputerUseDriver(
  lock: ComputerUseDriverLock,
  platform: 'win32' | 'darwin' | 'linux',
  options: Readonly<{
    signal?: AbortSignal
    transport?: ComputerUseDownloadTransport
  }> = {},
): Promise<Uint8Array> {
  const artifact = selectedArtifact(lock, platform)
  if (!artifact) throw new Error(`Computer Use lock has no ${platform} artifact for this architecture`)
  const expectedPrefix = `https://github.com/trycua/cua/releases/download/${lock.source.tag}/`
  if (!artifact.url.startsWith(expectedPrefix) || artifact.url !== `${expectedPrefix}${artifact.name}`)
    throw new Error('Computer Use artifact URL is not the exact locked release URL')
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Computer Use download timed out')), 120_000)
  try {
    if (options.signal?.aborted) controller.abort(options.signal.reason)
    const transport = options.transport ?? trustedHttpsGet
    let response = await transport(artifact.url, controller.signal)
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const redirected = trustedReleaseRedirect(response.location)
      await discardRedirectBody(response.body)
      response = await transport(redirected, controller.signal)
      if ([301, 302, 303, 307, 308].includes(response.statusCode))
        throw new Error('Computer Use download returned too many redirects')
    }
    if (response.statusCode !== 200)
      throw new Error(`Computer Use download returned HTTP ${response.statusCode}`)
    if (response.contentLength !== undefined && response.contentLength !== artifact.size)
      throw new Error('Computer Use download Content-Length differs from the lock')
    const chunks: Uint8Array[] = []
    let total = 0
    const digest = createHash('sha256')
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error('Computer Use download returned invalid bytes')
      total += chunk.byteLength
      if (total > artifact.size) throw new Error('Computer Use download exceeds the locked size')
      const copy = Uint8Array.from(chunk)
      chunks.push(copy)
      digest.update(copy)
    }
    if (total !== artifact.size) throw new Error('Computer Use download size differs from the lock')
    if (digest.digest('hex') !== artifact.sha256)
      throw new Error('Computer Use download digest differs from the lock')
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
