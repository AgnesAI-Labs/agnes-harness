import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

export function openMcpJournal(directory: string, tenantId: string, ownerId: string) {
  if (!existsSync(directory)) createPrivateDirectorySync(directory)
  const path = join(directory, 'mcp.sqlite')
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id = 1), tenant TEXT NOT NULL, generation TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, output TEXT); CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  )
  db.prepare('INSERT OR IGNORE INTO owner VALUES (1, ?, ?)').run(tenantId, ownerId)
  const owner = db.prepare('SELECT tenant, generation FROM owner WHERE id = 1').get()
  if (!owner || owner.tenant !== tenantId || owner.generation !== ownerId) {
    db.close()
    throw new Error('MCP journal ownership mismatch')
  }
  return {
    request(id: string) {
      return db.prepare('SELECT fingerprint, output FROM requests WHERE id = ?').get(id)
    },
    begin(id: string, fingerprint: string) {
      return (
        db.prepare('INSERT OR IGNORE INTO requests VALUES (?, ?, NULL)').run(id, fingerprint).changes === 1
      )
    },
    finish(id: string, output: unknown) {
      db.prepare('UPDATE requests SET output = ? WHERE id = ?').run(JSON.stringify(output), id)
    },
    connection(id: string): unknown {
      const row = db.prepare('SELECT data FROM connections WHERE id = ?').get(id)
      return row ? JSON.parse(String(row.data)) : null
    },
    saveConnection(id: string, data: unknown) {
      db.prepare('INSERT OR REPLACE INTO connections VALUES (?, ?)').run(id, JSON.stringify(data))
    },
    close() {
      db.close()
    },
  }
}
