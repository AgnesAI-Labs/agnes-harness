import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createPlatform } from '@agnes/host'

export type Owner = {
  pid: number
  processStartId: string
  generation: string
  startedAt: string
  socketPath: string
}
export class OwnerReadError extends Error {
  override name = 'OwnerReadError'
  constructor() {
    super('daemon owner record is unavailable or invalid')
  }
}
const hasControl = (text: string, max: number) =>
  [...text].some((char) => char.charCodeAt(0) <= max || char.charCodeAt(0) === 127)
const keys = ['pid', 'processStartId', 'generation', 'startedAt', 'socketPath']
function parseOwner(text: string): Owner {
  const v: unknown = JSON.parse(text)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OwnerReadError()
  const value = v as Record<string, unknown>
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new OwnerReadError()
  if (
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > 2147483647
  )
    throw new OwnerReadError()
  if (
    typeof value.processStartId !== 'string' ||
    !value.processStartId ||
    value.processStartId.length > 256 ||
    hasControl(value.processStartId, 32)
  )
    throw new OwnerReadError()
  if (
    typeof value.generation !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.generation)
  )
    throw new OwnerReadError()
  if (typeof value.startedAt !== 'string' || new Date(value.startedAt).toISOString() !== value.startedAt)
    throw new OwnerReadError()
  if (
    typeof value.socketPath !== 'string' ||
    value.socketPath.length > 1024 ||
    hasControl(value.socketPath, 31) ||
    !(isAbsolute(value.socketPath) || value.socketPath.startsWith('\\\\.\\pipe\\'))
  )
    throw new OwnerReadError()
  return value as Owner
}

/** Validate before publishing the same closed shape that the reader accepts. */
export function encodeOwner(owner: Owner): string {
  try {
    return JSON.stringify(parseOwner(JSON.stringify(owner)))
  } catch {
    throw new OwnerReadError()
  }
}

/** Null means absent, never corrupt. Reading does not acquire or reclaim the lock. */
export async function readOwner(dataDir: string): Promise<Owner | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      join(dataDir, 'daemon', 'owner.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw new OwnerReadError()
  }
  try {
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.size > 4096 ||
        // O_NOFOLLOW is not available on Windows. Reject hard-linked records so an external path
        // cannot mutate the exact file after this identity check.
        (createPlatform().os === 'win32' && info.nlink !== 1)
      )
        throw new OwnerReadError()
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) throw new OwnerReadError()
      return parseOwner(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)))
    } finally {
      await handle.close()
    }
  } catch {
    throw new OwnerReadError()
  }
}
