import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type DiagnosticRecord,
  diagnosticRecords,
  observeDiagnostics,
  safeDiagnosticRecord,
} from '@agnes/protocol'
import {
  windowsAppendPrivateFileSync,
  windowsEnsurePrivateDirectorySync,
  windowsOpenPrivateFileSync,
} from '@agnes/system-node'
import { observabilityHome } from './config.js'

const windows = process.platform === 'win32' // guards-allow-platform: private diagnostics storage primitives.
const registrations = new Map<string, { refs: number; stop(): void }>()
export function installDiagnosticJournal(home = observabilityHome()): () => void {
  const existing = registrations.get(home)
  if (existing) {
    existing.refs++
    return releaser(home)
  }
  const dir = join(home, 'diagnostics'),
    file = join(dir, 'errors.jsonl')
  if (windows) {
    windowsEnsurePrivateDirectorySync(dir)
    windowsAppendPrivateFileSync(file, Buffer.alloc(0))
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
      throw new Error('Invalid diagnostics directory')
    chmodSync(dir, 0o700)
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Invalid diagnostic journal')
      fchmodSync(fd, 0o600)
    } finally {
      closeSync(fd)
    }
  }
  const stop = observeDiagnostics((record) => {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
    if (windows) windowsAppendPrivateFileSync(file, bytes, true)
    else {
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
      try {
        appendFileSync(fd, bytes, { flush: true })
      } finally {
        closeSync(fd)
      }
    }
  })
  registrations.set(home, { refs: 1, stop })
  return releaser(home)
}
function releaser(home: string): () => void {
  let done = false
  return () => {
    if (!done) {
      done = true
      release(home)
    }
  }
}
function release(home: string): void {
  const value = registrations.get(home)
  if (value && --value.refs === 0) {
    value.stop()
    registrations.delete(home)
  }
}
/** Journal files are untrusted on export. Project only the fixed schema, including historical lookup. */
export function readDiagnosticJournal(
  home: string,
  limit: number,
  diagnosticId?: string,
): DiagnosticRecord[] {
  const byId = new Map<string, DiagnosticRecord>()
  const accept = (input: unknown): void => {
    const row = safeDiagnosticRecord(input)
    if (!row || (diagnosticId && row.diagnosticId !== diagnosticId)) return
    byId.delete(row.diagnosticId)
    byId.set(row.diagnosticId, row)
    if (byId.size > limit) byId.delete(byId.keys().next().value!)
  }
  const file = join(home, 'diagnostics', 'errors.jsonl')
  try {
    const fd = windows
      ? windowsOpenPrivateFileSync(file)
      : openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Invalid diagnostic journal')
      // Fixed-size chunks avoid loading the durable history into memory. Oversize lines are discarded.
      const buffer = Buffer.alloc(64 * 1024)
      let position = 0,
        line = '',
        skipping = false
      for (;;) {
        const n = readChunk(fd, buffer, 0, buffer.length, position)
        if (!n) break
        position += n
        for (const char of buffer.subarray(0, n).toString('utf8')) {
          if (char === '\n') {
            if (!skipping) {
              try {
                accept(JSON.parse(line))
              } catch {
                /* corrupt record omitted */
              }
            }
            line = ''
            skipping = false
          } else if (!skipping) {
            line += char
            if (line.length > 2048) {
              line = ''
              skipping = true
            }
          }
        }
      }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const row of diagnosticRecords()) accept(row)
  return [...byId.values()]
}

import { readSync as readChunk } from 'node:fs'
