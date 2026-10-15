import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * The ledger's `events` table is append-only except for whole-session deletion.
 * Damaged histories are refused without deleting the evidence.
 *
 * The Computer Use artifact GC proves "this session's indexed prefix is unchanged" from the id and
 * integrity digest of one anchor row, then re-extracts only the rows after it under the ledger
 * write lock. That proof is only sound while no code rewrites a row in place or deletes part of a
 * session: an in-place UPDATE, a REPLACE, or a partial DELETE below the anchor could drop an
 * artifact reference the index still counts on, and the screenshot would be deleted while the
 * ledger references it. Any such statement in product source fails here.
 */
const ALLOWED_DELETE = /^DELETE FROM events WHERE session_key = \?$/u

export function forbiddenEventWrites(text: string): string[] {
  const found: string[] = []
  const table = String.raw`["\x60]?events\b["\x60]?`
  for (const pattern of [
    new RegExp(String.raw`\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?${table}`, 'gu'),
    new RegExp(String.raw`\b(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\s+${table}`, 'gu'),
  ])
    for (const match of text.matchAll(pattern)) found.push(match[0])
  for (const match of text.matchAll(new RegExp(String.raw`\bDELETE\s+FROM\s+${table}[^'"\x60]*`, 'gu'))) {
    const statement = match[0].replace(/\s+/gu, ' ').trim()
    if (!ALLOWED_DELETE.test(statement)) found.push(statement)
  }
  return found
}

describe('ledger events are append-only apart from whole-session deletion', () => {
  it('no product source updates, replaces or partially deletes ledger events', () => {
    const files = listSourceFiles(join(root, 'packages')).filter(
      (file) => file.split(sep).includes('src') && !isTestFile(file),
    )
    expect(files.length, 'no product source found, so this guard checked nothing').toBeGreaterThan(100)
    const offenders = files.flatMap((file) =>
      forbiddenEventWrites(readFileSync(file, 'utf8')).map(
        (statement) => `${relative(root, file).split(sep).join('/')}: ${statement}`,
      ),
    )
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it.each([
    ["db.prepare('UPDATE events SET data = ? WHERE seq = ?')", ['UPDATE events']],
    ['`UPDATE OR IGNORE "events" SET x = 1`', ['UPDATE OR IGNORE "events"']],
    ["'INSERT OR REPLACE INTO events VALUES (?)'", ['INSERT OR REPLACE INTO events']],
    ["'REPLACE INTO events VALUES (?)'", ['REPLACE INTO events']],
    [
      "'DELETE FROM events WHERE session_key = ? AND seq > ?'",
      ['DELETE FROM events WHERE session_key = ? AND seq > ?'],
    ],
    ["'DELETE FROM events'", ['DELETE FROM events']],
    ["'DELETE FROM events WHERE session_key = ?'", []],
    ["'INSERT INTO events (session_key, seq) VALUES (?, ?)'", []],
    ["'UPDATE events_archive SET x = 1'", []],
    ["'DELETE FROM registers WHERE session_key = ?'", []],
  ])('classifies %s', (text, expected) => {
    expect(forbiddenEventWrites(text)).toEqual(expected)
  })
})

/** Retired names are forbidden in product source, including aliased or object-form writers. */
export function retiredApprovalEvents(text: string): string[] {
  return [...text.matchAll(/["'`]approval\/(?:asked|decided)["'`]/gu)].map((match) => match[0])
}

describe('human decisions have one ledger authority', () => {
  it('product source cannot introduce retired approval events', () => {
    const files = listSourceFiles(join(root, 'packages')).filter(
      (file) => file.split(sep).includes('src') && !isTestFile(file),
    )
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.flatMap((file) =>
      retiredApprovalEvents(readFileSync(file, 'utf8')).map((event) => `${relative(root, file)}: ${event}`),
    )
    expect(offenders, offenders.join('\n')).toEqual([])
  })
  it.each([
    ["session.ev('approval/asked', request)", ["'approval/asked'"]],
    ['{ type: "approval/decided", data: answer }', ['"approval/decided"']],
    ["const type = 'approval/asked'; append(type, data)", ["'approval/asked'"]],
    ["session.ev('decision/state', snapshot)", []],
    ["session.ev('approval/guardian-decided', fact)", []],
  ])('recognizes %s', (source, expected) => expect(retiredApprovalEvents(source)).toEqual(expected))
})
