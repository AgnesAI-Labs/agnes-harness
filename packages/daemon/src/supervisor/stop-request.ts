import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPrivateFileSync,
  renameWriteThroughSync,
  windowsProtectPrivateDirectorySync,
  windowsReadPrivateFileSync,
} from '@agnes/system-node'
import type { Owner } from './owner-record.js'

type Generation = Pick<Owner, 'pid' | 'processStartId' | 'generation'>
const requestPath = (dataDir: string) => join(dataDir, 'daemon', 'stop-request.json')
const record = (owner: Generation) => ({
  version: 1,
  command: 'stop',
  pid: owner.pid,
  processStartId: owner.processStartId,
  generation: owner.generation,
})

/** Windows-only private control file. The caller must first revalidate the current owner identity. */
export function publishWindowsStopRequest(dataDir: string, owner: Generation): void {
  windowsProtectPrivateDirectorySync(join(dataDir, 'daemon'))
  const file = requestPath(dataDir)
  const temporary = `${file}.${randomUUID()}.tmp`
  let created = false
  try {
    const fd = createPrivateFileSync(temporary)
    created = true
    try {
      writeFileSync(fd, JSON.stringify(record(owner)))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWriteThroughSync(temporary, file)
    created = false
  } catch (error) {
    if (created) {
      try {
        unlinkSync(temporary)
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new AggregateError([error, cleanup], 'Windows stop request publication and cleanup failed')
      }
    }
    throw error
  }
}

/** Exact generation and shape; absence, malformed data and unsafe files never authorize a stop. */
export function hasWindowsStopRequest(dataDir: string, owner: Generation): boolean {
  try {
    windowsProtectPrivateDirectorySync(join(dataDir, 'daemon'))
    const bytes = windowsReadPrivateFileSync(requestPath(dataDir), 4096)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const expected = record(owner)
    const actual = value as Record<string, unknown>
    return (
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, expectedValue]) => actual[key] === expectedValue)
    )
  } catch {
    return false
  }
}

/** The owning daemon supplies its immutable generation and its existing shutdown routine. */
export function watchWindowsStopRequest(dataDir: string, owner: Generation, stop: () => void): () => void {
  const timer = setInterval(() => {
    if (!hasWindowsStopRequest(dataDir, owner)) return
    clearInterval(timer)
    stop()
  }, 100)
  timer.unref()
  return () => clearInterval(timer)
}
