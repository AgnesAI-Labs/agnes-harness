import type { DatabaseSync, StatementSync } from 'node:sqlite'

// Each owner already has its own confined connection. Cache query plans, never rows or admission
// decisions; the table facade still checks SQL and every bound value on every operation.
const connections = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
const MAX_STATEMENTS = 128

export function preparedStatement(connection: DatabaseSync, sql: string): StatementSync {
  let statements = connections.get(connection)
  if (!statements) {
    statements = new Map()
    connections.set(connection, statements)
  }
  let statement = statements.get(sql)
  if (statement) statements.delete(sql)
  else statement = connection.prepare(sql)
  statements.set(sql, statement)
  if (statements.size > MAX_STATEMENTS) {
    const oldest = statements.keys().next().value
    if (oldest !== undefined) statements.delete(oldest)
  }
  return statement
}
