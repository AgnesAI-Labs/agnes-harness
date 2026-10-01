import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

export interface DurableNote {
  readonly id: string
  readonly body: string
  readonly revision: number
}

export interface NoteStore {
  read(id: string): DurableNote | null
  commit(note: DurableNote): void
  rollback(note: DurableNote): void
  holdPending(note: DurableNote): void
  close(): void
}

function noteFrom(value: unknown): DurableNote | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as { id?: unknown; body?: unknown; revision?: unknown }
  if (typeof row.id !== 'string' || typeof row.body !== 'string' || typeof row.revision !== 'number') {
    throw new Error('note row is invalid')
  }
  return { id: row.id, body: row.body, revision: row.revision }
}

export function openNoteStore(path: string): NoteStore {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  if (process.platform === 'darwin') db.exec('PRAGMA checkpoint_fullfsync = ON')
  db.exec(
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL
    )`,
  )
  let open = true
  const guard = () => {
    if (!open) throw new Error('store is closed')
  }
  const write = (note: DurableNote) => {
    db.prepare(
      `INSERT INTO notes (id, body, revision) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, revision = excluded.revision`,
    ).run(note.id, note.body, note.revision)
  }
  return {
    read(id) {
      guard()
      return noteFrom(db.prepare('SELECT id, body, revision FROM notes WHERE id = ?').get(id))
    },
    commit(note) {
      guard()
      db.exec('BEGIN IMMEDIATE')
      write(note)
      db.exec('COMMIT')
    },
    rollback(note) {
      guard()
      db.exec('BEGIN IMMEDIATE')
      write(note)
      db.exec('ROLLBACK')
    },
    holdPending(note) {
      guard()
      db.exec('BEGIN IMMEDIATE')
      write(note)
    },
    close() {
      if (!open) return
      open = false
      db.close()
    },
  }
}

export function refuseNote(scope: string, features: readonly string[]): boolean {
  return scope !== 'workspace' || !features.includes('write')
}

function argument(argv: readonly string[], index: number): string {
  const value = argv[index]
  if (value === undefined) throw new Error('sample provider arguments are missing')
  return value
}

function runCommand(argv: readonly string[]): void {
  const command = argument(argv, 0)
  const path = argument(argv, 1)
  const store = openNoteStore(path)
  if (command === 'read') {
    const note = store.read(argument(argv, 2))
    store.close()
    process.stdout.write(note === null ? 'MISSING\n' : `FOUND ${note.revision} ${note.body}\n`)
    return
  }
  if (command === 'hold') {
    store.commit({ id: argument(argv, 2), body: argument(argv, 3), revision: 1 })
    store.holdPending({ id: argument(argv, 4), body: argument(argv, 5), revision: 1 })
    process.stdout.write('READY\n')
    setInterval(() => undefined, 1000)
    return
  }
  store.close()
  throw new Error(`unknown sample command ${command}`)
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  try {
    runCommand(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'sample provider failed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
