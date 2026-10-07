import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

export function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}
export const identity = (...parts: unknown[]): string => JSON.stringify(parts)
export const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

type Change = [string, unknown] | [string]
type Frame = { version: 1; revision: number; previous: string | null; changes: Change[]; digest: string }
const digest = (changes: Change[], revision: number, previous: string | null): string =>
  createHash('sha256')
    .update(JSON.stringify([revision, previous, changes]))
    .digest('hex')

/** A single fsynced line commits an entire synchronous transaction, including nested writes. */
export class Journal {
  private data = new Map<string, unknown>()
  private pending: Map<string, unknown> | undefined
  private closed = false
  private poisoned = false
  private revision = 0
  private previous: string | null = null
  private readonly fd: number = -1
  private readonly lock: string
  private readonly path: string

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'store.jsonl')
    this.lock = join(directory, 'writer.json')
    if (
      !existsSync(this.path) &&
      (existsSync(join(directory, 'events.jsonl')) || existsSync(join(directory, 'state.json')))
    )
      fail('E_FORMAT', 'export legacy JSONL sessions before selecting the complete provider')
    const gate = join(directory, 'open.lock')
    try {
      mkdirSync(gate)
    } catch {
      fail('E_WRITER_LEASE', 'another provider opener holds the directory gate')
    }
    try {
      if (existsSync(this.lock)) {
        const owner = JSON.parse(readFileSync(this.lock, 'utf8')) as { pid: number }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
          fail('E_STORAGE_FAULT', 'invalid directory lease')
        let alive = true
        try {
          process.kill(owner.pid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
          else throw error
        }
        if (alive) fail('E_WRITER_LEASE', 'JSONL directory is already open in a live process')
        rmSync(this.lock)
      }
      writeFileSync(this.lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    } finally {
      rmSync(gate, { recursive: true })
    }
    try {
      if (existsSync(this.path)) {
        const bytes = readFileSync(this.path)
        const end = bytes.lastIndexOf(10) + 1
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
          if (!line) continue
          let frame: Frame
          try {
            frame = JSON.parse(line) as Frame
          } catch {
            fail('E_STORAGE_FAULT', 'invalid committed JSONL transaction')
          }
          if (frame.version !== 1) fail('E_FORMAT', 'unsupported JSONL journal version')
          if (
            !Array.isArray(frame.changes) ||
            frame.revision !== this.revision + 1 ||
            frame.previous !== this.previous ||
            frame.digest !== digest(frame.changes, frame.revision, frame.previous)
          )
            fail('E_STORAGE_FAULT', 'invalid journal checksum')
          this.revision = frame.revision
          this.previous = frame.digest
          for (const change of frame.changes) {
            if (
              !Array.isArray(change) ||
              typeof change[0] !== 'string' ||
              (change.length !== 1 && change.length !== 2)
            )
              fail('E_STORAGE_FAULT', 'invalid journal mutation')
            if (change.length === 1) this.data.delete(change[0])
            else this.data.set(change[0], change[1])
          }
        }
        // Only a non-newline-terminated, unacknowledged transaction may be discarded.
        if (end !== bytes.length) truncateSync(this.path, end)
      }
      this.fd = openSync(this.path, 'a', 0o600)
      fsyncSync(this.fd)
      const directoryFd = openSync(directory, 'r')
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
    } catch (error) {
      if (this.fd >= 0) {
        try {
          closeSync(this.fd)
        } catch {
          /* Preserve the opening failure. */
        }
      }
      rmSync(this.lock)
      throw error
    }
  }
  guard(): void {
    if (this.closed) fail('E_CLOSED', 'JSONL provider is closed')
    if (this.poisoned) fail('E_STORAGE_FAULT', 'journal write outcome is uncertain; reopen for recovery')
  }
  get<T>(key: string): T | undefined {
    this.guard()
    const value = (this.pending ?? this.data).get(key)
    return value === undefined ? undefined : (jsonCopy(value) as T)
  }
  entries<T>(): [string, T][] {
    this.guard()
    return [...(this.pending ?? this.data)].map(([key, value]) => [key, jsonCopy(value) as T])
  }
  set(key: string, value: unknown): void {
    this.guard()
    const copy = jsonCopy(value)
    if (this.pending) this.pending.set(key, copy)
    else
      this.transaction(() => {
        if (!this.pending) fail('E_STORAGE_FAULT', 'missing journal transaction')
        this.pending.set(key, copy)
      })
  }
  delete(key: string): void {
    this.guard()
    if (this.pending) this.pending.delete(key)
    else
      this.transaction(() => {
        if (!this.pending) fail('E_STORAGE_FAULT', 'missing journal transaction')
        this.pending.delete(key)
      })
  }
  transaction<T>(fn: () => T): T {
    this.guard()
    const outer = this.pending
    this.pending = new Map(outer ?? this.data)
    try {
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new TypeError('metadata transaction callback must be synchronous')
      const next = this.pending
      if (outer) {
        this.pending = outer
        outer.clear()
        for (const pair of next) outer.set(...pair)
        return result
      }
      const changes: Change[] = []
      for (const [key, value] of next)
        if (JSON.stringify(value) !== JSON.stringify(this.data.get(key))) changes.push([key, value])
      for (const key of this.data.keys()) if (!next.has(key)) changes.push([key])
      if (changes.length) {
        const revision = this.revision + 1
        const checksum = digest(changes, revision, this.previous)
        const bytes = Buffer.from(
          `${JSON.stringify({ version: 1, revision, previous: this.previous, changes, digest: checksum })}\n`,
        )
        try {
          let offset = 0
          while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset)
          fsyncSync(this.fd)
          this.revision = revision
          this.previous = checksum
        } catch (error) {
          this.poisoned = true
          throw error
        }
      }
      this.data = next
      return result
    } finally {
      this.pending = outer
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      closeSync(this.fd)
    } finally {
      rmSync(this.lock)
    }
  }
}
