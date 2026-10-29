import { readFileSync } from 'node:fs'
import { RUN_PROGRESS_EVENT_TYPES } from '@agnes/base/schedule'
import { APPROVAL_TICKET_EVENT_TYPES } from '@agnes/daemon-rpc/local/methods/agnes'
import { SESSION_ARTIFACT_ROOT_EVENT_TYPES } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { SESSION_REQUEST_EVENT_TYPES } from '../src/supervisor/session-request-events.js'

// A session that opens reads from its ledger only the event types its consumers react to. If a
// consumer learns to react to another type, the rows of that type would silently stop reaching it
// after a restart. These checks tie each consumer's own comparisons to the list the open reads.

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/** The text of one function: from its declaration to the closing brace at column zero. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration)
  expect(start, `${declaration} in source`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n}\n', start)
  return text.slice(start, end < 0 ? undefined : end)
}

/** Every event type a body compares `<receiver>.type` against (content blocks have a `type` too). */
function comparedTypes(body: string, receiver: string): string[] {
  const pattern = new RegExp(`\\b${receiver}\\.type\\s*(?:===|!==)\\s*'([^']+)'`, 'g')
  return [...body.matchAll(pattern)].map((match) => match[1] as string)
}

describe('history types each consumer is read for', () => {
  it('covers every type the artifact root parser answers for', () => {
    const body = functionBody(
      source('protocol/src/session-artifacts.ts'),
      'export function sessionArtifactRoots',
    )
    const compared = [
      ...comparedTypes(body, 'event'),
      ...(body.includes('ARTIFACT_REGISTERED_EVENT') ? ['x/core/artifact.registered'] : []),
    ]
    expect(compared.length).toBeGreaterThanOrEqual(5)
    for (const type of compared) expect(SESSION_ARTIFACT_ROOT_EVENT_TYPES, type).toContain(type)
  })

  it('covers every type run progress folds', () => {
    const body = functionBody(
      source('base/extensions/schedule/src/run-progress.ts'),
      'export function observeProgress',
    )
    expect(comparedTypes(body, 'event').length).toBeGreaterThanOrEqual(4)
    for (const type of comparedTypes(body, 'event')) expect(RUN_PROGRESS_EVENT_TYPES, type).toContain(type)
  })

  it('covers every type the approval ticket index reacts to', () => {
    const body = functionBody(
      source('daemon-rpc/src/local/methods/agnes.ts'),
      'export function indexApprovalTicket',
    )
    for (const type of comparedTypes(body, 'event')) expect(APPROVAL_TICKET_EVENT_TYPES, type).toContain(type)
    expect(body).toContain('APPROVAL_TICKET_EVENT_TYPES.includes(event.type)')
  })

  it('covers every type the session request lifetime reacts to', () => {
    const body = functionBody(
      source('daemon/src/supervisor/session-request-events.ts'),
      'export function observeSessionRequests',
    )
    expect(comparedTypes(body, 'e').length).toBeGreaterThanOrEqual(3)
    for (const type of comparedTypes(body, 'e')) expect(SESSION_REQUEST_EVENT_TYPES, type).toContain(type)
  })

  it('has both progress observers skip every type outside the list before touching state', () => {
    for (const file of ['base/extensions/schedule/src/catalog.ts', 'daemon-admin/src/webhooks/service.ts']) {
      const text = source(file)
      const at = text.search(/observeSession\([^)]*\)\s*\{/)
      expect(at, file).toBeGreaterThanOrEqual(0)
      expect(text.slice(at, at + 400), file).toContain('!RUN_PROGRESS_EVENT_TYPES.includes(event.type)')
    }
  })

  it('hands the daemon registry a consumer for each list', () => {
    const text = source('daemon/src/supervisor/assembly-workers.ts')
    for (const list of [
      'SESSION_REQUEST_EVENT_TYPES',
      'RUN_PROGRESS_EVENT_TYPES',
      'APPROVAL_TICKET_EVENT_TYPES',
    ])
      expect(text, list).toContain(`types: ${list}`)
  })
})
